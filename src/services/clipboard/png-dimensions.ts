/**
 * @fileoverview PNG IHDR reader — pixel dimensions from raw PNG bytes.
 * @module services/clipboard/png-dimensions
 */

/** The 8-byte PNG signature every PNG file opens with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature (8) + chunk length (4) + chunk type (4) + width (4) + height (4). */
const IHDR_END = 24;

/** Pixel dimensions of a PNG image. */
export interface PngDimensions {
  height: number;
  width: number;
}

/**
 * Read a PNG's pixel dimensions from its `IHDR` chunk.
 *
 * PNG fixes `IHDR` as the first chunk after the signature, so width and height
 * are 4-byte big-endian integers at byte offsets 16 and 20 — no chunk walking,
 * and ancillary chunks that follow are irrelevant. Backends whose native
 * clipboard API hands over opaque bytes (X11 `xclip`, Wayland `wl-paste`) call
 * this so their image reads carry the same dimensions macOS and Windows get
 * from `NSBitmapImageRep` and `System.Drawing.Image`.
 *
 * Returns `undefined` for anything that is not a PNG carrying a plausible
 * `IHDR` — truncated captures, other image formats, a zero dimension the PNG
 * spec forbids. Callers return the image bytes regardless; missing dimensions
 * degrade the response, they do not fail the read.
 */
export function readPngDimensions(bytes: Buffer): PngDimensions | undefined {
  if (bytes.byteLength < IHDR_END) return undefined;
  if (!bytes.subarray(0, SIGNATURE.byteLength).equals(SIGNATURE)) return undefined;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}
