/**
 * @fileoverview Unit tests for WindowsBackend — mocks child_process.spawn; where
 * `pwsh` is on PATH, also runs the FileDrop helper scripts under it against a
 * WinForms stub.
 * @module tests/services/clipboard/windows-backend.test
 */

import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { buildCfHtml } from '@/services/clipboard/cf-html.js';
import { WindowsBackend } from '@/services/clipboard/windows-backend.js';
import { REAL_PNG_13x7 } from './png-fixtures.js';
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

/** The revision the read helpers compute: base64 SHA-256 of the full representation. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function stringEnvelope(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
    revision: sha256Of(bytes),
  });
}

/** The ranged-read envelope the image script prints for a present image, whole. */
function imageEnvelope(bytes: Buffer, width: number, height: number): string {
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
    revision: sha256Of(bytes),
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
          itemCount: 0,
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

      expect(result).toEqual({
        format: 'text',
        content: Buffer.alloc(0),
        totalByteSize: 0,
        revision: sha256Of(Buffer.alloc(0)),
        itemCount: 1,
      });
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
      expect(Buffer.from(envelope.text ?? '', 'base64').toString('utf8')).toBe('Title\n\ncafé 😀');
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

  it('encodes each slice straight from the full array, never through a range-operator copy (#47)', async () => {
    const expected = {
      text: ['$bytes'],
      rtf: ['$bytes'],
      image: ['$png', '$bytes', '$png'],
    } as const;
    for (const format of ['text', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(
        fakeChild({ stdout: imageEnvelope(Buffer.from('payload'), 1, 1) }),
      );
      await backend.read(format, { offset: 5, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      const encoded = [
        ...script.matchAll(
          /contentBase64 = \[Convert\]::ToBase64String\((\$\w+), \$start, \$sliceLen\)/g,
        ),
      ].map((match) => match[1]);
      expect(encoded, format).toEqual(expected[format]);
      // 64-bit clamps: an Int32 first argument makes PowerShell pick Min(Int32, Int32).
      expect(script, format).toContain('$start = [Math]::Min([long]$offset, [long]$total)');
      expect(script, format).toContain(
        '$sliceLen = [Math]::Min([long]$limit, [long]$total - $start)',
      );
      expect(script, format).not.toMatch(/\[\$offset\.\./);
      expect(script, format).not.toContain('$slice ');
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
          revision: sha256Of(full),
        }),
      }),
    );
    const result = await backend.read('text', { offset: 2, limit: 4 });
    expect(result.content.toString()).toBe('2345');
    expect(result.totalByteSize).toBe(10);
    expect(result.revision).toBe(sha256Of(full));
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

describe('WindowsBackend — measured, unmeasured, and failed inspection entries (#41)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  async function inspectScript(): Promise<string> {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
    await backend.inspect();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    return args.at(-1) ?? '';
  }

  it('characterization: the listing sizes strings as UTF-8 and byte arrays by length', async () => {
    const script = await inspectScript();
    expect(script).toContain('[System.Text.Encoding]::UTF8.GetByteCount($obj)');
    expect(script).toContain('$obj -is [byte[]]');
    expect(script).toContain('$obj.Length');
  });

  it('marks a GetData that returns null or throws as measurementFailed, with no zero default', async () => {
    const script = await inspectScript();
    expect(script).toMatch(/\$obj -is \[byte\[\]\]\) \{ \$entry\.bytes = \$obj\.Length \}/);
    expect(script).toMatch(
      /\$obj -is \[System\.IO\.Stream\]\) \{ \$entry\.bytes = \$obj\.Length \}/,
    );
    expect(script).not.toContain('$bytes = 0');
    expect(script).toMatch(/if \(\$null -eq \$obj\) \{ \$entry\.measurementFailed = \$true \}/);
    expect(script).toMatch(/\} catch \{ \$entry\.measurementFailed = \$true \}/);
    // Any other object (a Bitmap, a non-FileDrop string[]) leaves bytes absent.
    expect(script).not.toMatch(/else \{ \$entry\.bytes/);
  });

  it('marks a text or RTF format whose data is not a string as measurementFailed, since those reads take only strings (#41)', async () => {
    const script = await inspectScript();
    const formats = [
      '[System.Windows.Forms.DataFormats]::UnicodeText',
      '[System.Windows.Forms.DataFormats]::Text',
      '[System.Windows.Forms.DataFormats]::OemText',
      '[System.Windows.Forms.DataFormats]::Rtf',
    ];
    expect(script).toContain(`$stringOnly = @(${formats.join(', ')})`);
    const stringBranch = script.indexOf('elseif ($obj -is [string])');
    const stringOnlyBranch = script.indexOf(
      'elseif ($stringOnly -contains $fmt) { $entry.measurementFailed = $true }',
    );
    expect(stringOnlyBranch).toBeGreaterThan(stringBranch);
    expect(stringOnlyBranch).toBeLessThan(script.indexOf('elseif ($obj -is [byte[]])'));
    // The same four formats are the only ones the text and RTF reads look up.
    for (const format of ['text', 'rtf'] as const) {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('abc') }));
      await backend.read(format, FULL);
      const read = (mockSpawn.mock.calls.at(-1) as [string, string[]])[1].at(-1) ?? '';
      expect(read).toContain('-is [string]');
      for (const name of read.match(/\[System\.Windows\.Forms\.DataFormats\]::\w+/g) ?? []) {
        expect(formats).toContain(name);
      }
    }
  });

  it('keeps unmeasured and failed entries without a size, and only read entries make a format available', async () => {
    const listing = [
      { type: 'Bitmap' },
      { type: 'UnicodeText', measurementFailed: true },
      { type: 'Rich Text Format', bytes: 0 },
    ];
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify(listing) }));
    await expect(backend.inspect()).resolves.toEqual({
      primaryFormat: 'image',
      availableFormats: ['rtf', 'image'],
      itemCount: 1,
      rawTypes: listing,
    });
  });

  it('still rejects an entry that is neither measured, unmeasured, nor failed', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({ stdout: '[{"type":"Text","bytes":4,"measurementFailed":true}]' }),
    );
    await expect(backend.inspect()).rejects.toMatchObject({ _inspectUnreadable: true });
  });

  it('the text read moves on to the next text format when one yields no string', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('abc') }));
    await backend.read('text', FULL);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const script = args.at(-1) ?? '';
    // GetData runs inside the loop, and only a string ends it.
    expect(script).toMatch(
      /foreach \(\$format in \$nativeTextFormats\) \{\s*if \(\$data\.GetDataPresent\(\$format, \$false\)\) \{\s*\$candidate = \$data\.GetData\(\$format, \$false\)\s*if \(\$candidate -is \[string\]\) \{\s*\$text = \$candidate\s*break/,
    );
    expect(script).toMatch(/if \(\$null -ne \$text\) \{/);
  });
});

