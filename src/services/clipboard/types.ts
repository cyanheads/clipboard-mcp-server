/**
 * @fileoverview Domain types and shared utilities for the clipboard service.
 * @module services/clipboard/types
 */

import { serializationError } from '@cyanheads/mcp-ts-core/errors';

/** A semantic clipboard format identifier. */
export type ClipboardFormat = 'text' | 'html' | 'rtf' | 'image';

/** Metadata about a single pasteboard type. */
export interface RawTypeEntry {
  /**
   * Byte size of this representation. Absent when `measurementFailed` is true —
   * a size that could not be read is reported as unknown, never as zero.
   */
  bytes?: number;
  /**
   * True when the platform listed this type but reading it to measure its size
   * failed. The type is present on the clipboard; only its size is unknown.
   */
  measurementFailed?: boolean;
  /** Platform-native type identifier (UTI, MIME type, or Windows format name). */
  type: string;
}

/**
 * Sentinel thrown by a backend whose native clipboard helper returned output
 * this server cannot read. Distinct from an empty clipboard, which is a
 * successful inspection with no types.
 */
export interface InspectUnreadableError {
  _inspectUnreadable: true;
  /** Platform whose helper produced the output. */
  platform: string;
}

/** Longest slice of unreadable helper output carried in the error message. */
const UNREADABLE_PREVIEW_LIMIT = 120;

/** Build the sentinel for helper output that could not be read. */
export function inspectUnreadable(platform: string, raw: string): Error & InspectUnreadableError {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const preview =
    collapsed.length > UNREADABLE_PREVIEW_LIMIT
      ? `${collapsed.slice(0, UNREADABLE_PREVIEW_LIMIT)}…`
      : collapsed;
  return Object.assign(
    new Error(
      `${platform} clipboard inspection returned unreadable output: ${preview || '(no output)'}`,
    ),
    { _inspectUnreadable: true as const, platform },
  );
}

/** Type guard for the unreadable-inspection sentinel. */
export function isInspectUnreadable(err: unknown): err is Error & InspectUnreadableError {
  return (
    typeof err === 'object' &&
    err !== null &&
    '_inspectUnreadable' in err &&
    (err as { _inspectUnreadable: unknown })._inspectUnreadable === true
  );
}

/**
 * What a native clipboard helper's outcome means, as classified by the
 * backend that ran it. Tools branch on this, never on helper message text.
 *
 * - `empty` — nothing is on the clipboard (no selection owner, nothing copied).
 * - `format_unavailable` — the clipboard holds content, but not the requested representation.
 * - `clipboard_unavailable` — the helper is missing, or it cannot reach the desktop session.
 */
export type ClipboardOutcomeCategory = 'empty' | 'format_unavailable' | 'clipboard_unavailable';

/** Category-specific fields: an unavailable clipboard always says how to recover. */
export type ClipboardOutcomeDetails =
  | { category: 'empty' | 'format_unavailable' }
  | {
      category: 'clipboard_unavailable';
      /** Next step for the caller — the install command or the session variable to fix. */
      recoveryHint: string;
    };

/**
 * Sentinel thrown by a backend for a classified helper outcome. Helper
 * failures a backend does not recognize stay ordinary errors.
 */
export type ClipboardOutcomeError = Error & {
  _clipboardOutcome: true;
  /** Platform whose helper produced the outcome. */
  platform: string;
} & ClipboardOutcomeDetails;

/** Build a classified-outcome sentinel. */
export function clipboardOutcome(
  platform: string,
  message: string,
  details: ClipboardOutcomeDetails,
  cause?: unknown,
): ClipboardOutcomeError {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { _clipboardOutcome: true as const, platform }, details);
}

/** Type guard for the classified-outcome sentinel. */
export function isClipboardOutcome(err: unknown): err is ClipboardOutcomeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    '_clipboardOutcome' in err &&
    (err as { _clipboardOutcome: unknown })._clipboardOutcome === true
  );
}

/** One `{ type, bytes }` pair as a platform's inspection helper emits it. */
interface NativeTypeEntry {
  bytes: number;
  type: string;
}

/**
 * Parse the JSON type listing a native inspection helper printed. Anything that
 * is not a list of `{ type: string, bytes: number }` throws the unreadable
 * sentinel — collapsing it to an empty list would be indistinguishable from a
 * genuinely empty clipboard. Callers handle their platform's own way of
 * spelling "nothing here" before calling.
 */
export function parseNativeTypeEntries(raw: string, platform: string): NativeTypeEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw inspectUnreadable(platform, raw);
  }
  if (parsed === null) return [];

  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) throw inspectUnreadable(platform, raw);
    const { bytes, type } = item as { bytes?: unknown; type?: unknown };
    if (typeof type !== 'string' || typeof bytes !== 'number' || !Number.isFinite(bytes)) {
      throw inspectUnreadable(platform, raw);
    }
    return { type, bytes };
  });
}

