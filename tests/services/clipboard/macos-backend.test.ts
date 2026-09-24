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
import { scriptedSpawn } from './scripted-spawn.js';

const mockSpawn = vi.mocked(spawn);

/** Decode the JSON envelope a writer received on stdin. */
function envelopeOf(stdin: Buffer | undefined): { html?: string; text?: string } {
  if (!stdin) throw new Error('writer received no stdin');
  return JSON.parse(stdin.toString('utf8')) as { html?: string; text?: string };
}

/** Full-representation range: what the service passes for an unranged read. */
const FULL = { offset: 0, limit: 8 * 1024 * 1024 } as const;

/** The pasteboard changeCount the modeled read scripts report as their revision. */
const CHANGE_COUNT = '4217';

/** The ranged-read envelope a JXA read script prints for a present representation, whole. */
function jxaEnvelope(bytes: Buffer, extra: Record<string, number> = {}): string {
  return JSON.stringify({
    present: true,
    total: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
    revision: CHANGE_COUNT,
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
    vi.resetAllMocks();
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

  describe('inspect() — nil data is a failed measurement (#41)', () => {
    it('the JXA listing reports nil data as measurementFailed, never as zero bytes', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: '[]' }));
      await backend.inspect();
      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain('measurementFailed: true');
      expect(script).not.toMatch(/isNil\(\) \? 0/);
    });

    it('a failed text measurement alone does not make text available', async () => {
      const listing = [
        { type: 'public.rtf', bytes: 9 },
        { type: 'public.utf8-plain-text', measurementFailed: true },
        { type: 'NSStringPboardType', measurementFailed: true },
      ];
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify(listing) }));
      await expect(backend.inspect()).resolves.toEqual({
        primaryFormat: 'rtf',
        availableFormats: ['rtf'],
        rawTypes: listing,
      });
    });

    it('a measured zero-byte text representation keeps text available', async () => {
      const listing = [{ type: 'public.utf8-plain-text', bytes: 0 }];
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify(listing) }));
      await expect(backend.inspect()).resolves.toMatchObject({
        availableFormats: ['text'],
        rawTypes: listing,
      });
    });
  });

  describe('inspect() — type mapping', () => {
    it.each([
      ['public.utf8-plain-text', 'text'],
      ['public.plain-text', 'text'],
      ['NSStringPboardType', 'text'],
      ['public.html', 'html'],
      ['public.rtf', 'rtf'],
      ['com.apple.flat-rtfd', 'rtf'],
      ['public.png', 'image'],
      ['public.tiff', 'image'],
      ['com.apple.pict', 'image'],
    ])('characterization: %s maps to %s', async (type, format) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify([{ type, bytes: 3 }]) }));
      await expect(backend.inspect()).resolves.toMatchObject({ availableFormats: [format] });
    });

    it.each(['NSHTMLPboardType', 'NSRTFPboardType', 'NSRTFDPboardType'])(
      '%s, a name pb.types never lists, maps to no format',
      async (type) => {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify([{ type, bytes: 3 }]) }));
        await expect(backend.inspect()).resolves.toMatchObject({
          availableFormats: [],
          primaryFormat: 'empty',
        });
      },
    );
  });

  describe('read() text (#42)', () => {
    it('reads text with one ranged JXA dataForType read, never pbpaste', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('hello world')) }));
      const result = await backend.read('text', FULL);
      expect(result).toEqual({
        format: 'text',
        content: Buffer.from('hello world'),
        totalByteSize: 11,
        revision: CHANGE_COUNT,
      });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [command, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(command).toBe('osascript');
      const script = args.at(-1) ?? '';
      expect(script).toContain("pb.dataForType('public.utf8-plain-text')");
      expect(script).toContain("pb.dataForType('public.plain-text')");
      expect(script.indexOf('public.utf8-plain-text')).toBeLessThan(
        script.indexOf('public.plain-text'),
      );
      expect(script).not.toContain('stringForType');
    });

    it('round-trips unicode, emoji, and a leading byte-order mark', async () => {
      const bytes = Buffer.from('﻿Hello 世界 🌍', 'utf8');
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(bytes) }));
      const result = await backend.read('text', FULL);
      expect(result.content.equals(bytes)).toBe(true);
      expect(result.totalByteSize).toBe(bytes.byteLength);
    });

    it('spawns no pbpaste and pins no locale on any read', async () => {
      for (const format of ['text', 'html', 'rtf', 'image'] as const) {
        mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('x')) }));
        await backend.read(format, FULL);
      }
      for (const [command, , options] of mockSpawn.mock.calls as [string, string[], object][]) {
        expect(command).toBe('osascript');
        expect(options).not.toHaveProperty('env');
      }
    });
  });

  describe('read() html reads raw bytes (#42)', () => {
    it('slices dataForType(public.html) directly, never through stringForType', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('<p>x</p>')) }));
      await backend.read('html', FULL);
      const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain("pb.dataForType('public.html')");
      expect(script).not.toContain('stringForType');
      expect(script).not.toContain('dataUsingEncoding');
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
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(backend.read('text', FULL)).rejects.toThrow(/not found/i);
    });

    it('returns empty buffer when text type is present but content is empty', async () => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.alloc(0)) }));
      const result = await backend.read('text', FULL);
      expect(result.format).toBe('text');
      expect(result.content.toString('utf8')).toBe('');
      expect(result.totalByteSize).toBe(0);
    });
  });

  describe('write() text (#30)', () => {
    it('writes text through the stdin-fed JXA writer, never pbcopy', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      const result = await backend.write('hello', 'text');

      expect(result).toEqual({ format: 'text', byteSize: 5 });
      expect(fake.calls).toHaveLength(1);
      const [call] = fake.calls;
      expect(call?.command).toBe('osascript');
      expect(call?.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
      expect(envelopeOf(call?.stdin)).toEqual({
        text: Buffer.from('hello').toString('base64'),
      });
    });

    it('publishes text with setStringForType as public.utf8-plain-text', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write('{\\rtf1 literal}', 'text');

      const script = fake.calls[0]?.args.at(-1) ?? '';
      expect(script).toContain('fileHandleWithStandardInput');
      expect(script).toContain('setStringForType(text, $.NSPasteboardTypeString)');
    });

    it('reports byteSize as the UTF-8 length', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      const text = 'café 😀 世界';

      const result = await backend.write(text, 'text');

      expect(result.byteSize).toBe(Buffer.byteLength(text, 'utf8'));
      expect(Buffer.from(envelopeOf(fake.calls[0]?.stdin).text ?? '', 'base64').toString()).toBe(
        text,
      );
    });

    it('fails when the writer exits non-zero (a pasteboard set failed)', async () => {
      const fake = scriptedSpawn(() => ({
        exitCode: 1,
        stderr: 'execution error: Error: setting public.utf8-plain-text failed (-2700)',
      }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await expect(backend.write('hello', 'text')).rejects.toThrow(
        /osascript exited 1: .*public\.utf8-plain-text failed/,
      );
    });

    it('checks every set in the writer script and throws on failure', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write('<p>x</p>', 'html');

      const script = fake.calls[0]?.args.at(-1) ?? '';
      expect(script).toMatch(
        /if \(!pb\.setStringForType\(html, \$\.NSPasteboardTypeHTML\)\) throw/,
      );
      expect(script).toMatch(
        /if \(!pb\.setStringForType\(text, \$\.NSPasteboardTypeString\)\) throw/,
      );
      expect(script).not.toMatch(/^'ok';$/m);
    });
  });

  describe('write() html', () => {
    it('writes HTML via osascript JXA — content only on stdin', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      const html = '<html><body><p>Test <script>alert(1)</script></p></body></html>';

      const result = await backend.write(html, 'html');

      expect(result).toEqual({ format: 'html', byteSize: Buffer.byteLength(html, 'utf8') });
      const [call] = fake.calls;
      expect(call?.command).toBe('osascript');
      expect(call?.args.join('\n')).not.toContain('alert(1)');
      expect(call?.args.join('\n')).not.toContain(Buffer.from(html).toString('base64'));
      expect(envelopeOf(call?.stdin).html).toBe(Buffer.from(html).toString('base64'));
    });

    it('writes the tag-stripped plain-text fallback alongside HTML', async () => {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

      await backend.write('<h1>Title</h1><script>alert(1)</script><p>Body</p>', 'html');

      expect(envelopeOf(fake.calls[0]?.stdin).text).toBe(
        Buffer.from('Title Body').toString('base64'),
      );
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
        const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
        mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);

        await backend.write(html, 'html');

        expect(envelopeOf(fake.calls[0]?.stdin).text).toBe(
          Buffer.from(expected, 'utf8').toString('base64'),
        );
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

    /** argv and decoded stdin for one write of `payload` in `format`. */
    async function writeCall(payload: string, format: 'text' | 'html') {
      const fake = scriptedSpawn(() => ({ stdout: 'ok' }));
      mockSpawn.mockImplementation(fake.spawnImpl as unknown as typeof spawn);
      await backend.write(payload, format);
      expect(fake.calls).toHaveLength(1);
      const [call] = fake.calls;
      return { command: call?.command, args: call?.args, envelope: envelopeOf(call?.stdin) };
    }

    it.each(INJECTION_PAYLOADS)(
      'write text: argv is constant and the payload travels only on stdin (%j)',
      async (payload) => {
        const baseline = await writeCall('x', 'text');
        const injected = await writeCall(payload, 'text');
        expect(injected.command).toBe('osascript');
        expect(injected.args).toEqual(baseline.args);
        expect(Buffer.from(injected.envelope.text ?? '', 'base64').toString('utf8')).toBe(payload);
      },
    );

    it.each(INJECTION_PAYLOADS)(
      'write html: argv is constant and the payload travels only on stdin (%j)',
      async (payload) => {
        const baseline = await writeCall('<p>x</p>', 'html');
        const injected = await writeCall(payload, 'html');
        expect(injected.command).toBe('osascript');
        expect(injected.args).toEqual(baseline.args);
        expect(Buffer.from(injected.envelope.html ?? '', 'base64').toString('utf8')).toBe(payload);
      },
    );
  });
});

