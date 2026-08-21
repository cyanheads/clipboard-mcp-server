/**
 * @fileoverview Unit tests for WindowsBackend — mocks child_process.spawn.
 * @module tests/services/clipboard/windows-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';

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

describe('WindowsBackend', () => {
  let backend: WindowsBackend;

  beforeEach(() => {
    backend = new WindowsBackend();
    vi.clearAllMocks();
  });

  describe('inspect()', () => {
    it('returns empty result when no formats on clipboard', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
      expect(result.availableFormats).toEqual([]);
    });

    it('detects text format from Text entry', async () => {
      const formats = JSON.stringify([{ type: 'Text', bytes: 11 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: formats }));
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('text');
    });

    it('detects html from HTML Format entry', async () => {
      const formats = JSON.stringify([
        { type: 'HTML Format', bytes: 150 },
        { type: 'Text', bytes: 20 },
      ]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: formats }));
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('html');
      expect(result.availableFormats).toContain('text');
      expect(result.primaryFormat).toBe('html');
    });

    it('handles single-object JSON (not array) from PowerShell', async () => {
      // PowerShell may return a single object instead of array when there is only one format
      const format = JSON.stringify({ type: 'Text', bytes: 5 });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: format }));
      const result = await backend.inspect();
      expect(result.availableFormats).toContain('text');
    });
  });

  describe('read() text', () => {
    it('reads text via PowerShell Get-Text', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'clipboard contents' }));
      const result = await backend.read('text');
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('clipboard contents');
      const [cmd] = mockSpawn.mock.calls[0] as [string];
      expect(cmd).toBe('powershell.exe');
    });

    it('throws when text not present (returns null)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
      await expect(backend.read('text')).rejects.toThrow(/not found/i);
    });
  });

  describe('read() html', () => {
    it('reads HTML via PowerShell .NET', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html><body>test</body></html>' }));
      const result = await backend.read('html');
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
    });
  });

  describe('read() image', () => {
    it('reads image as base64 PNG with dimensions', async () => {
      const pngData = Buffer.from('fakepngdata');
      const psResult = JSON.stringify({
        base64: pngData.toString('base64'),
        width: 800,
        height: 600,
      });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: psResult }));
      const result = await backend.read('image');
      expect(result.format).toBe('image');
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
      expect(result.content).toEqual(pngData);
    });
  });

  describe('write()', () => {
    it('writes text via PowerShell with content as base64 in script — not interpolated', async () => {
      const stdinEnd = vi.fn();
      const child = fakeChild({ stdout: '' });
      Object.assign(child, { stdin: { end: stdinEnd } });
      mockSpawn.mockReturnValueOnce(child);

      const text = 'hello world';
      const result = await backend.write(text, 'text');
      expect(result.format).toBe('text');
      expect(result.byteSize).toBe(Buffer.byteLength(text, 'utf8'));

      // The script arg must not contain the raw text — only its base64 encoding
      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const scriptArg = (args as string[]).find((a) => a.includes('Base64')) ?? '';
      expect(scriptArg).not.toContain('hello world');
    });
  });

  describe('missing PowerShell detection', () => {
    it('throws when powershell.exe not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text')).rejects.toThrow(/powershell/i);
    });
  });

  describe('security — injection prevention', () => {
    const INJECTION_PAYLOADS = [
      '"; $(whoami); "',
      '; Invoke-Expression "whoami"',
      '$(cat /etc/passwd)',
      '| cat /etc/passwd',
      '\x00',
    ];

    it.each(INJECTION_PAYLOADS)(
      'write: content passed as base64, not raw in script (%s)',
      async (payload) => {
        const child = fakeChild({ stdout: '' });
        mockSpawn.mockReturnValueOnce(child);

        await backend.write(payload, 'text').catch(() => {
          /* ignore */
        });
        const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
        // The -Command arg should have base64 content, not the raw payload
        const scriptArg = (args as string[]).find((a) => a.includes('FromBase64String')) ?? '';
        expect(scriptArg).not.toContain('Invoke-Expression');
        expect(scriptArg).not.toContain('$(');
        expect(scriptArg).not.toContain('whoami');
      },
    );
  });
});