/** The window a ranged read helper returned for a present representation. */
export interface RangedReadWindow {
  /** Base64 of the requested `[offset, offset + limit)` byte window. */
  contentBase64: string;
  /** Image height in pixels (image reads only). */
  height?: number;
  /** Byte size of the full representation. */
  total: number;
  /** Image width in pixels (image reads only). */
  width?: number;
}

/**
 * Parse the `{ present, total, contentBase64, width?, height? }` envelope a
 * macOS or Windows ranged read helper prints. `present: false` is the helper
 * reporting the representation absent (`format_unavailable`). Anything else
 * that is not a well-formed envelope is a SerializationError: the helper's
 * output was unreadable, which is neither the caller's input being wrong nor
 * the format being absent. The response can carry clipboard bytes, so it never
 * rides the error.
 */
export function parseRangedReadEnvelope(
  raw: string,
  platform: string,
  formatName: string,
): RangedReadWindow {
  const unreadable = () =>
    serializationError(
      `${platform} clipboard helper returned an unreadable response while reading ${formatName}.`,
      { platform, format: formatName, responseBytes: raw.length },
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadable();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unreadable();
  const envelope = parsed as {
    contentBase64?: unknown;
    height?: unknown;
    present?: unknown;
    total?: unknown;
    width?: unknown;
  };
  if (typeof envelope.present !== 'boolean') throw unreadable();
  if (!envelope.present) {
    throw clipboardOutcome(platform, `${formatName} format not found on clipboard`, {
      category: 'format_unavailable',
    });
  }
  const { total, contentBase64, width, height } = envelope;
  if (
    typeof total !== 'number' ||
    typeof contentBase64 !== 'string' ||
    (width !== undefined && typeof width !== 'number') ||
    (height !== undefined && typeof height !== 'number')
  ) {
    throw unreadable();
  }
  return {
    total,
    contentBase64,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
  };
}

/** Result of a clipboard inspection operation. */
export interface InspectResult {
  /** All semantic formats present on the clipboard. */
  availableFormats: ClipboardFormat[];
  /** The richest semantic format present (image > html > rtf > text), or 'empty'. */
  primaryFormat: ClipboardFormat | 'empty';
  /** All explicitly-set pasteboard types with sizes. */
  rawTypes: RawTypeEntry[];
}

/**
 * Format priority from lowest to highest richness (image wins, text is baseline).
 * Sort descending by index to get richest-first order.
 */
export const FORMAT_PRIORITY: ClipboardFormat[] = ['text', 'rtf', 'html', 'image'];

/**
 * Derive primaryFormat and availableFormats from a set of detected semantic formats.
 * Returns `'empty'` as primaryFormat when the set is empty.
 */
export function buildInspectFormats(semanticSet: Set<ClipboardFormat>): {
  availableFormats: ClipboardFormat[];
  primaryFormat: ClipboardFormat | 'empty';
} {
  const availableFormats = FORMAT_PRIORITY.filter((f) => semanticSet.has(f));
  const primaryFormat =
    availableFormats.length > 0
      ? availableFormats.reduce((a, b) =>
          FORMAT_PRIORITY.indexOf(b) > FORMAT_PRIORITY.indexOf(a) ? b : a,
        )
      : ('empty' as const);
  return { availableFormats, primaryFormat };
}

/**
 * Decode common named, decimal (`&#169;`), and hexadecimal (`&#xA9;`, `&#XA9;`)
 * references in one pass. `String.fromCodePoint` emits the correct surrogate pair for
 * astral code points. A reference outside the Unicode range, or one naming a
 * lone surrogate or NUL — none of which have a standalone text representation —
 * passes through as written rather than throwing.
 */
function decodeReferences(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };
  return text.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|nbsp));/gi,
    (reference, digits: string | undefined, name: string | undefined) => {
      if (digits === undefined) return named[name ?? ''] ?? reference;
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

/** Strip HTML tags to produce plain text, decoding common entities. */
export function stripHtmlTags(html: string): string {
  const parts: string[] = [];
  const block =
    /^(?:p|h[1-6]|div|li|td|tr|blockquote|pre|article|section|header|footer|aside|nav|main|figure|figcaption)$/;
  let hidden: string | undefined;
  let cursor = 0;
  while (cursor < html.length) {
    if (hidden) {
      const close = new RegExp(`</${hidden}\\s*>`, 'gi');
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) break;
      cursor = close.lastIndex;
      hidden = undefined;
      continue;
    }
    const start = html.indexOf('<', cursor);
    if (start === -1) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, start));
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    const tag = /^<[!/]?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(start));
    if (!tag?.[1]) {
      parts.push('<');
      cursor = start + 1;
      continue;
    }
    const name = tag[1].toLowerCase();
    const closing = html[start + 1] === '/';
    let end = start + tag[0].length;
    let quote: string | undefined;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') break;
    }
    if (!closing && (name === 'script' || name === 'style')) {
      hidden = name;
    } else if (name === 'br' || (closing && block.test(name))) {
      parts.push(' ');
    }
    cursor = end + 1;
  }
  // Decode after tokenization, once: escaped markup remains literal text.
  return decodeReferences(parts.join('')).replace(/\s+/g, ' ').trim();
}

