/**
 * @fileoverview Linux Wayland clipboard backend using wl-paste/wl-copy.
 * @module services/clipboard/linux-wayland-backend
 */

import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { collectByteWindow } from './byte-window.js';
import { inspectSelection, type LinuxSelection, readSelection } from './linux-selection.js';
import type {
  ByteRange,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  ReadResult,
} from './types.js';
import { clipboardOutcome, isClipboardOutcome } from './types.js';

const PLATFORM = 'Linux Wayland';

/** MIME types each semantic format is read from, in preference order. */
const FORMAT_MIME_TYPES: Record<ClipboardFormat, readonly string[]> = {
  text: ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'TEXT', 'STRING'],
  html: ['text/html'],
  rtf: ['text/rtf', 'application/rtf'],
  image: ['image/png'],
  files: ['text/uri-list'],
};

const INSTALL_HINT =
  'Install wl-clipboard (apt install wl-clipboard on Debian/Ubuntu, pacman -S wl-clipboard on Arch, dnf install wl-clipboard on Fedora), then retry.';

const SESSION_HINT =
  'Run the server inside the Wayland desktop session so WAYLAND_DISPLAY (with XDG_RUNTIME_DIR) names a running compositor socket, then retry.';

/**
 * Classify a non-zero wl-paste/wl-copy exit from its diagnostic. wl-clipboard
 * 2.1 and earlier print "No selection" / "No suitable type of content copied";
 * 2.2 and later print "Nothing is copied" / "Clipboard content is not
 * available as requested type …". A diagnostic matching neither generation
 * stays an ordinary error.
 */
function helperFailure(
  helper: 'wl-paste' | 'wl-copy',
  code: number | string | null,
  stderr: string,
): Error {
  const message = `${helper} exited ${code}: ${stderr}`;
  if (/^(?:Nothing is copied|No selection)$/m.test(stderr)) {
    return clipboardOutcome(PLATFORM, message, { category: 'empty' });
  }
  if (
    /Clipboard content is not available as requested type|No suitable type of content copied/.test(
      stderr,
    )
  ) {
    return clipboardOutcome(PLATFORM, message, { category: 'format_unavailable' });
  }
  if (/Failed to connect to a Wayland server/.test(stderr)) {
    return clipboardOutcome(PLATFORM, message, {
      category: 'clipboard_unavailable',
      recoveryHint: SESSION_HINT,
    });
  }
  return new Error(message);
}

/** Classify a spawn failure: a missing helper binary makes the clipboard unavailable. */
function spawnFailure(helper: 'wl-paste' | 'wl-copy', error: Error): Error {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return error;
  return clipboardOutcome(
    PLATFORM,
    `${helper} not found — install with: apt install wl-clipboard`,
    { category: 'clipboard_unavailable', recoveryHint: INSTALL_HINT },
    error,
  );
}

/**
 * Run wl-paste with `args`, streaming its stdout through `consume` instead of
 * buffering it — `consume` decides how much (if any) of the stream to retain.
 */
function runWlPasteStream<T>(
  args: string[],
  consume: (stdout: Readable) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-paste', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const resultPromise = consume(child.stdout as Readable);
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('close', (code) => {
      resultPromise.then((result) => {
        if (code === 0) resolve(result);
        else reject(helperFailure('wl-paste', code, Buffer.concat(err).toString('utf8').trim()));
      }, reject);
    });
    child.on('error', (error) => reject(spawnFailure('wl-paste', error)));
  });
}

/** A range covering a whole stream — for the type listing, which is always small. */
const WHOLE_STREAM: ByteRange = { offset: 0, limit: Number.MAX_SAFE_INTEGER };

/** The MIME types on offer — empty when nothing is copied. */
async function listTypes(): Promise<string[]> {
  let listing: Buffer;
  try {
    ({ window: listing } = await runWlPasteStream(['--list-types'], (stdout) =>
      collectByteWindow(stdout, WHOLE_STREAM),
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
 * Args reading one representation's exact bytes. Without `--no-newline`,
 * wl-paste appends "\n" to every type it treats as text (#35).
 */
function payloadArgs(mime: string): string[] {
  return ['--no-newline', '-t', mime];
}

/**
 * Run wl-copy with content on stdin. Uses detached mode so content persists
 * after the server moves on (Wayland clipboard is owned by the source process).
 *
 * Completion is the foreground process's own exit. Run without `--foreground`,
 * wl-copy drains stdin into a temp file, issues `set_selection`, and only once
 * that has gone through does it fork and let the process Node spawned exit 0.
 * That exit therefore proves both halves of the write; a non-zero exit, a spawn
 * failure, or a broken stdin pipe all mean the selection was never set. A
 * failed run never forks, so its outcome waits for `close`, by which point the
 * whole diagnostic has been read. A broken stdin pipe means wl-copy exited
 * before draining it — it connects to the compositor first — so its exit
 * status, not the EPIPE, says why.
 */
function runWlCopy(args: string[], content?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', args, {
      shell: false,
      stdio: [content === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
      detached: true,
    });
    const err: Buffer[] = [];
    let stdinError: Error | undefined;
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
    child.on('error', (error) => settle(spawnFailure('wl-copy', error)));
    // Without this listener a broken pipe raises an unhandled 'error' event.
    child.stdin?.on('error', (error: Error) => {
      stdinError = error;
    });
    child.on('exit', (code) => {
      if (code !== 0) return;
      settle(stdinError && new Error(`wl-copy stdin write failed: ${stdinError.message}`));
    });
    child.on('close', (code, signal) => {
      if (code === 0) return;
      settle(helperFailure('wl-copy', code ?? signal, Buffer.concat(err).toString('utf8').trim()));
    });

    // stdin is a pipe exactly when there is content to send.
    if (content !== undefined) child.stdin?.end(content);
  });
}

/** The Wayland selection offer, as wl-paste lists and reads it. */
const WAYLAND_SELECTION: LinuxSelection = {
  platform: PLATFORM,
  formatTypes: FORMAT_MIME_TYPES,
  listTypes,
  streamType: (mime, consume) => runWlPasteStream(payloadArgs(mime), consume),
};

/** Linux Wayland clipboard backend using wl-paste/wl-copy. */
export class LinuxWaylandBackend implements ClipboardBackend {
  /** Only recognized MIME types are read to measure them; the rest are listed without a size. */
  inspect(): Promise<InspectResult> {
    return inspectSelection(WAYLAND_SELECTION);
  }

  /** Presence is decided from `--list-types`, never from a read succeeding. */
  read(format: ClipboardFormat, range: ByteRange, item?: number): Promise<ReadResult> {
    return readSelection(WAYLAND_SELECTION, format, range, item);
  }

  async write(
    content: string,
    format: 'text' | 'html',
  ): Promise<{ format: 'text' | 'html'; byteSize: number }> {
    const buf = Buffer.from(content, 'utf8');
    await runWlCopy(['-t', format === 'text' ? 'text/plain' : 'text/html'], buf);
    return { format, byteSize: buf.byteLength };
  }

  async clear(): Promise<void> {
    // wl-copy --clear reads no stdin and exits as soon as the empty selection
    // is set; copying an empty payload would leave an owned representation.
    await runWlCopy(['--clear']);
  }
}
