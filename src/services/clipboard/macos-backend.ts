/**
 * @fileoverview macOS clipboard backend: JXA/NSPasteboard (via osascript) for
 * inspection, every read, every write, and clear.
 * @module services/clipboard/macos-backend
 */

import { spawn } from 'node:child_process';
import { assertByteRange } from './byte-window.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RangedReadWindow,
  ReadResult,
} from './types.js';
import {
  buildInspectResult,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  stripHtmlTags,
  toReadResult,
} from './types.js';

/**
 * JXA script listing the pasteboard's types, printed as a JSON array of
 * `RawTypeEntry` values. `pb.types` holds the types the owner declared plus
 * the translations AppKit can supply (`public.tiff` beside a `public.png`,
 * `public.utf8-plain-text` beside `public.utf16-plain-text`), so a listed type
 * can have nil data — a type declared and never set. Nil data is a failed
 * measurement, never a zero-byte representation.
 */
const JXA_INSPECT = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const types = pb.types;
const result = [];
if (!types.isNil()) {
  for (let i = 0; i < types.count; i++) {
    const t = ObjC.unwrap(types.objectAtIndex(i));
    const data = pb.dataForType(t);
    result.push(data.isNil() ? { type: t, measurementFailed: true } : { type: t, bytes: Number(data.length) });
  }
}
JSON.stringify(result);
`.trim();

/**
 * JXA script for emptying the pasteboard.
 * `clearContents` alone leaves no representation behind — the write path's
 * following `setStringForType` is what turns an empty write into a zero-byte
 * text representation.
 */
const JXA_CLEAR = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
'ok';
`.trim();

/**
 * Opening of every JXA read script: the pasteboard, its `changeCount` sampled
 * before any data is touched, and the `{ present: false }` envelope a script
 * replaces once it finds its representation.
 */
const JXA_READ_PRELUDE = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const changeCount = Number(pb.changeCount);
let result = { present: false };
`.trim();

/**
 * Closing statement of every JXA read script. `changeCount` is sampled again
 * after the data access: an unchanged count prints the envelope, whose
 * `revision` is that count; a changed one means another application wrote the
 * pasteboard mid-read, and the script prints `{ changed: true }` instead.
 */
const JXA_READ_REPORT =
  'JSON.stringify(Number(pb.changeCount) === changeCount ? result : { changed: true });';

/**
 * Clamp-and-slice snippet shared by every ranged JXA read script, given a
 * non-nil NSData `dataVar`. Fills in the `{ present, total, contentBase64,
 * revision }` envelope `parseRangedReadEnvelope` reads: `total` is the full
 * representation's byte size and `contentBase64` only the `[offset, offset +
 * limit)` window — the JXA process holds the full representation (that is how
 * NSPasteboard works), but Node never receives more than the window. The slice
 * location is clamped to `total`, so one `subdataWithRange` covers every
 * offset: past the end it is a valid empty range at `total`.
 */
function jxaSliceSnippet(dataVar: string, range: ByteRange, extraFields = ''): string {
  return `
const total = Number(${dataVar}.length);
const location = Math.min(${range.offset}, total);
const slice = ${dataVar}.subdataWithRange({ location: location, length: Math.min(${range.limit}, total - location) });
const b64 = ObjC.unwrap(slice.base64EncodedStringWithOptions(0));
result = { present: true, total: total, contentBase64: b64, revision: String(changeCount)${extraFields} };
`;
}

/**
 * JXA script builder for a ranged read of the NSData the `lookup` statements
 * leave in `data`: prints `{ present: false }` when it is nil, otherwise the
 * envelope from `jxaSliceSnippet`.
 *
 * Every nil test in the JXA read scripts uses `.isNil()`: a nil Objective-C
 * return is a truthy wrapper in JXA, so `!value` never detects it.
 */
function buildJxaDataRead(lookup: string, range: ByteRange): string {
  assertByteRange(range);
  return `
