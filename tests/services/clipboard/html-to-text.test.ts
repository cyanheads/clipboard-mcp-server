/**
 * @fileoverview Tests for `htmlToPlainText`, the plain-text fallback an HTML
 * write publishes on macOS and Windows: the `innerText`-style line breaks, tabs,
 * and whitespace rules, the tokenizer's script/style/title, comment, bogus
 * comment, and attribute handling, reference decoding, and linear CPU cost.
 * @module tests/services/clipboard/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '@/services/clipboard/html-to-text.js';

describe('htmlToPlainText', () => {
  describe('line breaks and tabs (#56)', () => {
    it.each([
      [
        'a table: tab between cells, line break between rows',
        '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apples</td><td>3</td></tr></table>',
        `<table>
  <tr>
    <th>Name</th>
    <th>Qty</th>
  </tr>
  <tr>
    <td>Apples</td>
    <td>3</td>
  </tr>
</table>`,
        'Name\tQty\nApples\t3',
      ],
      [
        'a description list',
        '<dl><dt>Term</dt><dd>Definition</dd></dl>',
        '<dl>\n  <dt>Term</dt>\n  <dd>Definition</dd>\n</dl>',
        'Term\nDefinition',
      ],
      ['a horizontal rule', 'Before<hr>After', 'Before\n<hr>\nAfter', 'Before\nAfter'],
      [
        'select options',
        '<select><option>A</option><option>B</option></select>',
        '<select>\n  <option>A</option>\n  <option>B</option>\n</select>',
        'A\nB',
      ],
      [
        'list items',
        '<ul><li>one</li><li>two</li></ul>',
        '<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>',
        'one\ntwo',
      ],
      [
        'a <br> inside a paragraph',
        '<p>Line A<br>Line B</p>',
        '<p>\n  Line A<br>\n  Line B\n</p>',
        'Line A\nLine B',
      ],
      [
        'preformatted text',
        '<pre>line1\n  line2</pre>',
        '<div>\n  <pre>line1\n  line2</pre>\n</div>',
        'line1\n  line2',
      ],
      ['paragraphs', '<p>A</p><p>B</p>', '<p>A</p>\n\n  <p>B</p>\n', 'A\n\nB'],
      [
        'text before a block',
        'Intro<div>Body</div>',
        'Intro\n<div>\n  Body\n</div>',
        'Intro\nBody',
      ],
      [
        'list items with omitted end tags',
        '<ul><li>one<li>two</ul>',
        '<ul>\n  <li>one\n  <li>two\n</ul>',
        'one\ntwo',
      ],
    ])('separates %s, compact or pretty-printed', (_label, compact, pretty, expected) => {
      expect(htmlToPlainText(compact)).toBe(expected);
      expect(htmlToPlainText(pretty)).toBe(expected);
    });

    it('puts a blank line between a heading and the paragraph after it', () => {
      expect(htmlToPlainText('<h1>Title</h1><p>Body text</p>')).toBe('Title\n\nBody text');
    });

    it('merges adjacent breaks to the largest and drops them at the start and end', () => {
      expect(htmlToPlainText('<div><p>x</p></div>')).toBe('x');
      expect(htmlToPlainText('<div>a</div><p>b</p>')).toBe('a\n\nb');
      expect(htmlToPlainText('<h2>a</h2><div><div>b</div></div>')).toBe('a\nb');
      expect(htmlToPlainText('<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>')).toBe('a\n\nb\n\nc');
    });

    it('keeps each <br> as its own line break, never merged', () => {
      expect(htmlToPlainText('a<br><br>b')).toBe('a\n\nb');
      expect(htmlToPlainText('a <br> b')).toBe('a\nb');
      expect(htmlToPlainText('Line 1<br/>Line 2')).toBe('Line 1\nLine 2');
      expect(htmlToPlainText('copied line<br class="Apple-interchange-newline">')).toBe(
        'copied line\n',
      );
    });

    it('marks boundaries at start tags, so omitted end tags still separate', () => {
      expect(htmlToPlainText('<p>one<p>two')).toBe('one\n\ntwo');
      expect(htmlToPlainText('<dl><dt>a<dd>b<dt>c</dl>')).toBe('a\nb\nc');
      expect(htmlToPlainText('<table><tr><td>a<td>b<tr><td>c<td>d</table>')).toBe('a\tb\nc\td');
    });

    it('gives a table caption its own line', () => {
      expect(htmlToPlainText('<table><caption>Cap</caption><tr><td>x</td></tr></table>')).toBe(
        'Cap\nx',
      );
    });

    it('keeps the tab for an empty first cell, so columns stay aligned', () => {
      const html =
        '<table><tr><th></th><th>Q1</th></tr><tr><th>A</th><td>1</td></tr><tr><td>B</td><td></td></tr></table>';
      expect(htmlToPlainText(html)).toBe('\tQ1\nA\t1\nB\t');
    });

    it('counts rows and cells per table through nested tables', () => {
      const html = `<table>
  <tr><td>a</td><td>
    <table>
      <tr><td>b</td><td>c</td></tr>
      <tr><td>d</td><td>e</td></tr>
    </table>
  </td></tr>
  <tr><td>f</td><td>g</td></tr>
</table>`;
      expect(htmlToPlainText(html)).toBe('a\t\nb\tc\nd\te\n\nf\tg');
      expect(
        htmlToPlainText(
          '<table><tr><td><table><tr><td><table><tr><td>x</td><td>y</td></tr></table></td><td>z</td></tr></table></td><td>w</td></tr><tr><td>v</td></tr></table>',
        ),
      ).toBe('x\ty\n\tz\n\tw\nv');
    });

    it('separates rows and cells that arrive without an enclosing table', () => {
      expect(htmlToPlainText('<tr><td>a</td><td>b</td></tr><tr><td>c</td></tr>')).toBe('a\tb\nc');
    });

    it('collapses whitespace runs to one space across inline elements', () => {
      expect(htmlToPlainText('foo<span>bar</span> baz')).toBe('foobar baz');
      expect(htmlToPlainText('foo <span> bar</span>')).toBe('foo bar');
      expect(htmlToPlainText('a\t\t b\r\n c')).toBe('a b c');
      expect(htmlToPlainText('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
    });

    it('drops whitespace next to a line break or a tab', () => {
      expect(htmlToPlainText('<table><tr><td> a </td><td> b </td></tr></table>')).toBe('a\tb');
      expect(htmlToPlainText(' x <br> y ')).toBe('x\ny');
      expect(htmlToPlainText('x <div> y </div> z')).toBe('x\ny\nz');
    });

    describe('<pre>', () => {
      it('keeps its whitespace, indentation on the first line included', () => {
        expect(htmlToPlainText('<pre>  indented\n\tmore   spaced</pre>')).toBe(
          '  indented\n\tmore   spaced',
        );
        expect(htmlToPlainText('<p>Intro</p><pre>  code</pre><p>Outro</p>')).toBe(
          'Intro\n\n  code\n\nOutro',
        );
      });

      it('drops only the one newline right after the start tag', () => {
        expect(htmlToPlainText('<pre>\nfirst\n</pre>')).toBe('first\n');
        expect(htmlToPlainText('<pre>\n\nsecond</pre>')).toBe('\nsecond');
        expect(htmlToPlainText('<pre>\r\nthird</pre>')).toBe('third');
        expect(htmlToPlainText('<pre><code>\nfourth</code></pre>')).toBe('\nfourth');
        expect(htmlToPlainText('<pre><!-- note -->\nfifth</pre>')).toBe('\nfifth');
      });

      it('writes LF line endings', () => {
        expect(htmlToPlainText('<pre>a\r\nb\rc</pre>')).toBe('a\nb\nc');
      });

      it('keeps whitespace through nested inline elements and decodes references', () => {
        expect(htmlToPlainText('<pre><b>if</b> (a &lt; b)\n  <i>go</i>();</pre>')).toBe(
          'if (a < b)\n  go();',
        );
      });
    });
  });

  describe('HTML fallback correctness (#34)', () => {
    it('removes document declarations', () => {
      expect(htmlToPlainText('<!DOCTYPE html><html><body>kept</body></html>')).toBe('kept');
    });

    it.each(['script', 'style', 'title'])('treats %s contents as raw text', (tag) => {
      expect(htmlToPlainText(`<${tag}><x title="</${tag}><p>kept</p>`)).toBe('kept');
    });

    it('decodes each reference only once', () => {
      expect(htmlToPlainText('&amp;lt; &amp;#169; &amp;amp;')).toBe('&lt; &#169; &amp;');
      expect(htmlToPlainText('&#38;lt; &#x26;#169;')).toBe('&lt; &#169;');
    });

    it('keeps quoted angle brackets inside attributes', () => {
      expect(htmlToPlainText('<p title="1 > 0">kept</p>')).toBe('kept');
      expect(htmlToPlainText("<p title='1 > 0'>kept</p>")).toBe('kept');
    });

    it.each(['script', 'style', 'title'])(
      'drops %s content with whitespace in its closing tag',
      (tag) => {
        expect(htmlToPlainText(`<${tag}>hidden</${tag} ><p>kept</p>`)).toBe('kept');
      },
    );

    it('preserves block separators with whitespace in closing tags', () => {
      expect(htmlToPlainText('<p>first</p ><p>second</p>')).toBe('first\n\nsecond');
    });

    it('preserves comparison text and escaped markup as text', () => {
      expect(htmlToPlainText('1 < 2 and 3 > 2 &lt;b&gt;literal&lt;/b&gt;')).toBe(
        '1 < 2 and 3 > 2 <b>literal</b>',
      );
    });

    it('handles deeply nested tags without recursive traversal', () => {
      expect(htmlToPlainText(`${'<div>'.repeat(10000)}kept${'</div>'.repeat(10000)}`)).toBe('kept');
      expect(
        htmlToPlainText(`${'<table><tr><td>'.repeat(10000)}kept${'</table>'.repeat(10000)}`),
      ).toBe('kept');
    });
  });

  describe('comments and markup the tokenizer drops', () => {
    describe('openers that stay text and comments that close', () => {
      it('keeps a `<` that opens no tag, comment, or declaration as text', () => {
        expect(htmlToPlainText('x<3 and a <= b')).toBe('x<3 and a <= b');
        expect(htmlToPlainText('a<')).toBe('a<');
        expect(htmlToPlainText('a</')).toBe('a</');
        expect(htmlToPlainText('<<p>>')).toBe('<\n\n>');
      });

      it('drops a comment through its first `-->`', () => {
        expect(htmlToPlainText('a<!--x-->b')).toBe('ab');
        expect(htmlToPlainText('a<!---->b')).toBe('ab');
        expect(htmlToPlainText('a<!--x--->b')).toBe('ab');
        expect(htmlToPlainText('a<!-- <p>x</p> -->b<!--c-->d')).toBe('abd');
        expect(htmlToPlainText('a<!-- <!-- -->b')).toBe('ab');
        expect(htmlToPlainText('a<!-- <? -->b')).toBe('ab');
      });

      it('keeps a comment open past a `->` or `!>` that does not close it', () => {
        expect(htmlToPlainText('a<!--x->b-->c')).toBe('ac');
        expect(htmlToPlainText('a<!--!>b-->c')).toBe('ac');
        expect(htmlToPlainText('a<!---!>b-->c')).toBe('ac');
      });

      it('drops an unclosed comment through the end of input', () => {
        expect(htmlToPlainText('a<!--x')).toBe('a');
        expect(htmlToPlainText('a<!--x--')).toBe('a');
      });

      it('drops a Word downlevel-hidden conditional comment whole', () => {
        expect(htmlToPlainText('<!--[if gte mso 9]><xml><o:x>1</o:x></xml><![endif]-->A')).toBe(
          'A',
        );
      });

      it('drops a declaration through its `>`', () => {
        expect(htmlToPlainText('a<!x>-->b')).toBe('a-->b');
        expect(htmlToPlainText('a<!doctype q>b')).toBe('ab');
      });

      it.each(['script', 'title'])('keeps a bogus-comment opener inside %s as its text', (tag) => {
        expect(htmlToPlainText(`<${tag}>a <!x <? </ </${tag}>c`)).toBe('c');
      });
    });

    describe('bogus comments, abrupt comment closes, and `</>`', () => {
      // Expected values are Chrome's innerText of each input set as a div's innerHTML.
      it.each([
        ['a<?b', 'a'],
        ['a<!x', 'a'],
        ['a</ x>b', 'ab'],
        ['a</>b', 'ab'],
        ['a<![CDATA[z]]>b', 'ab'],
        ['a<!-->b', 'ab'],
        ['a<!--->b', 'ab'],
        ['a<?x>y?>b', 'ay?>b'],
        ['a</3>b', 'ab'],
        ['<div><?xml version="1.0"?>A<![if !supportLists]>B<![endif]>C<!DOCTYPE x>D</div>', 'ABCD'],
      ])('renders %j as a browser does', (html, expected) => {
        expect(htmlToPlainText(html)).toBe(expected);
      });

      it('returns an empty string for input that is only a bogus comment or `</>`', () => {
        expect(htmlToPlainText('<?x>')).toBe('');
        expect(htmlToPlainText('</>')).toBe('');
        expect(htmlToPlainText('<!x')).toBe('');
        expect(htmlToPlainText('<![endif]>')).toBe('');
      });

      it('runs an unclosed bogus comment to the end of input', () => {
        expect(htmlToPlainText('a<!')).toBe('a');
        expect(htmlToPlainText('a<!-')).toBe('a');
        expect(htmlToPlainText('a</ x')).toBe('a');
        expect(htmlToPlainText('a<![CDATA[b]]')).toBe('a');
      });

      it('ends a bogus comment at its first `>`, quotes notwithstanding', () => {
        expect(htmlToPlainText('a<?x title="1>2"?>b')).toBe('a2"?>b');
        expect(htmlToPlainText('a<!DOCTYPE x PUBLIC "p>q" "r">b')).toBe('aq" "r">b');
      });

      it('hides the markup a bogus comment swallows', () => {
        expect(htmlToPlainText('a<!<p>b')).toBe('ab');
        expect(htmlToPlainText('a<?<!--x-->b')).toBe('ab');
        expect(htmlToPlainText('a<?<script>?>b')).toBe('a?>b');
        expect(htmlToPlainText('a<!<title>b</title>c')).toBe('abc');
      });

      it('makes `<!` before a tag name a comment, not that element', () => {
        expect(htmlToPlainText('a<!p>b')).toBe('ab');
        expect(htmlToPlainText('a<!br>b')).toBe('ab');
        expect(htmlToPlainText('a<!script>x</script>y')).toBe('axy');
      });

      it('closes a comment at `--!>`', () => {
        expect(htmlToPlainText('a<!--x--!>b')).toBe('ab');
        expect(htmlToPlainText('a<!----!>b')).toBe('ab');
        expect(htmlToPlainText('a<!--x--!-->b')).toBe('ab');
      });

      it('collapses whitespace on both sides of a bogus comment to one space', () => {
        expect(htmlToPlainText('a <![if x]> b')).toBe('a b');
        expect(htmlToPlainText('a <?x> <![endif]> b')).toBe('a b');
      });

      it('decodes the text on each side of `</>` on its own', () => {
        expect(htmlToPlainText('&am</>p;')).toBe('&amp;');
      });

      describe('inside <pre>', () => {
        it('keeps the whitespace around a bogus comment', () => {
          expect(htmlToPlainText('<pre>a <?x> b\n<![if !x]>  c</pre>')).toBe('a  b\n  c');
        });

        it('keeps the newline after a comment that follows the start tag', () => {
          expect(htmlToPlainText('<pre><?x>\nfirst</pre>')).toBe('\nfirst');
          expect(htmlToPlainText('<pre><!-->\nsecond</pre>')).toBe('\nsecond');
        });

        it('drops the newline after `</>`, which is no token', () => {
          expect(htmlToPlainText('<pre></>\nthird</pre>')).toBe('third');
        });
      });

      describe('inside a table cell', () => {
        it('joins the cell text around Word’s conditional markers', () => {
          expect(
            htmlToPlainText('<table><tr><td>a<![if x]>b<![endif]></td><td>c</td></tr></table>'),
          ).toBe('ab\tc');
        });

        it('swallows a cell tag inside a bogus comment', () => {
          expect(htmlToPlainText('<table><tr><td>a<!<td>b</td></tr></table>')).toBe('ab');
        });
      });
    });
  });

  describe('tag names, attributes, and elements whose content is text', () => {
    describe('tags and text-only elements that already parse as a browser does', () => {
      it('drops a tag the input ends inside, with everything after it', () => {
        expect(htmlToPlainText('x<y then')).toBe('x');
        expect(htmlToPlainText('a<p title="x')).toBe('a');
      });

      it('ends a tag at its first `>` outside a quoted attribute value', () => {
        expect(htmlToPlainText('a<b c="d>e">f')).toBe('af');
        expect(htmlToPlainText(`<a b='c">'>d`)).toBe('d');
        expect(htmlToPlainText('<a href=x>y</a>')).toBe('y');
        expect(htmlToPlainText('<p>a</p foo="x>y">b')).toBe('a\n\nb');
      });

      it('ends script, style, and title content at an end tag in any letter case', () => {
        expect(htmlToPlainText('<script>a</SCRIPT>b')).toBe('b');
        expect(htmlToPlainText('<style>a</style\n>b')).toBe('b');
        expect(htmlToPlainText('<title>a</titlex>b</title>c')).toBe('c');
        expect(htmlToPlainText('<script><xmp>x</script>y')).toBe('y');
      });
    });

    describe('tag names and text-only elements as the tokenizer reads them', () => {
      // Expected values are Chrome's innerText of each input set as a div's innerHTML.
      it.each([
        ['x<a"b>y', 'xy'],
        ['<p.x>q', 'q'],
        ['a<b', 'a'],
        ['<xmp><b>x</b></xmp>y', '<b>x</b>\ny'],
        ['a<plaintext><b>x</b>', 'a\n<b>x</b>'],
        ['<xmp><?x></xmp>y', '<?x>\ny'],
        ['<textarea><b>x</b></textarea>y', 'y'],
        ['<noscript><b>x</b></noscript>y', 'y'],
        ['<iframe><b>x</b></iframe>y', 'y'],
        ['<noembed>x</noembed>y', 'y'],
        ['<noframes>x</noframes>y', 'y'],
        ['a<zz>b', 'ab'],
      ])('renders %j as a browser does', (html, expected) => {
        expect(htmlToPlainText(html)).toBe(expected);
      });

      it.each([
        ['<p>A</p><p>B</p>', '<P>A</P><P>B</P>', 'A\n\nB'],
        ['a<br>b', 'a<BR>b', 'a\nb'],
        [
          '<table><tr><td>a<td>b<tr><td>c<td>d</table>',
          '<TABLE><TR><TD>a<TD>b<TR><TD>c<TD>d</TABLE>',
          'a\tb\nc\td',
        ],
        ['<pre>  x\n  y</pre>z', '<PRE>  x\n  y</PRE>z', '  x\n  y\nz'],
        ['<script>hidden</script>b', '<SCRIPT>hidden</SCRIPT>b', 'b'],
      ])(
        'reads tag names in any letter case: %j and its upper-case form',
        (lower, upper, expected) => {
          expect(htmlToPlainText(lower)).toBe(expected);
          expect(htmlToPlainText(upper)).toBe(expected);
        },
      );

      it('runs a tag name to whitespace, `/`, or `>`, whatever it holds', () => {
        expect(htmlToPlainText('if (a<b) c>d')).toBe('if (ad');
        expect(htmlToPlainText('a<p.x>b<br.x>c')).toBe('abc');
      });

      it('drops an end tag the input ends inside', () => {
        expect(htmlToPlainText('a</p')).toBe('a');
        expect(htmlToPlainText('a</b c')).toBe('a');
      });

      it('opens a quoted attribute value only where a value starts', () => {
        expect(htmlToPlainText('x<a b"c>d"e>f')).toBe('xd"e>f');
        expect(htmlToPlainText('x<a b=c"d>e"f>g')).toBe('xe"f>g');
        expect(htmlToPlainText('x<a ="y>z">w')).toBe('xz">w');
        expect(htmlToPlainText('<p>a</p b"c>d"e>f')).toBe('a\n\nd"e>f');
      });

      it('ends script, style, and title content at an end tag with attributes or `/`', () => {
        expect(htmlToPlainText('<script>x</script/>y')).toBe('y');
        expect(htmlToPlainText('<style>x</style foo="a>b">y')).toBe('y');
        expect(htmlToPlainText('<title>x</title y>z')).toBe('z');
      });

      it('drops the content of an unrendered text-only element with no end tag', () => {
        expect(htmlToPlainText('a<iframe>b<p>c')).toBe('a');
        expect(htmlToPlainText('a<textarea>b')).toBe('a');
      });

      it('ends an unrendered text-only element only at its own end tag', () => {
        expect(htmlToPlainText('<noscript>a</noscriptx>b</noscript>c')).toBe('c');
        expect(htmlToPlainText('<textarea>a</text>b</textarea>c')).toBe('c');
      });

      it('returns an empty string for an empty or unrendered text-only element', () => {
        expect(htmlToPlainText('<textarea>')).toBe('');
        expect(htmlToPlainText('<xmp></xmp>')).toBe('');
        expect(htmlToPlainText('<plaintext>')).toBe('');
      });

      describe('<xmp> and <plaintext>', () => {
        it('render their content verbatim: markup, references, and whitespace', () => {
          expect(htmlToPlainText('<xmp>&amp; &lt;b&gt;</xmp>')).toBe('&amp; &lt;b&gt;');
          expect(htmlToPlainText('a<xmp>  x\r\n  y </xmp>b')).toBe('a\n  x\n  y \nb');
          expect(htmlToPlainText('<xmp><!--x--></xmp>')).toBe('<!--x-->');
          expect(htmlToPlainText('<xmp><script>x</script></xmp>y')).toBe('<script>x</script>\ny');
        });

        it('keeps a newline right after the <xmp> start tag', () => {
          expect(htmlToPlainText('<xmp>\nx</xmp>')).toBe('\nx');
        });

        it('end <xmp> at its own end tag in any letter case, even split by a line break', () => {
          expect(htmlToPlainText('<XMP>a</XmP>b')).toBe('a\nb');
          expect(htmlToPlainText('<xmp>a</xmp\n>b')).toBe('a\nb');
        });

        it('keep an <xmp> the input ends inside, and its end tag but for a cut-off one', () => {
          expect(htmlToPlainText('<xmp>a')).toBe('a');
          expect(htmlToPlainText('<xmp>a</xmp')).toBe('a</xmp');
          expect(htmlToPlainText('<xmp>a</xmp foo')).toBe('a');
        });

        it('run <plaintext> to the end of input, end tags included', () => {
          expect(htmlToPlainText('a<plaintext>x</plaintext><p>y')).toBe('a\nx</plaintext><p>y');
          expect(htmlToPlainText('<plaintext>&amp;\r\n')).toBe('&amp;\n');
        });
      });

      describe('nested', () => {
        it('keeps an <xmp> inside <pre> as its own block', () => {
          expect(htmlToPlainText('<pre>a <xmp> b </xmp> c</pre>')).toBe('a \n b \n c');
        });

        it('separates an <xmp> inside a list item', () => {
          expect(htmlToPlainText('<ul><li>a<xmp>b</xmp>c</li></ul>')).toBe('a\nb\nc');
        });

        it('hides a cell tag inside a <textarea> in a table cell', () => {
          expect(
            htmlToPlainText(
              '<table><tr><td>a<textarea><td>x</td></textarea>b</td><td>c</td></tr></table>',
            ),
          ).toBe('ab\tc');
        });
      });
    });
  });

  describe('basic tag stripping', () => {
    it('removes simple tags', () => {
      expect(htmlToPlainText('<p>Hello</p>')).toBe('Hello');
    });

    it('decodes common HTML entities', () => {
      // &nbsp; decodes to a space, which collapses and is dropped at the end like any other.
      expect(htmlToPlainText('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
    });

    it('collapses whitespace and trims', () => {
      expect(htmlToPlainText('  <p>  hello   world  </p>  ')).toBe('hello world');
    });

    it('returns an empty string for markup with no text', () => {
      expect(htmlToPlainText('')).toBe('');
      expect(htmlToPlainText('<p></p><div> </div><br-x>')).toBe('');
    });
  });

  describe('content that is not rendered (#3, #56)', () => {
    it('removes script tag and its content', () => {
      const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
      expect(htmlToPlainText(html)).toBe('Hello\n\nWorld');
    });

    it('removes style tag and its content', () => {
      expect(htmlToPlainText('<style>body { color: red; }</style><p>Hello</p>')).toBe('Hello');
    });

    it('removes multi-line script content', () => {
      const html =
        '<p>Before</p><script type="text/javascript">\n  var x = 1;\n  console.log(x);\n</script><p>After</p>';
      expect(htmlToPlainText(html)).toBe('Before\n\nAfter');
    });

    it('handles script tag with attributes', () => {
      expect(htmlToPlainText('<script src="evil.js" async></script><p>Content</p>')).toBe(
        'Content',
      );
    });

    it('drops the document title instead of fusing it with the first line', () => {
      expect(
        htmlToPlainText('<html><head><title>Doc</title></head><body><p>Hi</p></body></html>'),
      ).toBe('Hi');
    });

    it('drops everything after a script that never closes', () => {
      expect(htmlToPlainText('<p>kept</p><script>var never = "closed";<p>lost</p>')).toBe('kept');
    });
  });

  describe('block-element boundaries (#3)', () => {
    it('separates adjacent blocks — h1 + p', () => {
      expect(htmlToPlainText('<h1>Title</h1><p>Body text</p>')).toBe('Title\n\nBody text');
    });

    it('separates divs', () => {
      expect(htmlToPlainText('<div>First</div><div>Second</div>')).toBe('First\nSecond');
    });

    it('separates list items', () => {
      expect(htmlToPlainText('<ul><li>Item 1</li><li>Item 2</li></ul>')).toBe('Item 1\nItem 2');
    });

    it('drops a block element’s trailing whitespace', () => {
      expect(htmlToPlainText('<p>Hello </p><p>World</p>')).toBe('Hello\n\nWorld');
    });

    it.each([1, 2, 3, 4, 5, 6])('separates an h%i from the paragraph after it', (level) => {
      expect(htmlToPlainText(`<h${level}>Heading</h${level}><p>Content</p>`)).toBe(
        'Heading\n\nContent',
      );
    });
  });

  describe('entity pass-through characterization', () => {
    it('leaves a bare ampersand untouched', () => {
      expect(htmlToPlainText('<p>Salt &amp; pepper &amp; more</p>')).toBe('Salt & pepper & more');
      expect(htmlToPlainText('<p>AT&T</p>')).toBe('AT&T');
    });

    it('passes an unknown named entity through unchanged', () => {
      expect(htmlToPlainText('<p>&notanentity; &copy;</p>')).toBe('&notanentity; &copy;');
    });

    it('decodes named entities nested several levels deep', () => {
      const html =
        '<div><section><blockquote><p>a &lt; b &amp;&amp; c &gt; d</p></blockquote></section></div>';
      expect(htmlToPlainText(html)).toBe('a < b && c > d');
    });
  });

  describe('combined scenarios', () => {
    it('handles a complete document with head, scripts, styles, and blocks', () => {
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
      expect(htmlToPlainText(html)).toBe('Title\n\nFirst paragraph\n\nSecond paragraph');
    });
  });
});

describe('htmlToPlainText — numeric character references (#25)', () => {
  it('decodes decimal references', () => {
    expect(htmlToPlainText('<p>Caf&#233;</p>')).toBe('Café');
    expect(htmlToPlainText('<p>&#169; 2026</p>')).toBe('© 2026');
  });

  it('decodes lowercase hexadecimal references', () => {
    expect(htmlToPlainText('<p>Caf&#xe9;</p>')).toBe('Café');
    expect(htmlToPlainText('<p>&#xA9; 2026</p>')).toBe('© 2026');
  });

  it('decodes uppercase-X hexadecimal references', () => {
    expect(htmlToPlainText('<p>Caf&#Xe9;</p>')).toBe('Café');
  });

  it('decodes astral code points to the correct surrogate pair', () => {
    const result = htmlToPlainText('<p>Smile &#x1F600; and &#128512;</p>');
    expect(result).toBe('Smile 😀 and 😀');
    // Astral code points occupy two UTF-16 units — the pair must be well-formed.
    expect(result.codePointAt(result.indexOf('\u{1F600}'))).toBe(0x1f600);
  });

  it('decodes references nested several levels deep inside tags', () => {
    const html =
      '<div><section><blockquote><p>&#8220;Caf&#233; &#x2014; open&#8221;</p></blockquote></section></div>';
    expect(htmlToPlainText(html)).toBe('“Café — open”');
  });

  it('decodes references inside a list, one item per line', () => {
    const html = '<ul><li>&#8364;5</li><li>&#xa3;3</li></ul>';
    expect(htmlToPlainText(html)).toBe('€5\n£3');
  });

  it('passes an out-of-range code point through unchanged', () => {
    expect(htmlToPlainText('<p>&#1114112; &#x110000;</p>')).toBe('&#1114112; &#x110000;');
    expect(htmlToPlainText('<p>&#99999999999;</p>')).toBe('&#99999999999;');
  });

  it('passes a lone surrogate through unchanged', () => {
    expect(htmlToPlainText('<p>&#xD800; &#55296;</p>')).toBe('&#xD800; &#55296;');
    expect(htmlToPlainText('<p>&#xDFFF; &#57343;</p>')).toBe('&#xDFFF; &#57343;');
  });

  it('passes malformed references through unchanged', () => {
    expect(htmlToPlainText('<p>&#; &#x; &#xZZ; &#12</p>')).toBe('&#; &#x; &#xZZ; &#12');
  });

  it('keeps the six named entities working alongside numeric decoding', () => {
    expect(htmlToPlainText('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
  });

  it('still removes script content before decoding references in it', () => {
    const html = '<p>&#65;</p><script>var s = "&#66;";</script><p>&#67;</p>';
    const result = htmlToPlainText(html);
    expect(result).toBe('A\n\nC');
    expect(result).not.toContain('B');
  });
});

/**
 * The converter runs over caller-sized HTML, up to the 1 MiB write limit, so its
 * CPU cost is held linear on the shapes that break a scanner or a pending-state
 * writer. Thread CPU time per call is timed over batches that each convert
 * 320k characters. The input doubles from 5k to 320k characters, each size
 * timed beside a fresh 5k baseline, keeping the least growth of three pairs:
 * the cost may grow at most 4× faster than the input at every step, so the
 * full 64× span stays under 256×, and each call stays under a per-character
 * ceiling. The cases are synchronous, so a wall-clock timeout cannot stop one
 * early and would only fail a loaded host after the CPU assertions passed;
 * timeout 0 leaves those assertions as the only bound.
 */
