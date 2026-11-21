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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Native process startup needs the same budget as the multi-read cases under load.
vi.setConfig({ testTimeout: 30_000 });

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
import { buildSolidPng, PNG_SIGNATURE, REAL_PNG_13x7 } from './png-fixtures.js';

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

/**
 * Replace the private pasteboard's contents with one `NSPasteboardItem` per
 * entry of `items`, written together by `writeObjects` — the multi-item
 * pasteboard a multi-selection copy in Photos or Finder leaves.
 */
function seedItems(items: readonly Record<string, Buffer>[]): void {
  const payload = items.map((types) =>
    Object.fromEntries(
      Object.entries(types).map(([type, bytes]) => [type, bytes.toString('base64')]),
    ),
  );
  jxa(
    `ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const items = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
const objects = items.map((types) => {
  const item = $.NSPasteboardItem.alloc.init;
  for (const t of Object.keys(types)) {
    if (!item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(types[t], 0), t)) throw new Error('seed failed: ' + t);
  }
  return item;
});
const pb = ${pasteboardRef()};
pb.clearContents;
if (!pb.writeObjects($(objects))) throw new Error('writeObjects failed');
'ok';`,
    JSON.stringify(payload),
  );
}

/** A URL `seedUrls` writes: a file path, that file's reference URL (`file:///.file/id=…`), or any URL string. */
type UrlSeed = { path: string } | { reference: string } | { url: string };

/** Replace the private pasteboard's contents with one NSURL per entry, written by `writeObjects`. */
function seedUrls(urls: readonly UrlSeed[]): void {
  jxa(
    `ObjC.import('AppKit');
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const urls = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
const objects = urls.map((u) => {
  if (u.path !== undefined) return $.NSURL.fileURLWithPath(u.path);
  if (u.reference !== undefined) {
    const reference = $.NSURL.fileURLWithPath(u.reference).fileReferenceURL;
    if (reference.isNil()) throw new Error('no file reference URL for ' + u.reference);
    return reference;
  }
  return $.NSURL.URLWithString(u.url);
});
const pb = ${pasteboardRef()};
pb.clearContents;
if (!pb.writeObjects($(objects))) throw new Error('writeObjects failed');
'ok';`,
    JSON.stringify(urls),
  );
}

/**
 * The flat RTFD and RTF AppKit writes for `rtfSource`, with a PNG file
 * attachment when `attachment` is set. Built from RTF data because JXA on
 * macOS 27 does not bridge `NSAttributedString initWithString:`.
 */
function attributedForms(
  rtfSource: string,
  { attachment = false } = {},
): { rtf: Buffer; rtfd: Buffer } {
  const forms = JSON.parse(
    jxa(`ObjC.import('AppKit');
const source = $(${JSON.stringify(rtfSource)}).dataUsingEncoding($.NSUTF8StringEncoding);
const s = $.NSMutableAttributedString.alloc.initWithRTFDocumentAttributes(source, $());
if (s.isNil()) throw new Error('RTF source did not parse');
if (${attachment}) {
  const wrapper = $.NSFileWrapper.alloc.initRegularFileWithContents($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(REAL_PNG_13x7.toString('base64'))}, 0));
  wrapper.preferredFilename = 'dot.png';
  s.appendAttributedString($.NSAttributedString.attributedStringWithAttachment($.NSTextAttachment.alloc.initWithFileWrapper(wrapper)));
}
const range = { location: 0, length: Number(s.length) };
JSON.stringify({
  rtfd: ObjC.unwrap(s.RTFDFromRangeDocumentAttributes(range, $()).base64EncodedStringWithOptions(0)),
  rtf: ObjC.unwrap(s.RTFFromRangeDocumentAttributes(range, $()).base64EncodedStringWithOptions(0)),
});`),
  ) as { rtf: string; rtfd: string };
  return { rtf: Buffer.from(forms.rtf, 'base64'), rtfd: Buffer.from(forms.rtfd, 'base64') };
}