${JXA_READ_PRELUDE}
${lookup.trim()}
if (!data.isNil()) {
  ${jxaSliceSnippet('data', range)}
}
${JXA_READ_REPORT}
`.trim();
}

/**
 * Plain text: the raw bytes of the first non-nil of `public.utf8-plain-text`
 * and `public.plain-text`. AppKit translates UTF-16 plain text into the former
 * but not the latter. Raw bytes keep a leading byte-order mark, which NSString
 * decoding (`stringForType`, `pbpaste`) consumes.
 */
const TEXT_LOOKUP = `
let data = pb.dataForType('public.utf8-plain-text');
if (data.isNil()) data = pb.dataForType('public.plain-text');
`;

/**
 * HTML: the raw bytes of `public.html`, whatever their encoding — decoding
 * through NSString would drop a leading byte-order mark.
 */
const HTML_LOOKUP = `
const data = pb.dataForType('public.html');
`;

/**
 * RTF: the first non-empty of the raw `com.apple.flat-rtfd` and `public.rtf`
 * data, then the plain-RTF string re-encoded as UTF-8. A listed type whose
 * data is zero-length is present and empty, as inspection reports it, so it
 * is the last resort before nil.
 */
const RTF_LOOKUP = `
const sources = [pb.dataForType('com.apple.flat-rtfd'), pb.dataForType('public.rtf')];
let data = sources.find((d) => !d.isNil() && Number(d.length) > 0);
if (data === undefined) {
  const str = pb.stringForType('public.rtf');
  data = str.isNil() ? (sources.find((d) => !d.isNil()) ?? str) : str.dataUsingEncoding($.NSUTF8StringEncoding);
}
`;

/** The data lookup and the name failures report, per format read through `buildJxaDataRead`. */
const DATA_READS = {
  text: { lookup: TEXT_LOOKUP, name: 'Text' },
  html: { lookup: HTML_LOOKUP, name: 'HTML' },
  rtf: { lookup: RTF_LOOKUP, name: 'RTF' },
} as const satisfies Record<Exclude<ClipboardFormat, 'image'>, { lookup: string; name: string }>;

/**
 * JXA script builder for reading an image from the pasteboard as PNG, bounded
 * to `range`. Takes the first of `public.png`, `public.tiff`, `com.apple.pict`
 * that NSBitmapImageRep decodes, skipping zero-length and undecodable data, and
 * re-encodes it as PNG. Width/height come from the full (unsliced) rep — always
 * reported when an image is returned, regardless of `range`. When every listed
 * image type is zero-length, the image is present and empty: an empty envelope
 * with no dimensions.
 */
function buildJxaReadImage(range: ByteRange): string {
  assertByteRange(range);
  return `
