/**
 * @fileoverview Unit tests for readPngDimensions — the IHDR parser the Linux
 * backends use to report image dimensions.
 * @module tests/services/clipboard/png-dimensions.test
 */

import { describe, expect, it } from 'vitest';
import { readPngDimensions } from '@/services/clipboard/png-dimensions.js';
import { buildPng, PNG_SIGNATURE, REAL_PNG_1x1, REAL_PNG_13x7 } from './png-fixtures.js';

describe('readPngDimensions', () => {
  it('reads the dimensions of an encoder-produced PNG', () => {
    expect(readPngDimensions(REAL_PNG_13x7)).toEqual({ width: 13, height: 7 });
  });

  it('reads a single-pixel PNG', () => {
    expect(readPngDimensions(REAL_PNG_1x1)).toEqual({ width: 1, height: 1 });
  });

  it('reads IHDR at its fixed offset even when ancillary chunks precede IDAT', () => {
    // REAL_PNG_13x7 carries sRGB and eXIf between IHDR and IDAT; the built
    // fixture adds gAMA and tEXt. Both must resolve to their IHDR values.
    expect(readPngDimensions(buildPng(640, 480, { ancillary: true }))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it.each([
    [1, 1],
    [16, 9],
    [1920, 1080],
    [65_535, 4],
    [0x7fffffff, 0x7fffffff],
  ])('decodes %ix%i from the big-endian IHDR fields', (width, height) => {
    expect(readPngDimensions(buildPng(width, height))).toEqual({ width, height });
  });

  it('returns undefined for input truncated mid-IHDR', () => {
    expect(readPngDimensions(REAL_PNG_13x7.subarray(0, 20))).toBeUndefined();
  });

  it('returns undefined for the signature alone', () => {
    expect(readPngDimensions(PNG_SIGNATURE)).toBeUndefined();
  });

  it('returns undefined for an empty buffer', () => {
    expect(readPngDimensions(Buffer.alloc(0))).toBeUndefined();
  });

  it('returns undefined for non-PNG bytes of sufficient length', () => {
    expect(
      readPngDimensions(Buffer.from('this is definitely not a png file at all')),
    ).toBeUndefined();
  });

  it('returns undefined for JPEG bytes', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 0x11)]);
    expect(readPngDimensions(jpeg)).toBeUndefined();
  });

  it('returns undefined when the first chunk is not IHDR', () => {
    const png = buildPng(8, 8);
    const impostor = Buffer.from(png);
    impostor.write('IDAT', 12, 'ascii');
    expect(readPngDimensions(impostor)).toBeUndefined();
  });

  it.each([
    ['zero width', 0, 4],
    ['zero height', 4, 0],
    ['both zero', 0, 0],
  ])('returns undefined for %s', (_label, width, height) => {
    expect(readPngDimensions(buildPng(width, height))).toBeUndefined();
  });
});
