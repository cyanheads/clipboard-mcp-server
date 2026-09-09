/**
 * @fileoverview ClipboardService — platform-detecting facade over backend adapters.
 * @module services/clipboard/clipboard-service
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { LinuxWaylandBackend } from './linux-wayland-backend.js';
import { LinuxX11Backend } from './linux-x11-backend.js';
import { MacosBackend } from './macos-backend.js';
import type {
  ClearResult,
  ClipboardBackend,
  ClipboardFormat,
  InspectResult,
  ReadResult,
  WriteResult,
} from './types.js';
import { WindowsBackend } from './windows-backend.js';

const execFileAsync = promisify(execFile);

/** Sentinel thrown by ClipboardService.read/write when content exceeds a size limit. */
export interface ContentTooLargeError {
  _contentTooLarge: true;
  bytes: number;
  format?: string;
  limit: number;
}

/** Type guard for ContentTooLargeError sentinels thrown by the service. */
export function isContentTooLarge(err: unknown): err is ContentTooLargeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    '_contentTooLarge' in err &&
    (err as { _contentTooLarge: unknown })._contentTooLarge === true
  );
}

/** Size limits in bytes. */
export const SIZE_LIMITS = {
  /** Max text/HTML/RTF content for reads. 512KB. */
  READ_TEXT: 512 * 1024,
  /** Max image content for reads. 5MB (raw bytes before base64 expansion). */
  READ_IMAGE: 5 * 1024 * 1024,
  /** Max content for writes. 1MB. */
  WRITE: 1 * 1024 * 1024,
} as const;

/** Check whether a CLI tool is available in PATH on POSIX platforms. */
async function toolAvailable(name: string): Promise<boolean> {
  try {
    await execFileAsync('which', [name]);
    return true;
  } catch {
    return false;
  }
}

/** Check whether a CLI tool is available in PATH on Windows. */
async function windowsToolAvailable(name: string): Promise<boolean> {
  try {
    await execFileAsync('where.exe', [name]);
    return true;
  } catch {
    return false;
  }
}

/** Detect the appropriate backend based on platform and environment. */
async function detectBackend(): Promise<ClipboardBackend> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // pbcopy/pbpaste and osascript are built-in on macOS — no detection needed.
    return new MacosBackend();
  }

  if (platform === 'linux') {
    const waylandDisplay = process.env.WAYLAND_DISPLAY;
    const xDisplay = process.env.DISPLAY;

    if (waylandDisplay) {
      // Wayland session: require both halves of wl-clipboard. Probing only the
      // read tool lets a session missing wl-copy start and fail on first write
      // with a bare ENOENT instead of this install guidance.
      const required = ['wl-paste', 'wl-copy'] as const;
      const availability = await Promise.all(required.map((tool) => toolAvailable(tool)));
      const missing = required.filter((_tool, index) => !availability[index]);
      if (missing.length > 0) {
        throw serviceUnavailable(
          `Wayland session detected but ${missing.join(' and ')} not found. Install with: apt install wl-clipboard`,
          {
            platform: 'linux',
            session: 'wayland',
            tool: 'wl-clipboard',
            missing,
            recovery: {
              hint: 'Install wl-clipboard: apt install wl-clipboard (Debian/Ubuntu) or pacman -S wl-clipboard (Arch).',
            },
          },
        );
      }
      return new LinuxWaylandBackend();
    }

    if (xDisplay) {
      // X11 session: require xclip
      const available = await toolAvailable('xclip');
      if (!available) {
        throw serviceUnavailable(
          'X11 session detected but xclip not found. Install with: apt install xclip',
          {
            platform: 'linux',
            session: 'x11',
            tool: 'xclip',
            recovery: {
              hint: 'Install xclip: apt install xclip (Debian/Ubuntu) or pacman -S xclip (Arch).',
            },
          },
        );
      }
      return new LinuxX11Backend();
    }

    throw serviceUnavailable(
      'Neither WAYLAND_DISPLAY nor DISPLAY is set — cannot determine clipboard session on Linux. Run within a desktop session.',
      {
        platform: 'linux',
        recovery: {
          hint: 'Start the server within a graphical desktop session where DISPLAY or WAYLAND_DISPLAY is set.',
        },
      },
    );
  }

  if (platform === 'win32') {
    // powershell.exe is built-in on Windows 10+
    const available =
      (await windowsToolAvailable('powershell.exe')) || (await windowsToolAvailable('powershell'));
    if (!available) {
      throw serviceUnavailable(
        'powershell.exe not found. Requires PowerShell 5.1+ (built-in on Windows 10+).',
        {
          platform: 'win32',
          recovery: {
            hint: 'Ensure PowerShell 5.1+ is available. It is built-in on Windows 10 and later.',
          },
        },
      );
    }
    return new WindowsBackend();
  }

  throw serviceUnavailable(
    `Unsupported platform: ${platform}. clipboard-mcp-server supports macOS, Linux (X11/Wayland), and Windows.`,
    {
      platform,
      recovery: { hint: 'This server supports macOS, Linux (X11/Wayland), and Windows only.' },
    },
  );
}

