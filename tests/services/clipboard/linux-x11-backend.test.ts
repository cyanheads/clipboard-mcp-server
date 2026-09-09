/**
 * @fileoverview Unit tests for LinuxX11Backend — mocks child_process.spawn.
 * @module tests/services/clipboard/linux-x11-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { REAL_PNG_13x7 } from './png-fixtures.js';

const mockSpawn = vi.mocked(spawn);

/** Full-representation range: what the service passes for an unranged read. */
const FULL = { offset: 0, limit: 8 * 1024 * 1024 } as const;

function fakeChild(opts: {
  stdout?: string | Buffer | Buffer[];
  stderr?: string;
  exitCode?: number;
  errorCode?: string;
}) {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as typeof child.stdin;
  (stdinEmitter as unknown as { end: (data?: Buffer) => void }).end = vi.fn();
  Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinEmitter });

  setImmediate(() => {
    if (opts.errorCode) {
      child.emit('error', Object.assign(new Error('spawn error'), { code: opts.errorCode }));
      return;
    }
    const chunks = Array.isArray(opts.stdout)
      ? opts.stdout
      : opts.stdout
        ? [Buffer.isBuffer(opts.stdout) ? opts.stdout : Buffer.from(opts.stdout)]
        : [];
    for (const chunk of chunks) stdoutEmitter.emit('data', chunk);
    if (opts.stderr) stderrEmitter.emit('data', Buffer.from(opts.stderr));
    stdoutEmitter.emit('end');
    child.emit('close', opts.exitCode ?? 0);
  });

  return child;
}

describe('LinuxX11Backend', () => {
  let backend: LinuxX11Backend;

  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.resetAllMocks();
  });

  describe('inspect()', () => {
    it('returns empty result when TARGETS is empty', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
    });

    it('detects text from UTF8_STRING target', async () => {
      // First call: TARGETS listing. No size reads for non-recognized types.
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\nTARGETS\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'hello world' })); // size read for UTF8_STRING
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('text');
    });

    it('detects html format', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/html\nUTF8_STRING\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: '<b>bold</b>' })) // text/html size
        .mockReturnValueOnce(fakeChild({ stdout: 'plain text' })); // UTF8_STRING size
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('html');
      expect(result.availableFormats).toContain('text');
      expect(result.primaryFormat).toBe('html');
    });

    it('advertises image when image/png is present', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'image/png\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: pngBytes }));

      const result = await backend.inspect();

      expect(result).toEqual({
        primaryFormat: 'image',
        availableFormats: ['image'],
        rawTypes: [{ type: 'image/png', bytes: pngBytes.byteLength }],
      });
    });

    it('marks a failed size measurement instead of reporting zero bytes (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\nimage/png\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'hello' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'xclip: Error: conversion failed' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'UTF8_STRING', bytes: 5 },
        { type: 'image/png', measurementFailed: true },
      ]);
      // The type is still advertised — only its size is unknown.
      expect(result.availableFormats).toEqual(['text', 'image']);
      expect(result.primaryFormat).toBe('image');
    });

    it('reports a genuine zero-length representation as bytes: 0 (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: '' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([{ type: 'UTF8_STRING', bytes: 0 }]);
      expect(result.rawTypes[0]).not.toHaveProperty('measurementFailed');
    });

    it('marks every failed measurement when several types fail (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\ntext/html\nimage/png\n' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'conversion failed' }))
        .mockReturnValueOnce(fakeChild({ stdout: '<b>ok</b>' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'conversion failed' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'UTF8_STRING', measurementFailed: true },
        { type: 'text/html', bytes: 9 },
        { type: 'image/png', measurementFailed: true },
      ]);
    });

    it('treats an unowned clipboard as an empty one', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeChild({
          exitCode: 1,
          stderr: 'xclip: Error: There is no owner for the CLIPBOARD selection',
        }),
      );

      await expect(backend.inspect()).resolves.toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        rawTypes: [],
      });
    });

    it('still surfaces an unrelated TARGETS failure', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeChild({ exitCode: 1, stderr: "xclip: Error: Can't open display: :0" }),
      );

      await expect(backend.inspect()).rejects.toThrow(/xclip exited 1/);
    });

    it.each(['image/jpeg', 'image/bmp'])(
      'retains %s in rawTypes without advertising PNG-compatible image output',
      async (type) => {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: `${type}\n` }));

        const result = await backend.inspect();

        expect(result).toEqual({
          primaryFormat: 'empty',
          availableFormats: [],
          rawTypes: [{ type, bytes: 0 }],
        });
      },
    );
  });

  describe('read()', () => {
    it('reads text via xclip with UTF8_STRING target', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'clipboard text' }));
      const result = await backend.read('text', FULL);
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('clipboard text');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('xclip');
      expect(args).toContain('-t');
      expect(args).toContain('UTF8_STRING');
    });

    it('keeps UTF8_STRING as the first text read target', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'primary text' }));

      await backend.read('text', FULL);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'xclip',
        ['-o', '-selection', 'clipboard', '-t', 'UTF8_STRING'],
        expect.any(Object),
      );
    });

    it.each(['text/plain', 'text/plain;charset=utf-8', 'TEXT', 'STRING'])(
      'falls back to the advertised %s text target',
      async (target) => {
        const fallbackOrder = [
          'UTF8_STRING',
          'text/plain',
          'text/plain;charset=utf-8',
          'TEXT',
          'STRING',
        ];
        const targetIndex = fallbackOrder.indexOf(target);
        for (let index = 0; index < targetIndex; index += 1) {
          mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'target not available' }));
        }
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: `${target} content` }));

        const result = await backend.read('text', FULL);

        expect(result.content.toString('utf8')).toBe(`${target} content`);
        expect(mockSpawn.mock.calls.map(([, args]) => (args as string[]).at(-1))).toEqual(
          fallbackOrder.slice(0, targetIndex + 1),
        );
      },
    );

    it('reads html via xclip with text/html target', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html>test</html>' }));
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
    });

    it('reads image/png via xclip and reports its dimensions', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: REAL_PNG_13x7 }));
      const result = await backend.read('image', FULL);
      expect(result.format).toBe('image');
      expect(result.content).toEqual(REAL_PNG_13x7);
      expect(result.width).toBe(13);
      expect(result.height).toBe(7);
    });

    it('returns the bytes without dimensions when the PNG capture is truncated', async () => {
      const truncated = REAL_PNG_13x7.subarray(0, 16);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: truncated }));

      const result = await backend.read('image', FULL);

      expect(result.content).toEqual(truncated);
      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
    });

    it('throws when html buffer is empty', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('html', FULL)).rejects.toThrow(/not found/i);
    });
  });

  describe('write()', () => {
    it('writes text via xclip with content on stdin', async () => {
      const stdinEnd = vi.fn();
      const child = fakeChild({ stdout: '' });
      Object.assign(child, { stdin: { end: stdinEnd } });
      mockSpawn.mockReturnValueOnce(child);

      const result = await backend.write('hello', 'text');
      expect(result.format).toBe('text');
      expect(result.byteSize).toBe(Buffer.byteLength('hello', 'utf8'));
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('xclip');
      expect(args).toContain('-i');
      // Content type from validated enum, not user input
      expect(args).toContain('UTF8_STRING');
    });
  });

  describe('clear() (#24)', () => {
    it('releases selection ownership with xsel rather than writing empty content', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));

      await backend.clear();

      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      // An empty xclip write would leave a zero-byte owned selection behind;
      // xsel --clear sets the selection owner to None.
      expect(cmd).toBe('xsel');
      expect(args).toEqual(['--clipboard', '--clear']);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('reports actionable guidance when xsel is missing', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));

      await expect(backend.clear()).rejects.toThrow(/xsel not found.*apt install xsel/i);
    });

    it('propagates a non-zero xsel exit', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: "xsel: Can't open display" }));

      await expect(backend.clear()).rejects.toThrow(/xsel exited 1/);
    });
  });

  describe('missing xclip detection', () => {
    it('throws informative error when xclip is not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/xclip not found/i);
    });
  });

  describe('security — injection prevention', () => {
    const INJECTION_PAYLOADS = [
      '"; $(whoami); "',
      "'; `id`; '",
      '$(cat /etc/passwd)',
      '| cat /etc/passwd',
      '\x00',
      '\n; rm -rf /',
    ];

    it.each(INJECTION_PAYLOADS)(
      'write: content goes to stdin, MIME type from enum (%s)',
      async (payload) => {
        const stdinEnd = vi.fn();
        const child = fakeChild({ stdout: '' });
        Object.assign(child, { stdin: { end: stdinEnd } });
        mockSpawn.mockReturnValueOnce(child);

        await backend.write(payload, 'text').catch(() => {
          /* ignore */
        });
        const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
        // The -t value must be a safe MIME type from enum, never user content
        const tIdx = args.indexOf('-t');
        if (tIdx >= 0) {
          const mimeArg = args[tIdx + 1];
          expect([
            'UTF8_STRING',
            'text/html',
            'text/plain',
            'text/rtf',
            'application/rtf',
            'image/png',
          ]).toContain(mimeArg);
        }
        // Payload must not appear in args
        for (const arg of args) {
          expect(arg).not.toContain('$(');
          expect(arg).not.toContain('`id`');
          expect(arg).not.toContain('whoami');
        }
      },
    );
  });
});