describe('WindowsBackend — image reads (#43)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  async function imageScript(): Promise<string> {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: imageEnvelope(Buffer.from('x'), 1, 1) }));
    await backend.read('image', FULL);
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    return args.at(-1) ?? '';
  }

  it('reads the PNG format before falling back to GetImage()', async () => {
    const script = await imageScript();
    const pngRead = script.indexOf("$data.GetData('PNG', $false)");
    expect(pngRead).toBeGreaterThanOrEqual(0);
    expect(pngRead).toBeLessThan(script.indexOf('[System.Windows.Forms.Clipboard]::GetImage()'));
    expect(script).toContain('$raw -is [System.IO.MemoryStream]');
    expect(script).toContain('$raw -is [byte[]]');
  });

  it('takes a non-empty PNG only when it decodes, with the decoded dimensions', async () => {
    const script = await imageScript();
    expect(script).toMatch(
      /if \(\$null -ne \$png -and \$png\.Length -gt 0\) \{\s*try \{\s*\$probe = \[System\.Drawing\.Image\]::FromStream\(\[System\.IO\.MemoryStream\]::new\(\$png\)\)\s*\$w = \$probe\.Width\s*\$h = \$probe\.Height\s*\$probe\.Dispose\(\)\s*\$pngDecodes = \$true\s*\} catch \{\}/,
    );
    const pngBranch = script.indexOf('if ($pngDecodes) {');
    expect(pngBranch).toBeGreaterThan(script.indexOf('FromStream'));
    const getImage = script.indexOf('[System.Windows.Forms.Clipboard]::GetImage()');
    expect(script.slice(pngBranch, getImage)).toContain(
      'ComputeHash($png)); width = $w; height = $h }',
    );
  });

  it('falls back to GetImage() for an undecodable PNG, and returns an empty PNG only when it is zero-length', async () => {
    const script = await imageScript();
    expect(script.indexOf('if ($pngDecodes) {')).toBeLessThan(
      script.indexOf('[System.Windows.Forms.Clipboard]::GetImage()'),
    );
    // The empty-PNG branch sits after the GetImage() attempt and takes only zero bytes.
    const emptyBranch = script.indexOf('} elseif ($null -ne $png -and $png.Length -eq 0) {');
    expect(emptyBranch).toBeGreaterThan(
      script.indexOf('[System.Windows.Forms.Clipboard]::GetImage()'),
    );
  });

  it('reports the dimensions the helper decoded, on a slice past the header too', async () => {
    const window = REAL_PNG_13x7.subarray(40, 50);
    mockSpawn.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          present: true,
          total: REAL_PNG_13x7.byteLength,
          contentBase64: window.toString('base64'),
          revision: sha256Of(REAL_PNG_13x7),
          width: 13,
          height: 7,
        }),
      }),
    );
    const result = await backend.read('image', { offset: 40, limit: 10 });
    expect(result).toMatchObject({ width: 13, height: 7, totalByteSize: REAL_PNG_13x7.byteLength });
    expect(result.content.equals(window)).toBe(true);
  });

  it('a zero-length PNG with no bitmap reads as an empty image success', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          present: true,
          total: 0,
          contentBase64: '',
          revision: sha256Of(Buffer.alloc(0)),
        }),
      }),
    );
    await expect(backend.read('image', FULL)).resolves.toEqual({
      format: 'image',
      content: Buffer.alloc(0),
      totalByteSize: 0,
      revision: sha256Of(Buffer.alloc(0)),
      itemCount: 1,
    });
  });

  it('characterization: a Bitmap read keeps the dimensions GetImage() reported', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: imageEnvelope(REAL_PNG_13x7, 800, 600) }));
    await expect(backend.read('image', FULL)).resolves.toMatchObject({ width: 800, height: 600 });
  });

  it.each([
    ['DeviceIndependentBitmap', ['image']],
    ['Format17', ['image']],
    ['Bitmap', ['image']],
    ['PNG', ['image']],
    ['dib', []],
    ['dibv5', []],
    ['FileDrop', ['files']],
    ['FileNameW', []],
    ['Shell IDList Array', []],
  ] as const)('inspection maps %s to %j', async (type, formats) => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify([{ type, bytes: 40 }]) }));
    await expect(backend.inspect()).resolves.toMatchObject({ availableFormats: formats });
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

