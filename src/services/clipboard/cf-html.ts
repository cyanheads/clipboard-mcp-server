/**
 * @fileoverview CF_HTML ("HTML Format") envelope builder and header parser for
 * the Windows clipboard. Pure byte logic: the PowerShell helper only moves the
 * envelope's bytes, and every offset is computed and validated here.
 *
 * Format reference: Microsoft, "HTML Clipboard Format" — a UTF-8 header of
 * `Name:Value` lines (CRLF, LF, or CR endings) whose `StartHTML`, `EndHTML`,
 * `StartFragment`, and `EndFragment` values are decimal byte offsets from the
 * start of the data (leading zeros allowed; `StartHTML`/`EndHTML` are `-1`
 * when there is no context), followed by the HTML.
 * @module services/clipboard/cf-html
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';

const START_MARKER = '<!--StartFragment-->';
const END_MARKER = '<!--EndFragment-->';
const CONTEXT_OPEN = `<html><body>\r\n${START_MARKER}`;
const CONTEXT_CLOSE = `${END_MARKER}\r\n</body></html>`;

/** Digits every offset is zero-padded to, so the header length never depends on the values. */
const OFFSET_WIDTH = 10;

/** Header byte offsets of a CF_HTML payload. */
export interface CfHtmlHeader {
  /** Offset of the first byte after the fragment (where `<!--EndFragment-->` starts). */
  endFragment: number;
  /** Offset just past the context, or -1 when the payload carries no context. */
  endHtml: number;
  /** Optional selection end. */
  endSelection?: number;
  /** Byte length of the header lines: the first byte that is not part of the header. */
  headerLength: number;
  /** Offset of the first fragment byte (just past `<!--StartFragment-->`). */
  startFragment: number;
  /** Offset where the context starts, or -1 when the payload carries no context. */
  startHtml: number;
  /** Optional selection start. */
  startSelection?: number;
  /** The `Version` value, e.g. `0.9` or `1.0`. */
  version: string;
}

/**
 * Build a UTF-8 CF_HTML envelope carrying `html` as its fragment, wrapped in a
 * minimal `<html><body>` context. No trailing NUL is appended.
 */
export function buildCfHtml(html: string): Buffer {
  const fragment = Buffer.from(html, 'utf8');
  const headerFor = (
    startHtml: number,
    endHtml: number,
    startFragment: number,
    endFragment: number,
  ) =>
    [
      'Version:0.9',
      `StartHTML:${pad(startHtml)}`,
      `EndHTML:${pad(endHtml)}`,
      `StartFragment:${pad(startFragment)}`,
      `EndFragment:${pad(endFragment)}`,
      '',
    ].join('\r\n');

  const headerLength = Buffer.byteLength(headerFor(0, 0, 0, 0), 'utf8');
  const startFragment = headerLength + Buffer.byteLength(CONTEXT_OPEN, 'utf8');
  const endFragment = startFragment + fragment.byteLength;
  const endHtml = endFragment + Buffer.byteLength(CONTEXT_CLOSE, 'utf8');

  return Buffer.concat([
    Buffer.from(
      headerFor(headerLength, endHtml, startFragment, endFragment) + CONTEXT_OPEN,
      'utf8',
    ),
    fragment,
    Buffer.from(CONTEXT_CLOSE, 'utf8'),
  ]);
}

function pad(value: number): string {
  const digits = String(value);
  if (digits.length > OFFSET_WIDTH) {
    throw new Error(`CF_HTML offset ${value} exceeds ${OFFSET_WIDTH} digits`);
  }
  return digits.padStart(OFFSET_WIDTH, '0');
}

/**
 * Parse the CF_HTML header at the start of `prefix`, the first bytes of a
 * `total`-byte clipboard payload. Returns `undefined` when the payload has no
 * header (it does not start with `Version:`), so the caller can treat it as
 * raw HTML. Throws a SerializationError naming the offending field when the
 * header is present but unusable — missing, non-numeric, out-of-range, or
 * reversed offsets, or a header longer than `prefix` — so header text is never
 * mistaken for HTML.
 */
