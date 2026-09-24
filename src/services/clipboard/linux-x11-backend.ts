/**
 * @fileoverview Linux X11 clipboard backend using xclip.
 * @module services/clipboard/linux-x11-backend
 */

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { collectByteWindow, collectHashedByteWindow, countBytes } from './byte-window.js';
import { readPngDimensions } from './png-dimensions.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import { buildInspectResult, clipboardOutcome, isClipboardOutcome } from './types.js';

const PLATFORM = 'Linux X11';

const TEXT_TARGETS: readonly string[] = [
  'UTF8_STRING',
  'text/plain',
  'text/plain;charset=utf-8',
  'TEXT',
  'STRING',
];

/** X targets each semantic format is read from, in preference order. */
const FORMAT_TARGETS: Record<ClipboardFormat, readonly string[]> = {
  text: TEXT_TARGETS,
  html: ['text/html'],
  rtf: ['text/rtf', 'application/rtf'],
  image: ['image/png'],
};

const XCLIP_INSTALL_HINT =
  'Install xclip (apt install xclip on Debian/Ubuntu, pacman -S xclip on Arch, dnf install xclip on Fedora), then retry.';

const XSEL_INSTALL_HINT =
  'Clearing the X11 clipboard needs xsel alongside xclip: install it (apt install xsel on Debian/Ubuntu, pacman -S xsel on Arch, dnf install xsel on Fedora), then retry.';

const DISPLAY_HINT =
  'Run the server inside the X11 desktop session so DISPLAY names a running X server it may connect to (check XAUTHORITY too), then retry.';

/** Map MIME type (or X TARGETS entry) → semantic format. */
function mimeToFormat(mime: string): ClipboardFormat | null {
  if (TEXT_TARGETS.includes(mime)) return 'text';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/rtf' || mime === 'application/rtf') return 'rtf';
  if (mime === 'image/png') return 'image';
  return null;
}

/** The `-t` target of an xclip invocation. */
function targetOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('-t');
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Classify a non-zero xclip exit from its diagnostic. xclip 0.13 (the release
 * most distributions ship) prints "Error: target <T> not available" both when
 * nothing owns the selection and when the owner cannot convert to `T`; git
 * builds print "There is no owner for the CLIPBOARD selection" and
 * "'<owner>' (0x…) cannot convert CLIPBOARD selection to target '<T>'". An
 * owner must answer TARGETS, so a failed TARGETS request means no owner. A
 * diagnostic matching neither generation stays an ordinary error.
 */
function xclipFailure(code: number | string | null, stderr: string, target?: string): Error {
  const message = `xclip exited ${code}: ${stderr}`;
  if (/Can't open display/.test(stderr)) {
    return clipboardOutcome(PLATFORM, message, {
      category: 'clipboard_unavailable',
      recoveryHint: DISPLAY_HINT,
    });
  }
  if (/There is no owner for the \S+ selection/i.test(stderr)) {
    return clipboardOutcome(PLATFORM, message, { category: 'empty' });
  }
  if (/target \S+ not available|cannot convert \S+ selection to target/.test(stderr)) {
    return clipboardOutcome(PLATFORM, message, {
      category: target === 'TARGETS' ? 'empty' : 'format_unavailable',
    });
  }
  return new Error(message);
}

/** Classify a spawn failure: a missing helper binary makes the clipboard unavailable. */
function spawnFailure(helper: 'xclip' | 'xsel', error: Error): Error {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return error;
  return helper === 'xclip'
    ? clipboardOutcome(
        PLATFORM,
        'xclip not found — install with: apt install xclip',
        { category: 'clipboard_unavailable', recoveryHint: XCLIP_INSTALL_HINT },
        error,
      )
    : clipboardOutcome(
        PLATFORM,
        'xsel not found — clearing the X11 clipboard needs it: apt install xsel',
        { category: 'clipboard_unavailable', recoveryHint: XSEL_INSTALL_HINT },
        error,
      );
}

/**
 * Run `xclip -o` with `args`, streaming its stdout through `consume` instead
 * of buffering it — `consume` decides how much (if any) of the stream to retain.
 */
function runXclipStream<T>(args: string[], consume: (stdout: Readable) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const resultPromise = consume(child.stdout as Readable);
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      resultPromise.then((result) => {
        if (code === 0) resolve(result);
        else reject(xclipFailure(code, Buffer.concat(err).toString('utf8').trim(), targetOf(args)));
      }, reject);
    });
    child.on('error', (error) => reject(spawnFailure('xclip', error)));
  });
}

/**
 * Run `xclip -i` with `content` on stdin, resolving once xclip owns the
 * selection (#40). xclip takes ownership, then forks a background process
 * that keeps serving the selection until another client claims it — and that
 * process inherits the stdio pipes, so `close` would not fire until then. The
 * foreground process's exit 0 is the completion signal instead, as for wl-copy.
 * A failed run never forks, so its outcome waits for `close`, by which point
 * the whole diagnostic has been read.
 */
