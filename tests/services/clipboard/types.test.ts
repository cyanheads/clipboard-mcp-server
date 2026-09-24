/**
 * @fileoverview Tests for shared domain utilities in types.ts — stripHtmlTags, buildInspectResult,
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
  stripHtmlTags,
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

describe('stripHtmlTags', () => {
  describe('HTML fallback correctness (#34)', () => {
    it('removes document declarations', () => {
      expect(stripHtmlTags('<!DOCTYPE html><html><body>kept</body></html>')).toBe('kept');
    });

    it.each(['script', 'style'])('treats %s contents as raw text', (tag) => {
      expect(stripHtmlTags(`<${tag}><x title="</${tag}><p>kept</p>`)).toBe('kept');
    });
    it('decodes each reference only once', () => {
      expect(stripHtmlTags('&amp;lt; &amp;#169; &amp;amp;')).toBe('&lt; &#169; &amp;');
      expect(stripHtmlTags('&#38;lt; &#x26;#169;')).toBe('&lt; &#169;');
    });

    it('keeps quoted angle brackets inside attributes', () => {
      expect(stripHtmlTags('<p title="1 > 0">kept</p>')).toBe('kept');
      expect(stripHtmlTags("<p title='1 > 0'>kept</p>")).toBe('kept');
    });

    it.each(['script', 'style'])('drops %s content with whitespace in its closing tag', (tag) => {
      expect(stripHtmlTags(`<${tag}>hidden</${tag} ><p>kept</p>`)).toBe('kept');
    });

    it('preserves block separators with whitespace in closing tags', () => {
      expect(stripHtmlTags('<p>first</p ><p>second</p>')).toBe('first second');
    });

    it('preserves comparison text and escaped markup as text', () => {
      expect(stripHtmlTags('1 < 2 and 3 > 2 &lt;b&gt;literal&lt;/b&gt;')).toBe(
        '1 < 2 and 3 > 2 <b>literal</b>',
      );
    });

    it('handles deeply nested tags without recursive traversal', () => {
      expect(stripHtmlTags(`${'<div>'.repeat(10000)}kept${'</div>'.repeat(10000)}`)).toBe('kept');
    });
  });

  describe('basic tag stripping', () => {
    it('removes simple tags', () => {
      expect(stripHtmlTags('<p>Hello</p>')).toBe('Hello');
    });

    it('decodes common HTML entities', () => {
      // &nbsp; becomes a space; trailing spaces are trimmed by the final .trim()
      expect(stripHtmlTags('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
    });

    it('collapses whitespace and trims', () => {
      expect(stripHtmlTags('  <p>  hello   world  </p>  ')).toBe('hello world');
    });
  });

  describe('script and style content removal (issue #3)', () => {
    it('removes script tag and its content', () => {
      const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
      const result = stripHtmlTags(html);
      expect(result).not.toContain('alert');
      expect(result).not.toContain('xss');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('removes style tag and its content', () => {
      const html = '<style>body { color: red; }</style><p>Hello</p>';
      const result = stripHtmlTags(html);
      expect(result).not.toContain('color');
      expect(result).not.toContain('body');
      expect(result).toContain('Hello');
    });

    it('removes multi-line script content', () => {
      const html =
        '<p>Before</p><script type="text/javascript">\n  var x = 1;\n  console.log(x);\n</script><p>After</p>';
      const result = stripHtmlTags(html);
      expect(result).not.toContain('console');
      expect(result).not.toContain('var x');
      expect(result).toBe('Before After');
    });

    it('handles script tag with attributes', () => {
      const html = '<script src="evil.js" async></script><p>Content</p>';
      const result = stripHtmlTags(html);
      expect(result).not.toContain('evil');
      expect(result).toBe('Content');
    });
  });

  describe('block-element word boundary insertion (issue #3)', () => {
    it('inserts space between adjacent block elements — h1 + p', () => {
      const html = '<h1>Title</h1><p>Body text</p>';
      const result = stripHtmlTags(html);
      expect(result).toBe('Title Body text');
    });

    it('inserts space at div boundaries', () => {
      expect(stripHtmlTags('<div>First</div><div>Second</div>')).toBe('First Second');
    });

    it('inserts space at li boundaries', () => {
      expect(stripHtmlTags('<ul><li>Item 1</li><li>Item 2</li></ul>')).toBe('Item 1 Item 2');
    });

    it('handles br tags as word separators', () => {
      expect(stripHtmlTags('Line 1<br>Line 2')).toBe('Line 1 Line 2');
      expect(stripHtmlTags('Line 1<br/>Line 2')).toBe('Line 1 Line 2');
    });

    it('no double spacing when block element has trailing whitespace', () => {
      const html = '<p>Hello </p><p>World</p>';
      const result = stripHtmlTags(html);
      // Should collapse to single spaces
      expect(result).toBe('Hello World');
    });

    it('all h1–h6 headings insert word breaks', () => {
      for (let i = 1; i <= 6; i++) {
        const html = `<h${i}>Heading</h${i}><p>Content</p>`;
        const result = stripHtmlTags(html);
        expect(result).toBe('Heading Content');
      }
    });
  });

  describe('entity pass-through characterization', () => {
    it('leaves a bare ampersand untouched', () => {
      expect(stripHtmlTags('<p>Salt &amp; pepper &amp; more</p>')).toBe('Salt & pepper & more');
      expect(stripHtmlTags('<p>AT&T</p>')).toBe('AT&T');
    });

    it('passes an unknown named entity through unchanged', () => {
      expect(stripHtmlTags('<p>&notanentity; &copy;</p>')).toBe('&notanentity; &copy;');
    });

    it('decodes named entities nested several levels deep', () => {
      const html =
        '<div><section><blockquote><p>a &lt; b &amp;&amp; c &gt; d</p></blockquote></section></div>';
      expect(stripHtmlTags(html)).toBe('a < b && c > d');
    });
  });

  describe('combined scenarios', () => {
    it('handles complex document with scripts, styles, and block elements', () => {
      const html = `
        <html>
          <head>
            <style>.foo { color: red; }</style>
            <title>Page</title>
          </head>
          <body>
            <h1>Title</h1>
            <p>First paragraph</p>
            <script>var analytics = {};</script>
            <p>Second paragraph</p>
          </body>
        </html>
      `;
      const result = stripHtmlTags(html);
      expect(result).toContain('Title');
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
      expect(result).not.toContain('analytics');
      expect(result).not.toContain('color: red');
      // Block elements should produce spaces
      expect(result).toMatch(/Title\s+First paragraph/);
    });

    it('preserves inline content without extra spaces', () => {
      expect(stripHtmlTags('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
    });
  });
});

describe('buildInspectResult — format priority', () => {
  /** Inspect entries whose type names are the semantic formats themselves. */
  function inspectOf(...types: string[]) {
    return buildInspectResult(
      types.map((type) => ({ type, bytes: 1 })),
      (type) =>
        ['text', 'html', 'rtf', 'image'].includes(type) ? (type as ClipboardFormat) : null,
    );
  }

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

