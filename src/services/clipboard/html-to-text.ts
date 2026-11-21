/**
 * @fileoverview Plain-text rendering of HTML for the fallback representation an
 * HTML write publishes beside the markup (macOS and Windows backends). Follows
 * the HTML Standard's `innerText` rules, taking each element's `display` from
 * the user-agent stylesheet by tag name (no CSS is evaluated).
 * @module services/clipboard/html-to-text
 */

const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
};

/**
 * Decode common named, decimal (`&#169;`), and hexadecimal (`&#xA9;`, `&#XA9;`)
 * references in one pass. `String.fromCodePoint` emits the correct surrogate pair for
 * astral code points. A reference outside the Unicode range, or one naming a
 * lone surrogate or NUL — none of which have a standalone text representation —
 * passes through as written rather than throwing.
 */
function decodeReferences(text: string): string {
  return text.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|nbsp));/gi,
    (reference, digits: string | undefined, name: string | undefined) => {
      if (digits === undefined) return NAMED_REFERENCES[name ?? ''] ?? reference;
      const codePoint =
        digits[0] === 'x' || digits[0] === 'X'
          ? Number.parseInt(digits.slice(1), 16)
          : Number.parseInt(digits, 10);
      if (codePoint <= 0 || codePoint > 0x10ffff) return reference;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return reference;
      return String.fromCodePoint(codePoint);
    },
  );
}

/**
 * Elements the user-agent stylesheet renders block-level (`block`, `list-item`,
 * `table`, `table-caption`), less `p`, which takes two line breaks. Each start
 * and end tag marks one, so an omitted optional end tag still separates.
 */
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'listing',
  'main',
  'menu',
  'nav',
  'ol',
  'optgroup',
  'option',
  'plaintext',
  'pre',
  'search',
  'section',
  'summary',
  'table',
  'ul',
  'xmp',
]);

/**
 * Elements the tokenizer reads as text up to their own end tag (raw text, RCDATA,
 * and script data) that are not rendered. `noscript` is among them because
 * scripting is taken as enabled.
 */
const HIDDEN_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
]);

/**
 * Elements whose content is raw text rendered as-is in a preformatted block:
 * `xmp` to its own end tag, `plaintext` to the end of input.
 */
const VERBATIM_ELEMENTS = new Set(['plaintext', 'xmp']);

const ASCII_LETTER = /[a-z]/i;

/**
 * HTML's whitespace. A carriage return counts because input preprocessing
 * turns it into a line feed.
 */
function isHtmlWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\f' || char === '\r';
}

/** Whether `char` ends a tag name: whitespace, `/`, or `>`. */
function endsTagName(char: string | undefined): boolean {
  return char === '/' || char === '>' || isHtmlWhitespace(char);
}

/**
 * Where the markup the `<` at `start` opens ends when the tokenizer makes it a
 * comment or drops it, or -1 when that `<` opens a tag or is text. Follows the
 * HTML Standard's tokenizer: `<?`, `<!` not followed by `--`, and `</` followed
 * by anything but an ASCII letter open a bogus comment, which ends after its
 * first `>` (so `</>` is dropped whole) or at the end of input. A DOCTYPE ends
 * the same way. `<![CDATA[` is a bogus comment too, since SVG and MathML, where
 * it opens a CDATA section, are not tracked. `</` at the end of input is text.
 */
function droppedMarkupEnd(html: string, start: number): number {
  const opener = html[start + 1];
  if (opener === '!' && html.startsWith('--', start + 2)) return commentEnd(html, start + 4);
  if (opener === '!' || opener === '?') return bogusCommentEnd(html, start + 2);
  if (opener !== '/') return -1;
  const next = html[start + 2];
  return next === undefined || ASCII_LETTER.test(next) ? -1 : bogusCommentEnd(html, start + 2);
}

/**
 * Where a bogus comment whose text starts at `from` ends: after its first `>`,
 * or at the end of input.
 */
function bogusCommentEnd(html: string, from: number): number {
  const close = html.indexOf('>', from);
  return close === -1 ? html.length : close + 1;
}

/**
 * Where a comment whose `<!--` ends at `from` ends: after a `>` or `->` right
 * there (an abrupt close), else after its first `-->` or `--!>`, else at the end
 * of input.
 */
function commentEnd(html: string, from: number): number {
  if (html[from] === '>') return from + 1;
  if (html.startsWith('->', from)) return from + 2;
  let dashes = html.indexOf('--', from);
  while (dashes !== -1) {
    const after = html[dashes + 2];
    if (after === '>') return dashes + 3;
    if (after === '!' && html[dashes + 3] === '>') return dashes + 4;
    dashes = html.indexOf('--', dashes + 1);
  }
  return html.length;
}

