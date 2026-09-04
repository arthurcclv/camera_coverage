/**
 * The placement **analysis**: independent random layouts, scored at every prefix
 * count (`camera_placement.md` §4.4, §4.5).
 *
 * It searches layouts; it measures nothing. Every number it returns is the
 * aim-free upper bound of §1.3, which is why the panel's axis says *reachable*
 * and never *coverage* — and why the word here is `analyze` rather than a module
 * called `search` under a button called Analyze.
 *
 * **Engine-free.** Everything here is a pure function of a pool of cached
 * reachable sets, so the whole algorithm is testable with synthetic sets and no
 * GPU, no worker, and no React — the same arrangement `aim_optimization.md`
 * §7.1 makes for `greedy.ts`.
 *
 * A trial draws `maxCount` distinct pool positions in random order and unions
 * them one at a time. Because a random **prefix** of a random scatter is itself
 * a random scatter of the smaller size, one rasterizing pass yields a sample at
 * every count from 1 to `maxCount` — the whole curve for the price of its
 * largest point.
 *
 * Trials are **independent**: nothing carries over, and the best layout at each
 * count is kept whole. The PRNG is seeded from `(seed, trialIndex)`, so an analysis
 * is reproducible from the group's own record — which is the point of seeding at
 * all, in a tool whose output ends up on an installation drawing.
 */
import type { LeafSet } from './leafSet.ts';
import type { VoxelBitset } from './leafSet.ts';

/** What the analysis needs of a pool position: its set, and nothing else. */
export interface AnalysisCandidate {
  set: LeafSet;
}

/** The best layout found at one camera count. */
export interface BestLayout {
  /** Cameras in the layout — `1..maxCount`. */
  count: number;
  /** Union voxel count of the layout's reachable sets (§1.2). */
  score: number;
  /** Indices into the pool, in the order the trial drew them. */
  indices: number[];
}

export interface AnalysisState {
  /** Layout size this analysis considers, clamped to the pool size. */
  maxCount: number;
  /** Trials run so far. */
  trialsDone: number;
  /** Entry `k − 1` is the best layout found at `k` cameras; `null` until one is. */
  best: (BestLayout | null)[];
  seed: number;
  /** Scratch permutation of pool indices, reused every trial. */
  order: Int32Array;
}

/**
 * A counter-based PRNG (splitmix32) — deterministic in `(seed, trial)` with no
 * state carried between trials, so trial *t* is the same layout however many
 * trials ran before it, and a cancelled-then-resumed analysis is identical to an
 * uninterrupted one.
 */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

/** Start an analysis over `poolSize` candidates. */
export function newAnalysis(poolSize: number, opts: { maxCount: number; seed: number }): AnalysisState {
  const maxCount = Math.max(1, Math.min(opts.maxCount, poolSize));
  const order = new Int32Array(poolSize);
  for (let i = 0; i < poolSize; i++) order[i] = i;
  return {
    maxCount,
    trialsDone: 0,
    best: new Array<BestLayout | null>(maxCount).fill(null),
    seed: opts.seed,
    order,
  };
}

/**
 * Run `trials` more trials, in place.
 *
 * Chunked rather than run-to-completion so the driver owns progress reporting
 * and cancellation: a thousand trials is tens of seconds, and an analysis
 * that could not be interrupted would be one the user cannot stop.
 */
export function advanceAnalysis(
  state: AnalysisState,
  pool: readonly AnalysisCandidate[],
  bits: VoxelBitset,
  trials: number,
): void {
  const order = state.order;
  const n = order.length;
  if (n === 0) return;

  for (let t = 0; t < trials; t++) {
    const trialIndex = state.trialsDone + t;
    // Mixing the trial index into the seed rather than advancing one stream is
    // what makes trial t independent of how the run was chunked.
    const rand = splitmix32((state.seed | 0) ^ Math.imul(trialIndex + 1, 0x9e3779b1));

    // Partial Fisher–Yates: the first `maxCount` slots become a uniform random
    // ordered sample without replacement, and the array is left permuted for
    // the next trial (which reshuffles what it needs anyway).
    const take = Math.min(state.maxCount, n);
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rand() * (n - i));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    bits.clear();
    let score = 0;
    for (let k = 1; k <= take; k++) {
      score += bits.add(pool[order[k - 1]].set);
      const cur = state.best[k - 1];
      if (cur === null || score > cur.score) {
        const indices: number[] = new Array(k);
        for (let i = 0; i < k; i++) indices[i] = order[i];
        state.best[k - 1] = { count: k, score, indices };
      }
    }
  }
  state.trialsDone += trials;
}

/** The best score found at any count — `curve[maxCount − 1]` in practice. */
export function bestScore(curve: readonly (BestLayout | null)[]): number {
  let top = 0;
  for (const b of curve) if (b !== null && b.score > top) top = b.score;
  return top;
}

/**
 * The **knee**: the fewest cameras whose best layout comes within `epsilon`
 * percentage points of the best score found (§4.5).
 *
 * A preselection, not a verdict — `epsilon` is a policy the user owns, and the
 * panel shows the whole curve beside it (§5.2).
 *
 * Asked of the **curve**, not of the live `AnalysisState`: `epsilon` enters the
 * trial loop nowhere, so the knee is a scan of a finished answer, and the panel
 * that owns the tolerance holds only the curve. That is what lets a tolerance
 * edit recompute the knee for free instead of asking for `trials` trials again.
 */
export function kneeOf(
  curve: readonly (BestLayout | null)[],
  epsilon: number,
  markedTotal: number,
): number {
  const top = bestScore(curve);
  const slack = markedTotal > 0 ? (epsilon / 100) * markedTotal : 0;
  const target = top - slack;
  for (const b of curve) if (b !== null && b.score >= target) return b.count;
  return curve.length;
}

/**
 * The count the §5.2 slider holds: the live knee until the user picks one.
 *
 * The knee is a *suggestion* (§4.5), so a tolerance edit is free to re-suggest —
 * but a count the user dragged to is a decision, and moving it under them would
 * make the tolerance field feel like it was arguing. `pinned` is set by the
 * slider and cleared by the next analysis.
 */
export function selectedCount(
  pinned: boolean,
  picked: number | null,
  knee: number | null,
): number | null {
  return pinned ? picked : knee;
}