describe('WindowsBackend — SHA-256 revision computed in the helper (#38)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  /**
   * Model of a sliced read helper over the full representation `full`: it
   * answers the `$offset`/`$limit` window the script asks for and hashes every
   * byte it holds, as `psSliceSnippet` does.
   */
  function slicedClipboard(full: () => Buffer): HelperScript {
    return (_command, args) => {
      const script = args.at(-1) ?? '';
      const bytes = full();
      const from = Math.min(psInt(script, 'offset'), bytes.byteLength);
      return {
        stdout: JSON.stringify({
          present: true,
          total: bytes.byteLength,
          contentBase64: bytes.subarray(from, from + psInt(script, 'limit')).toString('base64'),
          revision: sha256Of(bytes),
        }),
      };
    };
  }

  async function scriptFor(format: 'text' | 'rtf' | 'image'): Promise<string> {
    const fake = scriptedSpawn(slicedClipboard(() => Buffer.from('payload')));
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    await backend.read(format, { offset: 2, limit: 3 });
    return fake.calls[0]?.args.at(-1) ?? '';
  }

  it.each([
    ['text', ['$bytes']],
    ['rtf', ['$bytes']],
    ['image', ['$png', '$bytes', '$png']],
  ] as const)(
    'every %s envelope hashes the full representation variable, never the slice',
    async (format, hashed) => {
      const script = await scriptFor(format);
      const hashes = [
        ...script.matchAll(
          /revision = \[Convert\]::ToBase64String\(\[System\.Security\.Cryptography\.SHA256\]::Create\(\)\.ComputeHash\((\$\w+)\)\)/g,
        ),
      ].map((match) => match[1]);
      expect(hashes).toEqual(hashed);
      expect(script).not.toContain('ComputeHash($slice)');
      // One envelope per present branch, each carrying the revision.
      expect(script.match(/present = \$true/g)).toHaveLength(hashed.length);
    },
  );

  it.each(['text', 'rtf', 'image'] as const)(
    'a %s read returns the helper revision, equal across full and sliced reads of one value',
    async (format) => {
      const value = Buffer.from('AAAA1111');
      const fake = scriptedSpawn(slicedClipboard(() => value));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      const whole = await backend.read(format, FULL);
      const slice = await backend.read(format, { offset: 4, limit: 4 });
      expect(whole.revision).toBe(sha256Of(value));
      expect(slice.revision).toBe(whole.revision);
      expect(slice.content.toString()).toBe('1111');
    },
  );

  it('a same-size replacement between reads changes the revision', async () => {
    let value = Buffer.from('AAAA1111');
    const fake = scriptedSpawn(slicedClipboard(() => value));
    mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
    const first = await backend.read('text', { offset: 0, limit: 4 });
    value = Buffer.from('BBBB2222');
    const second = await backend.read('text', { offset: 4, limit: 4 });
    expect(second.totalByteSize).toBe(first.totalByteSize);
    expect(second.revision).not.toBe(first.revision);
  });

  it('an HTML read reports the whole payload hash on the one-call and the two-call path', async () => {
    const payload = buildCfHtml(`<p>${'a'.repeat(300_000)}Z</p>`);
    const fake = installHtml(() => payload);
    const head = await backend.read('html', { offset: 0, limit: 8 });
    const tail = await backend.read('html', { offset: 300_003, limit: 5 });
    expect(fake.calls).toHaveLength(3);
    expect(head.revision).toBe(sha256Of(payload));
    expect(tail.revision).toBe(head.revision);
    expect(tail.content.toString()).toBe('Z</p>');
  });

  it('the two HTML calls hashing differently fail representation_changed, never a plain Error', async () => {
    const before = buildCfHtml(`<p>${'a'.repeat(300_000)}</p>`);
    const after = buildCfHtml(`<p>${'b'.repeat(300_000)}</p>`);
    installHtml((call) => (call === 0 ? before : after));
    await expect(backend.read('html', { offset: 200_000, limit: 10 })).rejects.toMatchObject({
      _clipboardOutcome: true,
      category: 'representation_changed',
      platform: 'Windows',
      message: expect.stringMatching(/clipboard changed/i),
    });
  });

  it('an envelope without a revision is unreadable', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({ stdout: JSON.stringify({ present: true, total: 1, contentBase64: 'eA==' }) }),
    );
    await expect(backend.read('rtf', FULL)).rejects.toMatchObject({ code: -32070 });
  });
});