/** Where a tag name starting at `from` ends: at whitespace, `/`, or `>`, or at the end of input. */
function tagNameEnd(html: string, from: number): number {
  let index = from;
  while (index < html.length && !endsTagName(html[index])) index++;
  return index;
}

/**
 * Where a tag whose name ends at `from` ends: after its `>`, or -1 when the
 * input ends inside it. Follows the tokenizer's attribute states, folded to
 * the ones that decide that: a `>` ends the tag anywhere but inside a quoted
 * value, and a quote opens a value only where one starts, after an attribute
 * name's `=`. `between` stands for the states before and after a name, after
 * `/`, and after a quoted value.
 */
function attributesEnd(html: string, from: number): number {
  let state: 'between' | 'name' | 'value' | 'unquoted' | '"' | "'" = 'between';
  for (let index = from; index < html.length; index++) {
    const char = html[index];
    if (state === '"' || state === "'") {
      if (char === state) state = 'between';
    } else if (char === '>') {
      return index + 1;
    } else if (state === 'value') {
      if (!isHtmlWhitespace(char)) state = char === '"' || char === "'" ? char : 'unquoted';
    } else if (state === 'unquoted') {
      if (isHtmlWhitespace(char)) state = 'between';
    } else if (char === '/') {
      state = 'between';
    } else if (state === 'name' && char === '=') {
      state = 'value';
    } else if (!isHtmlWhitespace(char)) {
      state = 'name';
    }
  }
  return -1;
}

/**
 * Where the text of a `name` element starting at `from` ends: at its first
 * `</name`, in any letter case, followed by whitespace, `/`, or `>`; or -1 when
 * there is none and the text runs to the end of input.
 */
function textOnlyEnd(html: string, name: string, from: number): number {
  let close = html.indexOf('</', from);
  while (close !== -1) {
    const nameEnd = close + 2 + name.length;
    if (endsTagName(html[nameEnd]) && html.slice(close + 2, nameEnd).toLowerCase() === name) {
      return close;
    }
    close = html.indexOf('</', close + 2);
  }
  return -1;
}

/**
 * Collapsible whitespace: JavaScript's whitespace class, wider than HTML's
 * ASCII set, so a raw no-break space collapses the way `&nbsp;` does once
 * decoded to a plain space.
 */
const WHITESPACE_RUN = /\s+/g;

/** A CR LF pair or a lone CR, each of which input preprocessing turns into one LF. */
const LINE_ENDING = /\r\n?/g;

/**
 * Accumulates the text as `innerText` items: strings, and required line-break
 * counts that merge to the largest in a run and are dropped at the start and
 * end. Collapsible whitespace waits as one pending space, written only between
 * two pieces of text on the same line. Every operation is O(1) plus its own
 * output, so a document converts in one linear pass.
 */
class TextWriter {
  readonly #parts: string[] = [];
  #breaks = 0;
  #space = false;
  #started = false;
  #lineStart = true;

