/**
 * @fileoverview Unit tests for LinuxX11Backend — mocks child_process.spawn.
 * @module tests/services/clipboard/linux-x11-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { LinuxX11Backend } from '@/services/clipboard/linux-x11-backend.js';

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
    if (opts.stderr) stderrEmitter.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.exitCode ?? 0);
  });

  return child;
}

describe('LinuxX11Backend', () => {
  let backend: LinuxX11Backend;

  beforeEach(() => {
    backend = new LinuxX11Backend();
    vi.clearAllMocks();
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
  });

  describe('read()', () => {
    it('reads text via xclip with UTF8_STRING target', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'clipboard text' }));
      const result = await backend.read('text');
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('clipboard text');
      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('xclip');
      expect(args).toContain('-t');
      expect(args).toContain('UTF8_STRING');
    });

    it('reads html via xclip with text/html target', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html>test</html>' }));
      const result = await backend.read('html');
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
    });

    it('reads image/png via xclip', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: pngBytes }));
      const result = await backend.read('image');
      expect(result.format).toBe('image');
      expect(result.content.slice(0, 4)).toEqual(pngBytes);
    });

    it('throws when html buffer is empty', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      await expect(backend.read('html')).rejects.toThrow(/not found/i);
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

  describe('missing xclip detection', () => {
    it('throws informative error when xclip is not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text')).rejects.toThrow(/xclip not found/i);
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
