/**
 * @fileoverview Unit tests for the `text/uri-list` reader behind the Linux
 * `files` format: RFC 2483 framing, the local-file filter, percent-decoding,
 * the paths it leaves out, chunk boundaries, the windowed stream helper, and
 * linear running time.
 * @module tests/services/clipboard/uri-list.test
 */

import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  collectUriListPaths,
  countUriListPaths,
  UriListReader,
} from '@/services/clipboard/uri-list.js';
import { URI_LIST, URI_LIST_OMITTED, URI_LIST_PATHS } from './uri-list-fixtures.js';

/** Paths and the left-out count a reader produces from `chunks`. */
function readPaths(chunks: readonly (string | Buffer)[]): {
  omittedPaths: number;
  paths: string[];
} {
  const paths: string[] = [];
  const reader = new UriListReader((path) => paths.push(path.toString('utf8')));
  for (const chunk of chunks) reader.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  reader.end();
  expect(reader.pathCount).toBe(paths.length);
  return { paths, omittedPaths: reader.omittedPaths };
}

/** A stream that delivers `chunks` and ends, the way a helper's stdout does. */
function streamOf(chunks: readonly (string | Buffer)[]): PassThrough {
  const stream = new PassThrough();
  setImmediate(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream;
}

describe('UriListReader — RFC 2483 framing', () => {
  it('reads CRLF and LF lines, skipping comments and blank lines, and takes an unterminated last line', () => {
    expect(
      readPaths(['# comment\r\n\r\nfile:///a\r\n#file:///commented\nfile:///b\n\nfile:///c']),
    ).toEqual({ paths: ['/a', '/b', '/c'], omittedPaths: 0 });
  });

  it('trims surrounding whitespace and trailing NULs from a line', () => {
    expect(readPaths([' \tfile:///a \t\r\n  # indented comment\r\nfile:///b\0\0'])).toEqual({
      paths: ['/a', '/b'],
      omittedPaths: 0,
    });
  });

  it('an empty list and a list of comments yield nothing', () => {
    expect(readPaths([])).toEqual({ paths: [], omittedPaths: 0 });
    expect(readPaths(['# only\r\n# comments\r\n'])).toEqual({ paths: [], omittedPaths: 0 });
  });

  it('keeps a `#` inside a URI: only a line that starts with one is a comment', () => {
    expect(readPaths(['file:///a/b%23c#fragment\r\n'])).toEqual({
      paths: ['/a/b#c'],
      omittedPaths: 0,
    });
  });
});

describe('UriListReader — local file URIs only', () => {
  it.each([
    ['an empty host', 'file:///srv/x', '/srv/x'],
    ['localhost', 'file://localhost/srv/x', '/srv/x'],
    ['localhost in any case', 'file://LocalHost/srv/x', '/srv/x'],
    ['the single-slash form', 'file:/srv/x', '/srv/x'],
    ['an upper-case scheme', 'FILE:///srv/x', '/srv/x'],
    ['a query and fragment, which are not part of the path', 'file:///srv/x?y=1#z', '/srv/x'],
  ])('keeps %s', (_label, line, path) => {
    expect(readPaths([line])).toEqual({ paths: [path], omittedPaths: 0 });
  });

  it.each([
    ['an https URI', 'https://x.test/a'],
    ['a URN', 'urn:isbn:0451450523'],
    ['a remote host', 'file://other-host/srv/x'],
    ['a host with a port', 'file://localhost:80/srv/x'],
    ['a relative file URI', 'file:srv/x'],
    ['a file URI with no path', 'file://localhost'],
    ['a scheme that only starts like file', 'files:///srv/x'],
    ['a bare path', '/srv/x'],
  ])('skips %s without counting it', (_label, line) => {
    expect(readPaths([line])).toEqual({ paths: [], omittedPaths: 0 });
  });
});

describe('UriListReader — percent-decoding', () => {
  it.each([
    ['an encoded space', 'file:///a%20b', '/a b'],
    ['upper-case UTF-8 escapes', 'file:///caf%C3%A9', '/café'],
    ['lower-case UTF-8 escapes', 'file:///caf%c3%a9', '/café'],
    ['a combining accent', 'file:///e%CC%81', '/é'],
    ['raw UTF-8 a writer left unescaped', 'file:///café 1.txt', '/café 1.txt'],
    ['an encoded slash', 'file:///a%2Fb', '/a/b'],
    ['an encoded percent sign', 'file:///100%25', '/100%'],
  ])('decodes %s', (_label, line, path) => {
    expect(readPaths([line])).toEqual({ paths: [path], omittedPaths: 0 });
  });

  it.each([
    ['a percent sign followed by text', 'file:///100%.txt', '/100%.txt'],
    ['a percent sign before non-hex digits', 'file:///a%zzb', '/a%zzb'],
    ['a percent sign with one hex digit at the end', 'file:///a%4', '/a%4'],
    ['a percent sign at the end', 'file:///a%', '/a%'],
    ['a run of percent signs', 'file:///%%%41', '/%%A'],
    ['a percent sign before a digit and the letter after f', 'file:///a%4g', '/a%4g'],
    ['a percent sign before the capital after F and a digit', 'file:///a%G1', '/a%G1'],
    ['a percent sign before a digit and the byte after 9', 'file:///a%3:', '/a%3:'],
    ['a percent sign before the byte before A and a digit', 'file:///a%@1', '/a%@1'],
    ['a percent sign before the byte before a and a digit', 'file:///a%`1', '/a%`1'],
  ])('keeps a malformed escape literally, never failing the list: %s', (_label, line, path) => {
    expect(readPaths([line, '\r\nfile:///next'])).toEqual({
      paths: [path, '/next'],
      omittedPaths: 0,
    });
  });
});

describe('UriListReader — paths it cannot list one per line', () => {
  it.each([
    ['an encoded line feed', 'file:///a%0Ab'],
    ['an encoded carriage return', 'file:///a%0Db'],
    ['a raw carriage return inside the line', 'file:///a\rb'],
    ['bytes that are not UTF-8', 'file:///latin%E9.txt'],
    ['a truncated UTF-8 sequence', 'file:///caf%C3'],
  ])('leaves out and counts a path with %s', (_label, line) => {
    expect(readPaths([`file:///before\r\n${line}\r\nfile:///after`])).toEqual({
      paths: ['/before', '/after'],
      omittedPaths: 1,
    });
  });

  it('counts only local file paths: a remote or non-file URI with an encoded break is skipped', () => {
    expect(readPaths(['https://x.test/a%0Ab\r\nfile://other/a%0Ab\r\n'])).toEqual({
      paths: [],
      omittedPaths: 0,
    });
  });
});

describe('UriListReader — chunk boundaries', () => {
  const whole = Buffer.from(URI_LIST);
  const expected = { paths: URI_LIST_PATHS, omittedPaths: URI_LIST_OMITTED };

  it('reads a file manager list whole', () => {
    expect(readPaths([whole])).toEqual(expected);
  });

  it('reads the same paths whatever byte the list is split at', () => {
    for (let at = 0; at <= whole.byteLength; at += 1) {
      expect(readPaths([whole.subarray(0, at), whole.subarray(at)])).toEqual(expected);
    }
  });

  it('reads the same paths split at every pair of bytes into three chunks', () => {
    for (let first = 0; first <= whole.byteLength; first += 7) {
      for (let second = first; second <= whole.byteLength; second += 5) {
        const chunks = [
          whole.subarray(0, first),
          whole.subarray(first, second),
          whole.subarray(second),
        ];
        expect(readPaths(chunks)).toEqual(expected);
      }
    }
  });

  it('reads the same paths delivered one byte at a time', () => {
    const bytes = Array.from({ length: whole.byteLength }, (_, i) => whole.subarray(i, i + 1));
    expect(readPaths(bytes)).toEqual(expected);
  });

  it('reads a CRLF split between two chunks as one line break', () => {
    expect(readPaths(['file:///a\r', '\nfile:///b\r', '\n'])).toEqual({
      paths: ['/a', '/b'],
      omittedPaths: 0,
    });
  });
});

describe('collectUriListPaths — the files representation, windowed and hashed', () => {
  const joined = Buffer.from(URI_LIST_PATHS.join('\n'));
  const sha256 = createHash('sha256').update(joined).digest('base64url');
  const chunks = [URI_LIST.slice(0, 17), URI_LIST.slice(17, 80), URI_LIST.slice(80)];

  it('joins the paths with LF, no trailing newline, and hashes exactly those bytes', async () => {
    const result = await collectUriListPaths(streamOf(chunks), {
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    });
    expect(result.window.toString('utf8')).toBe(URI_LIST_PATHS.join('\n'));
    expect(result).toMatchObject({
      totalByteSize: joined.byteLength,
      sha256,
      pathCount: URI_LIST_PATHS.length,
      omittedPaths: URI_LIST_OMITTED,
    });
  });

  it('every window of the paths reassembles them, with the same total and revision', async () => {
    for (const limit of [1, 3, 7, 64]) {
      const pieces: Buffer[] = [];
      for (let offset = 0; offset < joined.byteLength; offset += limit) {
        const result = await collectUriListPaths(streamOf(chunks), { offset, limit });
        expect(result.totalByteSize).toBe(joined.byteLength);
        expect(result.sha256).toBe(sha256);
        pieces.push(result.window);
      }
      expect(Buffer.concat(pieces).equals(joined)).toBe(true);
    }
  });

  it('a window past the end is empty and keeps the true total', async () => {
    const result = await collectUriListPaths(streamOf(chunks), { offset: 10_000, limit: 10 });
    expect(result.window.byteLength).toBe(0);
    expect(result.totalByteSize).toBe(joined.byteLength);
  });

  it('a list with no local file path is an empty representation with no paths', async () => {
    const result = await collectUriListPaths(streamOf(['https://x.test/\r\n# note\r\n']), {
      offset: 0,
      limit: 100,
    });
    expect(result).toMatchObject({ totalByteSize: 0, pathCount: 0, omittedPaths: 0 });
  });

  it('rejects when the source stream fails', async () => {
    const stream = new PassThrough();
    setImmediate(() => stream.destroy(new Error('pipe broke')));
    await expect(collectUriListPaths(stream, { offset: 0, limit: 10 })).rejects.toThrow(
      'pipe broke',
    );
  });
});

describe('countUriListPaths — what inspect measures', () => {
  it('counts every raw byte of the list and reports whether it lists a path', async () => {
    const raw = Buffer.from(URI_LIST);
    await expect(countUriListPaths(streamOf([raw]))).resolves.toEqual({
      bytes: raw.byteLength,
      hasPath: true,
    });
  });

  it.each([
    ['no file URI', 'https://x.test/a\r\nurn:x\r\n'],
    ['only paths it cannot list', 'file:///a%0Ab\r\nfile:///c%FF\r\n'],
    ['only comments', '# file:///a\r\n'],
  ])('a list with %s has no path', async (_label, list) => {
    await expect(countUriListPaths(streamOf([list]))).resolves.toEqual({
      bytes: Buffer.byteLength(list),
      hasPath: false,
    });
  });

  it('takes a path from an unterminated last line, as the files read does', async () => {
    await expect(countUriListPaths(streamOf(['file:///a']))).resolves.toEqual({
      bytes: 9,
      hasPath: true,
    });
  });

  it('counts bytes past the first path across many chunks', async () => {
    const chunks = ['file:///a\r\n', ...Array.from({ length: 50 }, () => 'x'.repeat(100))];
    await expect(countUriListPaths(streamOf(chunks))).resolves.toEqual({
      bytes: 11 + 5000,
      hasPath: true,
    });
  });
});

describe('UriListReader — linear running time', () => {
  /** Thread CPU microseconds per read of `chunks`, least of three batches sized to ~320k bytes. */
  function cpuMicrosPerRead(chunks: readonly Buffer[]): number {
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const calls = Math.max(1, Math.round(320_000 / bytes));
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call += 1) {
        const reader = new UriListReader(() => undefined);
        for (const chunk of chunks) reader.write(chunk);
        reader.end();
      }
      const spent = process.threadCpuUsage(start);
      least = Math.min(least, (spent.user + spent.system) / calls);
    }
    return least;
  }

  const whole = (text: string) => [Buffer.from(text)];
  /** `text` delivered in 64-byte chunks: one line spanning many of them. */
  const chunked = (text: string) => {
    const bytes = Buffer.from(text);
    return Array.from({ length: Math.ceil(bytes.byteLength / 64) }, (_, i) =>
      bytes.subarray(i * 64, i * 64 + 64),
    );
  };

  /** Each shape builds an input of about `n` bytes. */
  const SHAPES: Array<[name: string, make: (n: number) => Buffer[]]> = [
    ['one long path', (n) => whole(`file:///${'a'.repeat(n)}`)],
    ['one long path in 64-byte chunks', (n) => chunked(`file:///${'a'.repeat(n)}`)],
    ['a run of stray percent signs', (n) => whole(`file:///${'%'.repeat(n)}`)],
    ['overlapping escape prefixes', (n) => whole(`file:///${'%2'.repeat(n / 2)}`)],
    ['valid escapes', (n) => whole(`file:///${'%41'.repeat(n / 3)}`)],
    ['encoded line breaks', (n) => whole(`file:///${'%0A'.repeat(n / 3)}`)],
    ['bytes that are not UTF-8', (n) => whole(`file:///${'%FF'.repeat(n / 3)}`)],
    ['a repeated scheme with no path', (n) => whole('file:'.repeat(n / 5))],
    ['an unclosed authority', (n) => whole(`file://${'l'.repeat(n)}`)],
    ['a run of comment openers', (n) => whole('#'.repeat(n))],
    ['one long line ending in a break', (n) => whole(`${'§1 x'.repeat(n / 5)}\ny`)],
    ['breaks throughout', (n) => whole('  \r\n'.repeat(n / 4))],
    ['many short lines', (n) => whole('file:///a\r\n'.repeat(n / 11))],
  ];

  const BASE = 5_000;

  it('reads every shape in time linear in its length, 5k → 320k bytes', () => {
    for (const [name, make] of SHAPES) {
      for (let n = BASE * 2; n <= BASE * 64; n *= 2) {
        const growth = n / BASE;
        // The baseline is timed again beside each size; the least ratio of three pairs counts.
        let leastRatio = Number.POSITIVE_INFINITY;
        let leastLarge = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 3; pair += 1) {
          const small = cpuMicrosPerRead(make(BASE));
          const large = cpuMicrosPerRead(make(n));
          leastRatio = Math.min(leastRatio, large / Math.max(small, 1));
          leastLarge = Math.min(leastLarge, large);
        }
        // Linear growth is `growth`; 4× headroom gives the 256 bound at the full 64× span.
        expect(leastRatio, `${name} at ${n} bytes`).toBeLessThan(4 * growth);
        // ⅛ µs per byte: several times the slowest shape's linear cost on either runtime.
        expect(leastLarge, `${name} at ${n} bytes, µs`).toBeLessThan(n / 8);
      }
    }
  }, 0);
});