function runXclipInput(args: string[], content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', args, { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    let stdinError: Error | undefined;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => settle(spawnFailure('xclip', error)));
    // xclip closing stdin early means it exited early; its exit status says why.
    child.stdin?.on('error', (error: Error) => {
      stdinError = error;
    });
    child.on('exit', (code) => {
      if (code !== 0) return;
      settle(stdinError && new Error(`xclip stdin write failed: ${stdinError.message}`));
      // Release this end of the pipe the forked owner still holds.
      child.stderr?.destroy();
    });
    child.on('close', (code, signal) => {
      if (code === 0) return;
      settle(
        xclipFailure(code ?? signal, Buffer.concat(err).toString('utf8').trim(), targetOf(args)),
      );
    });

    child.stdin?.end(content);
  });
}

/** A range covering a whole stream — for the TARGETS listing, which is always small. */
const WHOLE_STREAM: ByteRange = { offset: 0, limit: Number.MAX_SAFE_INTEGER };

/** The targets the selection owner offers — empty when nothing owns it. */
async function listTargets(): Promise<string[]> {
  let listing: Buffer;
  try {
    ({ window: listing } = await runXclipStream(
      ['-o', '-selection', 'clipboard', '-t', 'TARGETS'],
      (stdout) => collectByteWindow(stdout, WHOLE_STREAM),
    ));
  } catch (error) {
    if (isClipboardOutcome(error) && error.category === 'empty') return [];
    throw error;
  }
  return listing
    .toString('utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run xsel with the given args.
 *
 * xclip owns the read and write paths, but it has no way to give a selection
 * back: `xclip -i` takes ownership unconditionally, so an empty write leaves a
 * zero-byte representation that still reads as text. `xsel --clear` sets the
 * selection owner to `None`, which is what actually empties the clipboard.
 */
function runXsel(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('xsel', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = Buffer.concat(err).toString('utf8').trim();
      const message = `xsel exited ${code}: ${stderr}`;
      reject(
        /Can't open display/.test(stderr)
          ? clipboardOutcome(PLATFORM, message, {
              category: 'clipboard_unavailable',
              recoveryHint: DISPLAY_HINT,
            })
          : new Error(message),
      );
    });
    child.on('error', (error) => reject(spawnFailure('xsel', error)));
  });
}

/** Linux X11 clipboard backend using xclip. */
export class LinuxX11Backend implements ClipboardBackend {
  /**
   * Only recognized targets are converted to measure them: converting an
   * ICCCM side-effect target (`DELETE`) or a parameterized one (`MULTIPLE`) is
   * unsafe, so every other target is listed without a size.
   */
  async inspect(): Promise<InspectResult> {
    const rawTypes: RawTypeEntry[] = [];
    for (const target of await listTargets()) {
      if (!mimeToFormat(target)) {
        rawTypes.push({ type: target });
        continue;
      }
      try {
        // Stream and count — clipboard_inspect is metadata-only, so the
        // representation is never retained just to report its size (#26).
        const bytes = await runXclipStream(
          ['-o', '-selection', 'clipboard', '-t', target],
          countBytes,
        );
        rawTypes.push({ type: target, bytes });
      } catch {
        rawTypes.push({ type: target, measurementFailed: true });
      }
    }
    return buildInspectResult(rawTypes, mimeToFormat);
  }

  /**
   * Presence is decided from TARGETS, never from a conversion succeeding: an
   * `xclip`-owned selection — the state this backend's own writes leave —
   * answers any requested target with its one buffer. A listed representation
   * is read as-is, so a zero-byte one is an empty success.
   */
  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    const offered = await listTargets();
    if (offered.length === 0) {
      throw clipboardOutcome(PLATFORM, 'The clipboard is empty.', { category: 'empty' });
    }
    const candidates = FORMAT_TARGETS[format].filter((target) => offered.includes(target));
    if (candidates.length === 0) {
      throw clipboardOutcome(
        PLATFORM,
        `No ${format} representation on the clipboard (offered: ${offered.join(', ')}).`,
        { category: 'format_unavailable' },
      );
    }

    let lastError: unknown;
    for (const target of candidates) {
      try {
        // Every read streams the whole representation, so hashing it on the way
        // through identifies the value the window was cut from.
        const { window, totalByteSize, sha256 } = await runXclipStream(
          ['-o', '-selection', 'clipboard', '-t', target],
          (stdout) => collectHashedByteWindow(stdout, range),
        );
        // xclip hands over opaque bytes with no dimension API — read them out of
        // the PNG header so Linux reads carry what macOS and Windows report.
        // The header only lives in the window when the window starts at byte 0.
        const dimensions =
          format === 'image' && range.offset === 0 ? readPngDimensions(window) : {};
        return { format, content: window, totalByteSize, revision: sha256, ...dimensions };
      } catch (error) {
        if (isClipboardOutcome(error) && error.category === 'clipboard_unavailable') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async write(
    content: string,
    format: 'text' | 'html',
  ): Promise<{ format: 'text' | 'html'; byteSize: number }> {
    const buf = Buffer.from(content, 'utf8');
    const target = format === 'text' ? 'UTF8_STRING' : 'text/html';
    await runXclipInput(['-i', '-selection', 'clipboard', '-t', target], buf);
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    await runXsel(['--clipboard', '--clear']);
  }
}
