/**
 * @fileoverview Unit tests for LinuxWaylandBackend — mocks child_process.spawn.
 * @module tests/services/clipboard/linux-wayland-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { LinuxWaylandBackend } from '@/services/clipboard/linux-wayland-backend.js';
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
    if (opts.stderr) stderrEmitter.emit('data', Buffer.from(opts.stderr ?? ''));
    stdoutEmitter.emit('end');
    child.emit('close', opts.exitCode ?? 0);
  });

  return child;
}

/**
 * A wl-copy child under the test's control: nothing is emitted until the test
 * says so, so "did write() resolve yet?" is an observable question.
 */
function fakeWlCopyChild() {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as typeof child.stdin;
  const end = vi.fn();
  (stdinEmitter as unknown as { end: typeof end }).end = end;
  Object.assign(child, {
    stdout: null,
    stderr: stderrEmitter,
    stdin: stdinEmitter,
    unref: vi.fn(),
  });
  return { child, stderr: stderrEmitter, stdin: stdinEmitter, stdinEnd: end };
}

/** Track settlement of a promise without awaiting it. */
function watch(promise: Promise<unknown>) {
  const state = { settled: false, status: '' as '' | 'resolved' | 'rejected', reason: '' };
  const done = promise.then(
    () => {
      state.settled = true;
      state.status = 'resolved';
    },
    (error: unknown) => {
      state.settled = true;
      state.status = 'rejected';
      state.reason = error instanceof Error ? error.message : String(error);
    },
  );
  return { state, done };
}