describe('MacosBackend — ranged helper scripts (#7)', () => {
  let backend: MacosBackend;
  beforeEach(() => {
    backend = new MacosBackend();
    vi.resetAllMocks();
  });

  it('interpolates offset and limit into the JXA read scripts as literal integers', async () => {
    for (const format of ['text', 'html', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('payload')) }));
      await backend.read(format, { offset: 5, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain('const location = Math.min(5, total);');
      expect(script).toContain('Math.min(7, total - location)');
      expect(script).toContain('subdataWithRange');
    }
  });

  it('clamps the slice location to the total instead of allocating an empty NSData (#33)', async () => {
    for (const format of ['text', 'html', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('payload')) }));
      await backend.read(format, { offset: 5, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).not.toContain('initWithLength');
      expect(script.match(/subdataWithRange/g)).toHaveLength(1);
    }
  });

  it('tests every Objective-C nil with .isNil(), never JS truthiness (#33)', async () => {
    for (const format of ['text', 'html', 'rtf', 'image'] as const) {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('payload')) }));
      await backend.read(format, { offset: 0, limit: 7 });
      const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
      const script = args.at(-1) ?? '';
      expect(script).toContain('.isNil()');
      // A nil wrapper is truthy in JXA: `!x` and `x && …` never see it.
      expect(script).not.toMatch(/!(html|data|d|img|rep|pngData|s)\b(?!\.)/);
      expect(script).not.toMatch(/\b(html|data|d|img|rep|pngData|s) &&/);
      expect(script).not.toMatch(/\b(html|data|d|img|rep|pngData|s) \?/);
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

  it('text reads decode the windowed envelope and its total', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({
        stdout: JSON.stringify({
          present: true,
          total: 10,
          contentBase64: Buffer.from('6789').toString('base64'),
          revision: CHANGE_COUNT,
        }),
      }),
    );
    const result = await backend.read('text', { offset: 6, limit: 8 });
    expect(result.content.toString()).toBe('6789');
    expect(result.totalByteSize).toBe(10);
    expect(result.revision).toBe(CHANGE_COUNT);
  });
});

