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

/** Full-representation range: what the service passes for an unranged read. */
const FULL = { offset: 0, limit: 8 * 1024 * 1024 } as const;

/** The ranged-read envelope a JXA read script prints for a present representation, whole. */
function jxaEnvelope(bytes: Buffer, extra: Record<string, number> = {}): string {
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
    ...extra,
  });
}

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
    stdoutEmitter.emit('end');
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

    it.each(['public.png', 'public.tiff', 'com.apple.pict'])(
      'classifies supported image type %s as image',
      async (type) => {
        mockSpawn.mockReturnValueOnce(
          fakeChild({ stdout: JSON.stringify([{ type, bytes: 1024 }]) }),
        );

        const result = await backend.inspect();

        expect(result).toEqual({
          primaryFormat: 'image',
          availableFormats: ['image'],
          rawTypes: [{ type, bytes: 1024 }],
        });
      },
    );

    it('retains a filename-list type without classifying it as an image', async () => {
      const type = 'NSFilenamesPboardType';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify([{ type, bytes: 128 }]) }));

      const result = await backend.inspect();

      expect(result).toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        rawTypes: [{ type, bytes: 128 }],
      });
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

    it('reports malformed JXA output as a failure, not an empty clipboard', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'not json' }));
      await expect(backend.inspect()).rejects.toThrow(/unreadable/i);
    });
  });

  describe('inspect() — unreadable native output (#23)', () => {
    it.each([
      ['a JSON string', '"public.utf8-plain-text"'],
      ['a JSON number', '42'],
      ['an array of strings', '["public.html"]'],
      ['entries missing a type', '[{"bytes":12}]'],
      ['entries with a non-numeric size', '[{"type":"public.html","bytes":"big"}]'],
    ])('surfaces %s as unreadable rather than an empty clipboard', async (_label, stdout) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout }));
      await expect(backend.inspect()).rejects.toThrow(/unreadable/i);
    });

    it('names the platform on the thrown failure', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'not json' }));
      await expect(backend.inspect()).rejects.toMatchObject({
        _inspectUnreadable: true,
        platform: 'macOS',
      });
    });

    it('still reports a genuinely empty pasteboard as an empty success', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '[]' }));
      await expect(backend.inspect()).resolves.toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        rawTypes: [],
      });
    });
  });

  describe('read() text', () => {
    it('reads text via pbpaste', async () => {
      // inspect() runs first (JXA) — text type must be present
      const types = JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 11 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      // pbpaste returns the text content
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'hello world' }));
      const result = await backend.read('text', FULL);
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
      const result = await backend.read('text', FULL);
      expect(result.content.toString('utf8')).toBe(text);
    });
  });

  describe('read() html', () => {
    it('reads HTML via osascript JXA', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeChild({ stdout: jxaEnvelope(Buffer.from('<html><body><b>bold</b></body></html>')) }),
      );
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
      expect(mockSpawn).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object));
    });

    it('throws when HTML not present (osascript returns null)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(backend.read('html', FULL)).rejects.toThrow(/not found/i);
    });
  });

  describe('read() image', () => {
    it('reads image and returns PNG base64 with dimensions', async () => {
      const pngData = Buffer.from('fakepngdata');
      const jxaResult = jxaEnvelope(pngData, { width: 1920, height: 1080 });
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('image', FULL);
      expect(result.format).toBe('image');
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.content).toEqual(pngData);
    });

    it('throws when image not present', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(backend.read('image', FULL)).rejects.toThrow(/not found/i);
    });
  });

  describe('read() rtf', () => {
    it('reads RTF via osascript JXA', async () => {
      const rtfContent = '{\\rtf1 Hello}';
      const jxaResult = jxaEnvelope(Buffer.from(rtfContent));
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('rtf', FULL);
      expect(result.format).toBe('rtf');
      expect(result.content.toString('utf8')).toBe(rtfContent);
    });

    it('reads RTF via base64 encoding', async () => {
      const rtfContent = '{\\rtf1 Hello}';
      const jxaResult = jxaEnvelope(Buffer.from(rtfContent));
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaResult }));
      const result = await backend.read('rtf', FULL);
      expect(result.content.toString('utf8')).toBe(rtfContent);
    });

    it('throws when RTF not present (osascript returns null)', async () => {
      // JXA returns 'null' string when public.rtf and com.apple.flat-rtfd are absent
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(backend.read('rtf', FULL)).rejects.toThrow(/not found/i);
    });
  });

  describe('read() text — empty clipboard', () => {
    it('throws when text not present on clipboard', async () => {
      // inspect returns empty → text not in availableFormats → should throw
      const emptyInspect = JSON.stringify([]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: emptyInspect }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/not found/i);
    });

    it('returns empty buffer when text type is present but content is empty', async () => {
      // inspect: text type is present
      const types = JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 0 }]);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: types }));
      // pbpaste: returns empty string
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      const result = await backend.read('text', FULL);
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

    it('writes the tag-stripped plain-text fallback alongside HTML', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'ok' }));
      const html = '<h1>Title</h1><script>alert(1)</script><p>Body</p>';

      await backend.write(html, 'html');

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain(JSON.stringify(Buffer.from('Title Body').toString('base64')));
    });
  });

  describe('write() html — numeric entity fallback (#25)', () => {
    it.each([
      ['decimal', '<p>&#169; 2026</p>', '© 2026'],
      ['hexadecimal', '<p>&#xA9; 2026</p>', '© 2026'],
      ['astral', '<p>Smile &#x1F600;</p>', 'Smile 😀'],
      ['nested in block elements', '<div><p>Caf&#233;</p><p>&#8212; open</p></div>', 'Café — open'],
    ])(
      'publishes the decoded %s reference in the plain-text fallback',
      async (_label, html, expected) => {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'ok' }));

        await backend.write(html, 'html');

        const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
        const script = args.at(-1) ?? '';
        expect(script).toContain(JSON.stringify(Buffer.from(expected, 'utf8').toString('base64')));
      },
    );
  });

  describe('clear() (#24)', () => {
    it('clears the pasteboard without publishing any representation', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'ok' }));

      await backend.clear();

      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('osascript');
      const script = args.at(-1) ?? '';
      expect(script).toContain('clearContents');
      // A following setStringForType is what leaves an empty representation behind.
      expect(script).not.toContain('setStringForType');
      expect(script).not.toContain('pbcopy');
    });

    it('propagates an osascript failure', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'execution error' }));

      await expect(backend.clear()).rejects.toThrow(/osascript exited 1/);
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

