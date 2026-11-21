/**
 * @fileoverview Tests for shared domain utilities in types.ts — buildInspectResult,
 * the classified-outcome sentinel, and the ranged-read envelope parser.
 * @module tests/services/clipboard/types.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildInspectResult,
  type ClipboardFormat,
  clipboardOutcome,
  inspectUnreadable,
  isClipboardOutcome,
  isInspectUnreadable,
  parseNativeTypeEntries,
  parseRangedReadEnvelope,
  toReadResult,
} from '@/services/clipboard/types.js';

describe('parseNativeTypeEntries', () => {
  describe('characterization: measured listings', () => {
    it('parses a list of measured entries, zero bytes included', () => {
      expect(
        parseNativeTypeEntries(
          '[{"type":"public.html","bytes":12},{"type":"public.utf8-plain-text","bytes":0}]',
          'macOS',
        ),
      ).toEqual([
        { type: 'public.html', bytes: 12 },
        { type: 'public.utf8-plain-text', bytes: 0 },
      ]);
    });

    it('parses a single object as a one-entry listing, and null as an empty one', () => {
      expect(parseNativeTypeEntries('{"type":"Text","bytes":5}', 'Windows')).toEqual([
        { type: 'Text', bytes: 5 },
      ]);
      expect(parseNativeTypeEntries('null', 'Windows')).toEqual([]);
    });

    it.each([
      ['non-JSON output', 'not json'],
      ['entries missing a type', '[{"bytes":12}]'],
      ['entries with a non-numeric size', '[{"type":"public.html","bytes":"big"}]'],
      ['a bare string', '"public.html"'],
    ])('rejects %s as unreadable', (_label, raw) => {
      expect(() => parseNativeTypeEntries(raw, 'macOS')).toThrow(/unreadable/);
    });
  });

  describe('#41 — unmeasured and failed entries', () => {
    it('accepts an entry the helper did not size, keeping bytes absent', () => {
      const [entry] = parseNativeTypeEntries('[{"type":"Bitmap"}]', 'Windows');
      expect(entry).toEqual({ type: 'Bitmap' });
      expect(entry).not.toHaveProperty('bytes');
    });

    it('accepts a failed measurement, keeping bytes absent', () => {
      expect(
        parseNativeTypeEntries(
          '[{"type":"public.utf8-plain-text","measurementFailed":true},{"type":"public.rtf","bytes":9}]',
          'macOS',
        ),
      ).toEqual([
        { type: 'public.utf8-plain-text', measurementFailed: true },
        { type: 'public.rtf', bytes: 9 },
      ]);
    });

    it.each([
      [
        'a failed measurement that also carries a size',
        '[{"type":"x","bytes":3,"measurementFailed":true}]',
      ],
      ['a failure flag that is not true', '[{"type":"x","measurementFailed":false}]'],
      ['a non-boolean failure flag', '[{"type":"x","measurementFailed":"yes"}]'],
      ['a negative size', '[{"type":"x","bytes":-1}]'],
      ['a fractional size', '[{"type":"x","bytes":1.5}]'],
    ])('still rejects %s as unreadable', (_label, raw) => {
      let caught: unknown;
      try {
        parseNativeTypeEntries(raw, 'Windows');
      } catch (error) {
        caught = error;
      }
      expect(isInspectUnreadable(caught)).toBe(true);
    });
  });
});

describe('clipboardOutcome (#36)', () => {
  it('builds an Error carrying its category, platform, and cause', () => {
    const cause = Object.assign(new Error('spawn xclip ENOENT'), { code: 'ENOENT' });
    const outcome = clipboardOutcome(
      'Linux X11',
      'xclip not found',
      { category: 'clipboard_unavailable', recoveryHint: 'apt install xclip' },
      cause,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({
      message: 'xclip not found',
      category: 'clipboard_unavailable',
      platform: 'Linux X11',
      recoveryHint: 'apt install xclip',
      cause,
    });
    expect(isClipboardOutcome(outcome)).toBe(true);
  });

  it.each(['empty', 'format_unavailable'] as const)(
    'builds a %s outcome with no hint',
    (category) => {
      const outcome = clipboardOutcome('Linux Wayland', 'x', { category });
      expect(outcome.category).toBe(category);
      expect(outcome).not.toHaveProperty('recoveryHint');
      expect(outcome).not.toHaveProperty('cause');
    },
  );

  it.each([
    ['a plain Error', new Error('format not found on clipboard')],
    ['the unreadable-inspection sentinel', inspectUnreadable('macOS', 'x')],
    ['a look-alike with a non-true marker', { _clipboardOutcome: 'yes', category: 'empty' }],
    ['null', null],
    ['a string', 'format_unavailable'],
  ])('rejects %s', (_label, value) => {
    expect(isClipboardOutcome(value)).toBe(false);
  });
});

describe('buildInspectResult — format priority', () => {
  /** The semantic format a type name spells, for entries named after their format. */
  const toFormat = (type: string) =>
    ['text', 'html', 'rtf', 'image', 'files'].includes(type) ? (type as ClipboardFormat) : null;

  /** Inspect entries whose type names are the semantic formats themselves. */
  function inspectOf(...types: string[]) {
    return buildInspectResult(
      types.map((type) => ({ type, bytes: 1 })),
      toFormat,
      1,
    );
  }

  it('ranks files above image, so a file-manager copy resolves to its paths (#59)', () => {
    const result = inspectOf('image', 'files', 'text', 'html');
    expect(result.primaryFormat).toBe('files');
    expect(result.availableFormats).toEqual(['text', 'html', 'image', 'files']);
  });

  it('a files entry whose measurement failed does not make files available', () => {
    expect(buildInspectResult([{ type: 'files', bytes: 1 }], toFormat, 1).availableFormats).toEqual(
      ['files'],
    );
    const result = buildInspectResult(
      [
        { type: 'files', measurementFailed: true },
        { type: 'image', bytes: 9 },
      ],
      toFormat,
      1,
    );
    expect(result.availableFormats).toEqual(['image']);
    expect(result.primaryFormat).toBe('image');
  });

  it.each([0, 1, 3])('reports the itemCount it is given (%i) (#57)', (itemCount) => {
    const entries = itemCount === 0 ? [] : [{ type: 'text', bytes: 1 }];
    expect(buildInspectResult(entries, toFormat, itemCount)).toEqual({
      rawTypes: entries,
      availableFormats: itemCount === 0 ? [] : ['text'],
      itemCount,
      primaryFormat: itemCount === 0 ? 'empty' : 'text',
    });
  });

  it('returns empty primary format when no formats present', () => {
    const result = inspectOf();
    expect(result.primaryFormat).toBe('empty');
    expect(result.availableFormats).toEqual([]);
  });

  it('returns text as primary when only text is present', () => {
    const result = inspectOf('text');
    expect(result.primaryFormat).toBe('text');
    expect(result.availableFormats).toEqual(['text']);
  });

  it('returns image as primary when image and text are present', () => {
    const result = inspectOf('image', 'text');
    expect(result.primaryFormat).toBe('image');
    expect(result.availableFormats).toEqual(['text', 'image']);
  });

  it('returns html as primary over rtf and text', () => {
    const result = inspectOf('text', 'rtf', 'html');
    expect(result.primaryFormat).toBe('html');
  });

  it('ignores types with no semantic format and collapses duplicates', () => {
    const result = inspectOf('TARGETS', 'text', 'text');
    expect(result.availableFormats).toEqual(['text']);
    expect(result.primaryFormat).toBe('text');
  });
});

