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
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('@/services/clipboard/clipboard-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/clipboard/clipboard-service.js')>();
  return { ...actual, getClipboardService: vi.fn(), initClipboardService: vi.fn() };
});

import { spawn } from 'node:child_process';
import { clipboardInspect } from '@/mcp-server/tools/definitions/clipboard-inspect.tool.js';
import { clipboardRead } from '@/mcp-server/tools/definitions/clipboard-read.tool.js';
import { ClipboardService, getClipboardService } from '@/services/clipboard/clipboard-service.js';
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

/** The private pasteboard's current changeCount. */
function privateChangeCount(): number {
  return Number(jxa(`ObjC.import('AppKit'); Number(${pasteboardRef()}.changeCount)`));
}

/** The statement every read script opens its changeCount window with. */
const CHANGE_COUNT_SAMPLE = 'const changeCount = Number(pb.changeCount);';

/**
 * JXA statements spliced in right after a read script's first changeCount
 * sample, so they run inside the script's own read window against the private
 * pasteboard (`pb`). Undefined leaves scripts as generated.
 */
let midReadMutation: string | undefined;

/**
 * Replace the private pasteboard's contents with exactly `types`. Types named
 * in `declaredOnly` are declared with no data set, so `dataForType` returns nil
 * for them — the state `pbcopy` leaves when it re-types RTF-header input.
 */