/** `png` re-encoded by NSBitmapImageRep as `fileType` (an `NSBitmapImageFileType` constant name). */
function encodeAs(png: Buffer, fileType: string): Buffer {
  return Buffer.from(
    jxa(`ObjC.import('AppKit');
const rep = $.NSBitmapImageRep.imageRepWithData($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(png.toString('base64'))}, 0));
ObjC.unwrap(rep.representationUsingTypeProperties($.${fileType}, {}).base64EncodedStringWithOptions(0));`),
    'base64',
  );
}

/** The plain text AppKit parses out of RTF markup — `null` when it is not RTF it can read. */
function rtfPlainText(rtf: Buffer): string | null {
  return JSON.parse(
    jxa(`ObjC.import('AppKit');
const data = $.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(rtf.toString('base64'))}, 0);
const s = $.NSAttributedString.alloc.initWithRTFDocumentAttributes(data, $());
JSON.stringify(s.isNil() ? null : ObjC.unwrap(s.string));`),
  ) as string | null;
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
      // The script follows `-e`; a read of one item passes `-- <item>` after it.
      const scriptIndex = args.indexOf('-e') + 1;
      const script = args[scriptIndex] ?? '';
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
      return actual.spawn(command, args.with(scriptIndex, rewritten), options);
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

  describe('#54 — RTF reads return RTF markup', () => {
    const SOURCE = '{\\rtf1\\ansi {\\b Styled} RTFD sample text}';
    const TEXT = 'Styled RTFD sample text';

    it('with public.rtf beside a flat RTFD, rtf returns public.rtf byte for byte', async () => {
      const { rtf, rtfd } = attributedForms(SOURCE);
      expect(rtfd.subarray(0, 4).toString('latin1')).toBe('rtfd');
      seed({ 'com.apple.flat-rtfd': rtfd, 'public.rtf': rtf });
      const result = await backend.read('rtf', { offset: 0, limit: 64 * MiB });
      expect(result.content.equals(rtf)).toBe(true);
      expect(result.totalByteSize).toBe(rtf.byteLength);
      expect(result.content.subarray(0, 5).toString('latin1')).toBe('{\\rtf');
    });

    it('a non-empty public.rtf wins over a decodable flat RTFD of different text', async () => {
      const { rtfd } = attributedForms(SOURCE);
      const plain = Buffer.from('{\\rtf1 plain}');
      seed({ 'com.apple.flat-rtfd': rtfd, 'public.rtf': plain });
      const result = await backend.read('rtf', { offset: 0, limit: 64 * MiB });
      expect(result.content.equals(plain)).toBe(true);
      expect(result.totalByteSize).toBe(plain.byteLength);
    });

    it('a non-empty public.rtf wins over flat-RTFD bytes that are not a package', async () => {
      seed({
        'com.apple.flat-rtfd': Buffer.from('rtfd-bytes'),
        'public.rtf': Buffer.from('{\\rtf1 plain}'),
      });
      const result = await backend.read('rtf', { offset: 0, limit: 64 });
      expect(result.content.toString()).toBe('{\\rtf1 plain}');
    });

    it.each([
      ['plain', false],
      ['with an attachment', true],
    ])(
      'a flat RTFD alone (%s) lists rtf and reads as RTF markup carrying its text and styling',
      async (_label, attachment) => {
        const { rtfd } = attributedForms(SOURCE, { attachment });
        seed({ 'com.apple.flat-rtfd': rtfd });
        const inspection = await backend.inspect();
        expect(inspection.availableFormats).toEqual(['rtf']);
        expect(inspection.rawTypes).toContainEqual({
          type: 'com.apple.flat-rtfd',
          bytes: rtfd.byteLength,
        });

        const whole = await backend.read('rtf', { offset: 0, limit: 64 * MiB });
        expect(whole.content.subarray(0, 6).toString('latin1')).toBe('{\\rtf1');
        expect(whole.content.includes(0)).toBe(false);
        expect(whole.content.toString('latin1')).toMatch(/\\b(?![a-z])/);
        // The attachment is dropped: no U+FFFC object-replacement character survives.
        expect(rtfPlainText(whole.content)).toBe(TEXT);
        expect(whole.totalByteSize).toBe(whole.content.byteLength);
        expect(whole.totalByteSize).not.toBe(rtfd.byteLength);

        // The conversion runs again for every slice and yields the same document.
        const middle = await backend.read('rtf', { offset: 3, limit: 9 });
        expect(middle.content.equals(whole.content.subarray(3, 12))).toBe(true);
        expect(middle.totalByteSize).toBe(whole.totalByteSize);
        const past = await backend.read('rtf', { offset: whole.totalByteSize + 4, limit: 9 });
        expect(past.content.byteLength).toBe(0);
        expect(past.totalByteSize).toBe(whole.totalByteSize);
      },
      30_000,
    );

    it('an undecodable flat RTFD alone fails rtf with format_unavailable, and auto moves on', async () => {
      seed({
        'com.apple.flat-rtfd': Buffer.from('rtfd-bytes'),
        'public.utf8-plain-text': Buffer.from('abc'),
      });
      expect((await backend.inspect()).availableFormats).toEqual(['text', 'rtf']);
      await expect(backend.read('rtf', { offset: 0, limit: 64 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });

      vi.mocked(getClipboardService).mockReturnValue(new ClipboardService(backend));
      const auto = await runToolContract(clipboardRead, { format: 'auto' });
      expect(auto.structuredContent).toMatchObject({ format: 'text', content: 'abc' });
    }, 30_000);

    it('a flat RTFD package that fails to deserialize reads like any undecodable one', async () => {
      // A truncated package raises NSDeserializeException in the conversion instead of returning nil.
      const truncated = attributedForms(SOURCE, { attachment: true }).rtfd.subarray(0, 40);
      expect(truncated.subarray(0, 4).toString('latin1')).toBe('rtfd');
      seed({ 'com.apple.flat-rtfd': truncated, 'public.utf8-plain-text': Buffer.from('abc') });
      await expect(backend.read('rtf', { offset: 0, limit: 64 })).rejects.toMatchObject({
        category: 'format_unavailable',
      });
      vi.mocked(getClipboardService).mockReturnValue(new ClipboardService(backend));
      const auto = await runToolContract(clipboardRead, { format: 'auto' });
      expect(auto.structuredContent).toMatchObject({ format: 'text', content: 'abc' });

      seed({ 'public.rtf': Buffer.alloc(0), 'com.apple.flat-rtfd': truncated });
      await expect(backend.read('rtf', { offset: 0, limit: 64 })).resolves.toMatchObject({
        format: 'rtf',
        content: Buffer.alloc(0),
        totalByteSize: 0,
      });
    }, 30_000);

    it('a zero-length public.rtf beside a decodable flat RTFD reads the converted RTFD', async () => {
      const { rtfd } = attributedForms(SOURCE);
      seed({ 'public.rtf': Buffer.alloc(0), 'com.apple.flat-rtfd': rtfd });
      const result = await backend.read('rtf', { offset: 0, limit: 64 * MiB });
      expect(rtfPlainText(result.content)).toBe(TEXT);
    });

    it('a zero-length public.rtf beside an undecodable flat RTFD is an empty rtf success', async () => {
      seed({ 'public.rtf': Buffer.alloc(0), 'com.apple.flat-rtfd': Buffer.from('rtfd-bytes') });
      await expect(backend.read('rtf', { offset: 0, limit: 64 })).resolves.toMatchObject({
        format: 'rtf',
        content: Buffer.alloc(0),
        totalByteSize: 0,
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
        itemCount: 1,
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
          itemCount: 1,
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

  describe('#57 — multi-item pasteboards', () => {
    const WHOLE = { offset: 0, limit: 64 * MiB } as const;
    const PNGS = [buildSolidPng(10, 10), buildSolidPng(20, 20), buildSolidPng(30, 30)];

    it('3 × PNG: inspect counts the items; no item reads the first and says so; item reads each', async () => {
      seedItems(PNGS.map((png) => ({ 'public.png': png })));
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 3,
        availableFormats: ['image'],
        primaryFormat: 'image',
      });

      const whole = await backend.read('image', WHOLE);
      expect(whole).toMatchObject({ width: 10, height: 10, itemCount: 3, itemScope: 'first' });

      for (const [index, side] of [10, 20, 30].entries()) {
        const one = await backend.read('image', WHOLE, index);
        expect(one).toMatchObject({ width: side, height: side, itemCount: 3 });
        expect(one).not.toHaveProperty('itemScope');
      }
      await expect(backend.read('image', WHOLE, 3)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    }, 30_000);

    it('3 × HTML: no item reads the first item; item reads its own markup', async () => {
      seedItems([0, 1, 2].map((n) => ({ 'public.html': Buffer.from(`<p>item ${n}</p>`) })));
      const whole = await backend.read('html', WHOLE);
      expect(whole.content.toString()).toBe('<p>item 0</p>');
      expect(whole).toMatchObject({ itemCount: 3, itemScope: 'first' });

      const one = await backend.read('html', WHOLE, 1);
      expect(one.content.toString()).toBe('<p>item 1</p>');
      await expect(backend.read('text', WHOLE, 1)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('3 × text: no item reads every item joined; item reads its own text', async () => {
      seedItems([0, 1, 2].map((n) => ({ 'public.utf8-plain-text': Buffer.from(`item ${n}`) })));
      const whole = await backend.read('text', WHOLE);
      expect(whole.content.toString()).toBe('item 0\nitem 1\nitem 2');
      expect(whole).toMatchObject({ itemCount: 3, itemScope: 'joined' });

      const one = await backend.read('text', WHOLE, 1);
      expect(one.content.toString()).toBe('item 1');
      expect(one).not.toHaveProperty('itemScope');
    });

    it('3 × RTF and flat RTFD: no item reads one combined document; item reads its own public.rtf', async () => {
      // Each item's flat RTFD carries other text than its public.rtf, so a read of the RTFD shows.
      const forms = [0, 1, 2].map((n) => ({
        rtf: attributedForms(`{\\rtf1\\ansi item ${n}}`).rtf,
        rtfd: attributedForms(`{\\rtf1\\ansi rtfd ${n}}`).rtfd,
      }));
      seedItems(forms.map(({ rtf, rtfd }) => ({ 'public.rtf': rtf, 'com.apple.flat-rtfd': rtfd })));
      // AppKit builds a multi-item pasteboard's joined public.rtf from each item's flat RTFD.
      const whole = await backend.read('rtf', WHOLE);
      expect(rtfPlainText(whole.content)).toBe('rtfd 0\nrtfd 1\nrtfd 2');
      expect(whole).toMatchObject({ itemCount: 3, itemScope: 'joined' });

      const one = await backend.read('rtf', WHOLE, 1);
      expect(one.content.equals(forms[1]?.rtf ?? Buffer.alloc(0))).toBe(true);
    }, 30_000);

    it('a text item then a PNG item: each format reads the item carrying it', async () => {
      seedItems([
        { 'public.utf8-plain-text': Buffer.from('caption') },
        { 'public.png': PNGS[1] ?? REAL_PNG_13x7 },
      ]);
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 2,
        availableFormats: ['text', 'image'],
      });
      await expect(backend.read('image', WHOLE)).resolves.toMatchObject({
        width: 20,
        itemScope: 'first',
      });
      await expect(backend.read('image', WHOLE, 1)).resolves.toMatchObject({ width: 20 });
      await expect(backend.read('image', WHOLE, 0)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
      expect((await backend.read('text', WHOLE, 0)).content.toString()).toBe('caption');
      await expect(backend.read('text', WHOLE, 1)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    }, 30_000);

    it('an item carrying its image only as JPEG or GIF reads it as PNG, as the whole pasteboard does', async () => {
      const jpeg = encodeAs(buildSolidPng(10, 10), 'NSBitmapImageFileTypeJPEG');
      const gif = encodeAs(buildSolidPng(20, 20), 'NSBitmapImageFileTypeGIF');
      seed({ 'public.jpeg': jpeg });
      const whole = await backend.read('image', WHOLE);
      expect(whole).toMatchObject({ width: 10, height: 10, itemCount: 1 });
      const only = await backend.read('image', WHOLE, 0);
      expect(only).toMatchObject({ width: 10, height: 10, itemCount: 1 });
      expect(only.content.equals(whole.content)).toBe(true);

      seedItems([{ 'public.jpeg': jpeg }, { 'com.compuserve.gif': gif }]);
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 2,
        availableFormats: ['image'],
      });
      for (const [index, side] of [10, 20].entries()) {
        const one = await backend.read('image', WHOLE, index);
        expect(one).toMatchObject({ width: side, height: side, itemCount: 2 });
        expect(one.content.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }
    }, 30_000);

    it('an item holding only UTF-16 text reads as its UTF-8 translation', async () => {
      seedItems([
        { 'public.html': Buffer.from('<p>x</p>') },
        { 'public.utf16-plain-text': Buffer.from('héllo', 'utf16le') },
      ]);
      expect((await backend.read('text', WHOLE, 1)).content.toString()).toBe('héllo');
    });

    it('a single item: itemCount 1 and no itemScope; item 0 reads the same value; item 1 is format_unavailable', async () => {
      seed({ 'public.utf8-plain-text': Buffer.from('solo') });
      await expect(backend.inspect()).resolves.toMatchObject({ itemCount: 1 });
      const whole = await backend.read('text', WHOLE);
      expect(whole).toMatchObject({ itemCount: 1, content: Buffer.from('solo') });
      expect(whole).not.toHaveProperty('itemScope');
      const one = await backend.read('text', WHOLE, 0);
      expect(one.content.equals(whole.content)).toBe(true);
      await expect(backend.read('text', WHOLE, 1)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('an empty pasteboard: itemCount 0, and item 0 is format_unavailable', async () => {
      seed({});
      await expect(backend.inspect()).resolves.toEqual({
        primaryFormat: 'empty',
        availableFormats: [],
        itemCount: 0,
        rawTypes: [],
      });
      await expect(backend.read('text', WHOLE, 0)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('an item read pages through its own bytes under one revision', async () => {
      const texts = ['first item', 'second item, a longer one é', 'third'];
      seedItems(texts.map((text) => ({ 'public.utf8-plain-text': Buffer.from(text) })));
      const count = String(privateChangeCount());
      const expected = Buffer.from(texts[1] ?? '');
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const slice = await backend.read('text', { offset, limit: 5 }, 1);
        expect(slice).toMatchObject({ revision: count, totalByteSize: expected.byteLength });
        if (slice.content.byteLength === 0) break;
        chunks.push(slice.content);
        offset += slice.content.byteLength;
      }
      expect(offset).toBe(expected.byteLength);
      expect(Buffer.concat(chunks).equals(expected)).toBe(true);
    }, 60_000);

    it('an item read whose pasteboard is rewritten between its changeCount samples fails representation_changed', async () => {
      seedItems([0, 1, 2].map((n) => ({ 'public.utf8-plain-text': Buffer.from(`item ${n}`) })));
      midReadMutation = `pb.clearContents;\npb.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(${JSON.stringify(Buffer.from('BBBB').toString('base64'))}, 0), 'public.utf8-plain-text');`;
      try {
        await expect(backend.read('text', { offset: 0, limit: 4 }, 1)).rejects.toMatchObject({
          category: 'representation_changed',
        });
      } finally {
        midReadMutation = undefined;
      }
    });
  });

  describe('#59 — files', () => {
    const WHOLE = { offset: 0, limit: 64 * MiB } as const;
    let dir = '';
    let doc0 = '';
    let doc1 = '';
    let accented = '';
    let broken = '';
    let carriageReturn = '';
    let folder = '';

    beforeAll(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'clipboard-files-')));
      doc0 = join(dir, 'doc0.txt');
      doc1 = join(dir, 'doc1.txt');
      // A space and a combining accent (e + U+0301), as the file system stores it.
      accented = join(dir, 'doc 2 é.txt');
      broken = join(dir, 'line\nbreak.txt');
      carriageReturn = join(dir, 'carriage\rreturn.txt');
      folder = join(dir, 'folder');
      for (const file of [doc0, doc1, accented, broken, carriageReturn]) writeFileSync(file, 'x');
      mkdirSync(folder);
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('file URLs read as their paths in item order, one per line with no trailing newline', async () => {
      const paths = [doc0, doc1, folder, accented];
      seedUrls(paths.map((path) => ({ path })));
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 4,
        availableFormats: ['files'],
        primaryFormat: 'files',
      });

      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe(paths.join('\n'));
      expect(result).toMatchObject({
        format: 'files',
        totalByteSize: Buffer.byteLength(paths.join('\n')),
        itemCount: 4,
        itemScope: 'all',
      });
      expect(result).not.toHaveProperty('omittedPaths');
    });

    it('item reads one file’s path; an item past the last is format_unavailable', async () => {
      seedUrls([doc0, doc1, accented].map((path) => ({ path })));
      const one = await backend.read('files', WHOLE, 2);
      expect(one.content.toString()).toBe(accented);
      expect(one).not.toHaveProperty('itemScope');
      await expect(backend.read('files', WHOLE, 3)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('file reference URLs read as the paths they resolve to', async () => {
      seedUrls([{ reference: doc0 }, { reference: accented }]);
      expect(contents()['public.file-url']?.toString()).toMatch(/^file:\/\/\/\.file\/id=/);
      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe([doc0, accented].join('\n'));
    });

    it('file URLs beside an https URL list only the file paths', async () => {
      seedUrls([{ path: doc0 }, { url: 'https://example.com/a?b=1' }, { path: doc1 }]);
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 3,
        availableFormats: ['files'],
      });
      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe([doc0, doc1].join('\n'));
      await expect(backend.read('files', WHOLE, 1)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('a public.file-url holding a web URL or a bare word yields no path: no files, and the read is format_unavailable', async () => {
      seedItems([
        { 'public.file-url': Buffer.from('https://example.com/y') },
        { 'public.file-url': Buffer.from('not a url at all') },
      ]);
      const inspection = await backend.inspect();
      expect(inspection.rawTypes.map((entry) => entry.type)).toContain('public.file-url');
      expect(inspection.availableFormats).toEqual([]);
      await expect(backend.read('files', WHOLE)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('a file URL naming another host is skipped; localhost names this one', async () => {
      seedItems([
        { 'public.file-url': Buffer.from('file://otherhost/etc/hosts') },
        {
          'public.file-url': Buffer.from(
            pathToFileURL(doc0).href.replace('file:///', 'file://localhost/'),
          ),
        },
      ]);
      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe(doc0);
    });

    it('a file URL naming LOCALHOST in any case names this machine', async () => {
      seedItems([
        {
          'public.file-url': Buffer.from(
            pathToFileURL(doc0).href.replace('file:///', 'file://LocalHost/'),
          ),
        },
      ]);
      await expect(backend.inspect()).resolves.toMatchObject({ availableFormats: ['files'] });
      expect((await backend.read('files', WHOLE)).content.toString()).toBe(doc0);
    });

    it('a path containing only a carriage return is left out and counted; alone it lists no files', async () => {
      seedUrls([{ path: doc0 }, { path: carriageReturn }]);
      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe(doc0);
      expect(result).toMatchObject({ omittedPaths: 1, itemCount: 2 });

      seedUrls([{ path: carriageReturn }]);
      expect((await backend.inspect()).availableFormats).toEqual([]);
      await expect(backend.read('files', WHOLE)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('a path containing a line break is left out and counted', async () => {
      seedUrls([{ path: doc0 }, { path: broken }, { path: doc1 }]);
      expect((await backend.inspect()).availableFormats).toEqual(['files']);
      const result = await backend.read('files', WHOLE);
      expect(result.content.toString()).toBe([doc0, doc1].join('\n'));
      expect(result).toMatchObject({ omittedPaths: 1, itemCount: 3 });

      // The item holding the line-break path alone has no path to list.
      await expect(backend.read('files', WHOLE, 1)).rejects.toMatchObject({
        category: 'format_unavailable',
      });
    });

    it('when every path has a line break, files is not listed and the read is format_unavailable, whole and by item', async () => {
      seedUrls([{ path: broken }]);
      const inspection = await backend.inspect();
      expect(inspection.rawTypes.map((entry) => entry.type)).toContain('public.file-url');
      expect(inspection.availableFormats).not.toContain('files');
      for (const item of [undefined, 0]) {
        await expect(backend.read('files', WHOLE, item)).rejects.toMatchObject({
          category: 'format_unavailable',
        });
      }
    });

    it('a lone line-break path beside text: inspect lists text only, and auto reads the text', async () => {
      seedItems([
        {
          'public.file-url': Buffer.from(pathToFileURL(broken).href),
          'public.utf8-plain-text': Buffer.from('caption'),
        },
      ]);
      vi.mocked(getClipboardService).mockReturnValue(new ClipboardService(backend));
      const inspection = await runToolContract(clipboardInspect, {});
      expect(inspection.structuredContent).toMatchObject({
        primaryFormat: 'text',
        availableFormats: ['text'],
        itemCount: 1,
      });
      const auto = await runToolContract(clipboardRead, { format: 'auto' });
      expect(auto.structuredContent).toMatchObject({ format: 'text', content: 'caption' });
      expect(auto.structuredContent).not.toHaveProperty('notice');
    }, 30_000);

    it('a file URL beside an image: inspect ranks files first; image still reads the image', async () => {
      seedItems([
        { 'public.file-url': Buffer.from(pathToFileURL(doc0).href), 'public.png': REAL_PNG_13x7 },
      ]);
      await expect(backend.inspect()).resolves.toMatchObject({
        availableFormats: ['image', 'files'],
        primaryFormat: 'files',
      });
      await expect(backend.read('image', WHOLE)).resolves.toMatchObject({ width: 13, height: 7 });
      expect((await backend.read('files', WHOLE)).content.toString()).toBe(doc0);
    });

    it('a legacy NSFilenamesPboardType writer reads as files, one item per path', async () => {
      jxa(`ObjC.import('AppKit');
const pb = ${pasteboardRef()};
pb.clearContents;
pb.declareTypesOwner($(['NSFilenamesPboardType']), $());
if (!pb.setPropertyListForType($(${JSON.stringify([doc0, doc1])}), 'NSFilenamesPboardType')) throw new Error('seed failed');
'ok';`);
      await expect(backend.inspect()).resolves.toMatchObject({
        itemCount: 2,
        availableFormats: ['files'],
      });
      expect((await backend.read('files', WHOLE)).content.toString()).toBe([doc0, doc1].join('\n'));
    });

    it('a files read pages through its bytes under one revision, past the end included', async () => {
      const paths = [doc0, accented, doc1];
      seedUrls(paths.map((path) => ({ path })));
      const count = String(privateChangeCount());
      const expected = Buffer.from(paths.join('\n'));
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const slice = await backend.read('files', { offset, limit: 25 });
        expect(slice).toMatchObject({ revision: count, totalByteSize: expected.byteLength });
        if (slice.content.byteLength === 0) break;
        chunks.push(slice.content);
        offset += slice.content.byteLength;
      }
      expect(Buffer.concat(chunks).equals(expected)).toBe(true);
      const past = await backend.read('files', { offset: expected.byteLength + 7, limit: 25 });
      expect(past).toMatchObject({ content: Buffer.alloc(0), totalByteSize: expected.byteLength });
    }, 60_000);
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
