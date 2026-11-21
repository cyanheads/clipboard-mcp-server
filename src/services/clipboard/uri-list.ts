/**
 * @fileoverview `text/uri-list` (RFC 2483) to local file paths — the Linux
 * source of the `files` format. Lines end in CRLF (LF accepted); a line that
 * starts with `#` is a comment. Only `file:` URIs whose host is empty or
 * `localhost` name a local path; any other URI is skipped. The path is
 * percent-decoded byte by byte, and a `%` not followed by two hex digits stays
 * literal (the WHATWG URL percent-decode rule), so a malformed escape never
 * fails the list. A decoded path holding a line break, or bytes that are not
 * UTF-8, cannot be listed one per line as UTF-8 text: it is left out and
 * counted. The list is scanned once, a line at a time, as its bytes arrive.
 * @module services/clipboard/uri-list
 */

import { isUtf8 } from 'node:buffer';
import { PassThrough, type Readable } from 'node:stream';
import { type ByteWindowResult, collectHashedByteWindow } from './byte-window.js';
import type { ByteRange } from './types.js';

const LF = 0x0a;
const CR = 0x0d;
const HASH = 0x23;
const PERCENT = 0x25;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const COLON = 0x3a;

const LF_BYTES = Buffer.from([LF]);
const LOCALHOST = 'localhost';

/** What one uri-list line contributes to the path list. */
type LineOutcome =
  | { kind: 'path'; path: Buffer }
  /** A local file path that cannot be listed one per line as UTF-8. */
  | { kind: 'omitted' }
  /** A comment, a blank line, or a URI that names no local file. */
  | { kind: 'skipped' };

/** NUL, tab, CR, and space: trimmed from both ends of a line. */
function isTrimmed(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === CR || byte === 0x20;
}

/** Value of an ASCII hex digit, or -1. */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const lower = byte | 0x20;
  if (lower >= 0x61 && lower <= 0x66) return lower - 0x61 + 10;
  return -1;
}

/** True when `line[start..end)` is `text`, ASCII case-insensitively. */
function matchesAscii(line: Buffer, start: number, end: number, text: string): boolean {
  if (end - start !== text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    const byte = line[start + i] ?? 0;
    const expected = text.charCodeAt(i);
    // Letters compare with their case bit set; every other byte compares exactly.
    const folded = byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte;
    if (folded !== expected) return false;
  }
  return true;
}

