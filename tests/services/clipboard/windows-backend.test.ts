/**
 * @fileoverview Unit tests for WindowsBackend — mocks child_process.spawn.
 * @module tests/services/clipboard/windows-backend.test
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { buildCfHtml } from '@/services/clipboard/cf-html.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';
import { type HelperScript, scriptedSpawn } from './scripted-spawn.js';

const mockSpawn = vi.mocked(spawn);

/** Decode the JSON envelope a writer received on stdin. */
function envelopeOf(stdin: Buffer | undefined): { html?: string; text?: string } {
  if (!stdin) throw new Error('writer received no stdin');
  return JSON.parse(stdin.toString('utf8')) as { html?: string; text?: string };
}

/** Integer literal a PowerShell script assigns to `$name`. */
function psInt(script: string, name: string): number {
  const match = new RegExp(`^\\$${name} = (\\d+)$`, 'm').exec(script);
  if (!match?.[1]) throw new Error(`script assigns no $${name}`);
  return Number(match[1]);
}

/**
 * Model of the HTML read helper over the raw `HTML Format` bytes `payload`:
 * it answers exactly the prefix and window the script requests, the way the
 * real script moves bytes without interpreting them. `payloadFor(n)` lets the
 * clipboard change between the nth and a later call.
 */
function htmlClipboard(payloadFor: (call: number) => Buffer | undefined): HelperScript {
  let call = 0;
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    const payload = payloadFor(call++);
    if (!payload) return { stdout: JSON.stringify({ present: false }) };
    const total = payload.byteLength;
    let dataEnd = total;
    while (dataEnd > 0 && payload[dataEnd - 1] === 0) dataEnd--;
    const prefix = payload.subarray(0, Math.min(psInt(script, 'prefixLimit'), total));
    const from = Math.min(psInt(script, 'windowOffset'), total);
    const window = payload.subarray(from, from + psInt(script, 'windowLimit'));
    return {
      stdout: JSON.stringify({
        present: true,
        total,
        dataEnd,
        sha256: createHash('sha256').update(payload).digest('base64'),
        prefixBase64: prefix.toString('base64'),
        contentBase64: window.toString('base64'),
      }),
    };
  };
}

