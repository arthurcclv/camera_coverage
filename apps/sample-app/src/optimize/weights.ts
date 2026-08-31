/**
 * The caller-side weight tables Pass 7 sums (`aim_optimization.md` §1.1, §2.2).
 *
 * The SDK's projection primitive adds a `u32` the app hands it, indexed by the
 * voxel's popcount over the descriptor's camera mask (SDK spec §19.1). It never
 * learns that the app calls that popcount `n_others` or that the table encodes
 * `1/(n+1)^α` — which is exactly why changing the objective is a change to this
 * file and nothing else, and why raising α from 1 to 2 (worth ~1.7 points of
 * coverage, §1.1) touched one constant.
 */
/**
 * Fixed-point scale for the score plane (§2.2).
 *
 * Bounded above by overflow, below by precision. A bin accumulates in `u32`, so
 * one chunk may contribute at most `2^32 / SCORE_SCALE` voxels to a single bin —
 * at 16384 that is **262,144**. The worst case is a wide-angle bin far from the
 * camera at a fine voxel size: a 1.4° bin at 50 m is ~1.2 m across and the whole
 * depth column behind it is visible, so at 0.1 m voxels it can hold ~72k. That
 * leaves ~3.6× headroom, and the ceiling is well under the largest chunk the
 * engine accepts (SDK spec §11).
 *
 * It was 4096, which was enough for {@link REDUNDANCY_EXPONENT} = 1 but rounded
 * `1/(n+1)^2` to zero above `n = 90` — silently truncating the objective's tail
 * the moment the exponent moved off 1.
 */
export const SCORE_SCALE = 16384;

/**
 * How sharply the objective discounts an already-covered voxel (§1.1).
 *
 * `f(n) = 1/(n+1)^α`. At **α = 1** a voxel two cameras already see is still worth
 * a third of a blind one, so the optimizer spends real aim budget thinning
 * redundancy instead of filling blind spots. Measured on two scenes, that costs
 * coverage:
 *
 * | α | scene A (4 cam) | scene B (6 cam) |
 * |---|---|---|
 * | 1 | 93.79% | 97.34% |
 * | 2 | **95.44%** | **97.43%** |
 * | 3 | 95.62% | 97.43% |
 * | 4 | 95.08% | 97.43% |
 *
 * **2 is the default** because α ≥ 1.5 is uniformly at least as good as α = 1 and
 * 2 captures nearly all of the gain, while α ≥ 4 starts giving some back — a
 * weight that collapses to zero too fast loses the tiebreaker that decides
 * between two orientations covering equally many blind voxels. (Pure marginal
 * coverage — `f(0)=1`, else 0 — scores 95.22% / 97.43%, i.e. worse than α = 2 on
 * A, for exactly that reason.)
 *
 * Any α keeps §1.2's convergence guarantee: for `f` depending only on `n`,
 * `Φ = Σ_v G(n(v))` with `G(n) = Σ_{k<n} f(k)` satisfies `f(n) = G(n+1) − G(n)`,
 * so a camera's score is still exactly its marginal contribution to Φ.
 */
export const REDUNDANCY_EXPONENT = 2;

/**
 * Plane 0: `SCORE_SCALE / (n + 1)^α`, the §1.1 objective.
 *
 * `alpha` is a parameter only so the α sweep above is reproducible in a test;
 * production always passes {@link REDUNDANCY_EXPONENT}.
 */
export function scoreWeights(numCameras: number, alpha = REDUNDANCY_EXPONENT): Uint32Array {
  const w = new Uint32Array(numCameras + 1);
  for (let n = 0; n <= numCameras; n++) w[n] = Math.round(SCORE_SCALE / Math.pow(n + 1, alpha));
  return w;
}

/**
 * Plane 1: 1 where no other camera sees the voxel, 0 elsewhere.
 *
 * This is what the §4.4 blind gate compares. It rides the same pass as the score
 * because a second plane costs one `atomicAdd`, where a second projection would
 * cost another dispatch and another readback segment.
 */
export function blindWeights(numCameras: number): Uint32Array {
  const w = new Uint32Array(numCameras + 1);
  w[0] = 1;
  return w;
}

/** Raw bin sums → §1.1 units. */
export function toScore(fixed: number): number {
  return fixed / SCORE_SCALE;
}
