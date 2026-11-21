/**
 * @fileoverview Unit tests for LinuxX11Backend — mocks child_process.spawn.
 * @module tests/services/clipboard/linux-x11-backend.test
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';
import { REAL_PNG_13x7 } from './png-fixtures.js';
import { requestedType, scriptedSpawn } from './scripted-spawn.js';
import { URI_LIST, URI_LIST_OMITTED, URI_LIST_PATHS } from './uri-list-fixtures.js';

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
        itemCount: 1,
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
      // An unreadable representation cannot be returned by a read (#41).
      expect(result.availableFormats).toEqual(['text']);
      expect(result.primaryFormat).toBe('text');
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
        itemCount: 0,
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
          itemCount: 1,
          rawTypes: [{ type }],
        });
      },
    );

    it('omits bytes for targets it does not recognize and never converts them (#41)', async () => {
      const fake = scriptedSpawn((_c, args) =>
        requestedType(args) === 'TARGETS'
          ? {
              stdout:
                'TIMESTAMP\nMULTIPLE\nTARGETS\nDELETE\nINCR\nTEXT\nSTRING\napplication/x-probe\n',
            }
          : { stdout: 'hello' },
      );
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'TIMESTAMP' },
        { type: 'MULTIPLE' },
        { type: 'TARGETS' },
        { type: 'DELETE' },
        { type: 'INCR' },
        { type: 'TEXT', bytes: 5 },
        { type: 'STRING', bytes: 5 },
        { type: 'application/x-probe' },
      ]);
      expect(fake.calls.map((c) => requestedType(c.args))).toEqual(['TARGETS', 'TEXT', 'STRING']);
      expect(result.availableFormats).toEqual(['text']);
    });

    it('a format whose only target failed to measure is not available (#41)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'TARGETS\ntext/html\n' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'xclip: Error: conversion failed' }));

      const result = await backend.inspect();

      expect(result).toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        itemCount: 1,
        rawTypes: [{ type: 'TARGETS' }, { type: 'text/html', measurementFailed: true }],
      });
    });

    it('a format stays available when one of its targets measured and another failed (#41)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'UTF8_STRING\nSTRING\n' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'xclip: Error: conversion failed' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'abc' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'UTF8_STRING', measurementFailed: true },
        { type: 'STRING', bytes: 3 },
      ]);
      expect(result.availableFormats).toEqual(['text']);
    });
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
        itemCount: 0,
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

describe('LinuxX11Backend — streamed SHA-256 revision (#38)', () => {
  let backend: LinuxX11Backend;
  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.resetAllMocks();
  });

  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64url');
  const value = Buffer.from('AAAA1111é😀');

  /** Serve one read of `bytes`, delivered in three chunks. */
  function serve(bytes: Buffer, target = 'UTF8_STRING') {
    mockSpawn
      .mockReturnValueOnce(targets(target))
      .mockReturnValueOnce(
        fakeChild({ stdout: [bytes.subarray(0, 3), bytes.subarray(3, 9), bytes.subarray(9)] }),
      );
  }

  it.each([
    ['the whole representation', FULL],
    ['a first window', { offset: 0, limit: 4 }],
    ['a middle window spanning chunks', { offset: 2, limit: 8 }],
    ['a window past the end', { offset: 500, limit: 4 }],
  ])('%s is identified by the hash of every streamed byte', async (_label, range) => {
    serve(value);
    const result = await backend.read('text', range);
    expect(result.revision).toBe(sha256(value));
    expect(result.content.equals(value.subarray(range.offset, range.offset + range.limit))).toBe(
      true,
    );
  });

  it('a same-size replacement yields a different revision', async () => {
    serve(Buffer.from('AAAA1111'));
    const before = await backend.read('text', { offset: 0, limit: 4 });
    serve(Buffer.from('BBBB2222'));
    const after = await backend.read('text', { offset: 4, limit: 4 });
    expect(after.totalByteSize).toBe(before.totalByteSize);
    expect(after.revision).not.toBe(before.revision);
  });

  it('an image and a zero-byte representation are hashed the same way', async () => {
    serve(REAL_PNG_13x7, 'image/png');
    expect((await backend.read('image', { offset: 8, limit: 16 })).revision).toBe(
      sha256(REAL_PNG_13x7),
    );
    mockSpawn.mockReturnValueOnce(targets('text/html')).mockReturnValueOnce(fakeChild({}));
    expect((await backend.read('html', FULL)).revision).toBe(sha256(Buffer.alloc(0)));
  });
});

