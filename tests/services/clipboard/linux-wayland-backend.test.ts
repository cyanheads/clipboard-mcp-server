/**
 * @fileoverview Unit tests for LinuxWaylandBackend — mocks child_process.spawn.
 * @module tests/services/clipboard/linux-wayland-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { LinuxWaylandBackend } from '@/services/clipboard/linux-wayland-backend.js';

const mockSpawn = vi.mocked(spawn);

function fakeChild(opts: {
  stdout?: string | Buffer;
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
    if (opts.stdout)
      stdoutEmitter.emit(
        'data',
        Buffer.isBuffer(opts.stdout) ? opts.stdout : Buffer.from(opts.stdout),
      );
    if (opts.stderr) stderrEmitter.emit('data', Buffer.from(opts.stderr ?? ''));
    child.emit('close', opts.exitCode ?? 0);
  });

  return child;
}

describe('LinuxWaylandBackend', () => {
  let backend: LinuxWaylandBackend;

  beforeEach(() => {
    backend = new LinuxWaylandBackend();
    vi.clearAllMocks();
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
  });

  describe('read()', () => {
    it('reads text via wl-paste with -t text/plain', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'wayland text' }));
      const result = await backend.read('text');
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('wayland text');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('wl-paste');
      expect(args).toContain('text/plain');
    });

    it('reads html via wl-paste with -t text/html', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html><body>wayland</body></html>' }));
      const result = await backend.read('html');
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('wl-paste');
      expect(args).toContain('text/html');
    });

    it('throws when html buffer is empty (format not present)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('html')).rejects.toThrow(/not found/i);
    });

    it('reads rtf via wl-paste with -t text/rtf', async () => {
      const rtf = '{\\rtf1 test}';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: rtf }));
      const result = await backend.read('rtf');
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtf);
    });

    it('falls back to application/rtf when text/rtf fails', async () => {
      const rtf = '{\\rtf1 fallback}';
      // First call (text/rtf) fails, second (application/rtf) succeeds
      mockSpawn
        .mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'no such type' }))
        .mockReturnValueOnce(fakeChild({ stdout: rtf }));
      const result = await backend.read('rtf');
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtf);
    });

    it('throws when rtf returns empty buffer (format not present)', async () => {
      // text/rtf returns empty — no fallback needed, empty = not found
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('rtf')).rejects.toThrow(/not found/i);
    });

    it('reads image/png via wl-paste', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: pngBytes }));
      const result = await backend.read('image');
      expect(result.format).toBe('image');
      expect(result.content.slice(0, 4)).toEqual(pngBytes);
    });
  });

  describe('write() html', () => {
    it('invokes wl-copy with text/html MIME type', async () => {
      const spawnCallArgs: unknown[] = [];
      const child = fakeChild({ stdout: '' });
      Object.assign(child, { unref: vi.fn() });
      const origEmit = child.emit.bind(child);
      mockSpawn.mockImplementationOnce((...args) => {
        spawnCallArgs.push(...args);
        setImmediate(() => {
          origEmit('spawn');
        });
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
      const child = fakeChild({ stdout: '' });
      // Simulate detach/unref
      Object.assign(child, { unref: vi.fn() });
      // Override: emit 'spawn' so the timeout fires
      const origEmit = child.emit.bind(child);
      mockSpawn.mockImplementationOnce((...args) => {
        spawnCallArgs.push(...args);
        setImmediate(() => {
          origEmit('spawn');
        });
        return child;
      });

      const result = await backend.write('test text', 'text');
      expect(result.format).toBe('text');
      const [cmd, args] = spawnCallArgs as [string, string[]];
      expect(cmd).toBe('wl-copy');
      // MIME from enum, not content
      expect(args).toContain('text/plain');
    });
  });

  describe('missing wl-paste detection', () => {
    it('throws informative error when wl-paste is not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text')).rejects.toThrow(/wl-paste not found/i);
    });
  });

  describe('security — injection prevention', () => {
    const INJECTION_PAYLOADS = ['"; $(whoami); "', '| cat /etc/passwd', '\x00'];

    it.each(INJECTION_PAYLOADS)(
      'write: MIME type comes from enum, not content (%s)',
      async (payload) => {
        const child = fakeChild({ stdout: '' });
        Object.assign(child, { unref: vi.fn() });
        const origEmit = child.emit.bind(child);
        mockSpawn.mockImplementationOnce(() => {
          setImmediate(() => origEmit('spawn'));
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