/**
 * Thin facade over the platform backend. Enforces size limits and provides
 * correlated logging via ctx.
 */
export class ClipboardService {
  constructor(private readonly backend: ClipboardBackend) {}

  /** Inspect clipboard types and byte sizes. */
  async inspect(ctx: Context): Promise<InspectResult> {
    ctx.log.debug('clipboard inspect');
    return await this.backend.inspect();
  }

  /**
   * Read clipboard content in the requested format.
   * Enforces size limits before returning content.
   */
  async read(format: ClipboardFormat, ctx: Context): Promise<ReadResult> {
    ctx.log.debug('clipboard read', { format });
    const result = await this.backend.read(format);
    const limit = format === 'image' ? SIZE_LIMITS.READ_IMAGE : SIZE_LIMITS.READ_TEXT;
    if (result.content.byteLength > limit) {
      throw Object.assign(new Error('content_too_large'), {
        _contentTooLarge: true,
        bytes: result.content.byteLength,
        limit,
        format,
      });
    }
    return result;
  }

  /**
   * Write content to the clipboard.
   * Enforces write size limit, and captures the prior plain text so an
   * unintended overwrite stays recoverable.
   */
  async write(content: string, format: 'text' | 'html', ctx: Context): Promise<WriteResult> {
    ctx.log.debug('clipboard write', { format, bytes: Buffer.byteLength(content, 'utf8') });
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > SIZE_LIMITS.WRITE) {
      throw Object.assign(new Error('content_too_large'), {
        _contentTooLarge: true,
        bytes,
        limit: SIZE_LIMITS.WRITE,
      });
    }

    const previousContent = await this.priorText(ctx);

    const result = await this.backend.write(content, format);
    return { ...result, ...(previousContent !== undefined && { previousContent }) };
  }

  /**
   * Remove every representation from the clipboard, capturing the prior plain
   * text first so an unintended clear stays recoverable.
   */
  async clear(ctx: Context): Promise<ClearResult> {
    ctx.log.debug('clipboard clear');
    const previousContent = await this.priorText(ctx);
    await this.backend.clear();
    return {
      byteSize: 0,
      cleared: true,
      ...(previousContent !== undefined && { previousContent }),
    };
  }

  /**
   * Best-effort read of the clipboard's current plain text.
   *
   * Goes through this.read() rather than the backend so SIZE_LIMITS.READ_TEXT
   * applies. A failed pre-read never blocks the mutation the caller asked for:
   * an empty clipboard, a clipboard with no text representation, and oversized
   * prior text all simply leave the result absent.
   */
  private async priorText(ctx: Context): Promise<string | undefined> {
    try {
      const prior = await this.read('text', ctx);
      if (prior.content.byteLength > 0) return prior.content.toString('utf8');
    } catch (err) {
      ctx.log.debug('clipboard mutation: no recoverable prior contents', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }
}

// --- Init/accessor pattern ---

let _service: ClipboardService | undefined;

export async function initClipboardService(
  _config: AppConfig,
  _storage: StorageService,
): Promise<void> {
  const backend = await detectBackend();
  _service = new ClipboardService(backend);
}

export function getClipboardService(): ClipboardService {
  if (!_service) {
    throw new Error('ClipboardService not initialized — call initClipboardService() in setup()');
  }
  return _service;
}
