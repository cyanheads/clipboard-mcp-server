/**
 * @fileoverview Domain types and shared utilities for the clipboard service.
 * @module services/clipboard/types
 */

/** A semantic clipboard format identifier. */
export type ClipboardFormat = 'text' | 'html' | 'rtf' | 'image';

/** Metadata about a single pasteboard type. */
export interface RawTypeEntry {
  /** Byte size of this representation. */
  bytes: number;
  /** Platform-native type identifier (UTI, MIME type, or Windows format name). */
  type: string;
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

/** Strip HTML tags to produce plain text, decoding common entities. */
export function stripHtmlTags(html: string): string {
  return (
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
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
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
}

/**
 * Platform-agnostic clipboard backend interface. All platform-specific
 * clipboard adapters implement this contract.
 */
export interface ClipboardBackend {
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
