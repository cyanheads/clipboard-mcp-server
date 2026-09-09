/**
 * @fileoverview Linux Wayland clipboard backend using wl-paste/wl-copy.
 * @module services/clipboard/linux-wayland-backend
 */

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { collectByteWindow, countBytes } from './byte-window.js';
import { readPngDimensions } from './png-dimensions.js';
import type {
  ByteRange,
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
 * Run wl-paste with `args`, streaming its stdout through `consume` instead of
 * buffering it. `emptyResult` is what a "nothing is copied" non-zero exit
 * resolves to — the empty-clipboard case, not a failure.
 */
function runWlPasteStream<T>(
  args: string[],
  consume: (stdout: Readable) => Promise<T>,
  emptyResult: T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-paste', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const resultPromise = consume(child.stdout as Readable);
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      resultPromise.then((result) => {
        if (code === 0) {
          resolve(result);
          return;
        }
        const msg = Buffer.concat(err).toString('utf8').trim();
        if (msg.includes('nothing is copied')) {
          resolve(emptyResult);
        } else {
          reject(new Error(`wl-paste exited ${code}: ${msg}`));
        }
      }, reject);
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('wl-paste not found — install with: apt install wl-clipboard'));
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Run wl-paste and return the `[range.offset, range.offset + range.limit)`
 * byte window plus the stream's total size — wl-paste has no native range
 * support, so this streams stdout through `collectByteWindow` rather than
 * buffering the whole representation before slicing.
 */
function runWlPasteWindow(
  args: string[],
  range: ByteRange,
): Promise<{ totalByteSize: number; window: Buffer }> {
  return runWlPasteStream(args, (stdout) => collectByteWindow(stdout, range), {
    totalByteSize: 0,
    window: Buffer.alloc(0),
  });
}

/** Run wl-paste and count its stdout bytes without retaining any of them. */
function runWlPasteCount(args: string[]): Promise<number> {
  return runWlPasteStream(args, (stdout) => countBytes(stdout), 0);
}

/**
 * Run wl-copy with content on stdin. Uses detached mode so content persists
 * after the server moves on (Wayland clipboard is owned by the source process).
 *
 * Completion is the foreground process's own exit. Run without `--foreground`,
 * wl-copy drains stdin into a temp file, issues `set_selection`, and only once
 * that has gone through does it fork and let the process Node spawned exit 0.
 * That exit therefore proves both halves of the write; a non-zero exit, a spawn
 * failure, or a broken stdin pipe all mean the selection was never set.
 */
function runWlCopy(args: string[], content?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', args, {
      shell: false,
      stdio: [content === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
      detached: true,
    });
    const err: Buffer[] = [];
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      // Detach the backgrounded selection owner from this process's lifetime.
      child.unref();
      if (error) reject(error);
      else resolve();
    };

    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      settle(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('wl-copy not found — install with: apt install wl-clipboard')
          : error,
      );
    });
    // Without this listener a broken pipe raises an unhandled 'error' event
    // while the write promise sits pending forever.
    child.stdin?.on('error', (error: Error) => {
      settle(new Error(`wl-copy stdin write failed: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const detail = Buffer.concat(err).toString('utf8').trim();
      settle(new Error(`wl-copy exited ${code ?? signal}: ${detail}`));
    });

    // stdin is a pipe exactly when there is content to send.
    if (content !== undefined) child.stdin?.end(content);
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
          // Stream and count — clipboard_inspect is metadata-only, so the
          // representation is never retained just to report its size (#26).
          const bytes = await runWlPasteCount(['-t', mime]);
          rawTypes.push({ type: mime, bytes });
        } catch {
          // --list-types advertised this MIME type but reading it failed —
          // report the measurement as failed, not as a zero-byte payload.
          rawTypes.push({ type: mime, measurementFailed: true });
        }
      } else {
        rawTypes.push({ type: mime, bytes: 0 });
      }
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        let lastError: unknown;
        for (const mime of TEXT_MIME_TYPES) {
          try {
            const { window, totalByteSize } = await runWlPasteWindow(['-t', mime], range);
            return { format: 'text', content: window, totalByteSize };
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('wl-paste not found'))
              throw error;
            lastError = error;
          }
        }
        throw lastError;
      }
      case 'html': {
        const { window, totalByteSize } = await runWlPasteWindow(['-t', 'text/html'], range);
        if (totalByteSize === 0) throw new Error('HTML format not found on clipboard');
        return { format: 'html', content: window, totalByteSize };
      }
      case 'rtf': {
        let result: { totalByteSize: number; window: Buffer };
        try {
          result = await runWlPasteWindow(['-t', 'text/rtf'], range);
        } catch {
          result = await runWlPasteWindow(['-t', 'application/rtf'], range);
        }
        if (result.totalByteSize === 0) throw new Error('RTF format not found on clipboard');
        return { format: 'rtf', content: result.window, totalByteSize: result.totalByteSize };
      }
      case 'image': {
        const { window, totalByteSize } = await runWlPasteWindow(['-t', 'image/png'], range);
        if (totalByteSize === 0) throw new Error('Image format not found on clipboard');
        // wl-paste hands over opaque bytes with no dimension API — read them out
        // of the PNG header so Linux reads carry what macOS and Windows report.
        // The header only lives in the window when the window starts at byte 0.
        return {
          format: 'image',
          content: window,
          totalByteSize,
          ...(range.offset === 0 ? readPngDimensions(window) : {}),
        };
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

  async clear(): Promise<void> {
    // wl-copy --clear reads no stdin and exits as soon as the empty selection
    // is set; copying an empty payload would leave an owned representation.
    await runWlCopy(['--clear']);
  }
}