describe('MacosBackend — changeCount revision (#38)', () => {
  let backend: MacosBackend;
  beforeEach(() => {
    backend = new MacosBackend();
    vi.resetAllMocks();
  });

  /** The generated read script for `format`. */
  async function readScript(format: 'text' | 'html' | 'rtf' | 'image'): Promise<string> {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: jxaEnvelope(Buffer.from('x')) }));
    await backend.read(format, { offset: 0, limit: 4 });
    const [, args] = mockSpawn.mock.calls.at(-1) as [string, string[]];
    return args.at(-1) ?? '';
  }

  it.each(['text', 'html', 'rtf', 'image'] as const)(
    'the %s script samples changeCount before its first data access and again when it reports',
    async (format) => {
      const script = await readScript(format);
      const before = script.indexOf('const changeCount = Number(pb.changeCount);');
      expect(before).toBeGreaterThan(
        script.indexOf('const pb = $.NSPasteboard.generalPasteboard;'),
      );
      expect(before).toBeLessThan(script.indexOf('dataForType'));
      const report = script.lastIndexOf(
        'JSON.stringify(Number(pb.changeCount) === changeCount ? result : { changed: true });',
      );
      expect(report).toBeGreaterThan(script.lastIndexOf('subdataWithRange'));
      // The report is the script's last statement, so its value is what osascript prints.
      expect(script.slice(report).trim().split('\n')).toHaveLength(1);
      expect(script).toContain('revision: String(changeCount)');
    },
  );

  it('the empty-image envelope carries the revision too', async () => {
    const script = await readScript('image');
    expect(script).toContain(
      "result = { present: true, total: 0, contentBase64: '', revision: String(changeCount) };",
    );
  });

  it.each(['text', 'html', 'rtf', 'image'] as const)(
    'a %s read whose script saw changeCount move fails representation_changed',
    async (format) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ changed: true }) }));
      await expect(backend.read(format, FULL)).rejects.toMatchObject({
        _clipboardOutcome: true,
        category: 'representation_changed',
        platform: 'macOS',
      });
    },
  );

  it('an envelope without a revision is unreadable, not a read with no identity', async () => {
    mockSpawn.mockReturnValueOnce(
      fakeChild({ stdout: JSON.stringify({ present: true, total: 1, contentBase64: 'eA==' }) }),
    );
    await expect(backend.read('text', FULL)).rejects.toMatchObject({ code: -32070 });
  });
});

describe('MacosBackend — typed absent-format outcome (#36)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['html', 'rtf', 'image'] as const)(
    'an absent %s representation is format_unavailable',
    async (format) => {
      mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
      await expect(new MacosBackend().read(format, FULL)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    },
  );

  it('text on a pasteboard with no text type is format_unavailable', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ stdout: JSON.stringify({ present: false }) }));
    await expect(new MacosBackend().read('text', FULL)).rejects.toMatchObject({
      category: 'format_unavailable',
    });
  });

  it('a failed osascript run is not mistaken for an absent format', async () => {
    mockSpawn.mockReturnValueOnce(fakeChild({ exitCode: 1, stderr: 'execution error: -1728' }));
    const failure = new MacosBackend().read('html', FULL);
    await expect(failure).rejects.toThrow(/osascript exited 1/);
    await expect(failure).rejects.not.toHaveProperty('category');
  });
});
