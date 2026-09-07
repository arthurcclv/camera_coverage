/**
 * The placement **analysis**: a greedy pass and independent random layouts, both
 * scored at every prefix count (`camera_placement.md` §4.4, §4.5).
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
 *
 * The **greedy pass** (§4.4) is the other half, and it uses no PRNG at all: it
 * picks one camera at a time by largest gain against the union so far, breaking
 * ties by distance to the nearest camera already picked. Both halves offer their
 * prefixes to the same curve through the same two-key comparison, so what a
 * count holds is the better layout by §1.2's order and not the later of the two.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import type { LeafSet } from './leafSet.ts';
import type { VoxelBitset } from './leafSet.ts';

/** What the analysis needs of a pool position: its set and where it is. */
export interface AnalysisCandidate {
  set: LeafSet;
  /** Where the mount is, in world metres — §1.2's separation is between these. */
  position: Vec3;
}

/** The best layout found at one camera count. */
export interface BestLayout {
  /** Cameras in the layout — `1..maxCount`. */
  count: number;
  /** Union voxel count of the layout's reachable sets (§1.2). */
  score: number;
  /**
   * §1.2's `sep(L)`: metres between the layout's closest pair, `Infinity` at one
   * camera. The objective's second key, and §5.2's `spacing` readout.
   */
  separation: number;
  /** Indices into the pool, in the order the layout drew or picked them. */
  indices: number[];
}

/** The greedy pass's own progress through the pool (§4.4). */
export interface GreedyState {
  /** Pool indices picked so far, in pick order. */
  picked: number[];
  /** Union score of `picked`. */
  score: number;
  /** `sep(picked)` — the closest pair among them. */
  separation: number;
  /**
   * An **upper bound** on each position's gain, and the whole reason the pass is
   * affordable: the union only grows, so a gain can only fall, so a stale value
   * is still a bound. A step re-evaluates in bound order and stops as soon as no
   * unexamined bound can beat the best fresh gain in hand (Minoux's lazy greedy,
   * which returns the same layout as scanning every candidate every step).
   */
  bound: Float64Array;
  /** A gain of 0 can never rise, so such a position leaves the bound order. */
  exhausted: Uint8Array;
  /** Metres to the nearest picked position; `Infinity` until one is picked. */
  nearest: Float64Array;
  /** True once a position has been picked. */
  taken: Uint8Array;
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
  /** The greedy pass's state; its `picked.length` is how far it has got. */
  greedy: GreedyState;
}

/**
 * The largest `trials` the *Trials* field will accept (§5.1).
 *
 * Not a limit of the method — trials need no GPU and hold no memory beyond the
 * one accumulating bitset — but a guard against a mistyped digit. What it costs
 * is wall-clock: a trial is tens of milliseconds (§2.3), so the ceiling is tens
 * of minutes, which `advanceAnalysis`'s chunking and Cancel make abandonable.
 */
export const TRIALS_MAX = 100_000;

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
    greedy: {
      picked: [],
      score: 0,
      separation: Infinity,
      // Every gain starts bounded by the position's own count, which §4.3
      // cached — so the first step re-evaluates nothing.
      bound: new Float64Array(poolSize).fill(Infinity),
      exhausted: new Uint8Array(poolSize),
      nearest: new Float64Array(poolSize).fill(Infinity),
      taken: new Uint8Array(poolSize),
    },
  };
}

/**
 * The largest pool index in a layout — the comparison's last key.
 *
 * `ArrayLike` because a trial offers a window of its scratch `Int32Array` while
 * the greedy pass offers a plain array, and neither should copy to be compared.
 */
function maxIndexOf(indices: ArrayLike<number>, count: number): number {
  let top = -1;
  for (let i = 0; i < count; i++) if (indices[i] > top) top = indices[i];
  return top;
}

/**
 * §1.2's order: higher score, then wider separation, then the layout whose
 * highest pool index is lower.
 *
 * Score is *strictly* first — no tolerance blurs it, so the percentage §5.2
 * prints stays the best reachable score found rather than a compromise. The
 * third key exists only so two layouts that tie on both real keys resolve the
 * same way on every run, seed or no seed.
 */
function isBetter(
  score: number,
  separation: number,
  indices: ArrayLike<number>,
  count: number,
  cur: BestLayout | null,
): boolean {
  if (cur === null) return true;
  if (score !== cur.score) return score > cur.score;
  if (separation !== cur.separation) return separation > cur.separation;
  // `count` rather than `indices.length`: a trial offers a prefix of its whole
  // scratch permutation, so the tail of that array is not part of the layout.
  return maxIndexOf(indices, count) < maxIndexOf(cur.indices, cur.count);
}

