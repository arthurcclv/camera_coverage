/**
 * Encoding readback bytes to PNG/JPEG via `OffscreenCanvas` (spec §8.5).
 *
 * Impure: touches canvas APIs. The pixel work it depends on is in `pixels.ts`.
 */
import type { ImageFormat } from '../export/manifest.ts';

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** The filename extension for a format (§9.2). */
export function extensionFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : 'png';
}

/**
 * Encodes top-down RGBA bytes as an image (§8.5).
 *
 * @param pixels - `width * height * 4` bytes, already flipped and alpha-corrected.
 * @param quality - JPEG quality in (0, 1]; ignored for PNG.
 */
export async function encodeImage(
  pixels: Uint8Array,
  width: number,
  height: number,
  format: ImageFormat,
  quality: number,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not acquire a 2D context for encoding');

  // `ImageData` needs a plain ArrayBuffer-backed store, and the readback buffer may
  // be a view over a larger (or shared) buffer — so copy element-wise.
  const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
  ctx.putImageData(data, 0, 0);

  const blob = await canvas.convertToBlob(
    format === 'jpeg' ? { type: MIME[format], quality } : { type: MIME[format] },
  );
  return new Uint8Array(await blob.arrayBuffer());
}
