/**
 * @fileoverview Linux Wayland clipboard backend using wl-paste/wl-copy.
 * @module services/clipboard/linux-wayland-backend
 */

import { spawn } from 'node:child_process';
import type {
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import { buildInspectFormats } from './types.js';

const TEXT_MIME_TYPES: readonly string[] = [
  'text/plain',
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'TEXT',
  'STRING',
];

/** Map MIME type → semantic format. */
function mimeToFormat(mime: string): ClipboardFormat | null {
  if (TEXT_MIME_TYPES.includes(mime)) return 'text';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/rtf' || mime === 'application/rtf') return 'rtf';
  if (mime === 'image/png') return 'image';
  return null;
}

/** Run wl-paste with the given args. Returns stdout as Buffer. */
function runWlPaste(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-paste', args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(err).toString('utf8').trim();
        if (msg.includes('nothing is copied')) {
          resolve(Buffer.alloc(0));
        } else {
          reject(new Error(`wl-paste exited ${code}: ${msg}`));
        }
      } else {
        resolve(Buffer.concat(out));
      }
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('wl-paste not found — install with: apt install wl-clipboard'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Run wl-copy with content on stdin. Uses detached mode so content persists
 * after the server moves on (Wayland clipboard is owned by the source process).
 */
function runWlCopy(args: string[], content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      detached: true,
    });
    child.stdin.end(content);
    // Give the process a moment to receive stdin before unreffing
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('wl-copy not found — install with: apt install wl-clipboard'));
      } else {
        reject(err);
      }
    });
    // Detach after writing stdin — content persists until overwritten
    child.on('spawn', () => {
      // Allow the process to run independently after stdin is flushed
      setTimeout(() => {
        child.unref();
        resolve();
      }, 50);
    });
  });
}

/** Linux Wayland clipboard backend using wl-paste/wl-copy. */
export class LinuxWaylandBackend implements ClipboardBackend {
  async inspect(): Promise<InspectResult> {
    // wl-paste --list-types lists available MIME types
    const buf = await runWlPaste(['--list-types']);
    const mimes = buf
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const rawTypes: RawTypeEntry[] = [];
    const semanticSet = new Set<ClipboardFormat>();

    for (const mime of mimes) {
      const fmt = mimeToFormat(mime);
      if (fmt) semanticSet.add(fmt);
      // Read each recognized MIME type to measure size
      if (
        TEXT_MIME_TYPES.includes(mime) ||
        mime === 'text/html' ||
        mime === 'text/rtf' ||
        mime === 'application/rtf' ||
        mime === 'image/png'
      ) {
        try {
          const data = await runWlPaste(['-t', mime]);
          rawTypes.push({ type: mime, bytes: data.byteLength });
        } catch {
          rawTypes.push({ type: mime, bytes: 0 });
        }
      } else {
        rawTypes.push({ type: mime, bytes: 0 });
      }
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        let lastError: unknown;
        for (const mime of TEXT_MIME_TYPES) {
          try {
            const content = await runWlPaste(['-t', mime]);
            return { format: 'text', content };
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('wl-paste not found'))
              throw error;
            lastError = error;
          }
        }
        throw lastError;
      }
      case 'html': {
        const buf = await runWlPaste(['-t', 'text/html']);
        if (buf.byteLength === 0) throw new Error('HTML format not found on clipboard');
        return { format: 'html', content: buf };
      }
      case 'rtf': {
        let buf: Buffer;
        try {
          buf = await runWlPaste(['-t', 'text/rtf']);
        } catch {
          buf = await runWlPaste(['-t', 'application/rtf']);
        }
        if (buf.byteLength === 0) throw new Error('RTF format not found on clipboard');
        return { format: 'rtf', content: buf };
      }
      case 'image': {
        const buf = await runWlPaste(['-t', 'image/png']);
        if (buf.byteLength === 0) throw new Error('Image format not found on clipboard');
        return { format: 'image', content: buf };
      }
    }
  }

  async write(
    content: string,
    format: 'text' | 'html',
  ): Promise<{ format: 'text' | 'html'; byteSize: number }> {
    const buf = Buffer.from(content, 'utf8');
    if (format === 'text') {
      await runWlCopy(['-t', 'text/plain'], buf);
      return { format: 'text', byteSize: buf.byteLength };
    }
    await runWlCopy(['-t', 'text/html'], buf);
    return { format: 'html', byteSize: buf.byteLength };
  }
}