/**
 * Model of the FileDrop read helper over the drop list `paths()`: it keeps the
 * paths that hold no line break, joins them with LF, and answers the
 * `$offset`/`$limit` window of those UTF-8 bytes with their SHA-256 and the
 * count it left out — or `present: false` when it keeps none.
 */
function fileDropClipboard(paths: () => readonly string[]): HelperScript {
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    const list = paths();
    const kept = list.filter((path) => !/[\r\n]/.test(path));
    if (kept.length === 0) return { stdout: JSON.stringify({ present: false }) };
    const bytes = Buffer.from(kept.join('\n'));
    const from = Math.min(psInt(script, 'offset'), bytes.byteLength);
    return {
      stdout: JSON.stringify({
        present: true,
        total: bytes.byteLength,
        contentBase64: bytes.subarray(from, from + psInt(script, 'limit')).toString('base64'),
        revision: sha256Of(bytes),
        omittedPaths: list.length - kept.length,
      }),
    };
  };
}

/** Serve reads from `fileDropClipboard` and record every helper call. */
function installFileDrop(paths: () => readonly string[]) {
  const fake = scriptedSpawn(fileDropClipboard(paths));
  mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
  return fake;
}

/** A drop list as Explorer copies it: a local file with a space, one with an accent, a UNC path. */
const DROP_LIST = [
  'C:\\Users\\u\\a b.txt',
  'C:\\Users\\u\\cafe\u0301.txt',
  '\\\\server\\share\\x.pdf',
];