/** Serve reads from `htmlClipboard` and record every helper call. */
function installHtml(payloadFor: (call: number) => Buffer | undefined) {
  const fake = scriptedSpawn(htmlClipboard(payloadFor));
  mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
  return fake;
}

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
    vi.resetAllMocks();
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

  describe('read() html — headerless payloads (characterization)', () => {
    it('returns a payload with no CF_HTML header verbatim', async () => {
      installHtml(() => Buffer.from('<html><body>test</body></html>'));
      const result = await backend.read('html', FULL);
      expect(result.format).toBe('html');
      expect(result.content.toString('utf8')).toBe('<html><body>test</body></html>');
    });

    it('preserves HTML whitespace and newlines exactly', async () => {
      const html = '  <div>first line</div>\r\n<div>second line</div>  \n';
      installHtml(() => Buffer.from(html));

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

  describe('write() (#31)', () => {
    it('writes text through the stdin-fed writer as UnicodeText', async () => {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      const result = await backend.write('hello world', 'text');

      expect(result).toEqual({ format: 'text', byteSize: 11 });
      const [call] = fake.calls;
      expect(call?.command).toBe('powershell.exe');
      expect(call?.args.join(' ')).not.toContain('hello world');
      expect(call?.args.join(' ')).not.toContain(Buffer.from('hello world').toString('base64'));
      expect(envelopeOf(call?.stdin)).toEqual({
        text: Buffer.from('hello world').toString('base64'),
      });
      const script = call?.args.at(-1) ?? '';
      expect(script).toContain('[Console]::OpenStandardInput()');
      expect(script).toContain('[System.Windows.Forms.DataFormats]::UnicodeText');
    });

    it('fails when the writer exits non-zero', async () => {
      const fake = scriptedSpawn(() => ({ exitCode: 1, stderr: 'OpenClipboard Failed' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await expect(backend.write('hello', 'text')).rejects.toThrow(/powershell exited 1/);
    });

    it('stops on any failed set and exits non-zero', async () => {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write('hello', 'text');

      const script = fake.calls[0]?.args.at(-1) ?? '';
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toMatch(/catch \{[^}]*exit 1/s);
    });
  });

  describe('write() html (#37)', () => {
    it('sends a CF_HTML envelope and the tag-stripped fallback on stdin', async () => {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      const html = '<h1>Title</h1><script>alert(1)</script><p>café 😀</p>';

      const result = await backend.write(html, 'html');

      expect(result).toEqual({ format: 'html', byteSize: Buffer.byteLength(html) });
      const envelope = envelopeOf(fake.calls[0]?.stdin);
      expect(Buffer.from(envelope.html ?? '', 'base64').equals(buildCfHtml(html))).toBe(true);
      expect(Buffer.from(envelope.text ?? '', 'base64').toString('utf8')).toBe('Title café 😀');
    });

    it('stores the envelope bytes as a MemoryStream and the fallback as UnicodeText', async () => {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write('<p>x</p>', 'html');

      const script = fake.calls[0]?.args.at(-1) ?? '';
      expect(script).toContain("SetData('HTML Format', [System.IO.MemoryStream]::new(");
      expect(script).toContain('[System.Windows.Forms.DataFormats]::UnicodeText');
      expect(script).not.toContain('[System.Windows.Forms.DataFormats]::Text,');
      expect(script).not.toContain('[System.Windows.Forms.DataFormats]::Html');
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

  describe('security — injection prevention (#31)', () => {
    const INJECTION_PAYLOADS = [
      '"; $(whoami); "',
      '; Invoke-Expression "whoami"',
      '$(cat /etc/passwd)',
      '| cat /etc/passwd',
      '\x00',
    ];

    async function writeArgs(payload: string, format: 'text' | 'html') {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      await backend.write(payload, format);
      return fake.calls[0];
    }

    it.each(INJECTION_PAYLOADS)(
      'write: argv is constant, payload only on stdin (%j)',
      async (payload) => {
        for (const format of ['text', 'html'] as const) {
          const baseline = await writeArgs('x', format);
          const injected = await writeArgs(payload, format);
          expect(injected?.args).toEqual(baseline?.args);
          const envelope = envelopeOf(injected?.stdin);
          if (format === 'text') {
            expect(Buffer.from(envelope.text ?? '', 'base64').toString()).toBe(payload);
          } else {
            expect(Buffer.from(envelope.html ?? '', 'base64').equals(buildCfHtml(payload))).toBe(
              true,
            );
          }
        }
      },
    );
  });
});

describe('WindowsBackend write() html — numeric entity fallback (#25)', () => {
  let backend: WindowsBackend;

  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  it.each([
    ['decimal', '<p>&#169; 2026</p>', '© 2026'],
    ['hexadecimal', '<p>&#xA9; 2026</p>', '© 2026'],
    ['astral', '<p>Smile &#128512;</p>', 'Smile 😀'],
  ])(
    'publishes the decoded %s reference in the plain-text fallback',
    async (_label, html, expected) => {
      const fake = scriptedSpawn(() => ({}));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write(html, 'html');

      expect(envelopeOf(fake.calls[0]?.stdin).text).toBe(
        Buffer.from(expected, 'utf8').toString('base64'),
      );
    },
  );
});

describe('WindowsBackend — ranged helper scripts (#7)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  it('interpolates offset and limit into the text, RTF, and image read scripts', async () => {
    for (const format of ['text', 'rtf', 'image'] as const) {
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

describe('WindowsBackend — typed outcomes (#36)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['text', 'html', 'rtf', 'image'] as const)(
    'an absent %s representation is format_unavailable',
    async (format) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(new WindowsBackend().read(format, FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    },
  );

  it('a missing powershell.exe is clipboard_unavailable', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ errorCode: 'ENOENT' }));
    await expect(new WindowsBackend().read('text', FULL)).rejects.toMatchObject({
      category: 'clipboard_unavailable',
      recoveryHint: expect.stringMatching(/PowerShell/),
    });
  });

  it('a PowerShell failure is not mistaken for an absent format', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'CLIPBRD_E_CANT_OPEN' }));
    const failure = new WindowsBackend().read('html', FULL);
    await expect(failure).rejects.toThrow(/powershell exited 1/);
    await expect(failure).rejects.not.toHaveProperty('category');
  });
});

describe('WindowsBackend read() html — CF_HTML framing (#37)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  /** Hand-built context-less envelope (`StartHTML:-1`), LF line endings, zero padding. */
  function contextless(fragment: string): Buffer {
    const lines = (sf: number, ef: number) =>
      `Version:1.0\nStartHTML:-1\nEndHTML:-1\nStartFragment:${String(sf).padStart(8, '0')}\nEndFragment:${String(ef).padStart(8, '0')}\n`;
    const header = lines(0, 0);
    const sf = Buffer.byteLength(header) + Buffer.byteLength('<!--StartFragment-->');
    const ef = sf + Buffer.byteLength(fragment);
    return Buffer.from(`${lines(sf, ef)}<!--StartFragment-->${fragment}<!--EndFragment-->`);
  }

  it('returns [StartFragment, EndFragment) of a small envelope in one helper call', async () => {
    const fake = installHtml(() => buildCfHtml('<p>café 😀</p>'));

    const result = await backend.read('html', FULL);

    expect(result.content.toString('utf8')).toBe('<p>café 😀</p>');
    expect(result.totalByteSize).toBe(Buffer.byteLength('<p>café 😀</p>'));
    expect(fake.calls).toHaveLength(1);
  });

  it('reads a context-less envelope (StartHTML:-1) with trailing NUL padding', async () => {
    installHtml(() => Buffer.concat([contextless('<p>x</p>'), Buffer.alloc(3)]));
    const result = await backend.read('html', FULL);
    expect(result.content.toString()).toBe('<p>x</p>');
    expect(result.totalByteSize).toBe(8);
  });

  it('a headerless payload is returned verbatim minus trailing NULs', async () => {
    installHtml(() => Buffer.from('<b>raw</b>\0\0'));
    const result = await backend.read('html', FULL);
    expect(result.content.toString()).toBe('<b>raw</b>');
    expect(result.totalByteSize).toBe(10);
  });

  it('applies offset and limit to the fragment, and ranged reads reassemble it exactly', async () => {
    const fragment = '<p>ranged é😀 reads</p>';
    installHtml(() => buildCfHtml(fragment));
    const total = Buffer.byteLength(fragment);
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < total; offset += 5) {
      const slice = await backend.read('html', { offset, limit: 5 });
      expect(slice.totalByteSize).toBe(total);
      pieces.push(slice.content);
    }
    expect(Buffer.concat(pieces).toString('utf8')).toBe(fragment);
  });

  it.each([
    ['at the end', 0],
    ['one past the end', 1],
    ['far past the end', 10_000_000],
  ])('an offset %s returns an empty slice with the fragment total', async (_label, beyond) => {
    installHtml(() => buildCfHtml('<p>ok</p>'));
    const result = await backend.read('html', { offset: 9 + beyond, limit: 4 });
    expect(result.content.byteLength).toBe(0);
    expect(result.totalByteSize).toBe(9);
  });

  it('fetches a window beyond the prefix with a second call, holding at most prefix plus window', async () => {
    const fragment = `<p>${'a'.repeat(300_000)}Z</p>`;
    const fake = installHtml(() => buildCfHtml(fragment));

    const result = await backend.read('html', { offset: 300_003, limit: 5 });

    expect(result.content.toString()).toBe('Z</p>');
    expect(result.totalByteSize).toBe(Buffer.byteLength(fragment));
    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1]?.args.at(-1) ?? '';
    expect(psInt(second, 'windowLimit')).toBe(5);
    for (const call of fake.calls) {
      expect(psInt(call.args.at(-1) ?? '', 'prefixLimit')).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it('a large headerless payload is trimmed of trailing NULs across the two calls', async () => {
    const body = `${'b'.repeat(200_000)}END`;
    installHtml(() => Buffer.concat([Buffer.from(body), Buffer.alloc(2)]));
    const result = await backend.read('html', { offset: 200_000, limit: 100 });
    expect(result.content.toString()).toBe('END');
    expect(result.totalByteSize).toBe(200_003);
  });

  it('fails when the clipboard changes between the header call and the window call', async () => {
    const before = buildCfHtml(`<p>${'a'.repeat(300_000)}</p>`);
    const after = buildCfHtml(`<p>${'b'.repeat(300_001)}</p>`);
    installHtml((call) => (call === 0 ? before : after));
    await expect(backend.read('html', { offset: 200_000, limit: 10 })).rejects.toThrow(
      /clipboard changed/i,
    );
  });

  it('fails when the clipboard changes past the prefix between calls, even at the same size', async () => {
    const before = `<p>${'a'.repeat(300_000)}</p>`;
    const after = `${before.slice(0, 250_000)}b${before.slice(250_001)}`;
    installHtml((call) => buildCfHtml(call === 0 ? before : after));
    await expect(backend.read('html', { offset: 200_000, limit: 10 })).rejects.toThrow(
      /clipboard changed/i,
    );
  });

  it('a malformed header fails naming the field and never returns header text', async () => {
    const broken = Buffer.from(
      buildCfHtml('<p>x</p>')
        .toString('latin1')
        .replace(/StartFragment:\d+/, 'StartFragment:00000000zz'),
      'latin1',
    );
    installHtml(() => broken);
    await expect(backend.read('html', FULL)).rejects.toThrow(/StartFragment/);
  });

  it.each([
    ['non-JSON output', 'At line:1 char:1 secret-clipboard-bytes'],
    ['a response missing the prefix', JSON.stringify({ present: true, total: 3, dataEnd: 3 })],
  ])('%s is a SerializationError that carries no helper output', async (_label, stdout) => {
    const fake = scriptedSpawn(() => ({ stdout }));
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    const failure = backend.read('html', FULL);
    await expect(failure).rejects.toMatchObject({ code: -32070 });
    await expect(failure).rejects.not.toHaveProperty('category');
    const error = await failure.catch((err: unknown) => err);
    expect(JSON.stringify(error)).not.toContain('secret-clipboard-bytes');
  });

  it('an absent HTML Format is format_unavailable', async () => {
    installHtml(() => undefined);
    await expect(backend.read('html', FULL)).rejects.toMatchObject({
      category: 'format_unavailable',
    });
  });

  it('no PowerShell script parses CF_HTML — the helper only moves bytes', async () => {
    const fake = installHtml(() => buildCfHtml(`<p>${'a'.repeat(300_000)}</p>`));
    await backend.read('html', { offset: 100_000, limit: 10 });
    const writer = scriptedSpawn(() => ({}));
    mockSpawn.mockImplementation(writer.spawnImpl as unknown as typeof spawn);
    await backend.write('<p>x</p>', 'html');
    for (const call of [...fake.calls, ...writer.calls]) {
      const script = call.args.at(-1) ?? '';
      expect(script).not.toMatch(/StartFragment|EndFragment|StartHTML|Version:|<html|IndexOf/i);
    }
  });
});
