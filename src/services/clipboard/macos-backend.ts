/**
 * @fileoverview macOS clipboard backend using pbcopy/pbpaste (text) and JXA/NSPasteboard (rich types).
 * @module services/clipboard/macos-backend
 */

import { spawn } from 'node:child_process';
import { assertByteRange, collectByteWindow } from './byte-window.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import { buildInspectFormats, parseNativeTypeEntries, stripHtmlTags } from './types.js';

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
if (types && types.count > 0) {
  for (let i = 0; i < types.count; i++) {
    const t = ObjC.unwrap(types.objectAtIndex(i));
    const data = pb.dataForType(t);
    const bytes = data && data.length ? Number(data.length) : 0;
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
 * Envelope every ranged JXA read script prints: `present` mirrors whether the
 * type exists on the pasteboard at all, `total` is the full representation's
 * byte size, and `contentBase64` is only the `[offset, offset + limit)`
 * window — the JXA process holds the full representation in its own memory
 * (unavoidable — that's how NSPasteboard works), but Node never receives more
 * than the requested window.
 */
interface JxaRangedReadEnvelope {
  contentBase64?: string;
  height?: number;
  present: boolean;
  total?: number;
  width?: number;
}

/** Clamp-and-slice snippet shared by every ranged JXA read script, given an NSData-ish `dataVar`. */
function jxaSliceSnippet(dataVar: string, range: ByteRange, extraFields = ''): string {
  return `
const total = Number(${dataVar}.length);
const offset = ${range.offset};
const sliceLen = Math.max(0, Math.min(${range.limit}, total - offset));
const slice = offset <= total
  ? ${dataVar}.subdataWithRange({ location: offset, length: sliceLen })
  : $.NSData.alloc.initWithLength(0);
const b64 = ObjC.unwrap(slice.base64EncodedStringWithOptions(0));
JSON.stringify({ present: true, total: total, contentBase64: b64${extraFields} });
`;
}

/**
 * JXA script builder for reading HTML from the pasteboard, bounded to `range`.
 * Emits a `JxaRangedReadEnvelope`. The HTML string is re-encoded as UTF-8 so
 * the byte range the service trims to UTF-8 boundaries matches this response.
 */
function buildJxaReadHtml(range: ByteRange): string {
  assertByteRange(range);
  return `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const html = pb.stringForType($.NSPasteboardTypeHTML);
if (!html) {
  JSON.stringify({ present: false });
} else {
  const data = html.dataUsingEncoding($.NSUTF8StringEncoding);
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
let data = pb.dataForType(rtfType);
if (!data || !data.length) data = pb.dataForType(publicRtf);
if (!data || !data.length) {
  const s = pb.stringForType(publicRtf);
  const sv = s ? ObjC.unwrap(s) : null;
  data = sv != null ? $.NSString.alloc.initWithString(sv).dataUsingEncoding($.NSUTF8StringEncoding) : null;
}
if (!data) {
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
  if (d && d.length) { imgData = d; break; }
}
if (!imgData) {
  JSON.stringify({ present: false });
} else {
  const img = $.NSImage.alloc.initWithData(imgData);
  if (!img || !img.isValid) {
    JSON.stringify({ present: false });
  } else {
    const rep = $.NSBitmapImageRep.imageRepWithData(imgData);
    if (!rep) {
      JSON.stringify({ present: false });
    } else {
      const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, {});
      if (!pngData || !pngData.length) {
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
 * JXA script for writing HTML + plain-text fallback to the pasteboard.
 * Receives both representations as JSON-quoted base64 literals so raw user content
 * is never interpolated into the script source.
 */
function buildJxaWriteHtml(htmlBase64: string, plaintextBase64: string): string {
  // Values are base64-encoded bytes passed as literals — no user content in script source.
  return `
ObjC.import('AppKit');
const htmlB64 = ${JSON.stringify(htmlBase64)};
const ptB64 = ${JSON.stringify(plaintextBase64)};
const htmlData = $.NSData.alloc.initWithBase64EncodedStringOptions(htmlB64, 0);
const htmlStr = $.NSString.alloc.initWithDataEncoding(htmlData, $.NSUTF8StringEncoding);
const ptData = $.NSData.alloc.initWithBase64EncodedStringOptions(ptB64, 0);
const ptStr = $.NSString.alloc.initWithDataEncoding(ptData, $.NSUTF8StringEncoding);
const pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
pb.setStringForType(htmlStr, $.NSPasteboardTypeHTML);
pb.setStringForType(ptStr, $.NSPasteboardTypeString);
'ok';
`.trim();
}

/** Run a JXA script via osascript and return stdout as a string. */
function runJxa(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
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
 * Environment for pbpaste/pbcopy. Both transcode through the process locale, so a
 * parent with no UTF-8 locale (launchd, `env -i`, some client launchers) would make
 * pbpaste emit one byte for `é` and pbcopy store mojibake. Pinning LC_ALL keeps
 * text bytes equal to the clipboard's UTF-8 bytes on every launch path.
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

/** Run a ranged JXA read script and decode its `JxaRangedReadEnvelope`. */
async function runJxaRangedRead(
  script: string,
  formatName: string,
): Promise<{ contentBase64: string; height?: number; total: number; width?: number }> {
  const raw = await runJxa(script);
  const parsed = JSON.parse(raw) as JxaRangedReadEnvelope;
  if (!parsed.present) throw new Error(`${formatName} format not found on clipboard`);
  if (typeof parsed.total !== 'number' || typeof parsed.contentBase64 !== 'string') {
    throw new Error(`Invalid JXA response while reading ${formatName}`);
  }
  return {
    total: parsed.total,
    contentBase64: parsed.contentBase64,
    ...(parsed.width !== undefined && { width: parsed.width }),
    ...(parsed.height !== undefined && { height: parsed.height }),
  };
}

/** Run pbcopy with content on stdin. */
function runPbcopy(content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: UTF8_ENV,
    });
    child.stdin.end(content);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`pbcopy exited ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
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
          throw new Error('text format not found on clipboard');
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
    if (format === 'text') {
      const buf = Buffer.from(content, 'utf8');
      await runPbcopy(buf);
      return { format: 'text', byteSize: buf.byteLength };
    }

    // HTML: write both HTML and stripped plain-text fallback via JXA
    const htmlBuf = Buffer.from(content, 'utf8');
    const plaintext = stripHtmlTags(content);
    const ptBuf = Buffer.from(plaintext, 'utf8');
    const htmlB64 = htmlBuf.toString('base64');
    const ptB64 = ptBuf.toString('base64');
    const script = buildJxaWriteHtml(htmlB64, ptB64);
    await runJxa(script);
    return { format: 'html', byteSize: htmlBuf.byteLength };
  }

  async clear(): Promise<void> {
    await runJxa(JXA_CLEAR);
  }
}