export function parseCfHtmlHeader(prefix: Buffer, total: number): CfHtmlHeader | undefined {
  // latin1 maps each byte to one code unit, so string indices are byte offsets.
  const text = prefix.toString('latin1');
  if (!text.startsWith('Version:')) return undefined;

  const truncated = prefix.byteLength < total;
  const fields = new Map<string, string>();
  let pos = 0;
  for (;;) {
    let end = pos;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
    const lineText = text.slice(pos, end);
    const line = /^([A-Za-z]+):(.*)$/.exec(lineText);
    // A header line (or the start of one) cut off by the end of a partial
    // prefix may continue past it, so its value and length are unknown.
    const cutOff = truncated && end >= text.length - 1;
    if (cutOff && (line || /^[A-Za-z]*$/.test(lineText))) {
      throw malformed(
        'header',
        `the header runs past the first ${prefix.byteLength} bytes of the ${total}-byte payload`,
      );
    }
    if (!line?.[1]) break;
    if (!fields.has(line[1])) fields.set(line[1], line[2] ?? '');
    pos = end;
    if (text[pos] === '\r') pos++;
    if (text[pos] === '\n' && text[pos - 1] !== '\n') pos++;
    if (pos >= text.length) break;
  }
  const headerLength = pos;

  const version = fields.get('Version')?.trim() ?? '';
  if (!/^\d+\.\d+$/.test(version)) {
    throw malformed(
      'Version',
      `Version is ${JSON.stringify(version)}, not a number like 0.9 or 1.0`,
    );
  }

  const number = (field: string): number => {
    const raw = fields.get(field);
    if (raw === undefined) throw malformed(field, `${field} is missing`);
    const value = raw.trim();
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw malformed(field, `${field} is ${JSON.stringify(value)}, not a byte offset`);
    }
    return Number(value);
  };
  const inRange = (field: string, value: number, allowNone: boolean): number => {
    if (allowNone && value === -1) return value;
    if (value < 0 || value > total) {
      throw malformed(field, `${field} ${value} lies outside the ${total}-byte payload`);
    }
    return value;
  };

  const hasSelection = fields.has('StartSelection') || fields.has('EndSelection');
  const parsed = {
    startFragment: number('StartFragment'),
    endFragment: number('EndFragment'),
    startHtml: number('StartHTML'),
    endHtml: number('EndHTML'),
    startSelection: hasSelection ? number('StartSelection') : undefined,
    endSelection: hasSelection ? number('EndSelection') : undefined,
  };
  const startFragment = inRange('StartFragment', parsed.startFragment, false);
  const endFragment = inRange('EndFragment', parsed.endFragment, false);
  const startHtml = inRange('StartHTML', parsed.startHtml, true);
  const endHtml = inRange('EndHTML', parsed.endHtml, true);
  const startSelection =
    parsed.startSelection === undefined
      ? undefined
      : inRange('StartSelection', parsed.startSelection, false);
  const endSelection =
    parsed.endSelection === undefined
      ? undefined
      : inRange('EndSelection', parsed.endSelection, false);

  if ((startHtml === -1) !== (endHtml === -1)) {
    const field = startHtml === -1 ? 'StartHTML' : 'EndHTML';
    throw malformed(
      field,
      `${field} is -1 but its pair is not; both are -1 when there is no context`,
    );
  }
  if (startHtml !== -1 && startHtml < headerLength) {
    throw malformed(
      'StartHTML',
      `StartHTML ${startHtml} points into the ${headerLength}-byte header`,
    );
  }
  if (startFragment < headerLength) {
    throw malformed(
      'StartFragment',
      `StartFragment ${startFragment} points into the ${headerLength}-byte header`,
    );
  }
  if (endFragment < startFragment) {
    throw malformed(
      'EndFragment',
      `EndFragment ${endFragment} precedes StartFragment ${startFragment}`,
    );
  }
  if (startHtml !== -1 && startFragment < startHtml) {
    throw malformed(
      'StartFragment',
      `StartFragment ${startFragment} precedes StartHTML ${startHtml}`,
    );
  }
  if (endHtml !== -1 && endHtml < endFragment) {
    throw malformed('EndHTML', `EndHTML ${endHtml} precedes EndFragment ${endFragment}`);
  }
  if (startSelection !== undefined && endSelection !== undefined && endSelection < startSelection) {
    throw malformed(
      'EndSelection',
      `EndSelection ${endSelection} precedes StartSelection ${startSelection}`,
    );
  }

  return {
    version,
    startHtml,
    endHtml,
    startFragment,
    endFragment,
    headerLength,
    ...(startSelection !== undefined && { startSelection }),
    ...(endSelection !== undefined && { endSelection }),
  };
}

function malformed(field: string, detail: string) {
  return serializationError(`The clipboard's CF_HTML header is unusable: ${detail}.`, { field });
}