describe('MacosBackend — ranged helper scripts (#7)', () => {
  let backend: MacosBackend;
  beforeEach(() => {
    backend = new MacosBackend();
    vi.clearAllMocks();
  });

  it('interpolates offset and limit into the JXA read scripts as literal integers', async () => {
    for (const format of ['html', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('payload')) }));
      await backend.read(format, { offset: 5, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain('const offset = 5;');
      expect(script).toContain('Math.min(7, total - offset)');
      expect(script).toContain('subdataWithRange');
    }
  });

  it('refuses to build a script from an unsafe range', async () => {
    await expect(backend.read('html', { offset: -1, limit: 4 })).rejects.toThrow(
      /Invalid read range offset/,
    );
    await expect(backend.read('html', { offset: 0, limit: Number.NaN })).rejects.toThrow(
      /Invalid read range limit/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('pbpaste text reads stream the window and report the total', async () => {
    mockSpawn
      .mockReturnValueOnce(
        fakeChild({ stdout: JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 10 }]) }),
      )
      .mockReturnValueOnce(fakeChild({ stdout: '0123456789' }));
    const result = await backend.read('text', { offset: 6, limit: 8 });
    expect(result.content.toString()).toBe('6789');
    expect(result.totalByteSize).toBe(10);
  });
});

describe('MacosBackend — pbpaste/pbcopy run under an explicit UTF-8 locale', () => {
  let backend: MacosBackend;
  beforeEach(() => {
    backend = new MacosBackend();
    vi.clearAllMocks();
  });

  it('spawns pbpaste with LC_ALL=en_US.UTF-8 so text bytes do not depend on the parent locale', async () => {
    mockSpawn
      .mockReturnValueOnce(
        fakeChild({ stdout: JSON.stringify([{ type: 'public.utf8-plain-text', bytes: 3 }]) }),
      )
      .mockReturnValueOnce(fakeChild({ stdout: 'abc' }));
    await backend.read('text', FULL);
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'pbpaste',
      [],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'en_US.UTF-8' }) }),
    );
  });

  it('spawns pbcopy with LC_ALL=en_US.UTF-8 so stored text is the UTF-8 bytes it was given', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({}));
    await backend.write('café', 'text');
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'pbcopy',
      [],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'en_US.UTF-8' }) }),
    );
  });
});
