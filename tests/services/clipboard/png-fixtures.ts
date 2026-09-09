/**
 * @fileoverview PNG byte fixtures shared by the dimension-parser and Linux
 * backend tests. `REAL_PNG_13x7` and `REAL_PNG_1x1` are encoder-produced files
 * (base64 of the actual bytes); `buildPng` assembles structurally valid PNGs
 * with arbitrary dimensions and optional ancillary chunks.
 *
 * @module tests/services/clipboard/png-fixtures
 */

/** The 8-byte PNG signature. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A real 13x7 PNG written by an image encoder. Carries `sRGB` and `eXIf`
 * ancillary chunks between `IHDR` and `IDAT`, so a parser that walks chunks
 * instead of reading `IHDR` at its fixed offset shows up as a wrong answer.
 */
export const REAL_PNG_13x7 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAYAAADTcMcaAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAADaADAAQAAAABAAAABwAAAADjegAPAAAAGklEQVQYGWP8z8BQz0AiYCJRPVj5qCZoqAEAMlUBjODdYxAAAAAASUVORK5CYII=',
  'base64',
);

/** A real 1x1 PNG written by an image encoder. */
export const REAL_PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** CRC-32 as PNG specifies it, over a chunk's type and data bytes. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assemble one length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, crc]);
}

/**
 * Build a PNG with correct signature, chunk framing, CRCs, and `IHDR` values
 * for the given pixel dimensions. The `IDAT` payload is a stub rather than a
 * real raster, so use this for header-level assertions and the encoder-produced
 * constants above when genuine image bytes matter.
 */
export function buildPng(
  width: number,
  height: number,
  options: { ancillary?: boolean } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (options.ancillary) {
    parts.push(chunk('gAMA', Buffer.from([0x00, 0x00, 0xb1, 0x8f])));
    parts.push(chunk('tEXt', Buffer.from('Comment\0fixture', 'latin1')));
  }
  parts.push(chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
