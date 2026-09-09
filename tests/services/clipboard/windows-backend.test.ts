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

/** Full-representation range: what the service passes for an unranged read. */
const FULL = { offset: 0, limit: 8 * 1024 * 1024 } as const;

function stringEnvelope(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
  });
}

/** The ranged-read envelope the image script prints for a present image, whole. */
function imageEnvelope(bytes: Buffer, width: number, height: number): string {
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
    width,
    height,
  });
}

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
    stdoutEmitter.emit('end');
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

    it('surfaces unparseable PowerShell output instead of reporting an empty clipboard (#23)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'At line:1 char:1 + not json' }));
      await expect(backend.inspect()).rejects.toThrow(/unreadable/i);
    });

    it.each([
      ['a JSON string', '"Text"'],
      ['entries missing a type', '[{"bytes":12}]'],
      ['entries with a non-numeric size', '[{"type":"Text","bytes":"big"}]'],
    ])('surfaces %s as unreadable rather than an empty clipboard (#23)', async (_label, stdout) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout }));
      await expect(backend.inspect()).rejects.toThrow(/unreadable/i);
    });

    it('names the platform on the thrown failure (#23)', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'not json' }));
      await expect(backend.inspect()).rejects.toMatchObject({
        _inspectUnreadable: true,
        platform: 'Windows',
      });
    });

    it.each([['null'], ['']])(
      'still reports a genuinely empty clipboard (%s) as an empty success',
      async (stdout) => {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout }));
        await expect(backend.inspect()).resolves.toEqual({
          primaryFormat: 'empty',
          availableFormats: [],
          rawTypes: [],
        });
      },
    );

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
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('clipboard contents') }));
      const result = await backend.read('text', FULL);
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('clipboard contents');
      const [cmd] = mockSpawn.mock.calls[0] as [string];
      expect(cmd).toBe('powershell.exe');
    });

    it('throws when the text representation is absent', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/not found/i);
    });

    it('preserves leading and trailing whitespace and embedded newlines exactly', async () => {
      const text = '  padded text\r\nsecond line\n';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: `${stringEnvelope(text)}\r\n` }));

      const result = await backend.read('text', FULL);

      expect(result.content.toString('utf8')).toBe(text);
    });

    it('returns an empty buffer when an empty text representation is present', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('') }));

      const result = await backend.read('text', FULL);

      expect(result).toEqual({ format: 'text', content: Buffer.alloc(0), totalByteSize: 0 });
    });
  });

  describe('read() html', () => {
    it('reads HTML via PowerShell .NET', async () => {
      mockSpawn.mockReturnValueOnce(
        fakeChild({ stdout: stringEnvelope('<html><body>test</body></html>') }),
      );
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toContain('<html>');
    });

    it('preserves HTML whitespace and newlines exactly', async () => {
      const html = '  <div>first line</div>\r\n<div>second line</div>  \n';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope(html) }));

      const result = await backend.read('html', FULL);

      expect(result.content.toString('utf8')).toBe(html);
    });
  });

  describe('read() rtf', () => {
    it('preserves RTF whitespace and newlines exactly', async () => {
      const rtf = '  {\\rtf1\r\n padded }  \n';
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope(rtf) }));

      const result = await backend.read('rtf', FULL);

      expect(result.content.toString('utf8')).toBe(rtf);
    });
  });

  describe('read() image', () => {
    it('reads image as base64 PNG with dimensions', async () => {
      const pngData = Buffer.from('fakepngdata');
      const psResult = imageEnvelope(pngData, 800, 600);
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: psResult }));
      const result = await backend.read('image', FULL);
      expect(result.format).toBe('image');
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
      expect(result.content).toEqual(pngData);
    });

    it('captures image dimensions before disposing the image', async () => {
      const pngData = Buffer.from('fakepngdata');
      mockSpawn.mockReturnValueOnce(
        fakeChild({
          stdout: imageEnvelope(pngData, 800, 600),
        }),
      );

      await backend.read('image', FULL);

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      const disposeIndex = script.indexOf('$img.Dispose()');
      const widthIndex = script.indexOf('$w = $img.Width');
      const heightIndex = script.indexOf('$h = $img.Height');
      expect(widthIndex).toBeGreaterThanOrEqual(0);
      expect(heightIndex).toBeGreaterThanOrEqual(0);
      expect(disposeIndex).toBeGreaterThanOrEqual(0);
      expect(widthIndex).toBeLessThan(disposeIndex);
      expect(heightIndex).toBeLessThan(disposeIndex);
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

    it('writes the tag-stripped plain-text fallback alongside HTML', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));
      const html = '<h1>Title</h1><script>alert(1)</script><p>Body</p>';

      await backend.write(html, 'html');

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain(JSON.stringify(Buffer.from('Title Body').toString('base64')));
    });
  });

  describe('clear() (#24)', () => {
    it('clears via the .NET Clipboard::Clear API without setting data', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));

      await backend.clear();

      const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('powershell.exe');
      const script = args.at(-1) ?? '';
      expect(script).toContain('[System.Windows.Forms.Clipboard]::Clear()');
      expect(script).not.toContain('SetText');
      expect(script).not.toContain('SetDataObject');
    });

    it('propagates a PowerShell failure', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'CLIPBRD_E_CANT_OPEN' }));

      await expect(backend.clear()).rejects.toThrow(/powershell exited 1/);
    });
  });

  describe('missing PowerShell detection', () => {
    it('throws when powershell.exe not found', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/powershell/i);
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

describe('WindowsBackend write() html — numeric entity fallback (#25)', () => {
  let backend: WindowsBackend;

  beforeEach(() => {
    backend = new WindowsBackend();
    vi.clearAllMocks();
  });

  it.each([
    ['decimal', '<p>&#169; 2026</p>', '© 2026'],
    ['hexadecimal', '<p>&#xA9; 2026</p>', '© 2026'],
    ['astral', '<p>Smile &#128512;</p>', 'Smile 😀'],
  ])(
    'publishes the decoded %s reference in the plain-text fallback',
    async (_label, html, expected) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '' }));

      await backend.write(html, 'html');

      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain(JSON.stringify(Buffer.from(expected, 'utf8').toString('base64')));
    },
  );
});

describe('WindowsBackend — ranged helper scripts (#7)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.clearAllMocks();
  });

  it('interpolates offset and limit into every PowerShell read script', async () => {
    for (const format of ['text', 'html', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(
        fakeChild({ stdout: imageEnvelope(Buffer.from('payload'), 1, 1) }),
      );
      await backend.read(format, { offset: 5, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain('$offset = 5');
      expect(script).toContain('$limit = 7');
      expect(script).toContain('total = $total');
    }
  });

  it('refuses to build a script from an unsafe range', async () => {
    await expect(backend.read('text', { offset: 1.5, limit: 4 })).rejects.toThrow(
      /Invalid read range offset/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('decodes the windowed envelope and its total', async () => {
    const full = Buffer.from('0123456789');
    mockSpawn.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          present: true,
          total: full.byteLength,
          contentBase64: full.subarray(2, 6).toString('base64'),
        }),
      }),
    );
    const result = await backend.read('text', { offset: 2, limit: 4 });
    expect(result.content.toString()).toBe('2345');
    expect(result.totalByteSize).toBe(10);
  });
});