/** Percent-decode `line[start..end)`; a `%` not followed by two hex digits is kept. */
function percentDecode(line: Buffer, start: number, end: number): Buffer {
  const out = Buffer.allocUnsafe(end - start);
  let length = 0;
  for (let i = start; i < end; i += 1) {
    const byte = line[i] ?? 0;
    if (byte === PERCENT && i + 2 < end) {
      const high = hexValue(line[i + 1] ?? 0);
      const low = hexValue(line[i + 2] ?? 0);
      if (high >= 0 && low >= 0) {
        out[length++] = high * 16 + low;
        i += 2;
        continue;
      }
    }
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

/** Classify one uri-list line (its terminator already removed). */
function parseLine(line: Buffer): LineOutcome {
  let start = 0;
  let end = line.byteLength;
  while (start < end && isTrimmed(line[start] ?? 0)) start += 1;
  while (end > start && isTrimmed(line[end - 1] ?? 0)) end -= 1;
  if (start === end || line[start] === HASH) return { kind: 'skipped' };

  const schemeEnd = start + 'file'.length;
  if (line[schemeEnd] !== COLON || !matchesAscii(line, start, schemeEnd, 'file')) {
    return { kind: 'skipped' };
  }

  // `file://host/path`, or `file:/path` with no authority (RFC 8089).
  let pathStart = schemeEnd + 1;
  if (line[pathStart] === SLASH && line[pathStart + 1] === SLASH) {
    const hostStart = pathStart + 2;
    let hostEnd = hostStart;
    while (hostEnd < end) {
      const byte = line[hostEnd];
      if (byte === SLASH || byte === QUESTION || byte === HASH) break;
      hostEnd += 1;
    }
    if (hostEnd > hostStart && !matchesAscii(line, hostStart, hostEnd, LOCALHOST)) {
      return { kind: 'skipped' };
    }
    pathStart = hostEnd;
  }

  // The path ends where a query or fragment begins; neither is part of it.
  let pathEnd = pathStart;
  while (pathEnd < end && line[pathEnd] !== QUESTION && line[pathEnd] !== HASH) pathEnd += 1;
  if (pathEnd === pathStart || line[pathStart] !== SLASH) return { kind: 'skipped' };

  const path = percentDecode(line, pathStart, pathEnd);
  if (path.includes(LF) || path.includes(CR) || !isUtf8(path)) return { kind: 'omitted' };
  return { kind: 'path', path };
}

/**
 * Incremental `text/uri-list` reader: `write()` each chunk as it arrives, then
 * `end()`. Every local file path is handed to `onPath` in list order, with its
 * 0-based index among the listed paths. Holds at most one unterminated line.
 */
export class UriListReader {
  readonly #onPath: (path: Buffer, index: number) => void;
  /** Pieces of the line still waiting for its LF. */
  #pending: Buffer[] = [];
  #pathCount = 0;
  #omittedPaths = 0;

  constructor(onPath: (path: Buffer, index: number) => void) {
    this.#onPath = onPath;
  }

  /** Local file paths listed so far. */
  get pathCount(): number {
    return this.#pathCount;
  }

  /** Local file paths left out so far: a line break, or bytes that are not UTF-8. */
  get omittedPaths(): number {
    return this.#omittedPaths;
  }

  write(chunk: Buffer): void {
    let start = 0;
    for (let lf = chunk.indexOf(LF); lf !== -1; lf = chunk.indexOf(LF, start)) {
      const tail = chunk.subarray(start, lf);
      this.#line(this.#pending.length === 0 ? tail : Buffer.concat([...this.#pending, tail]));
      this.#pending = [];
      start = lf + 1;
    }
    if (start < chunk.byteLength) this.#pending.push(chunk.subarray(start));
  }

  /** Read the last line, which RFC 2483 lets a writer leave unterminated. */
  end(): void {
    if (this.#pending.length === 0) return;
    const line = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#line(line);
  }

  #line(line: Buffer): void {
    const outcome = parseLine(line);
    if (outcome.kind === 'path') {
      this.#onPath(outcome.path, this.#pathCount);
      this.#pathCount += 1;
    } else if (outcome.kind === 'omitted') {
      this.#omittedPaths += 1;
    }
  }
}

/** The `files` representation of a uri-list: its paths, windowed and hashed. */
export interface UriListPathsWindow extends ByteWindowResult {
  /** Local file paths left out: a line break, or bytes that are not UTF-8. */
  omittedPaths: number;
  /** Local file paths in the representation. */
  pathCount: number;
  /** Base64url SHA-256 of the whole representation (the LF-joined paths). */
  sha256: string;
}

/**
 * Stream a uri-list into its `files` representation — the local paths joined
 * by LF, no trailing newline — keeping only `range` of it, as
 * `collectHashedByteWindow` does for any other representation.
 */
export async function collectUriListPaths(
  stream: Readable,
  range: ByteRange,
): Promise<UriListPathsWindow> {
  const joined = new PassThrough();
  const window = collectHashedByteWindow(joined, range);
  const reader = new UriListReader((path, index) => {
    if (index > 0) joined.write(LF_BYTES);
    joined.write(path);
  });
  stream.on('data', (chunk: Buffer) => reader.write(chunk));
  stream.on('end', () => {
    reader.end();
    joined.end();
  });
  stream.on('error', (error: Error) => joined.destroy(error));
  return {
    ...(await window),
    pathCount: reader.pathCount,
    omittedPaths: reader.omittedPaths,
  };
}

/**
 * What inspection needs of a uri-list: its raw byte size, and whether it lists
 * any local file path. Parsing stops at the first path; counting does not.
 */
export function countUriListPaths(stream: Readable): Promise<{ bytes: number; hasPath: boolean }> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const reader = new UriListReader(() => undefined);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (reader.pathCount === 0) reader.write(chunk);
    });
    stream.on('end', () => {
      if (reader.pathCount === 0) reader.end();
      resolve({ bytes, hasPath: reader.pathCount > 0 });
    });
    stream.on('error', reject);
  });
}
