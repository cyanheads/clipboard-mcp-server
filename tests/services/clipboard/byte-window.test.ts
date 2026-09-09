/**
 * @fileoverview Unit tests for the streaming byte-window sink and the
 * UTF-8-boundary trimmer it feeds.
 * @module tests/services/clipboard/byte-window.test
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  collectByteWindow,
  countBytes,
  trimToUtf8Boundaries,
} from '@/services/clipboard/byte-window.js';

/** Feed `chunks` through a real PassThrough stream, one push per chunk. */
function streamOf(chunks: Buffer[]): PassThrough {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return stream;
}

describe('collectByteWindow', () => {
  it('returns the whole stream when the window covers it entirely', async () => {
    const stream = streamOf([Buffer.from('hello '), Buffer.from('world')]);
    const result = await collectByteWindow(stream, { offset: 0, limit: 100 });
    expect(result.window.toString('utf8')).toBe('hello world');
    expect(result.totalByteSize).toBe(11);
  });

  it('returns an empty window with limit 0 while still counting the total (countBytes basis)', async () => {
    const stream = streamOf([Buffer.from('a'.repeat(5000)), Buffer.from('b'.repeat(5000))]);
    const result = await collectByteWindow(stream, { offset: 0, limit: 0 });
    expect(result.window.byteLength).toBe(0);
    expect(result.totalByteSize).toBe(10000);
  });

  it('takes a window that spans a chunk boundary', async () => {
    // Chunks: [0-4), [4-9), [9-14) — window [3, 11) crosses two boundaries.
    const stream = streamOf([Buffer.from('01234'), Buffer.from('56789'), Buffer.from('ABCDE')]);
    const result = await collectByteWindow(stream, { offset: 3, limit: 8 });
    expect(result.window.toString('utf8')).toBe('3456789A'.slice(0, 8));
    expect(result.totalByteSize).toBe(15);
  });

  it('takes a middle chunk with the window fully inside one chunk', async () => {
    const stream = streamOf([
      Buffer.from('AAAAA'),
      Buffer.from('BBBBBBBBBB'),
      Buffer.from('CCCCC'),
    ]);
    const result = await collectByteWindow(stream, { offset: 7, limit: 3 });
    expect(result.window.toString('utf8')).toBe('BBB');
    expect(result.totalByteSize).toBe(20);
  });

  it('takes the final chunk exactly at the end', async () => {
    const stream = streamOf([Buffer.from('0123456789')]);
    const result = await collectByteWindow(stream, { offset: 7, limit: 3 });
    expect(result.window.toString('utf8')).toBe('789');
    expect(result.totalByteSize).toBe(10);
  });

  it('returns an empty window when offset is exactly at the end', async () => {
    const stream = streamOf([Buffer.from('0123456789')]);
    const result = await collectByteWindow(stream, { offset: 10, limit: 5 });
    expect(result.window.byteLength).toBe(0);
    expect(result.totalByteSize).toBe(10);
  });

  it('returns an empty window when offset is past the end', async () => {
    const stream = streamOf([Buffer.from('0123456789')]);
    const result = await collectByteWindow(stream, { offset: 50, limit: 5 });
    expect(result.window.byteLength).toBe(0);
    expect(result.totalByteSize).toBe(10);
  });

  it('never retains more than limit bytes even with many large chunks', async () => {
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(64 * 1024, 'x'));
    const stream = streamOf(chunks);
    const result = await collectByteWindow(stream, { offset: 0, limit: 10 });
    expect(result.window.byteLength).toBe(10);
    expect(result.totalByteSize).toBe(20 * 64 * 1024);
  });

  it('rejects when the stream errors', async () => {
    const stream = new PassThrough();
    const promise = collectByteWindow(stream, { offset: 0, limit: 10 });
    stream.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });
});

describe('countBytes', () => {
  it('counts every byte without retaining any of them', async () => {
    const chunks = Array.from({ length: 8 }, () => Buffer.alloc(32 * 1024, 'y'));
    const stream = streamOf(chunks);
    const total = await countBytes(stream);
    expect(total).toBe(8 * 32 * 1024);
  });

  it('counts zero for an empty stream', async () => {
    const total = await countBytes(streamOf([]));
    expect(total).toBe(0);
  });
});

describe('trimToUtf8Boundaries', () => {
  it('returns the window unchanged when it holds only complete ASCII codepoints', () => {
    const window = Buffer.from('hello world', 'utf8');
    const result = trimToUtf8Boundaries(window, false);
    expect(result.content).toEqual(window);
    expect(result.consumed).toBe(window.byteLength);
  });

  it('drops a trailing incomplete 4-byte sequence when not final', () => {
    const emoji = Buffer.from('😀', 'utf8'); // 4 bytes: F0 9F 98 80
    expect(emoji.byteLength).toBe(4);
    // Window holds "hi " (3 bytes) + only the first 2 bytes of the emoji.
    const window = Buffer.concat([Buffer.from('hi '), emoji.subarray(0, 2)]);
    const result = trimToUtf8Boundaries(window, false);
    expect(result.content.toString('utf8')).toBe('hi ');
    expect(result.consumed).toBe(3);
  });

  it('keeps a trailing incomplete sequence when isFinal is true', () => {
    const emoji = Buffer.from('😀', 'utf8');
    const window = Buffer.concat([Buffer.from('hi '), emoji.subarray(0, 2)]);
    const result = trimToUtf8Boundaries(window, true);
    expect(result.content).toEqual(window);
    expect(result.consumed).toBe(window.byteLength);
  });

  it('drops leading continuation bytes from a mid-codepoint offset', () => {
    const emoji = Buffer.from('😀', 'utf8');
    // Window starts mid-codepoint: last 2 continuation bytes of the emoji, then "bye".
    const window = Buffer.concat([emoji.subarray(2), Buffer.from('bye')]);
    const result = trimToUtf8Boundaries(window, false);
    expect(result.content.toString('utf8')).toBe('bye');
  });

  it('reassembles byte-identical text when chunks are trimmed and concatenated in order', () => {
    const original = Buffer.from('Hello 世界 🌍 — end', 'utf8');
    const chunkSize = 5;
    const parts: Buffer[] = [];
    let offset = 0;
    // Simulate paging with trimToUtf8Boundaries the way the service does.
    while (offset < original.byteLength) {
      const rawWindow = original.subarray(offset, offset + chunkSize);
      const isFinal = offset + rawWindow.byteLength >= original.byteLength;
      const { content, consumed } = trimToUtf8Boundaries(rawWindow, isFinal);
      parts.push(content);
      offset += consumed === 0 ? rawWindow.byteLength : consumed;
    }
    expect(Buffer.concat(parts)).toEqual(original);
  });

  it('handles an empty window', () => {
    const result = trimToUtf8Boundaries(Buffer.alloc(0), false);
    expect(result.content.byteLength).toBe(0);
    expect(result.consumed).toBe(0);
  });

  it('handles a window that is entirely continuation bytes', () => {
    const emoji = Buffer.from('😀', 'utf8');
    const window = emoji.subarray(1, 4); // three continuation bytes, no lead byte
    const result = trimToUtf8Boundaries(window, false);
    expect(result.content.byteLength).toBe(0);
    expect(result.consumed).toBe(window.byteLength);
  });
});