/**
 * Serve a selection owner offering `types`: TARGETS lists them, and each listed
 * target streams its value in `chunkSize`-byte chunks; any other target fails
 * the way xclip 0.13 reports it. Returns the targets requested, in order.
 */
function selection(types: Record<string, string | Buffer>, chunkSize = 16) {
  const requested: (string | undefined)[] = [];
  mockSpawn.mockImplementation(((_command: string, args: readonly string[]) => {
    const target = requestedType(args);
    requested.push(target);
    if (target === 'TARGETS') return targets(...Object.keys(types));
    const value = target === undefined ? undefined : types[target];
    if (value === undefined) {
      return fakeChild({ exitCode: 1, stderr: `Error: target ${target} not available` });
    }
    const bytes = Buffer.from(value);
    const chunks = Array.from({ length: Math.ceil(bytes.byteLength / chunkSize) }, (_, i) =>
      bytes.subarray(i * chunkSize, (i + 1) * chunkSize),
    );
    return fakeChild({ stdout: chunks });
  }) as unknown as typeof spawn);
  return requested;
}

const NO_OWNER = 'xclip: Error: There is no owner for the CLIPBOARD selection';

describe('LinuxX11Backend — one item per selection (#57)', () => {
  let backend: LinuxX11Backend;
  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.resetAllMocks();
  });

  it('inspect reports one item for an owned selection', async () => {
    selection({ UTF8_STRING: 'abc' });
    expect((await backend.inspect()).itemCount).toBe(1);
  });

  it('inspect reports no items for an unowned selection', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: NO_OWNER }));
    expect((await backend.inspect()).itemCount).toBe(0);
  });

  it.each([
    ['text', { UTF8_STRING: 'abc' }],
    ['html', { 'text/html': '<b>x</b>' }],
    ['rtf', { 'text/rtf': '{\\rtf1 x}' }],
    ['image', { 'image/png': REAL_PNG_13x7 }],
    ['files', { 'text/uri-list': 'file:///a' }],
  ] as const)('a %s read reports one item and no item scope', async (format, types) => {
    selection(types);
    const result = await backend.read(format, FULL);
    expect(result.itemCount).toBe(1);
    expect(result).not.toHaveProperty('itemScope');
  });

  it('item 0 reads exactly what a read without item does', async () => {
    selection({ UTF8_STRING: 'abc' });
    const whole = await backend.read('text', FULL);
    expect(await backend.read('text', FULL, 0)).toEqual(whole);
  });

  it.each([1, 2, 41])(
    'item %i fails format_unavailable after listing the targets, converting none',
    async (item) => {
      const requested = selection({ UTF8_STRING: 'abc', 'text/uri-list': 'file:///a' });
      await expect(backend.read('text', FULL, item)).rejects.toMatchObject({
        category: 'format_unavailable',
        message: expect.stringContaining(`item ${item}`),
      });
      expect(requested).toEqual(['TARGETS']);
    },
  );

  it('item 1 on an unowned selection is still an empty clipboard', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: NO_OWNER }));
    await expect(backend.read('text', FULL, 1)).rejects.toMatchObject({ category: 'empty' });
  });
});

