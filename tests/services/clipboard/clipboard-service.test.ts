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
  clear: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const read =
    opts.read instanceof Error
      ? vi.fn().mockRejectedValue(opts.read)
      : vi
          .fn()
          .mockResolvedValue(
            opts.read && { totalByteSize: opts.read.content.byteLength, ...opts.read },
          );
  return {
    clear: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn(),
    read,
    write: vi.fn().mockResolvedValue(opts.write),
  } as unknown as ClipboardBackend & {
    clear: ReturnType<typeof vi.fn>;
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

  it('probes wl-copy alongside wl-paste before selecting Wayland (#21)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('DISPLAY', '');
    mockToolAvailable();

    await initService();

    expect(mockExecFile).toHaveBeenCalledWith('which', ['wl-copy'], expect.any(Function));
  });

  it.each([['wl-paste'], ['wl-copy']])(
    'refuses a Wayland session missing %s, with install guidance',
    async (missing) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
      vi.stubEnv('DISPLAY', '');
      mockExecFile.mockImplementation((_file, args, callback) => {
        const error = args?.[0] === missing ? new Error('missing') : null;
        (callback as (error: Error | null, stdout: string, stderr: string) => void)(error, '', '');
        return {} as ReturnType<typeof execFile>;
      });

      await expect(initService()).rejects.toMatchObject({
        message: expect.stringContaining(`${missing} not found`),
        data: {
          session: 'wayland',
          recovery: { hint: expect.stringContaining('apt install wl-clipboard') },
        },
      });
    },
  );

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
    expect(backend.read).toHaveBeenCalledWith('text', {
      offset: 0,
      limit: SIZE_LIMITS.READ_TEXT + 1,
    });
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

describe('ClipboardService.clear (#24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to the backend and reports a zero-byte cleared result', async () => {
    const backend = fakeBackend({ write: { format: 'text', byteSize: 0 } });
    const svc = new ClipboardService(backend);

    const result = await svc.clear(createMockContext());

    expect(result).toMatchObject({ byteSize: 0, cleared: true });
    expect(backend.clear).toHaveBeenCalledTimes(1);
    expect(backend.write).not.toHaveBeenCalled();
  });

  it('returns the plain text that was on the clipboard before the clear', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from('the old note') },
      write: { format: 'text', byteSize: 0 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.clear(createMockContext());

    expect(result).toEqual({ byteSize: 0, cleared: true, previousContent: 'the old note' });
  });

  it('reads the prior contents before clearing them', async () => {
    const order: string[] = [];
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.from('old') },
      write: { format: 'text', byteSize: 0 },
    });
    backend.read.mockImplementation(async () => {
      order.push('read');
      return { format: 'text' as const, content: Buffer.from('old') };
    });
    backend.clear.mockImplementation(async () => {
      order.push('clear');
    });
    const svc = new ClipboardService(backend);

    await svc.clear(createMockContext());

    expect(order).toEqual(['read', 'clear']);
  });

  it('clears a clipboard holding only an image, with no previousContent', async () => {
    const backend = fakeBackend({
      read: new Error('text format not found on clipboard'),
      write: { format: 'text', byteSize: 0 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.clear(createMockContext());

    expect(result).toEqual({ byteSize: 0, cleared: true });
    expect(backend.clear).toHaveBeenCalledTimes(1);
  });

  it('omits previousContent when the prior text was empty', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.alloc(0) },
      write: { format: 'text', byteSize: 0 },
    });
    const svc = new ClipboardService(backend);

    await expect(svc.clear(createMockContext())).resolves.not.toHaveProperty('previousContent');
  });

  it('omits previousContent when the prior text exceeded the read size limit', async () => {
    const backend = fakeBackend({
      read: { format: 'text', content: Buffer.alloc(SIZE_LIMITS.READ_TEXT + 1, 'a') },
      write: { format: 'text', byteSize: 0 },
    });
    const svc = new ClipboardService(backend);

    const result = await svc.clear(createMockContext());

    expect(result).toEqual({ byteSize: 0, cleared: true });
  });

  it('propagates a backend clear failure', async () => {
    const backend = fakeBackend({ write: { format: 'text', byteSize: 0 } });
    backend.clear.mockRejectedValueOnce(new Error('xsel exited 1: cannot open display'));
    const svc = new ClipboardService(backend);

    await expect(svc.clear(createMockContext())).rejects.toThrow('xsel exited 1');
  });
});