describe('stripHtmlTags — numeric character references (#25)', () => {
  it('decodes decimal references', () => {
    expect(stripHtmlTags('<p>Caf&#233;</p>')).toBe('Café');
    expect(stripHtmlTags('<p>&#169; 2026</p>')).toBe('© 2026');
  });

  it('decodes lowercase hexadecimal references', () => {
    expect(stripHtmlTags('<p>Caf&#xe9;</p>')).toBe('Café');
    expect(stripHtmlTags('<p>&#xA9; 2026</p>')).toBe('© 2026');
  });

  it('decodes uppercase-X hexadecimal references', () => {
    expect(stripHtmlTags('<p>Caf&#Xe9;</p>')).toBe('Café');
  });

  it('decodes astral code points to the correct surrogate pair', () => {
    const result = stripHtmlTags('<p>Smile &#x1F600; and &#128512;</p>');
    expect(result).toBe('Smile 😀 and 😀');
    // Astral code points occupy two UTF-16 units — the pair must be well-formed.
    expect(result.codePointAt(result.indexOf('\u{1F600}'))).toBe(0x1f600);
  });

  it('decodes references nested several levels deep inside tags', () => {
    const html =
      '<div><section><blockquote><p>&#8220;Caf&#233; &#x2014; open&#8221;</p></blockquote></section></div>';
    expect(stripHtmlTags(html)).toBe('“Café — open”');
  });

  it('decodes references inside a list, one per item', () => {
    const html = '<ul><li>&#8364;5</li><li>&#xa3;3</li></ul>';
    expect(stripHtmlTags(html)).toBe('€5 £3');
  });

  it('passes an out-of-range code point through unchanged', () => {
    expect(stripHtmlTags('<p>&#1114112; &#x110000;</p>')).toBe('&#1114112; &#x110000;');
    expect(stripHtmlTags('<p>&#99999999999;</p>')).toBe('&#99999999999;');
  });

  it('passes a lone surrogate through unchanged', () => {
    expect(stripHtmlTags('<p>&#xD800; &#55296;</p>')).toBe('&#xD800; &#55296;');
  });

  it('passes malformed references through unchanged', () => {
    expect(stripHtmlTags('<p>&#; &#x; &#xZZ; &#12</p>')).toBe('&#; &#x; &#xZZ; &#12');
  });

  it('keeps the six named entities working alongside numeric decoding', () => {
    expect(stripHtmlTags('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
  });

  it('still removes script content before decoding references in it', () => {
    const html = '<p>&#65;</p><script>var s = "&#66;";</script><p>&#67;</p>';
    const result = stripHtmlTags(html);
    expect(result).toBe('A C');
    expect(result).not.toContain('B');
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