/** Euclidean distance between two mounts, in metres. */
function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Offer a layout to `best[count − 1]`, keeping it if it wins the comparison.
 *
 * Both halves of an analysis come through here, which is what makes the curve
 * hold the better layout rather than the more recent one. The copy is taken only
 * on a win: a trial offers `maxCount` prefixes and most of them lose.
 */
function offer(
  state: AnalysisState,
  count: number,
  score: number,
  separation: number,
  indices: ArrayLike<number>,
): void {
  const cur = state.best[count - 1];
  if (!isBetter(score, separation, indices, count, cur)) return;
  const kept: number[] = new Array(count);
  for (let i = 0; i < count; i++) kept[i] = indices[i];
  state.best[count - 1] = { count, score, separation, indices: kept };
}

/**
 * Run `steps` more greedy picks, in place (§4.4).
 *
 * `bits` must hold the union of what the pass has already picked — it does
 * between two calls, because nothing else touches it until the pass is done.
 * That is also the ordering constraint the driver respects: the greedy pass runs
 * to completion (or is cancelled) **before** the trials, which clear the bitset
 * every trial.
 *
 * Chunked one pick at a time for the same reason the trials are chunked: a step
 * scans the pool (§2.3), so a pass that could not be interrupted would be one
 * the user cannot stop.
 */
export function advanceGreedy(
  state: AnalysisState,
  pool: readonly AnalysisCandidate[],
  bits: VoxelBitset,
  steps: number,
): void {
  const g = state.greedy;
  const n = pool.length;
  if (n === 0) return;

  // Reused across steps so a pass allocates nothing per pick.
  const live: number[] = [];

  for (let s = 0; s < steps && g.picked.length < state.maxCount; s++) {
    const first = g.picked.length === 0;

    live.length = 0;
    for (let i = 0; i < n; i++) if (!g.taken[i] && !g.exhausted[i]) live.push(i);
    // Descending bound: the scan below may stop early only if what it has not
    // examined is bounded by what it has.
    live.sort((a, b) => g.bound[b] - g.bound[a]);

    let pick = -1;
    let pickGain = -1;
    let pickSep = -1;

    if (first) {
      // `U` is empty, so a position's gain is its own cached count — no
      // rasterizing at all, and the pick is §4.6's highest-count position.
      for (const i of live) {
        const gain = pool[i].set.count;
        g.bound[i] = gain;
        if (gain === 0) g.exhausted[i] = 1;
        if (gain > pickGain) {
          pickGain = gain;
          pick = i;
        }
      }
      pickSep = Infinity;
    } else {
      for (const i of live) {
        // A bound below the best fresh gain in hand cannot win, and neither can
        // anything after it — the list is in bound order. Equal bounds are still
        // examined, because separation decides those.
        if (g.bound[i] < pickGain) break;
        const gain = bits.gain(pool[i].set);
        g.bound[i] = gain;
        if (gain === 0) {
          g.exhausted[i] = 1;
          continue;
        }
        const sep = g.nearest[i];
        if (gain > pickGain || (gain === pickGain && sep > pickSep)) {
          pickGain = gain;
          pickSep = sep;
          pick = i;
        }
      }
    }

    if (pick < 0) {
      // Saturated: every remaining position adds nothing, so the second key is
      // the only one left and the pick is the one farthest from the layout —
      // farthest-point sampling, which is what spreads the tail (§4.4).
      let far = -1;
      for (let i = 0; i < n; i++) {
        if (g.taken[i]) continue;
        if (g.nearest[i] > far) {
          far = g.nearest[i];
          pick = i;
        }
      }
      if (pick < 0) return; // the whole pool is picked
      pickGain = 0;
      pickSep = g.nearest[pick];
    }

    g.taken[pick] = 1;
    g.score += bits.add(pool[pick].set);
    if (g.picked.length > 0) g.separation = Math.min(g.separation, pickSep);
    g.picked.push(pick);

    const at = pool[pick].position;
    for (let i = 0; i < n; i++) {
      if (g.taken[i]) continue;
      const d = distance(at, pool[i].position);
      if (d < g.nearest[i]) g.nearest[i] = d;
    }

    offer(state, g.picked.length, g.score, g.separation, g.picked);
  }
}

/** Picks the greedy pass still owes — `0` once it has filled the curve. */
export function greedyRemaining(state: AnalysisState, poolSize: number): number {
  if (poolSize === 0) return 0;
  return Math.max(0, state.maxCount - state.greedy.picked.length);
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
    let separation = Infinity;
    for (let k = 1; k <= take; k++) {
      const at = order[k - 1];
      score += bits.add(pool[at].set);
      // The prefix's separation, maintained the same way the greedy pass
      // maintains its own: the closest pair can only be the new position and
      // one already in the prefix.
      for (let i = 0; i < k - 1; i++) {
        const d = distance(pool[at].position, pool[order[i]].position);
        if (d < separation) separation = d;
      }
      offer(state, k, score, separation, order);
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
