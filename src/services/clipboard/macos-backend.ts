/**
 * @fileoverview macOS clipboard backend: JXA/NSPasteboard (via osascript) for
 * inspection, every read, every write, and clear.
 * @module services/clipboard/macos-backend
 */

import { spawn } from 'node:child_process';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { assertByteRange } from './byte-window.js';
import { htmlToPlainText } from './html-to-text.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  ItemScope,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import {
  buildInspectResult,
  inspectUnreadable,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  toReadResult,
} from './types.js';

/**
 * JXA function listing the local file paths the pasteboard items in
 * `[first, end)` carry, in item order: each item's `public.file-url` parsed as
 * an NSURL and taken as its `path`, which resolves a file reference URL
 * (`file:///.file/id=…`) to the file's path. A value that is not a `file:` URL,
 * names a host other than `localhost`, or has no path is skipped
 * (`isFileURL` bridges to a JS boolean, not an Objective-C object).
 *
 * Read per item rather than through `readObjectsForClasses:options:`, which
 * cannot select one item and, even with
 * `NSPasteboardURLReadingFileURLsOnlyKey`, returns whatever a `public.file-url`
 * holds — `https://example.com/y` as the path `/y`, a bare word as itself.
 *
 * Also defines `listable`, the one test inspection and the `files` read both
 * apply: a path holding a CR or LF cannot be listed one per line, so `files`
 * neither returns it nor counts it toward the format being available.
 */
const JXA_FILE_PATHS = `
function listable(path) {
  return !/[\\r\\n]/.test(path);
}
function filePaths(items, first, end) {
  const paths = [];
  for (let i = first; i < end; i++) {
    const value = items.objectAtIndex(i).stringForType('public.file-url');
    if (value.isNil()) continue;
    const url = $.NSURL.URLWithString(value);
    if (url.isNil() || !url.isFileURL) continue;
    const host = url.host;
    if (!host.isNil() && ObjC.unwrap(host).toLowerCase() !== 'localhost') continue;
    const path = url.path;
    if (!path.isNil()) paths.push(ObjC.unwrap(path));
  }
  return paths;
}
`.trim();

/**
 * JXA script describing the pasteboard, printed as
 * `{ itemCount, hasFilePaths, types }`. `types` is the `RawTypeEntry` listing:
 * `pb.types` holds every item's declared types plus the translations AppKit
 * can supply (`public.tiff` beside a `public.png`, `public.utf8-plain-text`
 * beside `public.utf16-plain-text`), so a listed type can have nil data — a
 * type declared and never set. Nil data is a failed measurement, never a
 * zero-byte representation. `itemCount` is the number of pasteboard items;
 * `hasFilePaths` says whether any item's `public.file-url` resolves to a local
 * path a `files` read can list — one holding no CR or LF (see `JXA_FILE_PATHS`).
 */
