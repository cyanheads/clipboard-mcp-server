/**
 * @fileoverview Streaming byte-window sink — bounds how many bytes of a
 * clipboard read are ever resident in Node memory, and a UTF-8-boundary-safe
 * trimmer for slicing text/HTML/RTF windows on codepoint edges.
 * @module services/clipboard/byte-window
 */

import type { Readable } from 'node:stream';
import type { ByteRange } from './types.js';

/** Result of streaming a child process's stdout through a byte window. */
export interface ByteWindowResult {
  /** Total byte size of the full stream, regardless of how much was retained. */
  totalByteSize: number;
  /** The bytes falling inside `[offset, offset + limit)`. Never larger than `limit`. */
  window: Buffer;
}

/**
 * Consume `stream` to completion, counting every byte, but retain only the
 * bytes inside `[range.offset, range.offset + range.limit)` — never more than
 * `range.limit` bytes resident at once. Everything outside the window is
 * discarded as it arrives, so the caller's peak memory is bounded by the
 * window size, not the stream's total size.
 */
export function collectByteWindow(stream: Readable, range: ByteRange): Promise<ByteWindowResult> {
  return new Promise((resolve, reject) => {
    let totalByteSize = 0;
    const pieces: Buffer[] = [];
    const windowEnd = range.offset + range.limit;

    stream.on('data', (chunk: Buffer) => {
      const chunkStart = totalByteSize;
      const chunkEnd = chunkStart + chunk.byteLength;
      totalByteSize = chunkEnd;

      const overlapStart = Math.max(chunkStart, range.offset);
      const overlapEnd = Math.min(chunkEnd, windowEnd);
      if (overlapStart < overlapEnd) {
        pieces.push(chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart));
      }
    });
    stream.on('end', () => resolve({ window: Buffer.concat(pieces), totalByteSize }));
    stream.on('error', reject);
  });
}

/** Count the bytes in `stream` without retaining any of them. */
export async function countBytes(stream: Readable): Promise<number> {
  const { totalByteSize } = await collectByteWindow(stream, { offset: 0, limit: 0 });
  return totalByteSize;
}

/**
 * Throws when `range` is not a safe, non-negative `{ offset, limit }` pair.
 * Guards a range before it is interpolated as literal numbers into a native
 * helper script (JXA, PowerShell) that performs its own offset/limit slicing.
 */
export function assertByteRange(range: ByteRange): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new Error(`Invalid read range offset: ${range.offset}`);
  }
  if (!Number.isSafeInteger(range.limit) || range.limit < 0) {
    throw new Error(`Invalid read range limit: ${range.limit}`);
  }
}

/** True for a UTF-8 continuation byte (`10xxxxxx`). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Byte length of the UTF-8 sequence a lead byte opens. Returns 1 for an
 * invalid lead byte — this trimmer is a best-effort boundary fixer, not a
 * validator, so an unrecognized byte is treated as already-complete rather
 * than causing the scan to hang.
 */
function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0x00) return 1; // 0xxxxxxx
  if ((leadByte & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((leadByte & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((leadByte & 0xf8) === 0xf0) return 4; // 11110xxx
  return 1;
}

/** How many trailing bytes of `window` to inspect for an incomplete lead sequence. */
const MAX_UTF8_SEQUENCE_LENGTH = 4;

/** Result of trimming a byte window to UTF-8 codepoint boundaries. */
export interface Utf8TrimResult {
  /**
   * Bytes of the original window advanced past, measured from the window's
   * own start (0) — including any leading bytes dropped, but excluding any
   * trailing incomplete sequence held back for the next call. Add this to the
   * window's starting offset to get the next call's offset.
   */
  consumed: number;
  /** The window trimmed to whole codepoints. */
  content: Buffer;
}

/**
 * Trim a byte window to whole UTF-8 codepoints.
 *
 * Drops leading continuation bytes — the caller passed an offset that landed
 * mid-codepoint (normally shouldn't happen when `offset` came from a prior
 * `nextOffset`, but defensive against an arbitrary caller-supplied offset).
 *
 * Drops a trailing incomplete multi-byte sequence unless `isFinal` is true —
 * the window is a byte-range slice, not necessarily UTF-8-aligned, so a
 * sequence that started inside the window but needs more bytes than the
 * window holds is held back for the next call rather than emitted broken.
 */
export function trimToUtf8Boundaries(window: Buffer, isFinal: boolean): Utf8TrimResult {
  let start = 0;
  while (start < window.byteLength && isContinuationByte(window[start] ?? 0)) {
    start += 1;
  }

  let end = window.byteLength;
  if (!isFinal) {
    let cursor = end;
    let scanned = 0;
    while (cursor > start && scanned < MAX_UTF8_SEQUENCE_LENGTH) {
      cursor -= 1;
      scanned += 1;
      const byte = window[cursor] ?? 0;
      if (!isContinuationByte(byte)) {
        const seqLen = utf8SequenceLength(byte);
        if (cursor + seqLen > end) end = cursor;
        break;
      }
    }
  }

  return { content: window.subarray(start, end), consumed: end };
}