describe('LinuxX11Backend — streamed measurement and windows (#26, #7)', () => {
  let backend: LinuxX11Backend;
  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.clearAllMocks();
  });

  it('inspect() counts a representation delivered in many chunks without buffering it', async () => {
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(1000, 'x'));
    mockSpawn
      .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\n' }))
      .mockReturnValueOnce(fakeChild({ stdout: chunks }));
    const result = await backend.inspect();
    expect(result.rawTypes).toEqual([{ type: 'UTF8_STRING', bytes: 5000 }]);
  });

  it('read() returns only the requested window across chunk boundaries, with the true total', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({ stdout: [Buffer.from('01234'), Buffer.from('56789'), Buffer.from('ABCDE')] }),
    );
    const result = await backend.read('text', { offset: 3, limit: 8 });
    expect(result.content.toString()).toBe('3456789A');
    expect(result.totalByteSize).toBe(15);
  });

  it('read() image reports PNG dimensions only for a window starting at byte 0', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IHDR'),
      Buffer.from([0, 0, 0, 16, 0, 0, 0, 8]),
      Buffer.alloc(20, 1),
    ]);
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: [png.subarray(0, 10), png.subarray(10)] }));
    const head = await backend.read('image', { offset: 0, limit: 24 });
    expect(head).toMatchObject({ width: 16, height: 8, totalByteSize: png.byteLength });
    expect(head.content.byteLength).toBe(24);

    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: png }));
    const tail = await backend.read('image', { offset: 24, limit: 100 });
    expect(tail.width).toBeUndefined();
    expect(tail.content.equals(png.subarray(24))).toBe(true);
  });
});
