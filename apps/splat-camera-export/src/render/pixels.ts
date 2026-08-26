/**
 * Pure pixel post-processing for readback buffers (spec §8.4).
 *
 * Render-target readback is **bottom-up** (WebGL origin lower-left) while PNG rows
 * are top-down, so rows must be reversed. Getting this wrong yields vertically
 * mirrored exports — plausible-looking and easy to ship unnoticed — which is why it
 * lives here as a tested pure function rather than inline in the render loop.
 */

/**
 * Flips an RGBA byte buffer vertically, in place, row by row.
 *
 * @param pixels - `width * height * 4` bytes, bottom-up.
 * @returns the same buffer, now top-down.
 */
export function flipVertical(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  if (pixels.length < stride * height) {
    throw new Error(`flipVertical: buffer holds ${pixels.length} bytes, need ${stride * height}`);
  }
  const row = new Uint8Array(stride);
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const top = y * stride;
    const bottom = (height - 1 - y) * stride;
    row.set(pixels.subarray(top, top + stride));
    pixels.copyWithin(top, bottom, bottom + stride);
    pixels.set(row, bottom);
  }
  return pixels;
}

/**
 * Forces every alpha byte to 255 (§8.4). The clear color is opaque, so alpha should
 * already be 255 everywhere; forcing it guarantees a splat's stochastic alpha can
 * never leave semi-transparent holes in a deliverable image.
 *
 * Skipped when the run wants a transparent background, which preserves rendered alpha.
 */
export function forceOpaque(pixels: Uint8Array): Uint8Array {
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}

/**
 * Whether a readback buffer is **entirely zero**, meaning the GPU read failed rather
 * than the camera seeing nothing (§8.6).
 *
 * The distinction is exact when the clear colour is opaque: a camera pointed at empty
 * space still returns the clear colour with **alpha 255**, so every byte being zero
 * cannot be a legitimate render — it is the signature of a failed or unsupported
 * readback, which is otherwise silent and ships a zip of black images.
 *
 * With a **transparent background** the check is not decidable (alpha 0 is expected and
 * a fully-empty frame is genuinely all-zero), so it returns `false` rather than risk a
 * false positive on a legitimate export.
 */
export function isBlankReadback(pixels: Uint8Array, transparentBackground: boolean): boolean {
  if (transparentBackground) return false;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== 0) return false;
  }
  return pixels.length > 0;
}

/**
 * The full readback → image-ready conversion (§8.4).
 *
 * @param flipRows - whether the readback is bottom-up and must be reversed. This is
 * **backend-dependent**: WebGL2's `readPixels` originates at the lower-left and needs the
 * flip, while WebGPU's `copyTextureToBuffer` starts at the texture's top-left and is
 * already in PNG row order. Flipping unconditionally exports mirrored images on WebGPU.
 */
export function prepareForEncode(
  pixels: Uint8Array,
  width: number,
  height: number,
  transparentBackground: boolean,
  flipRows: boolean,
): Uint8Array {
  if (flipRows) flipVertical(pixels, width, height);
  if (!transparentBackground) forceOpaque(pixels);
  return pixels;
}
