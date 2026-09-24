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
import { requestedType, scriptedSpawn } from './scripted-spawn.js';

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
  Object.assign(stderrEmitter, { destroy: vi.fn() });
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
    child.emit('exit', opts.exitCode ?? 0, null);
    child.emit('close', opts.exitCode ?? 0, null);
  });

  return child;
}

/** A TARGETS listing offering `targets` — what every read consults first. */
function targets(...offered: string[]) {
  return fakeChild({ stdout: `TARGETS\n${offered.join('\n')}\n` });
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
      mockSpawn
        .mockReturnValueOnce(targets('UTF8_STRING'))
        .mockReturnValueOnce(fakeChild({ stdout: 'clipboard text' }));
      const result = await backend.read('text', FULL);
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('clipboard text');
      const [cmd, args] = mockSpawn.mock.calls[1] as [string, string[]];
      expect(cmd).toBe('xclip');
      expect(args).toContain('-t');
      expect(args).toContain('UTF8_STRING');
    });

    it('keeps UTF8_STRING as the first text read target', async () => {
      mockSpawn
        .mockReturnValueOnce(targets('STRING', 'UTF8_STRING', 'text/plain'))
        .mockReturnValueOnce(fakeChild({ stdout: 'primary text' }));

      await backend.read('text', FULL);

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn).toHaveBeenLastCalledWith(
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
        mockSpawn.mockReturnValueOnce(targets(...fallbackOrder));
        for (let index = 0; index < targetIndex; index += 1) {
          mockSpawn.mockReturnValueOnce(
            fakeChild({
              exitCode: 1,
              stderr: `Error: target ${fallbackOrder[index]} not available`,
            }),
          );
        }
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: `${target} content` }));

        const result = await backend.read('text', FULL);

        expect(result.content.toString('utf8')).toBe(`${target} content`);
        expect(mockSpawn.mock.calls.map(([, args]) => (args as string[]).at(-1))).toEqual([
          'TARGETS',
          ...fallbackOrder.slice(0, targetIndex + 1),
        ]);
      },
    );

    it('reads html via xclip with text/html target', async () => {
      mockSpawn
        .mockReturnValueOnce(targets('text/html'))
        .mockReturnValueOnce(fakeChild({ stdout: '<html>test</html>' }));
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
    });

    it('reads image/png via xclip and reports its dimensions', async () => {
      mockSpawn
        .mockReturnValueOnce(targets('image/png'))
        .mockReturnValueOnce(fakeChild({ stdout: REAL_PNG_13x7 }));
      const result = await backend.read('image', FULL);
      expect(result.format).toBe('image');
      expect(result.content).toEqual(REAL_PNG_13x7);
      expect(result.width).toBe(13);
      expect(result.height).toBe(7);
    });

    it('returns the bytes without dimensions when the PNG capture is truncated', async () => {
      const truncated = REAL_PNG_13x7.subarray(0, 16);
      mockSpawn
        .mockReturnValueOnce(targets('image/png'))
        .mockReturnValueOnce(fakeChild({ stdout: truncated }));

      const result = await backend.read('image', FULL);

      expect(result.content).toEqual(truncated);
      expect(result.width).toBeUndefined();
      expect(result.height).toBeUndefined();
    });

    it('throws format_unavailable when TARGETS does not list html', async () => {
      mockSpawn.mockReturnValueOnce(targets('UTF8_STRING'));
      await expect(backend.read('html', FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
        message: expect.stringMatching(/No html representation/),
      });
    });
  });

  describe('write()', () => {
    it('writes text via xclip with content on stdin', async () => {
      const fake = scriptedSpawn(() => ({ forks: true }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      const result = await backend.write('hello', 'text');
      expect(result.format).toBe('text');
      expect(result.byteSize).toBe(Buffer.byteLength('hello', 'utf8'));
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('xclip');
      expect(args).toContain('-i');
      // Content type from validated enum, not user input
      expect(args).toContain('UTF8_STRING');
      expect(fake.calls[0]?.stdin?.toString('utf8')).toBe('hello');
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
        const fake = scriptedSpawn(() => ({ forks: true }));
        mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

        await backend.write(payload, 'text');
        expect(fake.calls[0]?.stdin?.toString('utf8')).toBe(payload);
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
    mockSpawn
      .mockReturnValueOnce(targets('UTF8_STRING'))
      .mockReturnValueOnce(
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
    mockSpawn
      .mockReturnValueOnce(targets('image/png'))
      .mockReturnValueOnce(fakeChild({ stdout: [png.subarray(0, 10), png.subarray(10)] }));
    const head = await backend.read('image', { offset: 0, limit: 24 });
    expect(head).toMatchObject({ width: 16, height: 8, totalByteSize: png.byteLength });
    expect(head.content.byteLength).toBe(24);

    mockSpawn
      .mockReturnValueOnce(targets('image/png'))
      .mockReturnValueOnce(fakeChild({ stdout: png }));
    const tail = await backend.read('image', { offset: 24, limit: 100 });
    expect(tail.width).toBeUndefined();
    expect(tail.content.equals(png.subarray(24))).toBe(true);
  });
});

describe('LinuxX11Backend — typed outcomes from xclip/xsel diagnostics (#36)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function script(fn: Parameters<typeof scriptedSpawn>[0]) {
    const fake = scriptedSpawn(fn);
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    return fake;
  }

  const NO_OWNER_LISTING = [
    ['0.13', 'Error: target TARGETS not available'],
    ['git', 'xclip: Error: There is no owner for the CLIPBOARD selection'],
  ] as const;
  const TYPE_ABSENT = [
    ['0.13', 'Error: target text/html not available'],
    [
      'git',
      "xclip: Error: 'xsel' (0x400001) cannot convert CLIPBOARD selection to target 'text/html'",
    ],
  ] as const;
  const NO_DISPLAY = [
    ['0.13', "Error: Can't open display: :98"],
    ['0.13 (unset)', "Error: Can't open display: (null)"],
    ['git', "xclip: Error: Can't open display: :98"],
    ['git (unset)', "xclip: Error: Can't open display: (null)"],
  ] as const;

  it.each(NO_OWNER_LISTING)(
    'xclip %s "%s" on TARGETS is an empty clipboard',
    async (_v, stderr) => {
      script(() => ({ exitCode: 1, stderr }));
      await expect(new LinuxX11Backend().inspect()).resolves.toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        rawTypes: [],
      });
      await expect(new LinuxX11Backend().read('text', FULL)).rejects.toMatchObject({
        category: 'empty',
      });
    },
  );

  it.each([
    ['0.13', 'Error: target STRING not available'],
    ['git', 'xclip: Error: There is no owner for the CLIPBOARD selection'],
  ])(
    'xclip %s no-owner diagnostic on a payload read (cleared after listing) is not a success',
    async (_v, stderr) => {
      script((_c, args) =>
        requestedType(args) === 'TARGETS'
          ? { stdout: 'TARGETS\nUTF8_STRING\n' }
          : { exitCode: 1, stderr },
      );
      await expect(new LinuxX11Backend().read('text', FULL)).rejects.toMatchObject({
        category: expect.stringMatching(/^(empty|format_unavailable)$/),
      });
    },
  );

  it.each(TYPE_ABSENT)(
    'xclip %s type-absent diagnostic on a listed type is format_unavailable',
    async (_v, stderr) => {
      script((_c, args) =>
        requestedType(args) === 'TARGETS'
          ? { stdout: 'TARGETS\ntext/html\n' }
          : { exitCode: 1, stderr },
      );
      await expect(new LinuxX11Backend().read('html', FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    },
  );

  it.each(NO_DISPLAY)(
    'xclip %s display diagnostic is clipboard_unavailable',
    async (_v, stderr) => {
      script(() => ({ exitCode: 1, stderr }));
      for (const call of [
        () => new LinuxX11Backend().inspect(),
        () => new LinuxX11Backend().read('html', FULL),
        () => new LinuxX11Backend().write('abc', 'text'),
      ]) {
        await expect(call()).rejects.toMatchObject({
          category: 'clipboard_unavailable',
          recoveryHint: expect.stringMatching(/DISPLAY/),
        });
      }
    },
  );

  it('xsel display diagnostic is clipboard_unavailable', async () => {
    script(() => ({
      exitCode: 1,
      stderr: "xsel: Can't open display: (null)\n: Connection refused",
    }));
    await expect(new LinuxX11Backend().clear()).rejects.toMatchObject({
      category: 'clipboard_unavailable',
      recoveryHint: expect.stringMatching(/DISPLAY/),
    });
  });

  it.each([
    ['xclip', () => new LinuxX11Backend().inspect(), /apt install xclip/],
    ['xclip', () => new LinuxX11Backend().write('abc', 'html'), /apt install xclip/],
    ['xsel', () => new LinuxX11Backend().clear(), /apt install xsel/],
  ] as const)(
    '%s ENOENT is clipboard_unavailable naming the install command',
    async (helper, call, hint) => {
      script((command) => (command === helper ? { errorCode: 'ENOENT' } : {}));
      await expect(call()).rejects.toMatchObject({
        category: 'clipboard_unavailable',
        recoveryHint: expect.stringMatching(hint),
      });
    },
  );

  it.each(['html', 'rtf', 'image'] as const)(
    'decides %s absence from TARGETS even though an xclip owner would serve any target',
    async (format) => {
      const fake = script((_c, args) =>
        requestedType(args) === 'TARGETS'
          ? { stdout: 'TARGETS\nUTF8_STRING\n' }
          : { stdout: 'abc' },
      );
      await expect(new LinuxX11Backend().read(format, FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
      expect(fake.calls.map((c) => requestedType(c.args))).toEqual(['TARGETS']);
    },
  );

  it('reads only the text targets TARGETS lists, in preference order', async () => {
    const fake = script((_c, args) =>
      requestedType(args) === 'TARGETS'
        ? { stdout: 'TARGETS\nSTRING\ntext/plain\n' }
        : { stdout: 'abc' },
    );
    const result = await new LinuxX11Backend().read('text', FULL);
    expect(result.content.toString('utf8')).toBe('abc');
    expect(fake.calls.map((c) => requestedType(c.args))).toEqual(['TARGETS', 'text/plain']);
  });

  it.each(['html', 'rtf', 'image'] as const)(
    'reads a present zero-byte %s as a success',
    async (format) => {
      const type = { html: 'text/html', rtf: 'text/rtf', image: 'image/png' }[format];
      script((_c, args) =>
        requestedType(args) === 'TARGETS' ? { stdout: `TARGETS\n${type}\n` } : { stdout: '' },
      );
      await expect(new LinuxX11Backend().read(format, FULL)).resolves.toMatchObject({
        format,
        totalByteSize: 0,
      });
    },
  );

  it('an unrecognized xclip failure stays an ordinary error', async () => {
    script(() => ({ exitCode: 1, stderr: 'xclip: Error: BadAlloc (insufficient resources)' }));
    const failure = new LinuxX11Backend().inspect();
    await expect(failure).rejects.toThrow('xclip exited 1: xclip: Error: BadAlloc');
    await expect(failure).rejects.not.toHaveProperty('category');
  });
});

describe('LinuxX11Backend — write settles once the selection is owned (#40)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['text', 'html'] as const)(
    'a %s write resolves when xclip exits 0 while its fork keeps the pipes open',
    async (format) => {
      const fake = scriptedSpawn(() => ({ forks: true }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      const outcome = await Promise.race([
        new LinuxX11Backend().write('<b>hi</b>', format),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
      ]);

      expect(outcome).toEqual({ format, byteSize: 9 });
      expect(fake.calls[0]?.args).toEqual([
        '-i',
        '-selection',
        'clipboard',
        '-t',
        format === 'text' ? 'UTF8_STRING' : 'text/html',
      ]);
      expect(fake.calls[0]?.stdin?.toString('utf8')).toBe('<b>hi</b>');
    },
  );

  it('xclip exiting before it drains stdin reports its own diagnostic, not the EPIPE', async () => {
    const child = fakeChild({ exitCode: 1, stderr: "Error: Can't open display: :98" });
    mockSpawn.mockReturnValueOnce(child);

    const write = new LinuxX11Backend().write('abc', 'text');
    child.stdin?.emit(
      'error',
      Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }),
    );

    await expect(write).rejects.toMatchObject({
      category: 'clipboard_unavailable',
      message: "xclip exited 1: Error: Can't open display: :98",
    });
  });

  it('a failing xclip -i still rejects with its diagnostic', async () => {
    const fake = scriptedSpawn(() => ({ exitCode: 1, stderr: 'xclip: Error: BadAlloc' }));
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    await expect(new LinuxX11Backend().write('abc', 'text')).rejects.toThrow(
      'xclip exited 1: xclip: Error: BadAlloc',
    );
  });
});