/**
 * A byte range for a bounded clipboard read: `[offset, offset + limit)`.
 * Backends stream at most `limit` bytes into memory regardless of how large
 * the underlying representation is.
 */
export interface ByteRange {
  /** Maximum number of bytes to retain in the window. */
  limit: number;
  /** Byte offset into the representation to start the window at. */
  offset: number;
}

/** Result of reading clipboard content. */
export interface ReadResult {
  /** The byte window `[range.offset, range.offset + range.limit)` of the representation. */
  content: Buffer;
  /** The format that was actually read. */
  format: ClipboardFormat;
  /** Image height in pixels (present only for image format). */
  height?: number;
  /** Total byte size of the full representation, regardless of how much of it `content` holds. */
  totalByteSize: number;
  /** Image width in pixels (present only for image format). */
  width?: number;
}

/**
 * Result of `ClipboardService.read()` — a UTF-8-trimmed byte window plus
 * continuation metadata for resuming a chunked read.
 */
export interface RangedReadResult {
  /** Bytes returned by this call (`content.byteLength`). */
  byteSize: number;
  /** True once this call's window reaches the end of the representation. */
  complete: boolean;
  /** The trimmed byte window. */
  content: Buffer;
  /** The format that was actually read. */
  format: ClipboardFormat;
  /** Image height in pixels (present only for image format). */
  height?: number;
  /** Offset to pass to the next call. Absent once `complete` is true. */
  nextOffset?: number;
  /** Total byte size of the full representation. */
  totalByteSize: number;
  /** Image width in pixels (present only for image format). */
  width?: number;
}

/** Result of writing clipboard content. */
export interface WriteResult {
  /** Byte size of the written content. */
  byteSize: number;
  /** The format that was written. */
  format: 'text' | 'html';
  /**
   * Plain text that was on the clipboard immediately before this write, for
   * recovery from an unintended overwrite. Absent when the clipboard was empty,
   * held no text representation, or its text exceeded the read size limit.
   */
  previousContent?: string;
}

/** Result of clearing the clipboard. */
export interface ClearResult {
  /** Always 0 — clearing publishes no content. */
  byteSize: number;
  /** Always true — this call cleared the clipboard instead of writing. */
  cleared: true;
  /**
   * Plain text that was on the clipboard immediately before this clear, for
   * recovery from an unintended clear. Absent when the clipboard was empty,
   * held no text representation, or its text exceeded the read size limit.
   */
  previousContent?: string;
}

/**
 * Platform-agnostic clipboard backend interface. All platform-specific
 * clipboard adapters implement this contract.
 */
export interface ClipboardBackend {
  /**
   * Remove every representation from the clipboard.
   * Each backend uses its platform's ownership-releasing primitive — writing
   * empty content instead would leave a zero-byte representation behind.
   */
  clear(): Promise<void>;
  /**
   * Inspect the clipboard: return type metadata without reading full content.
   * Platform: uses pb.types (macOS), TARGETS (X11), --list-types (Wayland), .GetFormats() (Windows).
   */
  inspect(): Promise<InspectResult>;

  /**
   * Read clipboard content in the specified format, bounded to `range`.
   * A format that is not present throws a `format_unavailable` (or, on an empty
   * clipboard, `empty`) outcome; a present zero-byte text, HTML, or RTF
   * representation is returned as empty content. A zero-byte image is too on
   * Linux; macOS and Windows cannot decode one and report it absent.
   */
  read(format: ClipboardFormat, range: ByteRange): Promise<ReadResult>;

  /**
   * Write content to the clipboard.
   * HTML fallback behavior is backend-dependent: macOS and Windows also publish
   * stripped plain text. The Linux helpers carry one payload, so an HTML write
   * has no stripped fallback — Wayland offers the markup under the plain-text
   * types too, and an `xclip`-owned X11 selection answers any target with it.
   */
  write(content: string, format: 'text' | 'html'): Promise<WriteResult>;
}