describe('ClipboardService.read — bounded ranged reads (#7)', () => {
  /** A backend that honors the range the way the real ones do: slice + true total. */
  function slicingBackend(full: Buffer, format: 'text' | 'image' = 'text') {
    const read = vi
      .fn()
      .mockImplementation(async (_format: string, range: { offset: number; limit: number }) => ({
        format,
        content: full.subarray(range.offset, range.offset + range.limit),
        totalByteSize: full.byteLength,
      }));
    return {
      backend: {
        clear: vi.fn(),
        inspect: vi.fn(),
        read,
        write: vi.fn(),
      } as unknown as ClipboardBackend,
      read,
    };
  }

  it('unranged: requests limit + 1 bytes and throws content_too_large from the total, not the buffer', async () => {
    const { backend, read } = slicingBackend(Buffer.alloc(SIZE_LIMITS.READ_TEXT + 10, 'a'));
    const svc = new ClipboardService(backend);

    await expect(svc.read('text', createMockContext())).rejects.toMatchObject({
      _contentTooLarge: true,
      bytes: SIZE_LIMITS.READ_TEXT + 10,
      limit: SIZE_LIMITS.READ_TEXT,
    });
    expect(read).toHaveBeenCalledWith('text', { offset: 0, limit: SIZE_LIMITS.READ_TEXT + 1 });
  });

  it('unranged: content within the limit is one complete slice', async () => {
    const { backend } = slicingBackend(Buffer.from('hello world'));
    const result = await new ClipboardService(backend).read('text', createMockContext());
    expect(result).toEqual({
      format: 'text',
      content: Buffer.from('hello world'),
      byteSize: 11,
      totalByteSize: 11,
      complete: true,
    });
  });

  it('ranged: first, middle, and exact-boundary final slices carry continuation metadata', async () => {
    const full = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
    const svc = new ClipboardService(slicingBackend(full).backend);
    const ctx = createMockContext();

    const first = await svc.read('text', ctx, { offset: 0, limit: 8 });
    expect(first.content.toString()).toBe('01234567');
    expect(first).toMatchObject({ byteSize: 8, totalByteSize: 20, complete: false, nextOffset: 8 });

    const middle = await svc.read('text', ctx, { offset: first.nextOffset ?? 0, limit: 8 });
    expect(middle.content.toString()).toBe('89ABCDEF');
    expect(middle).toMatchObject({ complete: false, nextOffset: 16 });

    const last = await svc.read('text', ctx, { offset: middle.nextOffset ?? 0, limit: 4 });
    expect(last.content.toString()).toBe('GHIJ');
    expect(last.complete).toBe(true);
    expect(last).not.toHaveProperty('nextOffset');
  });

  it('ranged: an offset at or past the end is an empty, complete slice with the real total', async () => {
    const svc = new ClipboardService(slicingBackend(Buffer.from('abc')).backend);
    for (const offset of [3, 999]) {
      const result = await svc.read('text', createMockContext(), { offset, limit: 8 });
      expect(result).toEqual({
        format: 'text',
        content: Buffer.alloc(0),
        byteSize: 0,
        totalByteSize: 3,
        complete: true,
      });
    }
  });

  it('ranged: never splits a UTF-8 sequence and reassembles byte-identically', async () => {
    const original = Buffer.from('aé😀b', 'utf8'); // 1 + 2 + 4 + 1 = 8 bytes
    const svc = new ClipboardService(slicingBackend(original).backend);
    const ctx = createMockContext();
    const pieces: Buffer[] = [];
    const offsets: number[] = [];
    let offset = 0;
    for (;;) {
      const slice = await svc.read('text', ctx, { offset, limit: 4 });
      expect(slice.content.toString('utf8')).not.toContain('�');
      pieces.push(slice.content);
      offsets.push(offset);
      if (slice.complete) break;
      expect(slice.nextOffset).toBeGreaterThan(offset);
      offset = slice.nextOffset ?? offset;
    }
    // 'aé' | '😀' | 'b' — the 4-byte emoji is held back from the first window.
    expect(offsets).toEqual([0, 3, 7]);
    expect(Buffer.concat(pieces).equals(original)).toBe(true);
  });

  it('ranged: never throws content_too_large and clamps limit to the format size limit', async () => {
    const { backend, read } = slicingBackend(Buffer.alloc(SIZE_LIMITS.READ_TEXT + 10, 'a'));
    const svc = new ClipboardService(backend);
    const result = await svc.read('text', createMockContext(), {
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(read).toHaveBeenCalledWith('text', { offset: 0, limit: SIZE_LIMITS.READ_TEXT });
    expect(result.byteSize).toBe(SIZE_LIMITS.READ_TEXT);
    expect(result).toMatchObject({
      totalByteSize: SIZE_LIMITS.READ_TEXT + 10,
      complete: false,
      nextOffset: SIZE_LIMITS.READ_TEXT,
    });
  });

  it('ranged image: bytes are sliced raw, never trimmed as UTF-8', async () => {
    // 0x80-0xBF look like UTF-8 continuation bytes; an image window must keep them.
    const full = Buffer.from([0x89, 0x50, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85]);
    const svc = new ClipboardService(slicingBackend(full, 'image').backend);
    const slice = await svc.read('image', createMockContext(), { offset: 2, limit: 4 });
    expect([...slice.content]).toEqual([0x80, 0x81, 0x82, 0x83]);
    expect(slice).toMatchObject({ byteSize: 4, totalByteSize: 8, complete: false, nextOffset: 6 });
  });
});