${JXA_READ_PRELUDE}
const imgTypes = ['public.png', 'public.tiff', 'com.apple.pict'];
let listed = false;
let sawBytes = false;
let rep = null;
let pngData = null;
for (const t of imgTypes) {
  const d = pb.dataForType(t);
  if (d.isNil()) continue;
  listed = true;
  if (Number(d.length) === 0) continue;
  sawBytes = true;
  const candidate = $.NSBitmapImageRep.imageRepWithData(d);
  if (candidate.isNil()) continue;
  const encoded = candidate.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, {});
  if (encoded.isNil() || Number(encoded.length) === 0) continue;
  rep = candidate;
  pngData = encoded;
  break;
}
if (pngData !== null) {
  const w = Math.round(ObjC.unwrap(rep.pixelsWide));
  const h = Math.round(ObjC.unwrap(rep.pixelsHigh));
  ${jxaSliceSnippet('pngData', range, ', width: w, height: h')}
} else if (listed && !sawBytes) {
  result = { present: true, total: 0, contentBase64: '', revision: String(changeCount) };
}
${JXA_READ_REPORT}
`.trim();
}

/**
 * Static JXA writer for every text and HTML write. The payload arrives on
 * stdin as a JSON envelope of base64 UTF-8 fields — `{ text, html? }` — and is
 * parsed as data, so no payload byte reaches the command line or the script
 * source, and argv is identical for every write. Text is published with
 * `setStringForType` as `public.utf8-plain-text` (pbcopy would re-type input
 * that starts with an RTF or EPS header). Every set is checked; a failure
 * throws, which exits osascript non-zero.
 */
const JXA_WRITE = `
ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const envelope = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
function decode(field) {
  const bytes = $.NSData.alloc.initWithBase64EncodedStringOptions(envelope[field], 0);
  if (bytes.isNil()) throw new Error('payload field ' + field + ' is not base64');
  // initWithData drops a leading byte-order mark, so decode behind a one-byte
  // ASCII sentinel and cut it off again: every payload byte survives.
  const guarded = $.NSMutableData.dataWithData($.NSData.alloc.initWithBase64EncodedStringOptions('YQ==', 0));
  guarded.appendData(bytes);
  const str = $.NSString.alloc.initWithDataEncoding(guarded, $.NSUTF8StringEncoding);
  if (str.isNil()) throw new Error('payload field ' + field + ' is not UTF-8');
  return str.substringFromIndex(1);
}
const text = decode('text');
const html = envelope.html === undefined ? null : decode('html');
const pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
if (html !== null) {
  if (!pb.setStringForType(html, $.NSPasteboardTypeHTML)) throw new Error('setting public.html failed');
}
if (!pb.setStringForType(text, $.NSPasteboardTypeString)) throw new Error('setting public.utf8-plain-text failed');
'written';
`.trim();

/** Run a JXA script via osascript, optionally feeding `stdin`, and return stdout as a string. */
function runJxa(script: string, stdin?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin) {
      // A script that exits before draining stdin surfaces as its exit code; the
      // resulting EPIPE on the pipe must not become an unhandled stream error.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdin);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`osascript exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`),
        );
      } else {
        resolve(Buffer.concat(out).toString('utf8').trim());
      }
    });
    child.on('error', reject);
  });
}

/** Run a ranged JXA read script and decode the envelope it prints (see `jxaSliceSnippet`). */
async function runJxaRangedRead(script: string, formatName: string): Promise<RangedReadWindow> {
  return parseRangedReadEnvelope(await runJxa(script), 'macOS', formatName);
}

/** Map macOS UTI/pasteboard type → semantic ClipboardFormat. */
function utiToFormat(uti: string): ClipboardFormat | null {
  if (
    uti === 'public.utf8-plain-text' ||
    uti === 'public.plain-text' ||
    uti === 'NSStringPboardType'
  )
    return 'text';
  if (uti === 'public.html') return 'html';
  if (uti === 'public.rtf' || uti === 'com.apple.flat-rtfd') return 'rtf';
  if (uti === 'public.tiff' || uti === 'public.png' || uti === 'com.apple.pict') return 'image';
  return null;
}

/** macOS clipboard backend. */
export class MacosBackend implements ClipboardBackend {
  async inspect(): Promise<InspectResult> {
    // JXA always prints a JSON array — `[]` for an empty pasteboard. Anything
    // else means the script failed, which is a reportable failure rather than
    // an empty clipboard.
    return buildInspectResult(
      parseNativeTypeEntries(await runJxa(JXA_INSPECT), 'macOS'),
      utiToFormat,
    );
  }

  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    const window =
      format === 'image'
        ? await runJxaRangedRead(buildJxaReadImage(range), 'Image')
        : await runJxaRangedRead(
            buildJxaDataRead(DATA_READS[format].lookup, range),
            DATA_READS[format].name,
          );
    return toReadResult(format, window);
  }

  async write(
    content: string,
    format: 'text' | 'html',
  ): Promise<{ format: 'text' | 'html'; byteSize: number }> {
    const buf = Buffer.from(content, 'utf8');
    // HTML also publishes a tag-stripped plain-text fallback.
    const envelope =
      format === 'text'
        ? { text: buf.toString('base64') }
        : {
            text: Buffer.from(stripHtmlTags(content), 'utf8').toString('base64'),
            html: buf.toString('base64'),
          };
    await runJxa(JXA_WRITE, Buffer.from(JSON.stringify(envelope), 'utf8'));
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runJxa(JXA_CLEAR);
  }
}