describe('LinuxWaylandBackend', () => {
  let backend: LinuxWaylandBackend;

  beforeEach(() => {
    backend = new LinuxWaylandBackend();
    vi.resetAllMocks();
  });

  describe('inspect()', () => {
    it('returns empty result when nothing is on clipboard', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
      expect(result.availableFormats).toEqual([]);
    });

    it('detects text/plain', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'some text' }));
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('text');
    });

    it('returns image as primaryFormat when image/png present', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\nimage/png\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'hello' }))
        .mockReturnValueOnce(fakeChild({ stdout: Buffer.from([0x89, 0x50]) }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('image');
    });

    it('handles "nothing is copied" as empty clipboard', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stderr: 'nothing is copied', exitCode: 1 }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
    });

    it('marks a failed size measurement instead of reporting zero bytes (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\nimage/png\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: 'hello' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'wl-paste: no data for that type' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'text/plain', bytes: 5 },
        { type: 'image/png', measurementFailed: true },
      ]);
      expect(result.availableFormats).toEqual(['text', 'image']);
      expect(result.primaryFormat).toBe('image');
    });

    it('reports a genuine zero-length representation as bytes: 0 (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\n' }))
        .mockReturnValueOnce(fakeChild({ stdout: '' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([{ type: 'text/plain', bytes: 0 }]);
      expect(result.rawTypes[0]).not.toHaveProperty('measurementFailed');
    });

    it('marks every failed measurement when several types fail (#23)', async () => {
      mockSpawn
        .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\ntext/html\nimage/png\n' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'no data for that type' }))
        .mockReturnValueOnce(fakeChild({ stdout: '<b>ok</b>' }))
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'no data for that type' }));

      const result = await backend.inspect();

      expect(result.rawTypes).toEqual([
        { type: 'text/plain', measurementFailed: true },
        { type: 'text/html', bytes: 9 },
        { type: 'image/png', measurementFailed: true },
      ]);
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
    it('reads text via wl-paste with -t text/plain', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'wayland text' }));
      const result = await backend.read('text', FULL);
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('wayland text');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('wl-paste');
      expect(args).toContain('text/plain');
    });

    it('keeps text/plain as the first text read MIME type', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'primary text' }));

      await backend.read('text', FULL);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith('wl-paste', ['-t', 'text/plain'], expect.any(Object));
    });

    it.each(['text/plain;charset=utf-8', 'UTF8_STRING', 'TEXT', 'STRING'])(
      'falls back to the advertised %s text MIME type',
      async (mime) => {
        const fallbackOrder = [
          'text/plain',
          'text/plain;charset=utf-8',
          'UTF8_STRING',
          'TEXT',
          'STRING',
        ];
        const targetIndex = fallbackOrder.indexOf(mime);
        for (let index = 0; index < targetIndex; index += 1) {
          mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'no such type' }));
        }
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: `${mime} content` }));

        const result = await backend.read('text', FULL);

        expect(result.content.toString('utf8')).toBe(`${mime} content`);
        expect(mockSpawn.mock.calls.map(([, args]) => (args as string[]).at(-1))).toEqual(
          fallbackOrder.slice(0, targetIndex + 1),
        );
      },
    );

    it('reads html via wl-paste with -t text/html', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html><body>wayland</body></html>' }));
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('wl-paste');
      expect(args).toContain('text/html');
    });

    it('throws when html buffer is empty (format not present)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('html', FULL)).rejects.toThrow(/not found/i);
    });

    it('reads rtf via wl-paste with -t text/rtf', async () => {
      const rtf = '{\\rtf1 test}';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: rtf }));
      const result = await backend.read('rtf', FULL);
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtf);
    });

    it('falls back to application/rtf when text/rtf fails', async () => {
      const rtf = '{\\rtf1 fallback}';
      // First call (text/rtf) fails, second (application/rtf) succeeds
      mockSpawn
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'no such type' }))
        .mockReturnValueOnce(fakeChild({ stdout: rtf }));
      const result = await backend.read('rtf', FULL);
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtf);
    });

    it('throws when rtf returns empty buffer (format not present)', async () => {
      // text/rtf returns empty — no fallback needed, empty = not found
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('rtf', FULL)).rejects.toThrow(/not found/i);
    });

    it('reads image/png via wl-paste and reports its dimensions', async () => {
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
  });

  describe('write() html', () => {
    it('invokes wl-copy with text/html MIME type', async () => {
      const spawnCallArgs: unknown[] = [];
      const { child } = fakeWlCopyChild();
      mockSpawn.mockImplementationOnce((...args) => {
        spawnCallArgs.push(...args);
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const result = await backend.write('<b>bold</b>', 'html');
      expect(result.format).toBe('html');
      const [cmd, args] = spawnCallArgs as [string, string[]];
      expect(cmd).toBe('wl-copy');
      expect(args).toContain('text/html');
    });
  });

  describe('write()', () => {
    it('invokes wl-copy detached (Wayland content persistence)', async () => {
      const spawnCallArgs: unknown[] = [];
      const { child } = fakeWlCopyChild();
      mockSpawn.mockImplementationOnce((...args) => {
        spawnCallArgs.push(...args);
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const result = await backend.write('test text', 'text');
      expect(result.format).toBe('text');
      const [cmd, args] = spawnCallArgs as [string, string[]];
      expect(cmd).toBe('wl-copy');
      // MIME from enum, not content
      expect(args).toContain('text/plain');
      const [, , options] = spawnCallArgs as [string, string[], { detached?: boolean }];
      expect(options.detached).toBe(true);
    });
  });

  describe('write() completion signal (#21)', () => {
    it('stays pending until the wl-copy process exits', async () => {
      const { child, stdinEnd } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const { state, done } = watch(backend.write('a big payload', 'text'));
      // stdin is queued immediately; that alone must not complete the write.
      expect(stdinEnd).toHaveBeenCalled();
      await Promise.resolve();
      expect(state.settled).toBe(false);

      child.emit('exit', 0, null);
      await done;
      expect(state.status).toBe('resolved');
    });

    it('does not resolve on a fixed delay while the child is still draining', async () => {
      vi.useFakeTimers();
      try {
        const { child } = fakeWlCopyChild();
        mockSpawn.mockReturnValueOnce(child);

        const { state, done } = watch(backend.write('slow payload', 'text'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.settled).toBe(false);

        child.emit('exit', 0, null);
        await done;
        expect(state.status).toBe('resolved');
      } finally {
        vi.useRealTimers();
      }
    });

    it('unrefs the child once it has exited so the process can detach', async () => {
      const { child } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const write = backend.write('detach me', 'text');
      child.emit('exit', 0, null);
      await write;

      expect((child as unknown as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalled();
    });

    it('rejects with the captured stderr on a non-zero exit', async () => {
      const { child, stderr } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const write = backend.write('doomed', 'text');
      stderr.emit('data', Buffer.from('Failed to connect to a Wayland server'));
      child.emit('exit', 1, null);

      await expect(write).rejects.toThrow(
        /wl-copy exited 1: Failed to connect to a Wayland server/,
      );
    });

    it('rejects on a non-zero exit that arrives after part of stdin was written', async () => {
      const { child, stderr } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const write = backend.write('x'.repeat(4096), 'text');
      // The child read some of stdin, then died mid-transfer.
      stderr.emit('data', Buffer.from('wl-copy: '));
      stderr.emit('data', Buffer.from('unexpected end of input'));
      child.emit('exit', 2, null);

      await expect(write).rejects.toThrow(/wl-copy exited 2: wl-copy: unexpected end of input/);
    });

    it('rejects with install guidance when wl-copy is missing', async () => {
      const { child } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const write = backend.write('nowhere to go', 'text');
      child.emit('error', Object.assign(new Error('spawn wl-copy ENOENT'), { code: 'ENOENT' }));

      await expect(write).rejects.toThrow(
        'wl-copy not found — install with: apt install wl-clipboard',
      );
    });

    it('rejects when the stdin pipe errors instead of leaving the write pending', async () => {
      const { child, stdin } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const { state, done } = watch(backend.write('broken pipe', 'text'));
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await done;

      expect(state.status).toBe('rejected');
      expect(state.reason).toMatch(/EPIPE/);
    });

    it('settles once even when stdin errors and the child then exits non-zero', async () => {
      const { child, stdin } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const { state, done } = watch(backend.write('broken pipe', 'text'));
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.emit('exit', 1, null);
      await done;

      expect(state.status).toBe('rejected');
      expect(state.reason).toMatch(/EPIPE/);
    });
  });

  describe('clear() (#24)', () => {
    it('clears with wl-copy --clear instead of copying empty content', async () => {
      const spawnCallArgs: unknown[] = [];
      const { child, stdinEnd } = fakeWlCopyChild();
      mockSpawn.mockImplementationOnce((...args) => {
        spawnCallArgs.push(...args);
        setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      await backend.clear();

      const [cmd, args] = spawnCallArgs as [string, string[]];
      expect(cmd).toBe('wl-copy');
      expect(args).toEqual(['--clear']);
      // --clear reads no stdin; an empty copy would leave an owned selection.
      expect(stdinEnd).not.toHaveBeenCalled();
    });

    it('rejects when wl-copy --clear exits non-zero', async () => {
      const { child, stderr } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const cleared = backend.clear();
      stderr.emit('data', Buffer.from('Failed to connect to a Wayland server'));
      child.emit('exit', 1, null);

      await expect(cleared).rejects.toThrow(/wl-copy exited 1/);
    });

    it('rejects with install guidance when wl-copy is missing', async () => {
      const { child } = fakeWlCopyChild();
      mockSpawn.mockReturnValueOnce(child);

      const cleared = backend.clear();
      child.emit('error', Object.assign(new Error('spawn wl-copy ENOENT'), { code: 'ENOENT' }));

      await expect(cleared).rejects.toThrow(
        'wl-copy not found — install with: apt install wl-clipboard',
      );
    });
  });

  describe('missing wl-paste detection', () => {
    it('throws informative error when wl-paste is not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/wl-paste not found/i);
    });
  });

  describe('security — injection prevention', () => {
    const INJECTION_PAYLOADS = ['"; $(whoami); "', '| cat /etc/passwd', '\x00'];

    it.each(INJECTION_PAYLOADS)(
      'write: MIME type comes from enum, not content (%s)',
      async (payload) => {
        const { child } = fakeWlCopyChild();
        mockSpawn.mockImplementationOnce(() => {
          setImmediate(() => child.emit('exit', 0, null));
          return child;
        });

        await backend.write(payload, 'text').catch(() => {
          /* ignore */
        });
        if (mockSpawn.mock.calls.length > 0) {
          const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
          for (const arg of args) {
            expect(arg).not.toContain('$(');
            expect(arg).not.toContain('whoami');
          }
        }
      },
    );
  });
});

describe('LinuxWaylandBackend — streamed measurement and windows (#26, #7)', () => {
  let backend: LinuxWaylandBackend;
  beforeEach(() => {
    backend = new LinuxWaylandBackend();
    vi.clearAllMocks();
  });

  it('inspect() counts a representation delivered in many chunks without buffering it', async () => {
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(2048, 'y'));
    mockSpawn
      .mockReturnValueOnce(fakeChild({ stdout: 'text/plain\n' }))
      .mockReturnValueOnce(fakeChild({ stdout: chunks }));
    const result = await backend.inspect();
    expect(result.rawTypes).toEqual([{ type: 'text/plain', bytes: 8192 }]);
  });

  it('read() returns only the requested window across chunk boundaries, with the true total', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({ stdout: [Buffer.from('abcdef'), Buffer.from('ghijkl')] }),
    );
    const result = await backend.read('html', { offset: 4, limit: 5 });
    expect(result.content.toString()).toBe('efghi');
    expect(result.totalByteSize).toBe(12);
  });
});
