/**
 * @fileoverview Inspection and reads shared by the Linux backends. An X11
 * selection and a Wayland offer are each one item offering a list of types,
 * every one streamed by a command-line helper; the backends differ only in the
 * helper, its arguments, and their type preferences.
 * @module services/clipboard/linux-selection
 */

import type { Readable } from 'node:stream';
import { collectHashedByteWindow, countBytes } from './byte-window.js';
import { readPngDimensions } from './png-dimensions.js';
import type {
  ByteRange,
  ClipboardFormat,
  InspectResult,
  RawTypeEntry,
  ReadResult,
} from './types.js';
import {
  buildInspectResult,
  clipboardOutcome,
  FORMAT_PRIORITY,
  isClipboardOutcome,
} from './types.js';
import { collectUriListPaths, countUriListPaths } from './uri-list.js';

/** How one Linux backend reaches its clipboard. */
export interface LinuxSelection {
  /** Types each semantic format is read from, in preference order. */
  formatTypes: Readonly<Record<ClipboardFormat, readonly string[]>>;
  /** The types on offer — empty when nothing is copied. */
  listTypes(): Promise<string[]>;
  /** Platform named on outcomes. */
  platform: string;
  /** Stream one offered type's exact bytes through `consume`. */
  streamType<T>(type: string, consume: (stdout: Readable) => Promise<T>): Promise<T>;
}

/** The semantic format a type is read as, or null for a type no format reads. */
function formatOf(selection: LinuxSelection, type: string): ClipboardFormat | null {
  return FORMAT_PRIORITY.find((format) => selection.formatTypes[format].includes(type)) ?? null;
}

/**
 * Only types a format reads are streamed to measure them — streamed and
 * counted, never retained (#26); every other type is listed without a size.
 * A uri-list is measured by its raw size and offers `files` only when it names
 * a local file path.
 */
export async function inspectSelection(selection: LinuxSelection): Promise<InspectResult> {
  const offered = await selection.listTypes();
  const rawTypes: RawTypeEntry[] = [];
  /** Offered uri-lists that name no local file path: present, with no `files` to read. */
  const pathless = new Set<string>();
  for (const type of offered) {
    const format = formatOf(selection, type);
    if (!format) {
      rawTypes.push({ type });
      continue;
    }
    try {
      if (format === 'files') {
        const { bytes, hasPath } = await selection.streamType(type, countUriListPaths);
        if (!hasPath) pathless.add(type);
        rawTypes.push({ type, bytes });
      } else {
        rawTypes.push({ type, bytes: await selection.streamType(type, countBytes) });
      }
    } catch {
      rawTypes.push({ type, measurementFailed: true });
    }
  }
  return buildInspectResult(
    rawTypes,
    (type) => (pathless.has(type) ? null : formatOf(selection, type)),
    offered.length > 0 ? 1 : 0,
  );
}

/** Read `range` of one offered type as `format`. */
async function readType(
  selection: LinuxSelection,
  format: ClipboardFormat,
  type: string,
  range: ByteRange,
): Promise<ReadResult> {
  if (format === 'files') {
    const { window, totalByteSize, sha256, pathCount, omittedPaths } = await selection.streamType(
      type,
      (stdout) => collectUriListPaths(stdout, range),
    );
    if (pathCount === 0) {
      throw clipboardOutcome(
        selection.platform,
        `The clipboard's ${type} names no local file path it can list${omittedPaths > 0 ? ` (${omittedPaths} left out: a line break, or bytes that are not UTF-8)` : ''}.`,
        { category: 'format_unavailable' },
      );
    }
    return {
      format,
      content: window,
      totalByteSize,
      revision: sha256,
      itemCount: 1,
      ...(omittedPaths > 0 && { omittedPaths }),
    };
  }
  // Every read streams the whole representation, so hashing it on the way
  // through identifies the value the window was cut from.
  const { window, totalByteSize, sha256 } = await selection.streamType(type, (stdout) =>
    collectHashedByteWindow(stdout, range),
  );
  // The helpers hand over opaque bytes with no dimension API — read them out of
  // the PNG header so Linux reads carry what macOS and Windows report. The
  // header only lives in the window when the window starts at byte 0.
  const dimensions = format === 'image' && range.offset === 0 ? readPngDimensions(window) : {};
  return { format, content: window, totalByteSize, revision: sha256, itemCount: 1, ...dimensions };
}

/**
 * Presence is decided from the type listing, never from a read succeeding; a
 * listed representation is read as-is, so a zero-byte one is an empty success.
 * The clipboard is one item: `item` 0 reads it, and any later `item` is
 * `format_unavailable`.
 */
export async function readSelection(
  selection: LinuxSelection,
  format: ClipboardFormat,
  range: ByteRange,
  item?: number,
): Promise<ReadResult> {
  const offered = await selection.listTypes();
  if (offered.length === 0) {
    throw clipboardOutcome(selection.platform, 'The clipboard is empty.', { category: 'empty' });
  }
  if (item !== undefined && item > 0) {
    throw clipboardOutcome(
      selection.platform,
      `The clipboard holds one item (item 0); item ${item} is not on it.`,
      { category: 'format_unavailable' },
    );
  }
  const candidates = selection.formatTypes[format].filter((type) => offered.includes(type));
  if (candidates.length === 0) {
    throw clipboardOutcome(
      selection.platform,
      `No ${format} representation on the clipboard (offered: ${offered.join(', ')}).`,
      { category: 'format_unavailable' },
    );
  }

  let lastError: unknown;
  for (const type of candidates) {
    try {
      return await readType(selection, format, type, range);
    } catch (error) {
      if (isClipboardOutcome(error) && error.category === 'clipboard_unavailable') throw error;
      lastError = error;
    }
  }
  throw lastError;
}