  /** A required line break: 1 at a block boundary, 2 at a paragraph's. */
  lineBreak(count: 1 | 2): void {
    if (count > this.#breaks) this.#breaks = count;
    this.#space = false;
  }

  /** Collapsible whitespace. */
  space(): void {
    this.#space = true;
  }

  /** A `<br>` line break, or the tab or line break before a table cell or row. */
  separator(char: '\n' | '\t'): void {
    this.#space = false;
    this.#write(char, true);
  }

  /** Text with no collapsible whitespace at either end. */
  text(value: string): void {
    this.#write(value, false);
  }

  /** Preformatted text, written as-is. */
  preformatted(value: string): void {
    this.#write(value, value.endsWith('\n'));
  }

  toString(): string {
    return this.#parts.join('');
  }

  #write(value: string, endsLine: boolean): void {
    if (this.#breaks > 0) {
      if (this.#started) this.#parts.push(this.#breaks === 2 ? '\n\n' : '\n');
    } else if (this.#space && !this.#lineStart) {
      this.#parts.push(' ');
    }
    this.#parts.push(value);
    this.#breaks = 0;
    this.#space = false;
    this.#started = true;
    this.#lineStart = endsLine;
  }
}

/**
 * Render HTML as plain text, following the HTML Standard's `innerText` rules:
 * `<br>` is a line break; block-level elements break before and after, `<p>`
 * twice, with adjacent breaks merged and none at either end; a tab precedes
 * every table cell but a row's first and a line break every row but a table's
 * first; `<pre>` keeps its whitespace less one newline right after its start
 * tag, and elsewhere whitespace collapses to one space, dropped beside a line
 * break or tab. Tags, attributes, and the elements whose content is text follow
 * the tokenizer: `xmp` and `plaintext` content is kept verbatim, while that of
 * `script`, `style`, `title`, `textarea`, `noscript`, `iframe`, `noembed`, and
 * `noframes` is dropped, as are comments, DOCTYPEs, and the bogus comments the
 * tokenizer makes of malformed markup such as `<?xml …?>` and Word's
 * `<![if …]>` markers. References are decoded once per text run, after
 * tokenization. Output uses LF.
 */
export function htmlToPlainText(html: string): string {
  const writer = new TextWriter();
  /**
   * Rows seen in the innermost open table and cells in its current row. Outside
   * any table it counts the rows and cells that arrive there; `outerTables`
   * holds the counts of the tables it is nested in, innermost last.
   */
  let table = { rows: 0, cells: 0 };
  const outerTables: (typeof table)[] = [];
  let preDepth = 0;
  /** The last token was a `<pre>` start tag, so a newline opening the next text is dropped. */
  let afterPreStart = false;

  const writeText = (raw: string): void => {
    const decoded = decodeReferences(raw);
    if (preDepth > 0) {
      let value = decoded.replace(LINE_ENDING, '\n');
      if (afterPreStart && value.startsWith('\n')) value = value.slice(1);
      if (value) writer.preformatted(value);
    } else {
      const collapsed = decoded.replace(WHITESPACE_RUN, ' ');
      const body = collapsed.trim();
      if (collapsed.startsWith(' ')) writer.space();
      if (body) writer.text(body);
      if (body && collapsed.endsWith(' ')) writer.space();
    }
    afterPreStart = false;
  };

  /** Start of the text run not yet written: everything since the last tag or comment. */
  let textStart = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) break;
    const droppedEnd = droppedMarkupEnd(html, start);
    if (droppedEnd !== -1) {
      if (start > textStart) writeText(html.slice(textStart, start));
      // `</>` emits no token, so a newline right after it is still the one a `<pre>` start tag drops.
      if (!html.startsWith('</>', start)) afterPreStart = false;
      cursor = textStart = droppedEnd;
      continue;
    }
    const closing = html[start + 1] === '/';
    const nameStart = start + (closing ? 2 : 1);
    const first = html[nameStart];
    if (first === undefined || !ASCII_LETTER.test(first)) {
      // Not a tag: the `<` stays part of the text run.
      cursor = start + 1;
      continue;
    }
    if (start > textStart) writeText(html.slice(textStart, start));
    afterPreStart = false;
    const nameEnd = tagNameEnd(html, nameStart);
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = attributesEnd(html, nameEnd);
    // The tokenizer drops a tag the input ends inside.
    if (end === -1) return writer.toString();
    cursor = textStart = end;

    const verbatim = VERBATIM_ELEMENTS.has(name);
    if (!closing && (verbatim || HIDDEN_TEXT_ELEMENTS.has(name))) {
      const close = name === 'plaintext' ? -1 : textOnlyEnd(html, name, end);
      if (verbatim) {
        writer.lineBreak(1);
        const text = html.slice(end, close === -1 ? html.length : close);
        if (text) writer.preformatted(text.replace(LINE_ENDING, '\n'));
      }
      if (close === -1) return writer.toString();
      const closeEnd = attributesEnd(html, close + 2 + name.length);
      if (closeEnd === -1) return writer.toString();
      cursor = textStart = closeEnd;
      if (verbatim) writer.lineBreak(1);
      continue;
    }

    if (name === 'br') {
      writer.separator('\n');
    } else if (name === 'p') {
      writer.lineBreak(2);
    } else if (closing) {
      if (name === 'table') table = outerTables.pop() ?? table;
      if (name === 'pre' && preDepth > 0) preDepth--;
    } else if (name === 'tr') {
      if (table.rows++ > 0) writer.separator('\n');
      table.cells = 0;
    } else if (name === 'td' || name === 'th') {
      if (table.cells++ > 0) writer.separator('\t');
    } else if (name === 'table') {
      outerTables.push(table);
      table = { rows: 0, cells: 0 };
    } else if (name === 'pre') {
      preDepth++;
      afterPreStart = true;
    }
    if (BLOCK_ELEMENTS.has(name)) writer.lineBreak(1);
  }
  if (textStart < html.length) writeText(html.slice(textStart));
  return writer.toString();
}
