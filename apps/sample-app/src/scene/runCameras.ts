/**
 * The camera list a retained run was computed against (spec §5.4, §12.2).
 *
 * Since §5.4 the app passes **every** camera to `setCameras()`, disabled ones
 * carrying `enabled: false` (SDK spec §5.2). That keeps mask-bit indices stable
 * across an enable/disable toggle, which is what lets the toggle recompute
 * incrementally instead of re-running the whole workspace — but it means a
 * camera's **mask-bit index is no longer its position among the cameras that
 * count**. Every readout phrased "of N cameras", and every per-camera list, has
 * to bridge that gap.
 *
 * This is that bridge, resolved once at `reset()` time and shared by all four
 * retained-run consumers so none of them re-derives it (or forgets to).
 */

/** A camera as a run knew it: its id and whether it contributed to the masks. */
export interface RunCamera {
  id: string;
  enabled: boolean;
}

/** The enabled cameras of a run, and where each one's bit lives in the masks. */
export interface RunCameras {
  /** Enabled camera ids, in mask-bit order. The denominator for "of N cameras". */
  ids: string[];
  /**
   * `bits[n]` is the mask-bit index of `ids[n]` — its position in the **full**
   * list passed to `setCameras()`, which is what `getMaskWord` is indexed by.
   * Equals `n` only while no camera is disabled.
   */
  bits: number[];
}

export const NO_RUN_CAMERAS: RunCameras = { ids: [], bits: [] };

export function runCameras(cameras: readonly RunCamera[]): RunCameras {
  const ids: string[] = [];
  const bits: number[] = [];
  for (let n = 0; n < cameras.length; n++) {
    if (!cameras[n].enabled) continue;
    ids.push(cameras[n].id);
    bits.push(n);
  }
  return { ids, bits };
}

/** Whether `bit` is set in a per-voxel/per-cell mask spread over `camWords` words. */
export function maskBitSet(
  words: (w: number) => number,
  camWords: number,
  bit: number,
): boolean {
  const w = bit >>> 5;
  if (w >= camWords) return false;
  return ((words(w) >>> (bit & 31)) & 1) === 1;
}
