/**
 * Pure export-resolution policy (spec §9.1). Turns a camera's aspect plus the run
 * settings into the exact pixel size of its render target, and reports when the
 * request had to be clamped so the UI can say so rather than silently exporting
 * something other than what was asked for.
 */

/** The smallest render target either mode may produce (§9.1). */
export const MIN_DIMENSION = 16;

export type ResolutionMode =
  /** height = `baseHeight`, width from the camera's own aspect (§9.1). */
  | { kind: 'derive'; baseHeight: number }
  /** An explicit size applied to every camera regardless of its aspect (§9.1). */
  | { kind: 'fixed'; width: number; height: number };

export interface ImageSize {
  width: number;
  height: number;
  /** True when {@link MIN_DIMENSION} or `maxTextureSize` altered the requested size. */
  clamped: boolean;
}

/** Rounds to an even number ≥ {@link MIN_DIMENSION} — JPEG chroma subsampling wants even dimensions. */
function toEven(n: number): number {
  return Math.max(1, Math.round(n / 2) * 2);
}

/**
 * The pixel size for one camera (§9.1).
 *
 * @param aspect - the camera's authored `aspect` (width / height); used by `derive` only.
 * @param mode - the run's resolution mode.
 * @param maxTextureSize - the graphics device's max texture dimension; both axes clamp to it.
 */
export function imageSizeFor(aspect: number, mode: ResolutionMode, maxTextureSize: number): ImageSize {
  const limit = Math.max(MIN_DIMENSION, Math.floor(maxTextureSize));

  let width: number;
  let height: number;
  if (mode.kind === 'derive') {
    height = toEven(mode.baseHeight);
    width = toEven(height * aspect);
  } else {
    width = toEven(mode.width);
    height = toEven(mode.height);
  }

  const clampedWidth = Math.min(limit, Math.max(MIN_DIMENSION, width));
  const clampedHeight = Math.min(limit, Math.max(MIN_DIMENSION, height));

  // Re-even after clamping: an odd `limit` or an odd MIN_DIMENSION floor could
  // otherwise reintroduce an odd dimension.
  const finalWidth = toEven(Math.min(limit, clampedWidth));
  const finalHeight = toEven(Math.min(limit, clampedHeight));

  return {
    width: finalWidth,
    height: finalHeight,
    clamped: finalWidth !== width || finalHeight !== height,
  };
}

/**
 * The aspect the render rig must use (§9.1): always the *output* size's aspect, so
 * the image is correctly proportioned. In `fixed` mode a camera whose authored
 * aspect differs simply sees a different amount of the scene — it is not stretched.
 */
export function rigAspect({ width, height }: ImageSize): number {
  return width / height;
}
