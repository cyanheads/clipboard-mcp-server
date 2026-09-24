/**
 * @fileoverview Linux Wayland clipboard backend using wl-paste/wl-copy.
 * @module services/clipboard/linux-wayland-backend
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

const PLATFORM = 'Linux Wayland';

const TEXT_MIME_TYPES: readonly string[] = [
  'text/plain',
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'TEXT',
  'STRING',
];

/** MIME types each semantic format is read from, in preference order. */
const FORMAT_MIME_TYPES: Record<ClipboardFormat, readonly string[]> = {
  text: TEXT_MIME_TYPES,
  html: ['text/html'],
  rtf: ['text/rtf', 'application/rtf'],
  image: ['image/png'],
};

const INSTALL_HINT =
  'Install wl-clipboard (apt install wl-clipboard on Debian/Ubuntu, pacman -S wl-clipboard on Arch, dnf install wl-clipboard on Fedora), then retry.';

const SESSION_HINT =
  'Run the server inside the Wayland desktop session so WAYLAND_DISPLAY (with XDG_RUNTIME_DIR) names a running compositor socket, then retry.';

/** Map MIME type → semantic format. */
function mimeToFormat(mime: string): ClipboardFormat | null {
  if (TEXT_MIME_TYPES.includes(mime)) return 'text';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/rtf' || mime === 'application/rtf') return 'rtf';
  if (mime === 'image/png') return 'image';
  return null;
}

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

/** Linux Wayland clipboard backend using wl-paste/wl-copy. */
export class LinuxWaylandBackend implements ClipboardBackend {
  /** Only recognized MIME types are read to measure them; the rest are listed without a size. */
  async inspect(): Promise<InspectResult> {
    const rawTypes: RawTypeEntry[] = [];
    for (const mime of await listTypes()) {
      if (!mimeToFormat(mime)) {
        rawTypes.push({ type: mime });
        continue;
      }
      try {
        // Stream and count — clipboard_inspect is metadata-only, so the
        // representation is never retained just to report its size (#26).
        const bytes = await runWlPasteStream(payloadArgs(mime), countBytes);
        rawTypes.push({ type: mime, bytes });
      } catch {
        rawTypes.push({ type: mime, measurementFailed: true });
      }
    }
    return buildInspectResult(rawTypes, mimeToFormat);
  }

  /**
   * Presence is decided from `--list-types`; a listed representation is read
   * as-is, so a zero-byte one is an empty success rather than an absent one.
   */
  async read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult> {
    const offered = await listTypes();
    if (offered.length === 0) {
      throw clipboardOutcome(PLATFORM, 'The clipboard is empty.', { category: 'empty' });
    }
    const candidates = FORMAT_MIME_TYPES[format].filter((mime) => offered.includes(mime));
    if (candidates.length === 0) {
      throw clipboardOutcome(
        PLATFORM,
        `No ${format} representation on the clipboard (offered: ${offered.join(', ')}).`,
        { category: 'format_unavailable' },
      );
    }

    let lastError: unknown;
    for (const mime of candidates) {
      try {
        // Every read streams the whole representation, so hashing it on the way
        // through identifies the value the window was cut from.
        const { window, totalByteSize, sha256 } = await runWlPasteStream(
          payloadArgs(mime),
          (stdout) => collectHashedByteWindow(stdout, range),
        );
        // wl-paste hands over opaque bytes with no dimension API — read them out
        // of the PNG header so Linux reads carry what macOS and Windows report.
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