describe('htmlToPlainText CPU cost', { timeout: 0 }, () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const BATCH_CHARACTERS = 320_000;
  /** Below this a baseline is under the timer's resolution, so growth is taken against the floor. */
  const BASELINE_FLOOR_MICROS = 5;
  const MAX_MICROS_PER_CHARACTER = 0.5;

  /** Thread CPU microseconds per call, over one batch of calls. */
  function cpuPerCall(input: string): number {
    const calls = Math.max(1, Math.round(BATCH_CHARACTERS / input.length));
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) htmlToPlainText(input);
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / calls;
  }

  /** `unit` repeated and cut to `size` characters. */
  const fill = (unit: string, size: number) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

  it.each([
    ['an opener repeated with no closer', (size: number) => '<'.repeat(size)],
    ['nested openers', (size: number) => `${'<a'.repeat(size / 4)}${'>'.repeat(size / 2)}`],
    ['an unclosed tag with a long attribute', (size: number) => `<p title="${'x'.repeat(size)}`],
    ['an unclosed tag name', (size: number) => `<${'a'.repeat(size)}`],
    ['an unclosed comment', (size: number) => `<!--${'-'.repeat(size)}`],
    [
      'an unclosed script of end-tag prefixes',
      (size: number) => `<script>${fill('</script ', size)}`,
    ],
    ['an unterminated decimal reference', (size: number) => `&#${'1'.repeat(size)}`],
    ['an unterminated hexadecimal reference', (size: number) => `&#x${'a'.repeat(size)}`],
    ['one long line ending in a break', (size: number) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size: number) => '  \r\n'.repeat(size / 4)],
    ['preformatted whitespace runs', (size: number) => `<pre>${fill(' \r\n\t  ', size)}</pre>`],
    [
      'blocks and line breaks throughout',
      (size: number) => fill('<p>a </p> <br> <div>b</div>', size),
    ],
    ['table cells throughout', (size: number) => fill('<tr><td> a <td>b ', size)],
    ['nested tables', (size: number) => fill('<table><tr><td>', size)],
    ['references and stray openers in text', (size: number) => fill('&amp;&#169; a < b ', size)],
    ['processing-instruction openers with no closer', (size: number) => fill('<?', size)],
    ['declaration openers with no closer', (size: number) => fill('<!x', size)],
    ['malformed end-tag openers with no closer', (size: number) => fill('</ ', size)],
    ['half comment openers with no closer', (size: number) => fill('<!-', size)],
    ['CDATA openers with no closer', (size: number) => fill('<![CDATA[', size)],
    ['closed processing instructions', (size: number) => fill('<?x>', size)],
    ['start-tag openers with no closer', (size: number) => fill('<a ', size)],
    ['end-tag openers with no closer', (size: number) => fill('</a ', size)],
    [
      'tags with quotes in and out of values',
      (size: number) => fill(`<a b"c=d 'e f='g' h=i"j>`, size),
    ],
    [
      'text-only elements throughout',
      (size: number) => fill('<xmp>a</xmp><noscript>b</noscript>', size),
    ],
    ['end-tag prefixes in an xmp', (size: number) => `<xmp>${fill('</xm</xmp', size)}`],
    ['end-tag prefixes in a textarea', (size: number) => `<textarea>${fill('</textarea', size)}`],
    ['plaintext markup and breaks', (size: number) => `<plaintext>${fill('<b>&amp;\r\n', size)}`],
    [
      'comments closed by `-->`, then by `--!>`',
      (size: number) => `${fill('<!--><!---><!--a-->', size / 2)}${fill('<!--b--!></>', size / 2)}`,
    ],
  ])('stays linear on %s', (_shape, build) => {
    const base = build(SIZES[0] as number);
    cpuPerCall(base);
    for (const size of SIZES.slice(1)) {
      const input = build(size);
      let growth = Number.POSITIVE_INFINITY;
      let perCall = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3; pair++) {
        const baseline = Math.max(cpuPerCall(base), BASELINE_FLOOR_MICROS);
        const sized = cpuPerCall(input);
        growth = Math.min(growth, sized / baseline);
        perCall = Math.min(perCall, sized);
      }
      expect(perCall, `${size} characters`).toBeLessThan(size * MAX_MICROS_PER_CHARACTER);
      expect(growth, `${size} characters`).toBeLessThan((size / (SIZES[0] as number)) * 4);
    }
  });
});
