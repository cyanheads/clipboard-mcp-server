/**
 * @fileoverview macOS clipboard backend: pbpaste for text reads, and JXA/NSPasteboard
 * (via osascript) for inspection, rich-format reads, every write, and clear.
 * @module services/clipboard/macos-backend
 */

import { spawn } from 'node:child_process';
import { assertByteRange, collectByteWindow } from './byte-window.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RangedReadWindow,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import {
  buildInspectFormats,
  clipboardOutcome,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  stripHtmlTags,
} from './types.js';

/**
 * JXA script for inspecting pasteboard types.
 * Returns JSON: [{ type: string, bytes: number }, ...]
 * Uses pb.types() to get only explicitly-set types (not synthesized ones).
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
    const bytes = data.isNil() ? 0 : Number(data.length);
    result.push({ type: t, bytes: bytes });
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
 * Clamp-and-slice snippet shared by every ranged JXA read script, given a
 * non-nil NSData `dataVar`. Prints the `{ present, total, contentBase64 }`
 * envelope `parseRangedReadEnvelope` reads: `total` is the full
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
JSON.stringify({ present: true, total: total, contentBase64: b64${extraFields} });
`;
}

/**
 * JXA script builder for reading HTML from the pasteboard, bounded to `range`.
 * Prints the ranged-read envelope (see `jxaSliceSnippet`). The HTML string is re-encoded as UTF-8 so
 * the byte range the service trims to UTF-8 boundaries matches this response;
 * a `public.html` AppKit cannot decode as a string is sliced as its raw bytes.
 *
 * Every nil test in the JXA read scripts uses `.isNil()`: a nil Objective-C
 * return is a truthy wrapper in JXA, so `!value` never detects it.
 */
function buildJxaReadHtml(range: ByteRange): string {
  assertByteRange(range);
  return `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const html = pb.stringForType($.NSPasteboardTypeHTML);
const data = html.isNil()
  ? pb.dataForType($.NSPasteboardTypeHTML)
  : html.dataUsingEncoding($.NSUTF8StringEncoding);
if (data.isNil()) {
  JSON.stringify({ present: false });
} else {
  ${jxaSliceSnippet('data', range)}
}
`.trim();
}

/**
 * JXA script builder for reading RTF from the pasteboard, bounded to `range`.
 * Prefers the raw RTF/RTFD data; falls back to the plain-RTF string
 * re-encoded as UTF-8, same source-preference order as the unranged read.
 */
function buildJxaReadRtf(range: ByteRange): string {
  assertByteRange(range);
  return `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const rtfType = 'com.apple.flat-rtfd';
const publicRtf = 'public.rtf';
const hasBytes = (d) => !d.isNil() && Number(d.length) > 0;
let data = pb.dataForType(rtfType);
if (!hasBytes(data)) data = pb.dataForType(publicRtf);
if (!hasBytes(data)) {
  const str = pb.stringForType(publicRtf);
  data = str.isNil() ? str : str.dataUsingEncoding($.NSUTF8StringEncoding);
}
if (data.isNil()) {
  JSON.stringify({ present: false });
} else {
  ${jxaSliceSnippet('data', range)}
}
`.trim();
}

/**
 * JXA script builder for reading an image from the pasteboard as PNG, bounded
 * to `range`. Converts TIFF to PNG via NSBitmapImageRep, same as the unranged
 * read. Width/height come from the full (unsliced) `NSBitmapImageRep` — they
 * are always reported when the image is present, regardless of `range`.
 */