describe('WindowsBackend — one item per data object (#57)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  it('inspect reports one item for a listing with any format', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify([{ type: 'Bitmap' }]) }));
    expect((await backend.inspect()).itemCount).toBe(1);
  });

  it.each(['text', 'rtf', 'image'] as const)(
    'a %s read reports one item and no item scope',
    async (format) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('abc') }));
      const result = await backend.read(format, FULL);
      expect(result.itemCount).toBe(1);
      expect(result).not.toHaveProperty('itemScope');
    },
  );

  it('an html read reports one item and no item scope', async () => {
    installHtml(() => buildCfHtml('<p>x</p>'));
    const result = await backend.read('html', FULL);
    expect(result.itemCount).toBe(1);
    expect(result).not.toHaveProperty('itemScope');
  });

  it('a files read reports one item and no item scope', async () => {
    installFileDrop(() => DROP_LIST);
    const result = await backend.read('files', FULL);
    expect(result.itemCount).toBe(1);
    expect(result).not.toHaveProperty('itemScope');
  });

  it('item 0 reads exactly what a read without item does', async () => {
    mockSpawn
      .mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('abc') }))
      .mockReturnValueOnce(fakeChild({ stdout: stringEnvelope('abc') }));
    const whole = await backend.read('text', FULL);
    expect(await backend.read('text', FULL, 0)).toEqual(whole);
  });

  it.each(['text', 'html', 'rtf', 'image', 'files'] as const)(
    'item 1 on a %s read fails format_unavailable without running PowerShell',
    async (format) => {
      await expect(backend.read(format, FULL, 1)).rejects.toMatchObject({
        _clipboardOutcome: true,
        category: 'format_unavailable',
        platform: 'Windows',
        message: expect.stringContaining('item 1'),
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    },
  );
});

