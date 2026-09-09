/**
 * @fileoverview Tests for shared domain utilities in types.ts — stripHtmlTags, buildInspectFormats.
 * @module tests/services/clipboard/types.test
 */

import { describe, expect, it } from 'vitest';
import { buildInspectFormats, stripHtmlTags } from '@/services/clipboard/types.js';

describe('stripHtmlTags', () => {
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

describe('buildInspectFormats', () => {
  it('returns empty primary format when no formats present', () => {
    const result = buildInspectFormats(new Set());
    expect(result.primaryFormat).toBe('empty');
    expect(result.availableFormats).toEqual([]);
  });

  it('returns text as primary when only text is present', () => {
    const result = buildInspectFormats(new Set(['text' as const]));
    expect(result.primaryFormat).toBe('text');
    expect(result.availableFormats).toEqual(['text']);
  });

  it('returns image as primary when image and text are present', () => {
    const result = buildInspectFormats(new Set(['text' as const, 'image' as const]));
    expect(result.primaryFormat).toBe('image');
  });

  it('returns html as primary over rtf and text', () => {
    const result = buildInspectFormats(new Set(['text' as const, 'rtf' as const, 'html' as const]));
    expect(result.primaryFormat).toBe('html');
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
