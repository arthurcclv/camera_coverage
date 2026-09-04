/**
 * The deterministic low-discrepancy sequence the pool is drawn from
 * (`camera_placement.md` §4.1).
 *
 * A **Halton** sequence emits points that spread out evenly by construction
 * rather than clumping the way independent random draws do, and it is
 * **prefix-stable**: its first `n` points are already well spread and point
 * `n + 1` lands in the largest remaining gap. That is what lets `poolSize` rise
 * from 200 to 260 and cost 60 build steps instead of 260 (§3.3.1).
 *
 * **Five dimensions are consumed per position, always** — whatever the kind and
 * whatever `distance` is. Keeping the stride fixed is what makes the mapping
 * from sequence index to position independent of the constraint's shape, so
 * editing `distance` or switching a kind does not reshuffle the pool.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

/** Dimensions consumed per drawn position (§4.1). */
export const HALTON_DIMS = 5;

/** The first `HALTON_DIMS` primes — one base per dimension. */
const BASES = [2, 3, 5, 7, 11] as const;

/**
 * The radical inverse of `index` in `base` — the 1-D Halton sequence. Returns a
 * value in [0, 1); index 0 returns 0, so callers start at 1 when they want to
 * avoid the corner.
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/**
 * The five unit parameters for one drawn position: `[u, v]` locate a point on
 * the primitive and `[a, b, c]` an offset inside the dilation ball (§4.1).
 */
export function haltonPoint(index: number): [number, number, number, number, number] {
  return [
    halton(index, BASES[0]),
    halton(index, BASES[1]),
    halton(index, BASES[2]),
    halton(index, BASES[3]),
    halton(index, BASES[4]),
  ];
}

/**
 * An offset uniform in the ball of radius `radius`, from three unit parameters:
 * radius by `radius · a^{1/3}` (the cube root is what makes it uniform by
 * volume rather than piling into the centre), direction from `z = 2b − 1` and
 * `φ = 2πc` (uniform on the sphere).
 *
 * `radius = 0` returns the zero offset, which is how a `distance = 0`
 * constraint degenerates to its primitive without a special case anywhere else.
 */
export function ballOffset(radius: number, a: number, b: number, c: number): Vec3 {
  if (radius <= 0) return [0, 0, 0];
  const r = radius * Math.cbrt(a);
  const z = 2 * b - 1;
  const phi = 2 * Math.PI * c;
  const sxy = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * sxy * Math.cos(phi), r * z, r * sxy * Math.sin(phi)];
}

/** FNV-1a over a string, as an unsigned 32-bit integer. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Where a constraint's own sub-sequence starts, from the group's `seed` and the
 * constraint's id (§4.1).
 *
 * Each constraint drawing from its own offset is what makes an edit local:
 * adding, deleting, or reshaping one constraint leaves every other
 * constraint's positions — and their build steps — untouched.
 *
 * Kept well below 2^31 so `offset + poolSize` stays an exactly-representable
 * integer and the `halton` loop terminates promptly.
 */
export function constraintOffset(seed: number, constraintId: string): number {
  const mixed = (hashString(constraintId) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  // +1 so a constraint never starts at index 0, whose radical inverse is all zeros
  // (the corner of the primitive, and the centre of the ball).
  return (mixed % 1_000_003) + 1;
}