const JXA_INSPECT = `
ObjC.import('AppKit');
${JXA_FILE_PATHS}
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
const items = pb.pasteboardItems;
const itemCount = Number(items.count);
JSON.stringify({ itemCount: itemCount, hasFilePaths: filePaths(items, 0, itemCount).some(listable), types: result });
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
 * Opening of every JXA read script, which runs as a `run(argv)` handler so the
 * selected item reaches it as an osascript argument, never as script text:
 * `argv[0]` is the 0-based item, absent for a read of the whole pasteboard.
 * Samples `changeCount` before any data is touched, counts the pasteboard
 * items, and binds `src`, the receiver every lookup reads: the pasteboard, the
 * selected `NSPasteboardItem` (which answers `types`, `dataForType:`, and
 * `stringForType:` for that item alone), or `null` for an item past the last,
 * which leaves the `{ present: false }` envelope in place.
 */
const JXA_READ_PRELUDE = `
ObjC.import('AppKit');
function run(argv) {
const pb = $.NSPasteboard.generalPasteboard;
const changeCount = Number(pb.changeCount);
const items = pb.pasteboardItems;
const itemCount = Number(items.count);
const item = argv.length > 0 ? Number(argv[0]) : null;
const src = item === null ? pb : item < itemCount ? items.objectAtIndex(item) : null;
let result = { present: false };
`.trim();

/**
 * Closing statement of every JXA read script. `changeCount` is sampled again
 * after the data access: an unchanged count returns the envelope, whose
 * `revision` is that count; a changed one means another application wrote the
 * pasteboard mid-read, and the script returns `{ changed: true }` instead.
 * osascript prints the `run` handler's return value.
 */
const JXA_READ_REPORT = `
return JSON.stringify(Number(pb.changeCount) === changeCount ? result : { changed: true });
}
`.trim();

/**
 * Clamp-and-slice snippet shared by every ranged JXA read script, given a
 * non-nil NSData `dataVar`. Fills in the `{ present, total, contentBase64,
 * revision, itemCount }` envelope `parseRangedReadEnvelope` reads: `total` is
 * the full representation's byte size and `contentBase64` only the `[offset,
 * offset + limit)` window — the JXA process holds the full representation
 * (that is how NSPasteboard works), but Node never receives more than the
 * window. The slice location is clamped to `total`, so one `subdataWithRange`
 * covers every offset: past the end it is a valid empty range at `total`.
 */
function jxaSliceSnippet(dataVar: string, range: ByteRange, extraFields = ''): string {
  return `
const total = Number(${dataVar}.length);
const location = Math.min(${range.offset}, total);
const slice = ${dataVar}.subdataWithRange({ location: location, length: Math.min(${range.limit}, total - location) });
const b64 = ObjC.unwrap(slice.base64EncodedStringWithOptions(0));
result = { present: true, total: total, contentBase64: b64, revision: String(changeCount), itemCount: itemCount${extraFields} };
`;
}

/**
 * JXA script builder for a ranged read of the NSData the `lookup` statements
 * leave in `data`, read from `src`: returns `{ present: false }` when it is
 * nil, otherwise the envelope from `jxaSliceSnippet`.
 *
 * Every nil test in the JXA read scripts uses `.isNil()`: a nil Objective-C
 * return is a truthy wrapper in JXA, so `!value` never detects it.
 */
function buildJxaDataRead(lookup: string, range: ByteRange): string {
  assertByteRange(range);
  return `
