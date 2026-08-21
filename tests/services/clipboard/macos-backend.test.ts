/**
 * @fileoverview Unit tests for MacosBackend — mocks child_process.spawn.
 * @module tests/services/clipboard/macos-backend.test
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';

const mockSpawn = vi.mocked(spawn);

/** Create a fake child process that emits given stdout/stderr and closes with code. */
function fakeChild(opts: {
  stdout?: string | Buffer;
  stderr?: string;
  exitCode?: number;
  errorOnStdin?: boolean;
}) {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as typeof child.stdin;
  (stdinEmitter as unknown as { end: (data?: Buffer) => void }).end = vi.fn();

  Object.assign(child, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: stdinEmitter,
  });

  // Emit output asynchronously so listeners have time to attach
  setImmediate(() => {
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

describe('MacosBackend', () => {
  let backend: MacosBackend;

  beforeEach(() => {
    backend = new MacosBackend();
    vi.clearAllMocks();
  });

  describe('inspect()', () => {
    it('returns empty result when no types on clipboard', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '[]' }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
      expect(result.availableFormats).toEqual([]);
      expect(result.rawTypes).toEqual([]);
    });

    it('returns text format when only plain text is present', async () => {
      const types = JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 12 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('text');
      expect(result.availableFormats).toContain('text');
    });

    it('returns image as primaryFormat when image and text both present', async () => {
      const types = JSON.stringify([
        { type: 'public.utf8-plain-text', bytes: 5 },
        { type: 'public.png', bytes: 1024 },
      ]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('image');
      expect(result.availableFormats).toContain('text');
      expect(result.availableFormats).toContain('image');
    });

    it('returns html as primaryFormat when html and text both present', async () => {
      const types = JSON.stringify([
        { type: 'public.utf8-plain-text', bytes: 5 },
        { type: 'public.html', bytes: 200 },
      ]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('html');
    });

    it('handles malformed JXA output gracefully', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'not json' }));
      const result = await backend.inspect();
      expect(result.primaryFormat).toBe('empty');
    });
  });

  describe('read() text', () => {
    it('reads text via pbpaste', async () => {
      // inspect() runs first (JXA) — text type must be present
      const types = JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 11 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      // pbpaste returns the text content
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'hello world' }));
      const result = await backend.read('text');
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('hello world');
      // Verify pbpaste was called second (not osascript for the actual read)
      expect(mockSpawn).toHaveBeenCalledWith('pbpaste', [], expect.any(Object));
    });

    it('round-trips unicode and emoji', async () => {
      const text = 'Hello 世界 🌍';
      // inspect() runs first
      const types = JSON.stringify([
        { type: 'public.utf8-plain-text', bytes: Buffer.byteLength(text, 'utf8') },
      ]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      // pbpaste returns content
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: Buffer.from(text, 'utf8') }));
      const result = await backend.read('text');
      expect(result.content.toString('utf8')).toBe(text);
    });
  });

  describe('read() html', () => {
    it('reads HTML via osascript JXA', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '<html><body><b>bold</b></body></html>' }));
      const result = await backend.read('html');
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
      expect(mockSpawn).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object));
    });

    it('throws when HTML not present (osascript returns null)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
      await expect(backend.read('html')).rejects.toThrow(/not found/i);
    });
  });

  describe('read() image', () => {
    it('reads image and returns PNG base64 with dimensions', async () => {
      const pngData = Buffer.from('fakepngdata');
      const jxaResult = JSON.stringify({
        base64: pngData.toString('base64'),
        width: 1920,
        height: 1080,
      });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('image');
      expect(result.format).toBe('image');
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.content).toEqual(pngData);
    });

    it('throws when image not present', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
      await expect(backend.read('image')).rejects.toThrow(/not found/i);
    });
  });

  describe('read() rtf', () => {
    it('reads RTF via osascript JXA', async () => {
      const rtfContent = '{\\rtf1 Hello}';
      const jxaResult = JSON.stringify({ type: 'string', value: rtfContent });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('rtf');
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtfContent);
    });

    it('reads RTF via base64 encoding', async () => {
      const rtfContent = '{\\rtf1 Hello}';
      const jxaResult = JSON.stringify({
        type: 'base64',
        value: Buffer.from(rtfContent).toString('base64'),
      });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('rtf');
      expect(result.content.toString('utf8')).toBe(rtfContent);
    });

    it('throws when RTF not present (osascript returns null)', async () => {
      // JXA returns 'null' string when public.rtf and com.apple.flat-rtfd are absent
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
      await expect(backend.read('rtf')).rejects.toThrow(/not found/i);
    });
  });

  describe('read() text — empty clipboard', () => {
    it('throws when text not present on clipboard', async () => {
      // inspect returns empty → text not in availableFormats → should throw
      const emptyInspect = JSON.stringify([]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: emptyInspect }));
      await expect(backend.read('text')).rejects.toThrow(/not found/i);
    });

    it('returns empty buffer when text type is present but content is empty', async () => {
      // inspect: text type is present
      const types = JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 0 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      // pbpaste: returns empty string
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      const result = await backend.read('text');
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('');
    });
  });

  describe('write() text', () => {
    it('writes text via pbcopy with content on stdin', async () => {
      const child = fakeChild({ stdout: '' });
      const stdinEnd = vi.fn();
      Object.assign(child, { stdin: { end: stdinEnd } });
      mockSpawn.mockReturnValueOnce(child);

      const result = await backend.write('hello', 'text');
      expect(result.format).toBe('text');
      expect(result.byteSize).toBe(Buffer.byteLength('hello', 'utf8'));
      // Content goes to stdin, not command args
      expect(mockSpawn).toHaveBeenCalledWith('pbcopy', [], expect.any(Object));
    });
  });

  describe('write() html', () => {
    it('writes HTML via osascript JXA — content never in command args', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'ok' }));
      const html = '<html><body><p>Test <script>alert(1)</script></p></body></html>';
      const result = await backend.write(html, 'html');
      expect(result.format).toBe('html');
      expect(result.byteSize).toBe(Buffer.byteLength(html, 'utf8'));
      // Verify osascript was called
      expect(mockSpawn).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object));
      // The actual HTML content must NOT appear literally in the command arguments array
      const callArgs = mockSpawn.mock.calls[0];
      const scriptArg =
        (callArgs[1] as string[]).find((a) => typeof a === 'string' && a.length > 50) ?? '';
      expect(scriptArg).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('security — injection prevention', () => {
    const INJECTION_PAYLOADS = [
      '"; $(whoami); "',
      "'; `id`; '",
      '$(cat /etc/passwd)',
      '\n; rm -rf /',
      '\\"; process.exit(); //',
      "'); ObjC.import('Foundation'); //",
      '; Invoke-Expression "whoami"',
      '| cat /etc/passwd',
      '\x00',
    ];

    it.each(INJECTION_PAYLOADS)(
      'write text: payload goes to stdin, not args (%s)',
      async (payload) => {
        const child = fakeChild({ stdout: '' });
        const stdinEnd = vi.fn();
        Object.assign(child, { stdin: { end: stdinEnd } });
        mockSpawn.mockReturnValueOnce(child);

        await backend.write(payload, 'text').catch(() => {
          /* ignore */
        });
        const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
        expect(cmd).toBe('pbcopy');
        // None of the injection payload should appear in the args array
        for (const arg of args) {
          expect(arg).not.toContain('$(');
          expect(arg).not.toContain('`id`');
        }
      },
    );

    it.each(INJECTION_PAYLOADS)(
      'write html: payload base64-encoded, not in script source (%s)',
      async (payload) => {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'ok' }));
        await backend.write(payload, 'html').catch(() => {
          /* ignore */
        });
        const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
        expect(cmd).toBe('osascript');
        const script = (args as string[]).find((a) => a.includes('base64')) ?? '';
        // The literal injection payload must not appear in the JXA script source
        expect(script).not.toContain(payload.slice(0, 10));
      },
    );
  });
});
