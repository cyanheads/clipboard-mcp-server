/**
 * @fileoverview Tests for platform-specific clipboard backend selection.
 * @module tests/services/clipboard/clipboard-service.test
 */

import { execFile } from 'node:child_process';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import {
  ClipboardService,
  getClipboardService,
  initClipboardService,
  SIZE_LIMITS,
} from '@/services/clipboard/clipboard-service.js';
import { LinuxWaylandBackend } from '@/services/clipboard/linux-wayland-backend.js';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';
import type { ClipboardBackend, ReadResult, WriteResult } from '@/services/clipboard/types.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';

const mockExecFile = vi.mocked(execFile);

function selectedBackend(): ClipboardBackend {
  return (getClipboardService() as unknown as { backend: ClipboardBackend }).backend;
}

function mockToolAvailable(): void {
  mockExecFile.mockImplementation((_file, _args, callback) => {
    (callback as (error: null, stdout: string, stderr: string) => void)(null, '', '');
    return {} as ReturnType<typeof execFile>;
  });
}

/**
 * Build a ClipboardBackend whose read/write are vi mocks. `read` may be a
 * ReadResult to resolve with or an error to reject with.
 */
function fakeBackend(opts: { read?: ReadResult | Error; write: WriteResult }): ClipboardBackend & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const read =
    opts.read instanceof Error
      ? vi.fn().mockRejectedValue(opts.read)
      : vi.fn().mockResolvedValue(opts.read);
  return {
    inspect: vi.fn(),
    read,
    write: vi.fn().mockResolvedValue(opts.write),
  } as unknown as ClipboardBackend & {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
}

async function initService(): Promise<void> {
  await initClipboardService({} as AppConfig, {} as StorageService);
}

describe('ClipboardService backend selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('selects macOS unconditionally without probing PATH', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    await initService();

    expect(selectedBackend()).toBeInstanceOf(MacosBackend);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('selects Wayland after probing wl-paste with Unix which', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('DISPLAY', '');
    mockToolAvailable();

    await initService();

    expect(selectedBackend()).toBeInstanceOf(LinuxWaylandBackend);
    expect(mockExecFile).toHaveBeenCalledWith('which', ['wl-paste'], expect.any(Function));
  });

  it('selects X11 after probing xclip with Unix which', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('DISPLAY', ':0');
    mockToolAvailable();

    await initService();

    expect(selectedBackend()).toBeInstanceOf(LinuxX11Backend);
    expect(mockExecFile).toHaveBeenCalledWith('which', ['xclip'], expect.any(Function));
  });

  it('selects Windows after finding powershell.exe with the native probe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockExecFile.mockImplementation((file, args, callback) => {
      const error =
        file === 'where.exe' && args?.[0] === 'powershell.exe' ? null : new Error('missing');
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    await initService();

    expect(selectedBackend()).toBeInstanceOf(WindowsBackend);
    expect(mockExecFile).toHaveBeenCalledWith(
      'where.exe',
      ['powershell.exe'],
      expect.any(Function),
    );
    expect(mockExecFile).not.toHaveBeenCalledWith('which', expect.anything(), expect.any(Function));
  });

  it('reports actionable guidance when the native Windows probe fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockExecFile.mockImplementation((_file, _args, callback) => {
      (callback as (error: Error, stdout: string, stderr: string) => void)(
        new Error('missing'),
        '',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    await expect(initService()).rejects.toMatchObject({
      message: 'powershell.exe not found. Requires PowerShell 5.1+ (built-in on Windows 10+).',
      data: {
        platform: 'win32',
        recovery: {
          hint: 'Ensure PowerShell 5.1+ is available. It is built-in on Windows 10 and later.',
        },
      },
    });
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      'where.exe',
      ['powershell.exe'],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'where.exe',
      ['powershell'],
      expect.any(Function),
    );
  });
});