${JXA_READ_PRELUDE}
if (src !== null) {
${lookup.trim()}
if (!data.isNil()) {
  ${jxaSliceSnippet('data', range)}
}
}
${JXA_READ_REPORT}
`.trim();
}

/**
 * Plain text: the raw bytes of the first non-nil of `public.utf8-plain-text`
 * and `public.plain-text`. AppKit translates UTF-16 plain text into the former
 * but not the latter, for the pasteboard and for each item. Raw bytes keep a
 * leading byte-order mark, which NSString decoding (`stringForType`,
 * `pbpaste`) consumes.
 */
const TEXT_LOOKUP = `
let data = src.dataForType('public.utf8-plain-text');
if (data.isNil()) data = src.dataForType('public.plain-text');
`;

/**
 * HTML: the raw bytes of `public.html`, whatever their encoding — decoding
 * through NSString would drop a leading byte-order mark.
 */
const HTML_LOOKUP = `
const data = src.dataForType('public.html');
`;

/**
 * RTF markup: the raw `public.rtf` data when it is non-empty. Otherwise a
 * non-empty `com.apple.flat-rtfd` — a binary package, not RTF markup — is
 * converted through NSAttributedString, keeping the text and its styling and
 * dropping the attachments RTF cannot carry; one that does not decode leaves
 * the read absent, or empty when a zero-length `public.rtf` is listed. Not
 * decoding is either a nil result or, for a malformed package (a truncated
 * one), an `NSDeserializeException` that JXA throws. A listed type whose data
 * is zero-length is present and empty, as inspection reports it, so it is the
 * last resort before nil. The conversion is the one
 * RTF read not returned byte for byte, and its `total` is the converted RTF's
 * size, not the inspected flat RTFD's.
 */
const RTF_LOOKUP = `
let data = src.dataForType('public.rtf');
if (data.isNil() || Number(data.length) === 0) {
  const rtfd = src.dataForType('com.apple.flat-rtfd');
  if (!rtfd.isNil() && Number(rtfd.length) > 0) {
    let attributed = null;
    try {
      attributed = $.NSAttributedString.alloc.initWithRTFDDocumentAttributes(rtfd, $());
    } catch (e) {
      attributed = null;
    }
    if (attributed !== null && !attributed.isNil()) data = attributed.RTFFromRangeDocumentAttributes({ location: 0, length: Number(attributed.length) }, $());
  } else if (data.isNil()) {
    data = rtfd;
  }
}
`;

/**
 * JXA script builder for reading an image from `src` as PNG, bounded to
 * `range`. Takes the first of `public.png`, `public.tiff`, `com.apple.pict`
 * that NSBitmapImageRep decodes, skipping zero-length and undecodable data, and
 * re-encodes it as PNG. Width/height come from the full (unsliced) rep — always
 * reported when an image is returned, regardless of `range`. When every listed
 * image type is zero-length, the image is present and empty: an empty envelope
 * with no dimensions.
 *
 * AppKit converts any other image type NSImage reads (JPEG, HEIC, GIF) to
 * `public.tiff` on the pasteboard but not on a single item, so a read of one
 * item also tries, after those three, each of the item's own types NSImage
 * reads, in the item's order — the images inspection lists through that
 * conversion. A type NSBitmapImageRep cannot decode (PDF) is skipped.
 */
function buildJxaReadImage(range: ByteRange): string {
  assertByteRange(range);
  return `
${JXA_READ_PRELUDE}
if (src !== null) {
const imgTypes = ['public.png', 'public.tiff', 'com.apple.pict'];
if (item !== null) {
  const readable = ObjC.deepUnwrap($.NSImage.imageTypes);
  for (const t of ObjC.deepUnwrap(src.types)) {
    if (!imgTypes.includes(t) && readable.includes(t)) imgTypes.push(t);
  }
}
let listed = false;
let sawBytes = false;
let rep = null;
let pngData = null;
for (const t of imgTypes) {
  const d = src.dataForType(t);
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
  result = { present: true, total: 0, contentBase64: '', revision: String(changeCount), itemCount: itemCount };
}
}
${JXA_READ_REPORT}
`.trim();
}

/**
 * JXA script builder for a `files` read, bounded to `range`: the local paths
 * `JXA_FILE_PATHS` finds on every item, or on the selected one, as UTF-8, one
 * per line (LF, no trailing newline). A path containing a CR or LF cannot be
 * listed one per line, so it is left out and counted in `omittedPaths`. With no
 * path to list — none at all, or only ones holding a line break — the read is
 * absent, whether of the whole pasteboard (which inspection then lists without
 * `files`) or of one item.
 */
function buildJxaReadFiles(range: ByteRange): string {
  assertByteRange(range);
  return `
