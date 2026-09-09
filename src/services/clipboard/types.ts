/**
 * @fileoverview Domain types and shared utilities for the clipboard service.
 * @module services/clipboard/types
 */

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
 * Decode decimal (`&#169;`) and hexadecimal (`&#xA9;`, `&#XA9;`) character
 * references. `String.fromCodePoint` emits the correct surrogate pair for
 * astral code points. A reference outside the Unicode range, or one naming a
 * lone surrogate or NUL — none of which have a standalone text representation —
 * passes through as written rather than throwing.
 */
function decodeNumericReferences(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (reference, digits: string) => {
    const codePoint =
      digits[0] === 'x' || digits[0] === 'X'
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);
    if (codePoint <= 0 || codePoint > 0x10ffff) return reference;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return reference;
    return String.fromCodePoint(codePoint);
  });
}

/** Strip HTML tags to produce plain text, decoding common entities. */
export function stripHtmlTags(html: string): string {
  const decoded = decodeNumericReferences(
    html
      // Remove script and style blocks entirely (content, not just tags)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      // Insert a space before block-level closing tags so adjacent blocks don't merge
      .replace(
        /<\/(p|h[1-6]|div|li|td|tr|blockquote|pre|article|section|header|footer|aside|nav|main|figure|figcaption)>/gi,
        ' ',
      )
      // Also insert a space before self-closing <br> tags
      .replace(/<br\s*\/?>/gi, ' ')
      // Strip remaining tags
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' '),
  );
  return decoded.replace(/\s+/g, ' ').trim();
}

/** Result of reading clipboard content. */
export interface ReadResult {
  /** Content bytes — text is UTF-8, image is PNG. */
  content: Buffer;
  /** The format that was actually read. */
  format: ClipboardFormat;
  /** Image height in pixels (present only for image format). */
  height?: number;
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
   * Read clipboard content in the specified format.
   * Throws if the format is not present — callers should inspect first if unsure.
   */
  read(format: ClipboardFormat): Promise<ReadResult>;

  /**
   * Write content to the clipboard.
   * HTML fallback behavior is backend-dependent: macOS and Windows also publish
   * stripped plain text, while X11 and Wayland publish only text/html.
   */
  write(content: string, format: 'text' | 'html'): Promise<WriteResult>;
}
