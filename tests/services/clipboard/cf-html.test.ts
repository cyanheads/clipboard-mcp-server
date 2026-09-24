/**
 * @fileoverview Unit tests for the CF_HTML ("HTML Format") envelope builder and
 * header parser. Offsets are checked by slicing the UTF-8 buffer where each
 * header field points, per the Windows HTML Clipboard Format rules.
 * @module tests/services/clipboard/cf-html.test
 */

import { describe, expect, it } from 'vitest';
import { buildCfHtml, type CfHtmlHeader, parseCfHtmlHeader } from '@/services/clipboard/cf-html.js';

const START_MARKER = '<!--StartFragment-->';
const END_MARKER = '<!--EndFragment-->';

/** Parse a whole envelope (prefix == data) and return the fragment bytes. */
function fragmentOf(envelope: Buffer): Buffer {
  const header = parseCfHtmlHeader(envelope, envelope.byteLength);
  if (!header) throw new Error('expected a CF_HTML header');
  return envelope.subarray(header.startFragment, header.endFragment);
}

/** Header lines, joined with `eol`, followed by `body` — offsets supplied verbatim. */
function envelopeOf(lines: string[], body: string, eol = '\r\n'): Buffer {
  return Buffer.from(`${lines.join(eol)}${eol}${body}`, 'utf8');
}

/**
 * Hand-assembled envelope with correct offsets for `fragment`, laid out as
 * `header | <html><body> | START | fragment | END | </body></html>`.
 */
function handBuilt(
  fragment: string,
  opts: {
    eol?: string;
    pad?: number;
    version?: string;
    noContext?: boolean;
    extra?: string[];
  } = {},
): Buffer {
  const eol = opts.eol ?? '\r\n';
  const pad = opts.pad ?? 10;
  const version = opts.version ?? '0.9';
  const pre = opts.noContext ? START_MARKER : `<html><body>${START_MARKER}`;
  const post = opts.noContext ? END_MARKER : `${END_MARKER}</body></html>`;
  const n = (value: number) => (value < 0 ? String(value) : String(value).padStart(pad, '0'));
  const lineFor = (sh: number, eh: number, sf: number, ef: number) => [
    `Version:${version}`,
    `StartHTML:${n(sh)}`,
    `EndHTML:${n(eh)}`,
    `StartFragment:${n(sf)}`,
    `EndFragment:${n(ef)}`,
    ...(opts.extra ?? []),
  ];
  // Offsets depend on the header length, which depends on the offsets' printed
  // widths: iterate until the header length stops changing.
  const fragBytes = Buffer.byteLength(fragment, 'utf8');
  let headerLength = 0;
  for (;;) {
    const sh = opts.noContext ? -1 : headerLength;
    const sf = headerLength + Buffer.byteLength(pre, 'utf8');
    const ef = sf + fragBytes;
    const eh = opts.noContext ? -1 : ef + Buffer.byteLength(post, 'utf8');
    const lines = lineFor(sh, eh, sf, ef);
    const length = Buffer.byteLength(lines.join(eol) + eol, 'utf8');
    if (length === headerLength) return envelopeOf(lines, `${pre}${fragment}${post}`, eol);
    headerLength = length;
  }
}