function buildJxaReadImage(range: ByteRange): string {
  assertByteRange(range);
  return `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const imgTypes = ['public.png', 'public.tiff', 'com.apple.pict'];
let imgData = null;
for (const t of imgTypes) {
  const d = pb.dataForType(t);
  if (!d.isNil() && Number(d.length) > 0) { imgData = d; break; }
}
if (imgData === null) {
  JSON.stringify({ present: false });
} else {
  const img = $.NSImage.alloc.initWithData(imgData);
  if (img.isNil() || !img.isValid) {
    JSON.stringify({ present: false });
  } else {
    const rep = $.NSBitmapImageRep.imageRepWithData(imgData);
    if (rep.isNil()) {
      JSON.stringify({ present: false });
    } else {
      const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, {});
      if (pngData.isNil() || Number(pngData.length) === 0) {
        JSON.stringify({ present: false });
      } else {
        const w = Math.round(ObjC.unwrap(rep.pixelsWide));
        const h = Math.round(ObjC.unwrap(rep.pixelsHigh));
        ${jxaSliceSnippet('pngData', range, ', width: w, height: h')}
      }
    }
  }
}
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

/**
 * Environment for pbpaste. It transcodes through the process locale, so a parent
 * with no UTF-8 locale (launchd, `env -i`, some client launchers) would make it
 * emit one byte for `é`. Pinning LC_ALL keeps text bytes equal to the
 * clipboard's UTF-8 bytes on every launch path. The JXA writer decodes UTF-8
 * itself and needs no locale.
 */
const UTF8_ENV = { ...process.env, LC_ALL: 'en_US.UTF-8' };

/**
 * Run pbpaste and return the `[range.offset, range.offset + range.limit)`
 * byte window plus the stream's total size — pbpaste has no native range
 * support, so this streams its stdout through `collectByteWindow` rather than
 * buffering the whole output before slicing.
 */
function runPbpasteWindow(range: ByteRange): Promise<{ totalByteSize: number; window: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbpaste', [], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: UTF8_ENV,
    });
    const windowPromise = collectByteWindow(child.stdout, range);
    child.on('close', (code) => {
      windowPromise.then(
        (result) => (code === 0 ? resolve(result) : reject(new Error(`pbpaste exited ${code}`))),
        reject,
      );
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
  if (uti === 'public.html' || uti === 'NSHTMLPboardType') return 'html';
  if (
    uti === 'public.rtf' ||
    uti === 'com.apple.flat-rtfd' ||
    uti === 'NSRTFPboardType' ||
    uti === 'NSRTFDPboardType'
  )
    return 'rtf';
  if (uti === 'public.tiff' || uti === 'public.png' || uti === 'com.apple.pict') return 'image';
  return null;
}

/** macOS clipboard backend. */
export class MacosBackend implements ClipboardBackend {
  async inspect(): Promise<InspectResult> {
    // JXA always prints a JSON array — `[]` for an empty pasteboard. Anything
    // else means the script failed, which is a reportable failure rather than
    // an empty clipboard.
    const raw = await runJxa(JXA_INSPECT);
    const entries = parseNativeTypeEntries(raw, 'macOS');

    const rawTypes: RawTypeEntry[] = entries.map((e) => ({ type: e.type, bytes: e.bytes }));
    const semanticSet = new Set<ClipboardFormat>();
    for (const e of entries) {
      const fmt = utiToFormat(e.type);
      if (fmt) semanticSet.add(fmt);
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        // pbpaste returns "" on empty clipboard, indistinguishable from a real empty string.
        // Inspect first so an empty clipboard gets a proper "not found" error.
        const inspection = await this.inspect();
        if (!inspection.availableFormats.includes('text')) {
          throw clipboardOutcome('macOS', 'text format not found on clipboard', {
            category: 'format_unavailable',
          });
        }
        const { window, totalByteSize } = await runPbpasteWindow(range);
        return { format: 'text', content: window, totalByteSize };
      }

      case 'html': {
        const { total, contentBase64 } = await runJxaRangedRead(buildJxaReadHtml(range), 'HTML');
        return {
          format: 'html',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
        };
      }

      case 'rtf': {
        const { total, contentBase64 } = await runJxaRangedRead(buildJxaReadRtf(range), 'RTF');
        return {
          format: 'rtf',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
        };
      }

      case 'image': {
        const { total, contentBase64, width, height } = await runJxaRangedRead(
          buildJxaReadImage(range),
          'Image',
        );
        return {
          format: 'image',
          content: Buffer.from(contentBase64, 'base64'),
          totalByteSize: total,
          ...(width !== undefined && { width }),
          ...(height !== undefined && { height }),
        };
      }
    }
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