${JXA_READ_PRELUDE}
${JXA_FILE_PATHS}
if (src !== null) {
const paths = item === null ? filePaths(items, 0, itemCount) : filePaths(items, item, item + 1);
const listed = paths.filter(listable);
if (listed.length > 0) {
  const data = $(listed.join('\\n')).dataUsingEncoding($.NSUTF8StringEncoding);
  ${jxaSliceSnippet('data', range, ', omittedPaths: paths.length - listed.length')}
}
}
${JXA_READ_REPORT}
`.trim();
}

/**
 * Per format: the read script builder, the name failures report, and how a
 * read with no `item` draws on a pasteboard holding more than one item —
 * `dataForType:` answers HTML and images from the first item carrying the
 * type and joins text and RTF across items with newlines; `files` lists every
 * item's path.
 */
const READS = {
  text: {
    build: (range: ByteRange) => buildJxaDataRead(TEXT_LOOKUP, range),
    name: 'Text',
    scope: 'joined',
  },
  html: {
    build: (range: ByteRange) => buildJxaDataRead(HTML_LOOKUP, range),
    name: 'HTML',
    scope: 'first',
  },
  rtf: {
    build: (range: ByteRange) => buildJxaDataRead(RTF_LOOKUP, range),
    name: 'RTF',
    scope: 'joined',
  },
  image: { build: buildJxaReadImage, name: 'Image', scope: 'first' },
  files: { build: buildJxaReadFiles, name: 'Files', scope: 'all' },
} as const satisfies Record<
  ClipboardFormat,
  { build: (range: ByteRange) => string; name: string; scope: ItemScope }
>;

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

/**
 * Run a JXA script via osascript and return stdout as a string. `args` reach
 * the script's `run(argv)` handler; `stdin`, when given, is fed to the script.
 */
function runJxa(
  script: string,
  { args = [], stdin }: { args?: readonly string[]; stdin?: Buffer } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script, ...args], {
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

/**
 * Parse the `{ itemCount, hasFilePaths, types }` description `JXA_INSPECT`
 * prints — `types` empty for an empty pasteboard. Anything else means the
 * script failed, which is a reportable failure rather than an empty clipboard.
 */
function parseInspection(raw: string): {
  hasFilePaths: boolean;
  itemCount: number;
  rawTypes: RawTypeEntry[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw inspectUnreadable('macOS', raw);
  }
  const { itemCount, hasFilePaths, types } = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as { hasFilePaths?: unknown; itemCount?: unknown; types?: unknown };
  if (
    typeof itemCount !== 'number' ||
    !Number.isSafeInteger(itemCount) ||
    itemCount < 0 ||
    typeof hasFilePaths !== 'boolean' ||
    !Array.isArray(types)
  ) {
    throw inspectUnreadable('macOS', raw);
  }
  return {
    itemCount,
    hasFilePaths,
    rawTypes: parseNativeTypeEntries(JSON.stringify(types), 'macOS'),
  };
}

/**
 * Map a macOS UTI/pasteboard type → semantic ClipboardFormat. `public.file-url`
 * is not mapped here: it makes `files` available only when it resolves to a
 * path a `files` read can list (see `MacosBackend.inspect`). `NSFilenamesPboardType` stays unmapped —
 * deprecated, and AppKit translates it into one `public.file-url` item per path.
 */
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
    const { itemCount, hasFilePaths, rawTypes } = parseInspection(await runJxa(JXA_INSPECT));
    // A `public.file-url` whose values are web URLs or junk yields no path, and
    // one whose only paths hold a line break yields none a read could list, so
    // either lists no `files`.
    return buildInspectResult(
      rawTypes,
      (uti) => (uti === 'public.file-url' ? (hasFilePaths ? 'files' : null) : utiToFormat(uti)),
      itemCount,
    );
  }

  async read(format: ClipboardFormat, range: ByteRange, item?: number): Promise<ReadResult> {
    const { build, name, scope } = READS[format];
    const raw = await runJxa(build(range), {
      args: item === undefined ? [] : ['--', String(item)],
    });
    const window = parseRangedReadEnvelope(raw, 'macOS', name);
    // Every macOS read script reports the item count; a window without one is unreadable output.
    const { itemCount } = window;
    if (itemCount === undefined) {
      throw serializationError(
        `macOS clipboard helper returned an unreadable response while reading ${name}.`,
        { platform: 'macOS', format: name, responseBytes: raw.length },
      );
    }
    return toReadResult(
      format,
      window,
      item === undefined && itemCount > 1 ? { itemCount, itemScope: scope } : { itemCount },
    );
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
            text: Buffer.from(htmlToPlainText(content), 'utf8').toString('base64'),
            html: buf.toString('base64'),
          };
    await runJxa(JXA_WRITE, { stdin: Buffer.from(JSON.stringify(envelope), 'utf8') });
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runJxa(JXA_CLEAR);
  }
}