describe('parseRangedReadEnvelope — revision and mid-read changes (#38)', () => {
  const envelope = (fields: Record<string, unknown>) =>
    JSON.stringify({ present: true, total: 3, contentBase64: 'YWJj', ...fields });

  it('returns the helper revision with the window', () => {
    expect(parseRangedReadEnvelope(envelope({ revision: '42' }), 'macOS', 'Text')).toEqual({
      total: 3,
      contentBase64: 'YWJj',
      revision: '42',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { revision: '' }],
    ['a number', { revision: 42 }],
  ])('a revision that is %s makes the envelope unreadable', (_label, fields) => {
    expect(() => parseRangedReadEnvelope(envelope(fields), 'Windows', 'RTF')).toThrow(
      expect.objectContaining({ code: -32070 }),
    );
  });

  it('`changed: true` is the typed representation_changed outcome, never unreadable', () => {
    let thrown: unknown;
    try {
      parseRangedReadEnvelope(JSON.stringify({ changed: true }), 'macOS', 'HTML');
    } catch (err) {
      thrown = err;
    }
    expect(isClipboardOutcome(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      category: 'representation_changed',
      platform: 'macOS',
      message: 'The clipboard changed while its HTML was being read.',
    });
  });

  it('characterization: `present: false` is still format_unavailable', () => {
    expect(() =>
      parseRangedReadEnvelope(JSON.stringify({ present: false }), 'macOS', 'RTF'),
    ).toThrow(expect.objectContaining({ category: 'format_unavailable' }));
  });
});

describe('parseRangedReadEnvelope — itemCount and omittedPaths (#57, #59)', () => {
  const envelope = (fields: Record<string, unknown>) =>
    JSON.stringify({ present: true, total: 3, contentBase64: 'YWJj', revision: '7', ...fields });

  it('carries the item count and the omitted-path count a helper reports', () => {
    expect(
      parseRangedReadEnvelope(envelope({ itemCount: 3, omittedPaths: 2 }), 'macOS', 'Files'),
    ).toEqual({ total: 3, contentBase64: 'YWJj', revision: '7', itemCount: 3, omittedPaths: 2 });
  });

  it('keeps an omitted-path count of 0 as the helper printed it', () => {
    expect(parseRangedReadEnvelope(envelope({ omittedPaths: 0 }), 'macOS', 'Files')).toEqual({
      total: 3,
      contentBase64: 'YWJj',
      revision: '7',
      omittedPaths: 0,
    });
  });

  it('leaves both out when the helper reports neither', () => {
    const window = parseRangedReadEnvelope(envelope({}), 'Windows', 'Text');
    expect(window).not.toHaveProperty('itemCount');
    expect(window).not.toHaveProperty('omittedPaths');
  });

  it('accepts 0 as either count', () => {
    expect(
      parseRangedReadEnvelope(envelope({ itemCount: 0, omittedPaths: 0 }), 'macOS', 'Files'),
    ).toMatchObject({ itemCount: 0, omittedPaths: 0 });
  });

  it.each([
    ['a string itemCount', { itemCount: '3' }],
    ['a null itemCount', { itemCount: null }],
    ['a boolean itemCount', { itemCount: true }],
    ['a negative itemCount', { itemCount: -1 }],
    ['a fractional itemCount', { itemCount: 2.5 }],
    ['a string omittedPaths', { omittedPaths: '1' }],
    ['an array omittedPaths', { omittedPaths: [1] }],
    ['a negative omittedPaths', { omittedPaths: -2 }],
    ['a fractional omittedPaths', { omittedPaths: 0.5 }],
  ])('%s makes the envelope unreadable', (_label, fields) => {
    expect(() => parseRangedReadEnvelope(envelope(fields), 'macOS', 'Files')).toThrow(
      expect.objectContaining({ code: -32070 }),
    );
  });

  it.each(['itemCount', 'omittedPaths'])(
    'a %s past the largest double (JSON 1e400, parsed as Infinity) makes the envelope unreadable',
    (field) => {
      const raw = envelope({}).replace(/\}$/, `,"${field}":1e400}`);
      expect(() => parseRangedReadEnvelope(raw, 'macOS', 'Files')).toThrow(
        expect.objectContaining({ code: -32070 }),
      );
    },
  );

  it('an absent envelope stays format_unavailable whatever counts ride it', () => {
    const raw = JSON.stringify({ present: false, itemCount: -1, omittedPaths: 0.5 });
    expect(() => parseRangedReadEnvelope(raw, 'macOS', 'Files')).toThrow(
      expect.objectContaining({ category: 'format_unavailable' }),
    );
  });
});

