/**
 * @fileoverview darwin-only: runs MacosBackend end to end — its real generated
 * JXA scripts, argv, stdin, and exit handling, through the real `osascript` —
 * against a private, uniquely named pasteboard. `spawn` passes through to the
 * real one after rewriting the script's single `$.NSPasteboard.generalPasteboard`
 * reference to that private pasteboard; it refuses any other helper (`pbcopy`,
 * `pbpaste`) and any script that does not reference the general pasteboard
 * exactly once, so nothing here can touch the developer's clipboard. The
 * general pasteboard's `changeCount` is checked unchanged afterwards.
 * @module tests/services/clipboard/macos-native.test
 */

import type * as ChildProcess from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
import { MacosBackend } from '@/services/clipboard/macos-backend.js';
import { REAL_PNG_13x7 } from './png-fixtures.js';

const actual = await vi.importActual<typeof ChildProcess>('node:child_process');
const mockSpawn = vi.mocked(spawn);

const GENERAL = '$.NSPasteboard.generalPasteboard';
const onDarwin = process.platform === 'darwin';
const MiB = 1024 * 1024;

/** Run a helper JXA script directly (not through the backend) with optional stdin. */
function jxa(script: string, input?: string): string {
  const result = actual.spawnSync('osascript', ['-l', 'JavaScript', '-e', script], {
    input: input ?? '',
    maxBuffer: 64 * MiB,
  });
  if (result.status !== 0) {
    throw new Error(`helper osascript exited ${result.status}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString('utf8').trim();
}

function generalChangeCount(): number {
  return Number(jxa(`ObjC.import('AppKit'); Number(${GENERAL}.changeCount)`));
}

let pasteboardName = '';
const pasteboardRef = () => `$.NSPasteboard.pasteboardWithName(${JSON.stringify(pasteboardName)})`;

/** Replace the private pasteboard's contents with exactly `types`. */
function seed(types: Record<string, Buffer>): void {
  const payload = Object.fromEntries(
    Object.entries(types).map(([type, bytes]) => [type, bytes.toString('base64')]),
  );
  jxa(
    `ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const types = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
const pb = ${pasteboardRef()};
pb.clearContents;
for (const t of Object.keys(types)) {
  if (!pb.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(types[t], 0), t)) throw new Error('seed failed: ' + t);
}
'ok';`,
    JSON.stringify(payload),
  );
}

/** Every type on the private pasteboard with its exact bytes. */
function contents(): Record<string, Buffer> {
  const raw = jxa(`ObjC.import('AppKit');
const pb = ${pasteboardRef()};
const out = {};
const types = pb.types;
if (!types.isNil()) {
  for (let i = 0; i < types.count; i++) {
    const t = ObjC.unwrap(types.objectAtIndex(i));
    const d = pb.dataForType(t);
    out[t] = d.isNil() ? null : ObjC.unwrap(d.base64EncodedStringWithOptions(0));
  }
}
JSON.stringify(out);`);
  const parsed = JSON.parse(raw) as Record<string, string | null>;
  return Object.fromEntries(
    Object.entries(parsed).map(([type, b64]) => [type, Buffer.from(b64 ?? '', 'base64')]),
  );
}

describe.skipIf(!onDarwin)('MacosBackend against a private pasteboard (real osascript)', () => {
  let changeCountBefore = 0;
  const backend = new MacosBackend();

  beforeAll(() => {
    changeCountBefore = generalChangeCount();
    pasteboardName = jxa(
      `ObjC.import('AppKit'); ObjC.unwrap($.NSPasteboard.pasteboardWithUniqueName.name)`,
    );
    expect(pasteboardName).toMatch(/\S/);
    mockSpawn.mockImplementation(((command: string, args: readonly string[], options: object) => {
      if (command !== 'osascript') {
        throw new Error(
          `test isolation: refusing to spawn ${command} (it targets the general pasteboard)`,
        );
      }
      const script = args.at(-1) ?? '';
      const references = script.split(GENERAL).length - 1;
      if (references !== 1) {
        throw new Error(
          `test isolation: script references ${GENERAL} ${references} times, expected 1`,
        );
      }
      const redirected = [...args.slice(0, -1), script.replace(GENERAL, pasteboardRef())];
      return actual.spawn(command, redirected, options);
    }) as unknown as typeof spawn);
  });

  afterAll(() => {
    if (!onDarwin || !pasteboardName) return;
    jxa(`ObjC.import('AppKit'); ${pasteboardRef()}.releaseGlobally; 'released'`);
    expect(generalChangeCount()).toBe(changeCountBefore);
  });

  describe('characterization: behavior kept', () => {
    it('an HTML write publishes public.html and the tag-stripped text fallback', async () => {
      const html = '<p>café 😀</p>';
      const result = await backend.write(html, 'html');
      expect(result).toMatchObject({ format: 'html', byteSize: Buffer.byteLength(html) });
      const types = contents();
      expect(types['public.html']?.toString('utf8')).toBe(html);
      expect(types['public.utf8-plain-text']?.toString('utf8')).toBe('café 😀');
    });

    it.each(['html', 'rtf', 'image'] as const)(
      'a %s read below and at the end returns the slice and the full total',
      async (format) => {
        seed({
          'public.html': Buffer.from('<p>ok</p>'),
          'public.rtf': Buffer.from('{\\rtf1\\ansi hello}'),
          'public.png': REAL_PNG_13x7,
        });
        const whole = await backend.read(format, { offset: 0, limit: 64 * MiB });
        const total = whole.totalByteSize;
        expect(whole.content.byteLength).toBe(total);
        if (format === 'image') expect(whole).toMatchObject({ width: 13, height: 7 });

        const middle = await backend.read(format, { offset: 2, limit: 4 });
        expect(middle.content.equals(whole.content.subarray(2, 6))).toBe(true);
        expect(middle.totalByteSize).toBe(total);

        const atEnd = await backend.read(format, { offset: total, limit: 4 });
        expect(atEnd.content.byteLength).toBe(0);
        expect(atEnd.totalByteSize).toBe(total);
      },
      30_000,
    );

    it('an RTF read prefers com.apple.flat-rtfd over public.rtf', async () => {
      seed({
        'com.apple.flat-rtfd': Buffer.from('rtfd-bytes'),
        'public.rtf': Buffer.from('{\\rtf1 plain}'),
      });
      const result = await backend.read('rtf', { offset: 0, limit: 64 });
      expect(result.content.toString()).toBe('rtfd-bytes');
    });

    it('an image read converts a TIFF-only pasteboard to PNG with its dimensions', async () => {
      jxa(
        `ObjC.import('AppKit');
const png = $.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(REAL_PNG_13x7.toString('base64'))}, 0);
const pb = ${pasteboardRef()};
pb.clearContents;
if (!pb.setDataForType($.NSBitmapImageRep.imageRepWithData(png).TIFFRepresentation, 'public.tiff')) throw new Error('seed failed');
'ok';`,
      );
      const result = await backend.read('image', { offset: 0, limit: 64 * MiB });
      expect(result).toMatchObject({ width: 13, height: 7 });
      expect(result.content.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(result.totalByteSize).toBe(result.content.byteLength);
    });

    it.each(['rtf', 'image'] as const)('an absent %s is format_unavailable', async (format) => {
      seed({ 'public.utf8-plain-text': Buffer.from('hello') });
      await expect(backend.read(format, { offset: 0, limit: 16 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });
  });

  describe('#33 — reads past EOF and absent HTML', () => {
    it.each(['html', 'rtf', 'image'] as const)(
      'a %s read past the end returns an empty slice with the real total',
      async (format) => {
        seed({
          'public.html': Buffer.from('<p>ok</p>'),
          'public.rtf': Buffer.from('{\\rtf1\\ansi hello}'),
          'public.png': REAL_PNG_13x7,
        });
        const { totalByteSize: total } = await backend.read(format, { offset: 0, limit: 0 });
        for (const offset of [total + 1, total + 10_000_000]) {
          const past = await backend.read(format, { offset, limit: 4 });
          expect(past.content.byteLength).toBe(0);
          expect(past.totalByteSize).toBe(total);
        }
      },
      30_000,
    );

    it('an HTML read of a public.html that is not UTF-8 returns its raw bytes', async () => {
      const latin1 = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);
      seed({ 'public.html': latin1 });
      const result = await backend.read('html', { offset: 0, limit: 64 });
      expect(result.content.equals(latin1)).toBe(true);
      expect(result.totalByteSize).toBe(latin1.byteLength);
    });

    it('an HTML read with no HTML present is format_unavailable', async () => {
      seed({ 'public.utf8-plain-text': Buffer.from('hello') });
      await expect(backend.read('html', { offset: 0, limit: 16 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });
  });

  describe('#30 — text writes publish literal plain text', () => {
    it.each([
      ['an RTF header', '{\\rtf1\\ansi This should stay literal}'],
      ['a bare RTF header', '{\\rtf'],
      ['an EPS 2.0 header', '%!PS-Adobe-2.0 EPSF-2.0\n'],
    ])('%s stays public.utf8-plain-text only, byte-identical', async (_label, text) => {
      await backend.write(text, 'text');
      const types = contents();
      expect(Object.keys(types).sort()).toEqual(['NSStringPboardType', 'public.utf8-plain-text']);
      expect(types['public.utf8-plain-text']?.equals(Buffer.from(text, 'utf8'))).toBe(true);
    });

    it.each([
      'café 😀 世界',
      'embedded\u0000NUL',
      'crlf\r\nline endings\r\n',
      '\ufeffleading byte-order mark',
      '\ufeff',
      'a\ud800 lone surrogate',
      '"; $(whoami); "',
      "'; `id`; '",
      '$(cat /etc/passwd)',
      '\n; rm -rf /',
      '\\"; process.exit(); //',
      "'); ObjC.import('Foundation'); //",
      '; Invoke-Expression "whoami"',
      '| cat /etc/passwd',
      '\x00',
    ])('round-trips %j byte-identically with byteSize equal to its UTF-8 length', async (text) => {
      const result = await backend.write(text, 'text');
      expect(result.byteSize).toBe(Buffer.byteLength(text, 'utf8'));
      expect(contents()['public.utf8-plain-text']?.equals(Buffer.from(text, 'utf8'))).toBe(true);
    });
  });

  describe('#30/#31 — HTML payload bytes are kept exactly', () => {
    it('an HTML write keeps a leading byte-order mark in public.html', async () => {
      const html = '\ufeff<p>x</p>';
      await backend.write(html, 'html');
      expect(contents()['public.html']?.equals(Buffer.from(html, 'utf8'))).toBe(true);
    });
  });

  describe('#31 — 1 MiB writes succeed', () => {
    it('a 1,048,576-byte HTML write publishes the HTML and its fallback', async () => {
      const html = `<p>${'x'.repeat(1048569)}</p>`;
      expect(Buffer.byteLength(html)).toBe(MiB);
      const result = await backend.write(html, 'html');
      expect(result.byteSize).toBe(MiB);
      const types = contents();
      expect(types['public.html']?.byteLength).toBe(MiB);
      expect(types['public.utf8-plain-text']?.byteLength).toBe(1048569);
    }, 60_000);

    it('a 1,048,576-byte text write publishes every byte', async () => {
      const text = 'y'.repeat(MiB);
      const result = await backend.write(text, 'text');
      expect(result.byteSize).toBe(MiB);
      expect(contents()['public.utf8-plain-text']?.equals(Buffer.from(text))).toBe(true);
    }, 60_000);
  });
});