describe('ClipboardService.write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to the backend and returns the written format and byte size', async () => {
    const backend = fakeBackend({ write: { format: 'text', byteSize: 5 } });
    const svc = new ClipboardService(backend);

    const result = await svc.write('hello', 'text', createMockContext());

    expect(result).toMatchObject({ format: 'text', byteSize: 5 });
    expect(backend.write).toHaveBeenCalledWith('hello', 'text');
  });

  it('rejects content over the write size limit before touching the backend', async () => {
    const backend = fakeBackend({ write: { format: 'text', byteSize: 0 } });
    const svc = new ClipboardService(backend);
    const oversized = 'a'.repeat(SIZE_LIMITS.WRITE + 1);

    await expect(svc.write(oversized, 'text', createMockContext())).rejects.toMatchObject({
      _contentTooLarge: true,
      bytes: SIZE_LIMITS.WRITE + 1,
      limit: SIZE_LIMITS.WRITE,
    });
    expect(backend.write).not.toHaveBeenCalled();
  });

  it('propagates a backend write failure', async () => {
    const backend = fakeBackend({ write: { format: 'text', byteSize: 0 } });
    backend.write = vi.fn().mockRejectedValue(new Error('pbcopy exited 1'));
    const svc = new ClipboardService(backend);

    await expect(svc.write('x', 'text', createMockContext())).rejects.toThrow('pbcopy exited 1');
  });
});

describe('ClipboardService.write — prior contents capture (#28)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the plain text that was on the clipboard before the write', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from('the old note') },
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result).toEqual({ format: 'text', byteSize: 3, previousContent: 'the old note' });
    expect(backend.read).toHaveBeenCalledWith('text');
  });

  it('reads the prior contents before overwriting them', async () => {
    const order: string[] = [];
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from('old') },
      write: { format: 'text', byteSize: 3 },
    });
    backend.read.mockImplementation(async () => {
      order.push('read');
      return { format: 'text' as const, content: Buffer.from('old') };
    });
    backend.write.mockImplementation(async () => {
      order.push('write');
      return { format: 'text' as const, byteSize: 3 };
    });
    const svc = new ClipboardService(backend);

    await svc.write('new', 'text', createMockContext());

    expect(order).toEqual(['read', 'write']);
  });

  it('preserves unicode and emoji in the prior contents', async () => {
    const prior = 'Hello 世界 🌍';
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from(prior, 'utf8') },
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result.previousContent).toBe(prior);
  });

  it('omits previousContent when the clipboard held no text representation', async () => {
    const backend = fakeBackend({
      read: new Error('text format not found on clipboard'),
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result).toEqual({ format: 'text', byteSize: 3 });
    expect(result).not.toHaveProperty('previousContent');
    expect(backend.write).toHaveBeenCalledWith('new', 'text');
  });

  it('omits previousContent when the prior text was empty', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.alloc(0) },
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result).not.toHaveProperty('previousContent');
  });

  it('omits previousContent when the prior text exceeded the read size limit', async () => {
    const backend = fakeBackend({
      read: {
        format: 'text',
        content: Buffer.alloc(SIZE_LIMITS.READ_TEXT + 1, 'a'),
      },
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result).toEqual({ format: 'text', byteSize: 3 });
    expect(backend.write).toHaveBeenCalledWith('new', 'text');
  });

  it('returns prior text sitting exactly at the read size limit', async () => {
    const prior = 'a'.repeat(SIZE_LIMITS.READ_TEXT);
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from(prior, 'utf8') },
      write: { format: 'text', byteSize: 3 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('new', 'text', createMockContext());

    expect(result.previousContent).toHaveLength(SIZE_LIMITS.READ_TEXT);
  });

  it('completes the write when the prior read fails unexpectedly', async () => {
    const backend = fakeBackend({
      read: new Error('pbpaste exited 1'),
      write: { format: 'html', byteSize: 12 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.write('<p>Hello</p>', 'html', createMockContext());

    expect(result).toEqual({ format: 'html', byteSize: 12 });
  });

  it('does not read the prior contents when the new content is over the write limit', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from('old') },
      write: { format: 'text', byteSize: 0 },
    });
    const svc = new ClipboardService(backend);

    await expect(
      svc.write('a'.repeat(SIZE_LIMITS.WRITE + 1), 'text', createMockContext()),
    ).rejects.toMatchObject({ _contentTooLarge: true });
    expect(backend.read).not.toHaveBeenCalled();
  });
});
