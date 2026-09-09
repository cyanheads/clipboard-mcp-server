/**
 * @fileoverview Linux X11 clipboard backend using xclip.
 * @module services/clipboard/linux-x11-backend
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

const TEXT_TARGETS: readonly string[] = [
  'UTF8_STRING',
  'text/plain',
  'text/plain;charset=utf-8',
  'TEXT',
  'STRING',
];

/** Map MIME type (or X TARGETS entry) → semantic format. */
function mimeToFormat(mime: string): ClipboardFormat | null {
  if (TEXT_TARGETS.includes(mime)) return 'text';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/rtf' || mime === 'application/rtf') return 'rtf';
  if (mime === 'image/png') return 'image';
  return null;
}

/** Run xclip with the given args; optionally write stdin. Returns stdout as Buffer. */
function runXclip(args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', args, {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin) child.stdin?.end(stdin);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`xclip exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('xclip not found — install with: apt install xclip'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * xclip's wording when the CLIPBOARD selection has no owner at all — an empty
 * clipboard, not a failure. It exits non-zero either way, so the message is
 * what separates the two.
 */
const NO_OWNER_PATTERN = /there is no owner for the .* selection/i;

/**
 * Run xclip with `args`, streaming its stdout through `consume` instead of
 * buffering it — `consume` decides how much (if any) of the stream to retain.
 */
function runXclipStream<T>(args: string[], consume: (stdout: Readable) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const resultPromise = consume(child.stdout as Readable);
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      resultPromise.then((result) => {
        if (code !== 0) {
          reject(new Error(`xclip exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
        } else {
          resolve(result);
        }
      }, reject);
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('xclip not found — install with: apt install xclip'));
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Run xclip and return the `[range.offset, range.offset + range.limit)` byte
 * window plus the stream's total size — xclip has no native range support,
 * so this streams stdout through `collectByteWindow` rather than buffering
 * the whole representation before slicing.
 */
function runXclipWindow(
  args: string[],
  range: ByteRange,
): Promise<{ totalByteSize: number; window: Buffer }> {
  return runXclipStream(args, (stdout) => collectByteWindow(stdout, range));
}

/** Run xclip and count its stdout bytes without retaining any of them. */
function runXclipCount(args: string[]): Promise<number> {
  return runXclipStream(args, (stdout) => countBytes(stdout));
}

/**
 * Run xsel with the given args. Returns stdout as Buffer.
 *
 * xclip owns the read and write paths, but it has no way to give a selection
 * back: `xclip -i` takes ownership unconditionally, so an empty write leaves a
 * zero-byte representation that still reads as text. `xsel --clear` sets the
 * selection owner to `None`, which is what actually empties the clipboard.
 */
function runXsel(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('xsel', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`xsel exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('xsel not found — clearing the X11 clipboard needs it: apt install xsel'));
      } else {
        reject(error);
      }
    });
  });
}

/** Linux X11 clipboard backend using xclip. */
export class LinuxX11Backend implements ClipboardBackend {
  async inspect(): Promise<InspectResult> {
    // xclip -o -selection clipboard -t TARGETS lists available MIME types
    let buf: Buffer;
    try {
      buf = await runXclip(['-o', '-selection', 'clipboard', '-t', 'TARGETS']);
    } catch (error) {
      if (error instanceof Error && NO_OWNER_PATTERN.test(error.message)) {
        return { rawTypes: [], ...buildInspectFormats(new Set()) };
      }
      throw error;
    }
    const targets = buf
      .toString('utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const rawTypes: RawTypeEntry[] = [];
    const semanticSet = new Set<ClipboardFormat>();

    for (const target of targets) {
      const fmt = mimeToFormat(target);
      if (fmt) semanticSet.add(fmt);
      // Measure size by reading the content for each known semantic type
      // We only read for recognized MIME types to limit latency
      if (
        TEXT_TARGETS.includes(target) ||
        target === 'text/html' ||
        target === 'text/rtf' ||
        target === 'application/rtf' ||
        target === 'image/png'
      ) {
        try {
          // Stream and count — clipboard_inspect is metadata-only, so the
          // representation is never retained just to report its size (#26).
          const bytes = await runXclipCount(['-o', '-selection', 'clipboard', '-t', target]);
          rawTypes.push({ type: target, bytes });
        } catch {
          // TARGETS advertised this type but reading it failed — report the
          // measurement as failed rather than as a zero-byte representation.
          rawTypes.push({ type: target, measurementFailed: true });
        }
      } else {
        rawTypes.push({ type: target, bytes: 0 });
      }
    }

    return { rawTypes, ...buildInspectFormats(semanticSet) };
  }

  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    switch (format) {
      case 'text': {
        let lastError: unknown;
        for (const target of TEXT_TARGETS) {
          try {
            const { window, totalByteSize } = await runXclipWindow(
              ['-o', '-selection', 'clipboard', '-t', target],
              range,
            );
            return { format: 'text', content: window, totalByteSize };
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('xclip not found')) throw error;
            lastError = error;
          }
        }
        throw lastError;
      }
      case 'html': {
        const { window, totalByteSize } = await runXclipWindow(
          ['-o', '-selection', 'clipboard', '-t', 'text/html'],
          range,
        );
        if (totalByteSize === 0) throw new Error('HTML format not found on clipboard');
        return { format: 'html', content: window, totalByteSize };
      }
      case 'rtf': {
        // Try text/rtf first, then application/rtf
        let result: { totalByteSize: number; window: Buffer };
        try {
          result = await runXclipWindow(['-o', '-selection', 'clipboard', '-t', 'text/rtf'], range);
        } catch {
          result = await runXclipWindow(
            ['-o', '-selection', 'clipboard', '-t', 'application/rtf'],
            range,
          );
        }
        if (result.totalByteSize === 0) throw new Error('RTF format not found on clipboard');
        return { format: 'rtf', content: result.window, totalByteSize: result.totalByteSize };
      }
      case 'image': {
        const { window, totalByteSize } = await runXclipWindow(
          ['-o', '-selection', 'clipboard', '-t', 'image/png'],
          range,
        );
        if (totalByteSize === 0) throw new Error('Image format not found on clipboard');
        // xclip hands over opaque bytes with no dimension API — read them out of
        // the PNG header so Linux reads carry what macOS and Windows report.
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
      await runXclip(['-i', '-selection', 'clipboard', '-t', 'UTF8_STRING'], buf);
      return { format: 'text', byteSize: buf.byteLength };
    }
    await runXclip(['-i', '-selection', 'clipboard', '-t', 'text/html'], buf);
    return { format: 'html', byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runXsel(['--clipboard', '--clear']);
  }
}
