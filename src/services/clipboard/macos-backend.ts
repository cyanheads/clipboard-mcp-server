/**
 * @fileoverview macOS clipboard backend using pbcopy/pbpaste (text) and JXA/NSPasteboard (rich types).
 * @module services/clipboard/macos-backend
 */

import { spawn } from 'node:child_process';
import type {
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import { buildInspectFormats, stripHtmlTags } from './types.js';

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
 * JXA script for reading HTML from the pasteboard.
 * Returns the raw HTML string or null if not present.
 */
const JXA_READ_HTML = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const html = pb.stringForType($.NSPasteboardTypeHTML);
html ? ObjC.unwrap(html) : 'null';
`.trim();

/**
 * JXA script for reading RTF from the pasteboard.
 * Returns base64-encoded RTF bytes or null if not present.
 */
const JXA_READ_RTF = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const rtfType = 'com.apple.flat-rtfd';
const publicRtf = 'public.rtf';
let data = pb.dataForType(rtfType);
if (!data || !data.length) data = pb.dataForType(publicRtf);
if (!data || !data.length) {
  // Try stringForType for plain RTF — unwrap first to guard against bridged nil (truthy but undefined after unwrap)
  const s = pb.stringForType(publicRtf);
  const sv = s ? ObjC.unwrap(s) : null;
  if (sv != null) {
    JSON.stringify({ type: 'string', value: sv });
  } else {
    'null';
  }
} else {
  JSON.stringify({ type: 'base64', value: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) });
}
`.trim();

/**
 * JXA script for reading an image from the pasteboard as PNG.
 * Converts TIFF to PNG via NSBitmapImageRep.
 * Returns JSON: { base64: string, width: number, height: number } or null.
 */
const JXA_READ_IMAGE = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const imgTypes = ['public.png', 'public.tiff', 'com.apple.pict'];
let imgData = null;
let imgType = null;
for (const t of imgTypes) {
  const d = pb.dataForType(t);
  if (d && d.length) { imgData = d; imgType = t; break; }
}
if (!imgData) {
  'null';
} else {
  const img = $.NSImage.alloc.initWithData(imgData);
  if (!img || !img.isValid) {
    'null';
  } else {
    const rep = $.NSBitmapImageRep.imageRepWithData(imgData);
    if (!rep) {
      'null';
    } else {
      const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, {});
      if (!pngData || !pngData.length) {
        'null';
      } else {
        const w = Math.round(ObjC.unwrap(rep.pixelsWide));
        const h = Math.round(ObjC.unwrap(rep.pixelsHigh));
        const b64 = ObjC.unwrap(pngData.base64EncodedStringWithOptions(0));
        JSON.stringify({ base64: b64, width: w, height: h });
      }
    }
  }
}
`.trim();

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

/** Run pbpaste and return stdout as a Buffer. */
function runPbpaste(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbpaste', [], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`pbpaste exited ${code}`));
      else resolve(Buffer.concat(out));
    });
    child.on('error', reject);
  });
}

/** Run pbcopy with content on stdin. */
function runPbcopy(content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
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
    const raw = await runJxa(JXA_INSPECT);
    let entries: Array<{ type: string; bytes: number }> = [];
    try {
      entries = JSON.parse(raw) as Array<{ type: string; bytes: number }>;
    } catch {
      entries = [];
    }

    const rawTypes: RawTypeEntry[] = entries.map((e) => ({ type: e.type, bytes: e.bytes }));
    const semanticSet = new Set<ClipboardFormat>();
    for (const e of entries) {
      const fmt = utiToFormat(e.type);
      if (fmt) semanticSet.add(fmt);
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        // pbpaste returns "" on empty clipboard, indistinguishable from a real empty string.
        // Inspect first so an empty clipboard gets a proper "not found" error.
        const inspection = await this.inspect();
        if (!inspection.availableFormats.includes('text')) {
          throw new Error('text format not found on clipboard');
        }
        const buf = await runPbpaste();
        return { format: 'text', content: buf };
      }

      case 'html': {
        const raw = await runJxa(JXA_READ_HTML);
        if (raw === 'null' || raw === '') {
          throw new Error('HTML format not found on clipboard');
        }
        return { format: 'html', content: Buffer.from(raw, 'utf8') };
      }

      case 'rtf': {
        const raw = await runJxa(JXA_READ_RTF);
        if (raw === 'null' || raw === '') {
          throw new Error('RTF format not found on clipboard');
        }
        const parsed = JSON.parse(raw) as { type: 'string' | 'base64'; value: string };
        const content =
          parsed.type === 'base64'
            ? Buffer.from(parsed.value, 'base64')
            : Buffer.from(parsed.value, 'utf8');
        return { format: 'rtf', content };
      }

      case 'image': {
        const raw = await runJxa(JXA_READ_IMAGE);
        if (raw === 'null' || raw === '') {
          throw new Error('Image format not found on clipboard');
        }
        const parsed = JSON.parse(raw) as { base64: string; width: number; height: number };
        const content = Buffer.from(parsed.base64, 'base64');
        return { format: 'image', content, width: parsed.width, height: parsed.height };
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
}