describe('WindowsBackend — files from FileDrop (#59)', () => {
  let backend: WindowsBackend;
  beforeEach(() => {
    backend = new WindowsBackend();
    vi.resetAllMocks();
  });

  const joined = Buffer.from(DROP_LIST.join('\n'));

  it('inspect maps FileDrop to files, the richest format, beside the icon and shell formats Explorer offers', async () => {
    const listing = [
      { type: 'Shell IDList Array', bytes: 412 },
      { type: 'FileDrop', bytes: joined.byteLength },
      { type: 'FileNameW' },
      { type: 'Bitmap' },
    ];
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify(listing) }));
    await expect(backend.inspect()).resolves.toEqual({
      primaryFormat: 'files',
      availableFormats: ['image', 'files'],
      itemCount: 1,
      rawTypes: listing,
    });
  });

  it('a FileDrop the inspection could not list a path from offers no files', async () => {
    const listing = [{ type: 'FileDrop', measurementFailed: true }, { type: 'Bitmap' }];
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify(listing) }));
    await expect(backend.inspect()).resolves.toMatchObject({
      primaryFormat: 'image',
      availableFormats: ['image'],
    });
  });

  it('the inspection sizes FileDrop as its LF-joined listable paths, and fails a list with none', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: 'null' }));
    await backend.inspect();
    const script = mockSpawn.mock.calls[0]?.[1].at(-1) ?? '';
    const branch = script.slice(
      script.indexOf('[System.Windows.Forms.DataFormats]::FileDrop -and $obj -is [string[]]'),
    );
    expect(branch).not.toBe(script);
    expect(branch).toContain('.IndexOfAny([char[]]@(10, 13))');
    expect(branch).toMatch(
      /if \(\$kept\.Count -gt 0\) \{ \$entry\.bytes = \[System\.Text\.Encoding\]::UTF8\.GetByteCount\(\[string\]::Join\(\[string\]\[char\]10, \$kept\.ToArray\(\)\)\) \}\s*else \{ \$entry\.measurementFailed = \$true \}/,
    );
  });

  it('reads the paths in drop-list order, LF-joined, hashed, with one item', async () => {
    installFileDrop(() => DROP_LIST);
    await expect(backend.read('files', FULL)).resolves.toEqual({
      format: 'files',
      content: joined,
      totalByteSize: joined.byteLength,
      revision: sha256Of(joined),
      itemCount: 1,
    });
  });

  it('reports how many paths it left out for holding a line break', async () => {
    installFileDrop(() => ['C:\\a.txt', 'C:\\line\nbreak.txt', 'C:\\b.txt', 'C:\\cr\rhere']);
    const result = await backend.read('files', FULL);
    expect(result.content.toString('utf8')).toBe('C:\\a.txt\nC:\\b.txt');
    expect(result.omittedPaths).toBe(2);
  });

  it('pages through the paths: every window reassembles them under one revision', async () => {
    installFileDrop(() => DROP_LIST);
    for (const limit of [1, 4, 9]) {
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < joined.byteLength; offset += limit) {
        const slice = await backend.read('files', { offset, limit });
        expect(slice.totalByteSize).toBe(joined.byteLength);
        expect(slice.revision).toBe(sha256Of(joined));
        pieces.push(slice.content);
      }
      expect(Buffer.concat(pieces).equals(joined)).toBe(true);
    }
    const past = await backend.read('files', { offset: joined.byteLength + 10, limit: 10 });
    expect(past.content.byteLength).toBe(0);
    expect(past.totalByteSize).toBe(joined.byteLength);
  });

  it.each([
    ['an empty drop list', []],
    ['a drop list of paths it cannot list', ['C:\\a\nb']],
  ])('%s is format_unavailable naming FileDrop', async (_label, paths) => {
    installFileDrop(() => paths);
    await expect(backend.read('files', FULL)).rejects.toMatchObject({
      category: 'format_unavailable',
      message: expect.stringMatching(/FileDrop/),
    });
  });

  it('the read script takes the drop list from GetFileDropList, slices its LF-joined UTF-8 bytes, and hashes them whole', async () => {
    const fake = installFileDrop(() => DROP_LIST);
    await backend.read('files', { offset: 2, limit: 3 });
    const script = fake.calls[0]?.args.at(-1) ?? '';
    expect(script).toContain('$list = [System.Windows.Forms.Clipboard]::GetFileDropList()');
    expect(script).toContain('.IndexOfAny([char[]]@(10, 13))');
    expect(script).toContain(
      '$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]::Join([string][char]10, $kept.ToArray()))',
    );
    expect(script).toContain('$offset = 2');
    expect(script).toContain('$limit = 3');
    expect(script).toContain(
      'contentBase64 = [Convert]::ToBase64String($bytes, $start, $sliceLen)',
    );
    expect(script).toContain('ComputeHash($bytes)); omittedPaths = $omitted }');
    expect(script).not.toContain('C:\\Users');
  });

  it('refuses to build the files script from an unsafe range', async () => {
    await expect(backend.read('files', { offset: -1, limit: 4 })).rejects.toThrow(
      /Invalid read range offset/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

const actualChildProcess = await vi.importActual<typeof ChildProcess>('node:child_process');

/** Environment for every pwsh this file starts: no startup telemetry or update check. */
const PWSH_ENV = {
  ...process.env,
  POWERSHELL_TELEMETRY_OPTOUT: '1',
  POWERSHELL_UPDATECHECK: 'Off',
};

const hasPwsh =
  actualChildProcess.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    env: PWSH_ENV,
  }).status === 0;

/** The line every helper script loads WinForms with; the suite below swaps it for the stub. */
const LOAD_WINFORMS = 'Add-Type -AssemblyName System.Windows.Forms';

/**
 * C# stub of the `System.Windows.Forms` members the FileDrop inspection and read
 * call. `Clipboard.Files` is the drop list a case sets: `GetFileDropList()`
 * returns it as a `StringCollection` and `GetDataObject()` offers it as
 * `FileDrop` data, a `string[]`, as WinForms does.
 */
const WINFORMS_STUB = `
namespace System.Windows.Forms {
  public static class DataFormats {
    public static readonly string UnicodeText = "UnicodeText";
    public static readonly string Text = "Text";
    public static readonly string OemText = "OEMText";
    public static readonly string Rtf = "Rich Text Format";
    public static readonly string FileDrop = "FileDrop";
  }
  public sealed class DataObject {
    private readonly string[] files;
    public DataObject(string[] files) { this.files = files; }
    public string[] GetFormats(bool autoConvert) { return new[] { DataFormats.FileDrop }; }
    public object GetData(string format) { return format == DataFormats.FileDrop ? files : null; }
  }
  public static class Clipboard {
    public static string[] Files = new string[0];
    public static DataObject GetDataObject() { return new DataObject(Files); }
    public static System.Collections.Specialized.StringCollection GetFileDropList() {
      var list = new System.Collections.Specialized.StringCollection();
      list.AddRange(Files);
      return list;
    }
  }
}`;

/**
 * The inspection and files-read scripts the backend generates, run end to end
 * under PowerShell 7 with only their WinForms load replaced by the stub, so the
 * shipped line-break filter and both "no path to list" branches run for real
 * rather than through a TypeScript model of them.
 */
describe.skipIf(!hasPwsh)(
  'WindowsBackend — FileDrop scripts run under pwsh (skipped when pwsh is not on PATH)',
  { timeout: 30_000 },
  () => {
    let dir = '';
    let stubPath = '';
    let dropList: readonly string[] = [];
    let backend: WindowsBackend;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'clipboard-pwsh-'));
      stubPath = join(dir, 'winforms-stub.dll');
      const compiled = actualChildProcess.spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -TypeDefinition $env:WINFORMS_STUB -OutputAssembly $env:WINFORMS_STUB_PATH -OutputType Library',
        ],
        { env: { ...PWSH_ENV, WINFORMS_STUB, WINFORMS_STUB_PATH: stubPath } },
      );
      if (compiled.status !== 0) {
        throw new Error(`compiling the WinForms stub failed: ${compiled.stderr.toString()}`);
      }
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      backend = new WindowsBackend();
      vi.resetAllMocks();
      mockSpawn.mockImplementation(((command: string, args: readonly string[], options: object) => {
        const parts = (args.at(-1) ?? '').split(LOAD_WINFORMS);
        if (command !== 'powershell.exe' || parts.length !== 2) {
          throw new Error(
            `test isolation: expected one powershell.exe script with one ${LOAD_WINFORMS}`,
          );
        }
        const files = dropList
          .map(
            (path) =>
              `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString('base64')}'))`,
          )
          .join(', ');
        const stubbed = `Add-Type -Path '${stubPath.replaceAll("'", "''")}'\n[System.Windows.Forms.Clipboard]::Files = [string[]]@(${files})${parts.join('')}`;
        return actualChildProcess.spawn('pwsh', args.with(-1, stubbed), {
          ...options,
          env: PWSH_ENV,
        });
      }) as unknown as typeof spawn);
    });

    it.each([
      ['a clean list', DROP_LIST, DROP_LIST.join('\n'), {}],
      [
        'an LF path',
        ['C:\\a.txt', 'C:\\line\nbreak.txt', 'C:\\b.txt'],
        'C:\\a.txt\nC:\\b.txt',
        { omittedPaths: 1 },
      ],
      ['a CR path', ['C:\\cr\rhere.txt', 'C:\\b.txt'], 'C:\\b.txt', { omittedPaths: 1 }],
      ['a CRLF path', ['C:\\a.txt', 'C:\\crlf\r\npath.txt'], 'C:\\a.txt', { omittedPaths: 1 }],
    ])(
      '%s: inspect sizes the kept paths, and the read returns them with the left-out count',
      async (_label, list, kept, omitted) => {
        dropList = list;
        const bytes = Buffer.from(kept);
        await expect(backend.inspect()).resolves.toEqual({
          primaryFormat: 'files',
          availableFormats: ['files'],
          itemCount: 1,
          rawTypes: [{ type: 'FileDrop', bytes: bytes.byteLength }],
        });
        await expect(backend.read('files', FULL)).resolves.toEqual({
          format: 'files',
          content: bytes,
          totalByteSize: bytes.byteLength,
          revision: sha256Of(bytes),
          itemCount: 1,
          ...omitted,
        });
      },
    );

    it('a list whose every path holds a line break: inspect fails the FileDrop measurement, and the read is format_unavailable', async () => {
      dropList = ['C:\\a\nb', 'C:\\c\rd', 'C:\\e\r\nf'];
      await expect(backend.inspect()).resolves.toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        itemCount: 1,
        rawTypes: [{ type: 'FileDrop', measurementFailed: true }],
      });
      await expect(backend.read('files', FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
        message: expect.stringMatching(/FileDrop/),
      });
    });
  },
);