describe('buildCfHtml', () => {
  it.each([
    ['ASCII', '<p>hello</p>'],
    ['multi-byte', '<p>café</p>'],
    ['astral', '<p>😀 smile</p>'],
    ['1 MiB', `<p>${'x'.repeat(1048569)}</p>`],
  ])('places every %s header offset on its marked position', (_label, html) => {
    const envelope = buildCfHtml(html);
    const header = parseCfHtmlHeader(envelope, envelope.byteLength) as CfHtmlHeader;
    expect(header.version).toBe('0.9');
    expect(envelope.subarray(header.startHtml, header.startHtml + 6).toString()).toBe('<html>');
    expect(
      envelope
        .subarray(header.startFragment - Buffer.byteLength(START_MARKER), header.startFragment)
        .toString(),
    ).toBe(START_MARKER);
    expect(
      envelope
        .subarray(header.endFragment, header.endFragment + Buffer.byteLength(END_MARKER))
        .toString(),
    ).toBe(END_MARKER);
    expect(header.endHtml).toBe(envelope.byteLength);
    expect(envelope.subarray(header.endHtml - 7, header.endHtml).toString()).toBe('</html>');
  });

  it.each([
    '<p>hello</p>',
    '<p>café 😀 世界</p>',
    '  <div>padded</div>\r\n<div>two</div>  \n',
    `<p>${'x'.repeat(1048569)}</p>`,
    // Markers inside the payload do not confuse offset-based extraction.
    `<p>${START_MARKER}inner${END_MARKER}</p>`,
    'plain text, no tags',
  ])('parse(build(x)) returns x byte for byte (%#)', (html) => {
    expect(fragmentOf(buildCfHtml(html)).equals(Buffer.from(html, 'utf8'))).toBe(true);
  });

  it('writes fixed-width, zero-padded decimal offsets on CRLF lines', () => {
    const text = buildCfHtml('<b>x</b>').toString('latin1');
    expect(text).toMatch(
      /^Version:0\.9\r\nStartHTML:\d{10}\r\nEndHTML:\d{10}\r\nStartFragment:\d{10}\r\nEndFragment:\d{10}\r\n<html>/,
    );
  });

  it('adds no trailing NUL', () => {
    const envelope = buildCfHtml('<b>x</b>');
    expect(envelope.at(-1)).not.toBe(0);
  });
});

describe('parseCfHtmlHeader — accepted grammar', () => {
  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
    ['CR', '\r'],
  ])('accepts %s line endings', (_label, eol) => {
    const envelope = handBuilt('<p>x</p>', { eol });
    expect(fragmentOf(envelope).toString()).toBe('<p>x</p>');
  });

  it.each([1, 6, 10, 14])('accepts offsets zero-padded to %i digits', (pad) => {
    const envelope = handBuilt('<p>x</p>', { pad });
    expect(fragmentOf(envelope).toString()).toBe('<p>x</p>');
  });

  it.each(['0.9', '1.0'])('accepts Version:%s', (version) => {
    const envelope = handBuilt('<p>x</p>', { version });
    const header = parseCfHtmlHeader(envelope, envelope.byteLength);
    expect(header?.version).toBe(version);
  });

  it('accepts StartHTML:-1 with EndHTML:-1 (no context)', () => {
    const envelope = handBuilt('<p>x</p>', { noContext: true });
    const header = parseCfHtmlHeader(envelope, envelope.byteLength);
    expect(header).toMatchObject({ startHtml: -1, endHtml: -1 });
    expect(fragmentOf(envelope).toString()).toBe('<p>x</p>');
  });

  it('accepts optional StartSelection/EndSelection and SourceURL lines', () => {
    const plain = handBuilt('<p>sel</p>');
    const plainHeader = parseCfHtmlHeader(plain, plain.byteLength) as CfHtmlHeader;
    // Same widths as the offsets so the precomputed layout stays exact.
    const extra = [
      'SourceURL:https://example.com/page?q=1',
      'StartSelection:0000000000',
      'EndSelection:0000000000',
    ];
    const withExtras = handBuilt('<p>sel</p>', { extra });
    const header = parseCfHtmlHeader(withExtras, withExtras.byteLength) as CfHtmlHeader;
    expect(fragmentOf(withExtras).toString()).toBe('<p>sel</p>');
    expect(header.headerLength).toBeGreaterThan(plainHeader.headerLength);
    expect(header.startSelection).toBe(0);
    expect(header.endSelection).toBe(0);
  });

  it('ignores trailing NUL padding after the envelope', () => {
    const envelope = Buffer.concat([handBuilt('<p>x</p>'), Buffer.alloc(7)]);
    expect(fragmentOf(envelope).toString()).toBe('<p>x</p>');
  });

  it('parses from a bounded prefix of a larger payload', () => {
    const envelope = buildCfHtml(`<p>${'y'.repeat(100_000)}</p>`);
    const header = parseCfHtmlHeader(envelope.subarray(0, 512), envelope.byteLength);
    expect(header?.endFragment).toBe(
      envelope.byteLength - Buffer.byteLength(`${END_MARKER}\r\n</body></html>`),
    );
  });

  it('returns undefined for a payload with no Version header (headerless)', () => {
    const raw = Buffer.from('<html><body><p>x</p></body></html>\0', 'utf8');
    expect(parseCfHtmlHeader(raw, raw.byteLength)).toBeUndefined();
  });
});