describe('LinuxX11Backend — files from text/uri-list (#59)', () => {
  let backend: LinuxX11Backend;
  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.resetAllMocks();
  });

  const joined = Buffer.from(URI_LIST_PATHS.join('\n'));
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64url');

  it('inspect lists files, the richest format, beside the text and icon a file manager offers', async () => {
    selection({
      'text/uri-list': URI_LIST,
      UTF8_STRING: 'a b.txt',
      'image/png': REAL_PNG_13x7,
      'x-special/gnome-copied-files': 'copy\nfile:///home/u/a%20b.txt',
    });
    expect(await backend.inspect()).toEqual({
      primaryFormat: 'files',
      availableFormats: ['text', 'image', 'files'],
      itemCount: 1,
      rawTypes: [
        { type: 'TARGETS' },
        { type: 'text/uri-list', bytes: Buffer.byteLength(URI_LIST) },
        { type: 'UTF8_STRING', bytes: 7 },
        { type: 'image/png', bytes: REAL_PNG_13x7.byteLength },
        { type: 'x-special/gnome-copied-files' },
      ],
    });
  });

  it('reads file:///a%20b beside https://x.test as /a b', async () => {
    selection({ 'text/uri-list': 'file:///a%20b\r\nhttps://x.test\r\n' });
    expect((await backend.read('files', FULL)).content.toString('utf8')).toBe('/a b');
  });

  it('reads the local paths LF-joined, hashed, with the left-out count and one item', async () => {
    const requested = selection({ 'text/uri-list': URI_LIST });
    expect(await backend.read('files', FULL)).toEqual({
      format: 'files',
      content: joined,
      totalByteSize: joined.byteLength,
      revision: sha256(joined),
      itemCount: 1,
      omittedPaths: URI_LIST_OMITTED,
    });
    expect(requested).toEqual(['TARGETS', 'text/uri-list']);
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'xclip',
      ['-o', '-selection', 'clipboard', '-t', 'text/uri-list'],
      expect.any(Object),
    );
  });

  it('an unterminated one-line uri-list lists files, and the read returns its path', async () => {
    selection({ 'text/uri-list': 'file:///a' });
    expect(await backend.inspect()).toEqual({
      primaryFormat: 'files',
      availableFormats: ['files'],
      itemCount: 1,
      rawTypes: [{ type: 'TARGETS' }, { type: 'text/uri-list', bytes: 9 }],
    });
    expect((await backend.read('files', FULL)).content.toString('utf8')).toBe('/a');
  });

  it('carries no left-out count when every path is listed', async () => {
    selection({ 'text/uri-list': 'file:///a\r\nfile:///b\r\n' });
    const paths = Buffer.from('/a\n/b');
    expect(await backend.read('files', FULL)).toEqual({
      format: 'files',
      content: paths,
      totalByteSize: paths.byteLength,
      revision: sha256(paths),
      itemCount: 1,
    });
  });

  it('pages through the paths: every window reassembles them under one revision', async () => {
    for (const limit of [1, 5, 13]) {
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < joined.byteLength; offset += limit) {
        selection({ 'text/uri-list': URI_LIST }, 7);
        const slice = await backend.read('files', { offset, limit });
        expect(slice.totalByteSize).toBe(joined.byteLength);
        expect(slice.revision).toBe(sha256(joined));
        pieces.push(slice.content);
      }
      expect(Buffer.concat(pieces).equals(joined)).toBe(true);
    }
    selection({ 'text/uri-list': URI_LIST });
    const past = await backend.read('files', { offset: joined.byteLength + 10, limit: 10 });
    expect(past.content.byteLength).toBe(0);
    expect(past.totalByteSize).toBe(joined.byteLength);
  });

  it.each([
    ['no file URI', 'https://x.test/\r\nurn:isbn:1\r\n'],
    ['only remote hosts', 'file://other/srv/x\r\n'],
    ['only paths it cannot list', 'file:///a%0Ab\r\nfile:///c%FF\r\n'],
    ['only comments', '# file:///a\r\n'],
    ['nothing', ''],
  ])(
    'a uri-list with %s offers no files: inspect leaves files out and a read is format_unavailable',
    async (_label, list) => {
      selection({ 'text/uri-list': list, UTF8_STRING: 'x' });
      const inspected = await backend.inspect();
      expect(inspected.availableFormats).toEqual(['text']);
      expect(inspected.primaryFormat).toBe('text');
      expect(inspected.rawTypes).toContainEqual({
        type: 'text/uri-list',
        bytes: Buffer.byteLength(list),
      });
      await expect(backend.read('files', FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    },
  );

  it('a selection without text/uri-list has no files, and nothing is converted to say so', async () => {
    const requested = selection({ UTF8_STRING: '/home/u/a.txt' });
    await expect(backend.read('files', FULL)).rejects.toMatchObject({
      category: 'format_unavailable',
      message: expect.stringMatching(/No files representation/),
    });
    expect(requested).toEqual(['TARGETS']);
  });

  it('a uri-list that fails to convert is a failed measurement, and files is not offered', async () => {
    mockSpawn
      .mockReturnValueOnce(targets('text/uri-list'))
      .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'xclip: Error: conversion failed' }));
    expect(await backend.inspect()).toEqual({
      primaryFormat: 'empty',
      availableFormats: [],
      itemCount: 1,
      rawTypes: [{ type: 'TARGETS' }, { type: 'text/uri-list', measurementFailed: true }],
    });
  });

  it('characterization: a text read beside a uri-list reads the text and never converts the list', async () => {
    const requested = selection({ 'text/uri-list': URI_LIST, UTF8_STRING: 'plain' });
    expect((await backend.read('text', FULL)).content.toString('utf8')).toBe('plain');
    expect(requested).toEqual(['TARGETS', 'UTF8_STRING']);
  });
});