describe('toReadResult — items (#57, #59)', () => {
  const window = { total: 3, contentBase64: 'YWJj', revision: 'r' };

  it('builds the result from the window and the item metadata', () => {
    expect(
      toReadResult('files', { ...window, omittedPaths: 2 }, { itemCount: 3, itemScope: 'all' }),
    ).toEqual({
      format: 'files',
      content: Buffer.from('abc'),
      totalByteSize: 3,
      revision: 'r',
      itemCount: 3,
      itemScope: 'all',
      omittedPaths: 2,
    });
  });

  it('takes itemCount from the item metadata, never from the window', () => {
    expect(toReadResult('text', { ...window, itemCount: 5 }, { itemCount: 2 }).itemCount).toBe(2);
  });

  it('leaves out an absent itemScope and an omitted-path count of 0', () => {
    const result = toReadResult('files', { ...window, omittedPaths: 0 }, { itemCount: 1 });
    expect(result).not.toHaveProperty('itemScope');
    expect(result).not.toHaveProperty('omittedPaths');
  });

  it.each(['first', 'joined', 'all'] as const)('carries the %s item scope', (itemScope) => {
    expect(toReadResult('html', window, { itemCount: 2, itemScope }).itemScope).toBe(itemScope);
  });

  it('characterization: image dimensions still pass through', () => {
    expect(
      toReadResult('image', { ...window, width: 13, height: 7 }, { itemCount: 1 }),
    ).toMatchObject({ width: 13, height: 7 });
  });
});