describe('parseCfHtmlHeader — rejected headers name the field', () => {
  const good = (fragment = '<p>x</p>') => handBuilt(fragment);

  /** Rewrite one header field's value in a good envelope (keeps byte widths only if caller does). */
  function withField(field: string, value: string, source = good()): Buffer {
    const text = source.toString('latin1');
    const replaced = text.replace(new RegExp(`^${field}:[^\\r\\n]*`, 'm'), `${field}:${value}`);
    return Buffer.from(replaced, 'latin1');
  }

  function withoutField(field: string): Buffer {
    const text = good().toString('latin1');
    return Buffer.from(text.replace(new RegExp(`^${field}:[^\\r\\n]*\\r\\n`, 'm'), ''), 'latin1');
  }

  function expectFieldError(envelope: Buffer, field: string) {
    let thrown: unknown;
    try {
      parseCfHtmlHeader(envelope, envelope.byteLength);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(field);
    expect((thrown as { data?: { field?: string } }).data?.field).toBe(field);
  }

  it.each(['StartHTML', 'EndHTML', 'StartFragment', 'EndFragment'])('missing %s', (field) => {
    expectFieldError(withoutField(field), field);
  });

  it.each(['StartHTML', 'EndHTML', 'StartFragment', 'EndFragment'])('non-numeric %s', (field) => {
    expectFieldError(withField(field, '00000abcde'), field);
  });

  it('non-numeric Version', () => {
    expectFieldError(withField('Version', 'x.y'), 'Version');
  });

  it.each(['StartFragment', 'EndFragment', 'EndHTML'])('%s past the end of the data', (field) => {
    expectFieldError(withField(field, '9999999999'), field);
  });

  it('negative StartFragment', () => {
    expectFieldError(withField('StartFragment', '-1'), 'StartFragment');
  });

  it('StartFragment pointing into the header text', () => {
    expectFieldError(withField('StartFragment', '0000000003'), 'StartFragment');
  });

  it('StartHTML pointing into the header text', () => {
    expectFieldError(withField('StartHTML', '0000000001'), 'StartHTML');
  });

  it('reversed fragment offsets (EndFragment before StartFragment)', () => {
    const envelope = good();
    const header = parseCfHtmlHeader(envelope, envelope.byteLength) as CfHtmlHeader;
    const reversed = withField(
      'EndFragment',
      String(header.startFragment - 1).padStart(10, '0'),
      envelope,
    );
    expectFieldError(reversed, 'EndFragment');
  });

  it('reversed context offsets (EndHTML before EndFragment)', () => {
    const envelope = good();
    const header = parseCfHtmlHeader(envelope, envelope.byteLength) as CfHtmlHeader;
    expectFieldError(
      withField('EndHTML', String(header.endFragment - 1).padStart(10, '0'), envelope),
      'EndHTML',
    );
  });

  it('only one of StartHTML/EndHTML set to -1', () => {
    expectFieldError(withField('EndHTML', '-1'), 'EndHTML');
  });

  it('reversed selection offsets', () => {
    const envelope = handBuilt('<p>x</p>', {
      extra: ['StartSelection:0000000009', 'EndSelection:0000000001'],
    });
    expectFieldError(envelope, 'EndSelection');
  });

  it('a header that runs past the prefix fails rather than guessing', () => {
    const longUrl = `SourceURL:https://example.com/${'a'.repeat(200)}`;
    const envelope = handBuilt('<p>x</p>', { extra: [longUrl] });
    expect(() => parseCfHtmlHeader(envelope.subarray(0, 100), envelope.byteLength)).toThrow(
      /header/i,
    );
  });

  it('is a SerializationError, never a caller validation error', () => {
    const envelope = withoutField('StartFragment');
    expect(() => parseCfHtmlHeader(envelope, envelope.byteLength)).toThrow(
      expect.objectContaining({ code: -32070 }),
    );
  });
});