function seed(types: Record<string, Buffer>, declaredOnly: readonly string[] = []): void {
  const payload = Object.fromEntries(
    Object.entries(types).map(([type, bytes]) => [type, bytes.toString('base64')]),
  );
  jxa(
    `ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const types = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
const declared = ${JSON.stringify(declaredOnly)};
const pb = ${pasteboardRef()};
pb.clearContents;
if (declared.length > 0) pb.declareTypesOwner(Object.keys(types).concat(declared), $());
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
      let rewritten = script.replace(GENERAL, pasteboardRef());
      if (midReadMutation !== undefined) {
        if (!rewritten.includes(CHANGE_COUNT_SAMPLE)) {
          throw new Error('test setup: script has no changeCount sample to mutate after');
        }
        rewritten = rewritten.replace(
          CHANGE_COUNT_SAMPLE,
          `${CHANGE_COUNT_SAMPLE}\n${midReadMutation}`,
        );
      }
      return actual.spawn(command, [...args.slice(0, -1), rewritten], options);
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

  describe('characterization: inspection and image reads kept', () => {
    it('a present, empty public.utf8-plain-text is measured at 0 bytes and keeps text available', async () => {
      seed({ 'public.utf8-plain-text': Buffer.alloc(0) });
      const inspection = await backend.inspect();
      expect(inspection.availableFormats).toEqual(['text']);
      expect(inspection.rawTypes).toContainEqual({ type: 'public.utf8-plain-text', bytes: 0 });
    });

    it('a zero-length public.png lists image, with its AppKit translation', async () => {
      seed({ 'public.png': Buffer.alloc(0) });
      const inspection = await backend.inspect();
      expect(inspection.availableFormats).toEqual(['image']);
      expect(inspection.rawTypes).toContainEqual({ type: 'public.png', bytes: 0 });
      expect(inspection.rawTypes.map((entry) => entry.type)).toContain('public.tiff');
    });

    it('a UTF-16 public.html is read as its raw bytes', async () => {
      const html = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>é</p>', 'utf16le')]);
      seed({ 'public.html': html });
      const result = await backend.read('html', { offset: 0, limit: 64 });
      expect(result.content.equals(html)).toBe(true);
      expect(result.totalByteSize).toBe(html.byteLength);
    });

    it('a zero-length public.png beside a decodable public.tiff reads the converted TIFF', async () => {
      seedTiff({ 'public.png': Buffer.alloc(0) });
      const result = await backend.read('image', { offset: 0, limit: 64 * MiB });
      expect(result).toMatchObject({ width: 13, height: 7 });
      expect(result.content.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    });
  });

  describe('#41 — declared types with nil data', () => {
    const rtf = Buffer.from('{\\rtf1 x}');

    it('reports nil text data as measurementFailed and leaves text unavailable', async () => {
      seed({ 'public.rtf': rtf }, ['public.utf8-plain-text']);
      const inspection = await backend.inspect();
      expect(inspection.availableFormats).toEqual(['rtf']);
      expect(inspection.primaryFormat).toBe('rtf');
      expect(inspection.rawTypes).toContainEqual({
        type: 'public.utf8-plain-text',
        measurementFailed: true,
      });
      expect(inspection.rawTypes).toContainEqual({ type: 'public.rtf', bytes: rtf.byteLength });
      for (const entry of inspection.rawTypes) {
        if (entry.measurementFailed) expect(entry).not.toHaveProperty('bytes');
      }
    });

    it('a text read of the nil-text pasteboard is format_unavailable, not empty text', async () => {
      seed({ 'public.rtf': rtf }, ['public.utf8-plain-text']);
      await expect(backend.read('text', { offset: 0, limit: 64 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it.each(['com.apple.flat-rtfd', 'public.rtf'])(
      'a zero-length %s alone lists rtf and reads as an empty rtf success',
      async (type) => {
        seed({ [type]: Buffer.alloc(0) });
        const inspection = await backend.inspect();
        expect(inspection.availableFormats).toEqual(['rtf']);
        expect(inspection.rawTypes).toContainEqual({ type, bytes: 0 });
        await expect(backend.read('rtf', { offset: 0, limit: 64 })).resolves.toMatchObject({
          format: 'rtf',
          content: Buffer.alloc(0),
          totalByteSize: 0,
        });
      },
    );
  });

  describe('#42 — text and HTML reads keep every byte', () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const text = Buffer.concat([BOM, Buffer.from('bom-led')]);
    const html = Buffer.concat([BOM, Buffer.from('<p>x</p>')]);

    it.each([
      ['text', 'public.utf8-plain-text', text],
      ['html', 'public.html', html],
    ] as const)(
      'a BOM-led %s read keeps the BOM and matches the inspected size',
      async (format, type, bytes) => {
        seed({ 'public.utf8-plain-text': text, 'public.html': html });
        const inspected = (await backend.inspect()).rawTypes.find((entry) => entry.type === type);
        expect(inspected?.bytes).toBe(bytes.byteLength);

        const whole = await backend.read(format, { offset: 0, limit: 64 });
        expect(whole.content.equals(bytes)).toBe(true);
        expect(whole.totalByteSize).toBe(inspected?.bytes);

        const slice = await backend.read(format, { offset: 0, limit: 4 });
        expect(slice.content.equals(bytes.subarray(0, 4))).toBe(true);
        expect(slice.totalByteSize).toBe(bytes.byteLength);

        const past = await backend.read(format, { offset: bytes.byteLength + 5, limit: 4 });
        expect(past.content.byteLength).toBe(0);
        expect(past.totalByteSize).toBe(bytes.byteLength);
      },
      30_000,
    );

    it('a pasteboard holding only public.utf16-plain-text reads as its UTF-8 translation', async () => {
      seed({ 'public.utf16-plain-text': Buffer.from('héllo', 'utf16le') });
      const result = await backend.read('text', { offset: 0, limit: 64 });
      expect(result.content.toString('utf8')).toBe('héllo');
      expect(result.totalByteSize).toBe(Buffer.byteLength('héllo'));
    });

    it('a pasteboard holding only public.plain-text reads its bytes', async () => {
      seed({ 'public.plain-text': Buffer.from('plain only') });
      expect((await backend.inspect()).availableFormats).toEqual(['text']);
      const result = await backend.read('text', { offset: 0, limit: 64 });
      expect(result.content.toString('utf8')).toBe('plain only');
    });

    it('invalid UTF-8 in public.utf8-plain-text is read as its raw bytes', async () => {
      const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
      seed({ 'public.utf8-plain-text': latin1 });
      const result = await backend.read('text', { offset: 0, limit: 64 });
      expect(result.content.equals(latin1)).toBe(true);
    });

    it('a text read with no text on the pasteboard is format_unavailable', async () => {
      seed({ 'public.png': REAL_PNG_13x7 });
      await expect(backend.read('text', { offset: 0, limit: 64 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });
  });

  describe('#43 — zero-byte and undecodable images', () => {
    function serveTools(): void {
      vi.mocked(getClipboardService).mockReturnValue(new ClipboardService(backend));
    }

    it('a zero-length public.png alone reads as an empty image success', async () => {
      seed({ 'public.png': Buffer.alloc(0) });
      const result = await backend.read('image', { offset: 0, limit: 64 });
      expect(result).toEqual({
        format: 'image',
        content: Buffer.alloc(0),
        totalByteSize: 0,
        revision: String(privateChangeCount()),
      });
    });

    it('a zero-length public.png beside text: image and auto return the empty image, with no image block', async () => {
      seed({ 'public.png': Buffer.alloc(0), 'public.utf8-plain-text': Buffer.from('abc') });
      serveTools();

      const inspection = await runToolContract(clipboardInspect, {});
      expect(inspection.structuredContent).toMatchObject({
        primaryFormat: 'image',
        availableFormats: ['text', 'image'],
      });

      for (const format of ['image', 'auto'] as const) {
        const result = await runToolContract(clipboardRead, { format });
        expect(result.isError, format).toBeFalsy();
        expect(result.structuredContent).toEqual({
          format: 'image',
          content: '',
          byteSize: 0,
          totalByteSize: 0,
          complete: true,
          representationId: `image:${privateChangeCount()}`,
        });
        expect(result.content.some((block) => block.type === 'image')).toBe(false);
      }

      const text = await runToolContract(clipboardRead, { format: 'text' });
      expect(text.structuredContent).toMatchObject({ format: 'text', content: 'abc' });
    }, 30_000);

    it('an undecodable public.png beside a decodable public.tiff reads the converted TIFF', async () => {
      seedTiff({ 'public.png': Buffer.from('not a png') });
      const result = await backend.read('image', { offset: 0, limit: 64 * MiB });
      expect(result).toMatchObject({ width: 13, height: 7 });
      expect(result.content.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    });

    it('auto over an undecodable public.png beside text returns the text (#46)', async () => {
      seed({
        'public.png': Buffer.from('not a png'),
        'public.utf8-plain-text': Buffer.from('abc'),
      });
      serveTools();
      const inspection = await runToolContract(clipboardInspect, {});
      expect(inspection.structuredContent).toMatchObject({ availableFormats: ['text', 'image'] });
      const result = await runToolContract(clipboardRead, { format: 'auto' });
      expect(result.structuredContent).toMatchObject({
        format: 'text',
        content: 'abc',
        representationId: `text:${privateChangeCount()}`,
      });
      const image = await runToolContract(clipboardRead, { format: 'image' });
      expect(image.structuredContent).toMatchObject({
        error: { data: { reason: 'format_unavailable' } },
      });
    }, 30_000);

    it('an undecodable public.png with no other image is format_unavailable', async () => {
      seed({ 'public.png': Buffer.from('not a png') });
      await expect(backend.read('image', { offset: 0, limit: 64 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });
  });

  describe('#38 — changeCount revision', () => {
    const FORMATS = ['text', 'html', 'rtf', 'image'] as const;

    function seedAll(text = 'AAAA1111'): void {
      seed({
        'public.utf8-plain-text': Buffer.from(text),
        'public.html': Buffer.from(`<p>${text}</p>`),
        'public.rtf': Buffer.from(`{\\rtf1 ${text}}`),
        'public.png': REAL_PNG_13x7,
      });
    }

    it.each(FORMATS)(
      'a %s read reports the pasteboard changeCount, equal across whole, sliced, and past-the-end reads',
      async (format) => {
        seedAll();
        const count = String(privateChangeCount());
        const whole = await backend.read(format, { offset: 0, limit: 64 * MiB });
        const slice = await backend.read(format, { offset: 3, limit: 5 });
        const past = await backend.read(format, { offset: whole.totalByteSize + 9, limit: 5 });
        expect([whole.revision, slice.revision, past.revision]).toEqual([count, count, count]);
      },
      30_000,
    );

    it('a same-size rewrite between reads moves the revision', async () => {
      seedAll('AAAA1111');
      const before = await backend.read('text', { offset: 0, limit: 4 });
      seedAll('BBBB2222');
      const after = await backend.read('text', { offset: 4, limit: 4 });
      expect(after.totalByteSize).toBe(before.totalByteSize);
      expect(Number(after.revision)).toBeGreaterThan(Number(before.revision));
      expect(after.revision).toBe(String(privateChangeCount()));
    });

    it.each(FORMATS)(
      'a %s read whose pasteboard is rewritten between its two changeCount samples fails representation_changed',
      async (format) => {
        seedAll();
        const replacement = {
          'public.utf8-plain-text': 'BBBB2222',
          'public.html': '<p>BBBB2222</p>',
          'public.rtf': '{\\rtf1 BBBB2222}',
          'public.png': REAL_PNG_13x7.toString('latin1'),
        };
        midReadMutation = `pb.clearContents;\n${Object.entries(replacement)
          .map(
            ([type, value]) =>
              `pb.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(Buffer.from(value, 'latin1').toString('base64'))}, 0), ${JSON.stringify(type)});`,
          )
          .join('\n')}`;
        const countBefore = privateChangeCount();
        try {
          await expect(backend.read(format, { offset: 0, limit: 4 })).rejects.toMatchObject({
            _clipboardOutcome: true,
            category: 'representation_changed',
            platform: 'macOS',
          });
        } finally {
          midReadMutation = undefined;
        }
        // The rewrite really happened inside the script's window.
        expect(privateChangeCount()).toBeGreaterThan(countBefore);
      },
      30_000,
    );

    it('end to end: a same-size replacement between tool slices fails representation_changed, an unchanged value continues', async () => {
      vi.mocked(getClipboardService).mockReturnValue(new ClipboardService(backend));
      seedAll('AAAA1111');

      const first = await runToolContract(clipboardRead, { format: 'text', offset: 0, limit: 4 });
      const token = (first.structuredContent as { representationId: string }).representationId;
      expect(token).toBe(`text:${privateChangeCount()}`);
      const next = await runToolContract(clipboardRead, {
        format: 'text',
        offset: 4,
        limit: 4,
        representationId: token,
      });
      expect(next.structuredContent).toMatchObject({ content: '1111', representationId: token });

      seedAll('BBBB2222');
      const stale = await runToolContract(clipboardRead, {
        format: 'text',
        offset: 4,
        limit: 4,
        representationId: token,
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        error: { code: -32002, data: { reason: 'representation_changed' } },
      });
      expect(stale.structuredContent).not.toHaveProperty('content');
    }, 30_000);
  });
});

/**
 * Seed a decodable `public.tiff` (the 13x7 fixture) plus `others`, set as raw
 * data. Separate from `seed` because the TIFF is produced by AppKit itself.
 */
function seedTiff(others: Record<string, Buffer>): void {
  const payload = Object.fromEntries(
    Object.entries(others).map(([type, bytes]) => [type, bytes.toString('base64')]),
  );
  jxa(
    `ObjC.import('AppKit');
const others = ${JSON.stringify(payload)};
const png = $.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(REAL_PNG_13x7.toString('base64'))}, 0);
const pb = ${pasteboardRef()};
pb.clearContents;
for (const t of Object.keys(others)) {
  if (!pb.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(others[t], 0), t)) throw new Error('seed failed: ' + t);
}
if (!pb.setDataForType($.NSBitmapImageRep.imageRepWithData(png).TIFFRepresentation, 'public.tiff')) throw new Error('seed failed');
'ok';`,
  );
}
