/**
 * The union arithmetic and the trial loop (`camera_placement.md` §2.1, §4.4,
 * §4.5, §13).
 *
 * Synthetic reachable sets, no engine: what is pinned here is that a voxel two
 * positions both reach is counted **once** (the property that penalizes a
 * clustered layout, §1.2), that a seeded analysis reproduces exactly, and that
 * chunking the trials cannot change the answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelBitset, leafSetOf, type LeafChunk, type LeafSet } from '../src/placement/leafSet.ts';
import {
  advanceAnalysis,
  advanceGreedy,
  greedyRemaining,
  bestScore,
  kneeOf,
  newAnalysis,
  selectedCount,
  TRIALS_MAX,
  type AnalysisCandidate,
} from '../src/placement/analyze.ts';

const DIMS = [16, 4, 16] as const;

/** One chunk covering the whole test grid, so local index === global index. */
function chunkOf(cubes: { at: [number, number, number]; size?: number }[]): LeafChunk {
  const index = new Uint32Array(cubes.length);
  const size = new Uint16Array(cubes.length);
  cubes.forEach((c, n) => {
    const [i, j, k] = c.at;
    index[n] = i + DIMS[0] * (j + DIMS[1] * k);
    size[n] = c.size ?? 1;
  });
  return { base: [0, 0, 0], dims: DIMS, index, size };
}

function setOf(cubes: { at: [number, number, number]; size?: number }[]): LeafSet {
  return leafSetOf([chunkOf(cubes)]);
}

type Cube = { at: [number, number, number]; size?: number };

/** A run of `n` single voxels along X at row (j, k). */
function rowCubes(j: number, k: number, from: number, n: number): Cube[] {
  return Array.from({ length: n }, (_, i) => ({ at: [from + i, j, k] as [number, number, number] }));
}

function row(j: number, k: number, from: number, n: number): LeafSet {
  return setOf(rowCubes(j, k, from, n));
}

// --- The union primitive (§2.1) ----------------------------------------------

test('leafSetOf counts a cube as edge³', () => {
  assert.equal(setOf([{ at: [0, 0, 0], size: 2 }]).count, 8);
  assert.equal(setOf([{ at: [0, 0, 0] }, { at: [5, 1, 2] }]).count, 2);
});

test('a bitset counts each voxel once, however many sets reach it', () => {
  const bits = new VoxelBitset(DIMS);
  const a = row(0, 0, 0, 8);
  const b = row(0, 0, 4, 8); // overlaps a in voxels 4..7

  assert.equal(bits.add(a), 8);
  // Only the four voxels b adds are new — the shared four are already covered.
  assert.equal(bits.add(b), 4);
  assert.equal(bits.count(), 12);

  // Adding the same set twice contributes nothing the second time, which is the
  // property that makes a clustered layout score no better than one camera.
  assert.equal(bits.add(a), 0);
});

test('a cube rasterizes to its whole volume, in the right voxels', () => {
  const bits = new VoxelBitset(DIMS);
  assert.equal(bits.add(setOf([{ at: [2, 1, 3], size: 2 }])), 8);
  for (let k = 3; k < 5; k++) {
    for (let j = 1; j < 3; j++) {
      for (let i = 2; i < 4; i++) assert.equal(bits.has(i, j, k), true, `${i},${j},${k}`);
    }
  }
  assert.equal(bits.has(4, 1, 3), false);
  assert.equal(bits.has(2, 0, 3), false);
});

test('a bitset honours a chunk base, so two chunks land in different voxels', () => {
  const bits = new VoxelBitset(DIMS);
  const shifted: LeafChunk = { ...chunkOf([{ at: [0, 0, 0] }]), base: [8, 0, 0] };
  assert.equal(bits.add(leafSetOf([chunkOf([{ at: [0, 0, 0] }]), shifted])), 2);
  assert.equal(bits.has(0, 0, 0), true);
  assert.equal(bits.has(8, 0, 0), true);
});

test('clear() empties the bitset without reallocating', () => {
  const bits = new VoxelBitset(DIMS);
  bits.add(row(0, 0, 0, 8));
  bits.clear();
  assert.equal(bits.count(), 0);
  assert.equal(bits.add(row(0, 0, 0, 8)), 8);
});

test('a grid too large for the scratch bitset is refused with a usable message', () => {
  assert.throws(() => new VoxelBitset([100_000, 100_000, 100_000]), /coarser resolution/);
});

// --- The trial loop (§4.4) ---------------------------------------------------

/**
 * Ten positions in two disjoint rooms, five each.
 *
 * Every position in a room sees that whole room plus **one voxel unique to
 * it** — so two mounts in the same room are nearly redundant, which is the
 * situation a union objective is supposed to notice and a summed one is not.
 *
 * Room A is 12 voxels, room B is 6.
 */
function twoRoomPool(): AnalysisCandidate[] {
  const pool: AnalysisCandidate[] = [];
  // Mounts stand a metre apart within a room and eight between them, so a
  // layout's separation says which rooms it drew from (§1.2).
  for (let n = 0; n < 5; n++) {
    pool.push({ position: [n, 1, 0], set: setOf([...rowCubes(0, 0, 0, 12), { at: [n, 1, 0] }]) });
  }
  for (let n = 0; n < 5; n++) {
    pool.push({ position: [n, 1, 8], set: setOf([...rowCubes(0, 8, 0, 6), { at: [n, 1, 8] }]) });
  }
  return pool;
}

test('best-per-count is non-decreasing in count, by construction', () => {
  const pool = twoRoomPool();
  const bits = new VoxelBitset(DIMS);
  const state = newAnalysis(pool.length, { maxCount: 6, seed: 1 });
  advanceAnalysis(state, pool, bits, 200);
  for (let k = 1; k < state.best.length; k++) {
    assert.ok(state.best[k]!.score >= state.best[k - 1]!.score, `dip at ${k + 1}`);
  }
});

test('a layout is `count` distinct pool positions', () => {
  const pool = twoRoomPool();
  const state = newAnalysis(pool.length, { maxCount: 4, seed: 3 });
  advanceAnalysis(state, pool, new VoxelBitset(DIMS), 50);
  for (const b of state.best) {
    assert.equal(b!.indices.length, b!.count);
    assert.equal(new Set(b!.indices).size, b!.count);
  }
});

test('the union objective spreads a 2-camera layout across both rooms', () => {
  // Two mounts in room A union to 14 (12 shared + 2 unique); one from each room
  // unions to 20 (12 + 1 + 6 + 1). A score that *summed* instead of unioning
  // would rank two A mounts at 26 and put both in the same room — the failure
  // this test exists to catch.
  const pool = twoRoomPool();
  const state = newAnalysis(pool.length, { maxCount: 2, seed: 1 });
  advanceAnalysis(state, pool, new VoxelBitset(DIMS), 200);
  const best2 = state.best[1]!;
  assert.equal(best2.score, 20);
  const rooms = new Set(best2.indices.map((i) => (i < 5 ? 'A' : 'B')));
  assert.deepEqual([...rooms].sort(), ['A', 'B']);
});

test('the same seed reproduces a search exactly; a different seed does not', () => {
  const pool = twoRoomPool();
  const run = (seed: number) => {
    const s = newAnalysis(pool.length, { maxCount: 3, seed });
    advanceAnalysis(s, pool, new VoxelBitset(DIMS), 5);
    return s.best.map((b) => `${b!.score}:${b!.indices.join(',')}`);
  };
  assert.deepEqual(run(1), run(1));
  assert.notDeepEqual(run(1), run(2));
});

test('chunking the trials cannot change the answer', () => {
  const pool = twoRoomPool();
  const whole = newAnalysis(pool.length, { maxCount: 3, seed: 9 });
  advanceAnalysis(whole, pool, new VoxelBitset(DIMS), 20);

  const chunked = newAnalysis(pool.length, { maxCount: 3, seed: 9 });
  const bits = new VoxelBitset(DIMS);
  for (let i = 0; i < 4; i++) advanceAnalysis(chunked, pool, bits, 5);

  assert.equal(chunked.trialsDone, whole.trialsDone);
  assert.deepEqual(
    chunked.best.map((b) => `${b!.score}:${b!.indices.join(',')}`),
    whole.best.map((b) => `${b!.score}:${b!.indices.join(',')}`),
  );
});

test('the trial stream is still fresh at the ceiling', () => {
  // What the 100,000-trial ceiling (§5.1) rests on: trial t is seeded from t
  // alone, so the last trials of a full run are new layouts rather than
  // repeats of the first. Drawn one trial at a time from indices just under
  // the ceiling, `best[2]` is exactly that trial's triple.
  const pool = twoRoomPool();
  const bits = new VoxelBitset(DIMS);
  const layouts = new Set<string>();
  for (let t = 0; t < 200; t++) {
    const state = newAnalysis(pool.length, { maxCount: 3, seed: 4 });
    state.trialsDone = TRIALS_MAX - 200 + t;
    advanceAnalysis(state, pool, bits, 1);
    layouts.add(state.best[2]!.indices.join(','));
  }
  assert.ok(layouts.size > 100, `only ${layouts.size} distinct layouts in 200 trials`);
});

test('a ceiling-length run is chunk-invariant', () => {
  // The batching the panel's Cancel and progress line depend on (§4.4) is
  // pinned at the top of the range, not just at 20 trials.
  const pool = twoRoomPool();
  const whole = newAnalysis(pool.length, { maxCount: 3, seed: 7 });
  advanceAnalysis(whole, pool, new VoxelBitset(DIMS), TRIALS_MAX);

  const chunked = newAnalysis(pool.length, { maxCount: 3, seed: 7 });
  const bits = new VoxelBitset(DIMS);
  for (let done = 0; done < TRIALS_MAX; done += 50) advanceAnalysis(chunked, pool, bits, 50);

  assert.equal(chunked.trialsDone, TRIALS_MAX);
  assert.deepEqual(
    chunked.best.map((b) => `${b!.score}:${b!.indices.join(',')}`),
    whole.best.map((b) => `${b!.score}:${b!.indices.join(',')}`),
  );
});

test('maxCount is clamped to the pool size', () => {
  const pool = twoRoomPool().slice(0, 3);
  const state = newAnalysis(pool.length, { maxCount: 10, seed: 1 });
  assert.equal(state.maxCount, 3);
  advanceAnalysis(state, pool, new VoxelBitset(DIMS), 10);
  assert.equal(state.best.length, 3);
});

test('an empty pool searches to nothing rather than throwing', () => {
  const state = newAnalysis(0, { maxCount: 5, seed: 1 });
  advanceAnalysis(state, [], new VoxelBitset(DIMS), 10);
  assert.equal(bestScore(state.best), 0);
});

// --- The greedy pass (§4.4) --------------------------------------------------

/** A pool of `n` mounts a metre apart along X, all reaching the same voxels. */
function saturatedPool(n: number): AnalysisCandidate[] {
  const set = setOf(rowCubes(0, 0, 0, 12));
  return Array.from({ length: n }, (_, i) => ({ position: [i, 0, 0] as [number, number, number], set }));
}

/**
 * §4.4's greedy pass with no laziness: every unpicked candidate re-evaluated
 * every step. The reference the lazy pass must agree with — the bound order is
 * an optimisation, and an optimisation that changed the answer would be a bug
 * no assertion about the answer alone could catch.
 */
function naiveGreedy(pool: readonly AnalysisCandidate[], maxCount: number): number[] {
  const bits = new VoxelBitset(DIMS);
  const picked: number[] = [];
  const taken = new Set<number>();
  for (let k = 0; k < maxCount; k++) {
    let pick = -1;
    let bestGain = -1;
    let bestSep = -1;
    for (let i = 0; i < pool.length; i++) {
      if (taken.has(i)) continue;
      const gain = bits.gain(pool[i].set);
      let sep = Infinity;
      for (const q of picked) {
        const [ax, ay, az] = pool[i].position;
        const [bx, by, bz] = pool[q].position;
        const d = Math.hypot(ax - bx, ay - by, az - bz);
        if (d < sep) sep = d;
      }
      if (gain > bestGain || (gain === bestGain && sep > bestSep)) {
        bestGain = gain;
        bestSep = sep;
        pick = i;
      }
    }
    taken.add(pick);
    picked.push(pick);
    bits.add(pool[pick].set);
  }
  return picked;
}

function runGreedy(pool: readonly AnalysisCandidate[], maxCount: number, steps = 0) {
  const state = newAnalysis(pool.length, { maxCount, seed: 1 });
  const bits = new VoxelBitset(DIMS);
  const total = greedyRemaining(state, pool.length);
  if (steps === 0) advanceGreedy(state, pool, bits, total);
  else for (let done = 0; done < total; done += steps) advanceGreedy(state, pool, bits, steps);
  return state;
}

test('the lazy greedy pass picks what a naive all-candidates scan picks', () => {
  // The two rooms plus a third set of mounts that start looking good and go
  // stale — their gain collapses once the room they share is covered, which is
  // the case the bound order has to survive.
  const pool = twoRoomPool();
  for (let n = 0; n < 4; n++) {
    pool.push({ position: [n, 2, 4], set: setOf([...rowCubes(0, 0, 0, 10), { at: [n, 2, 4] }]) });
  }
  const state = runGreedy(pool, 5);
  assert.deepEqual(state.greedy.picked, naiveGreedy(pool, 5));
});

test('the greedy pass beats trials on a pool random draws miss', () => {
  // One mount sees a whole row; the rest see a voxel each. A trial of 3 out of
  // 40 usually misses it — greedy takes it first, by construction rather than
  // by luck. `seed: 1` is such a trial (`seed: 5` happens to draw it, which is
  // why the guarantee is a floor and the trials are kept, §4.4).
  const pool: AnalysisCandidate[] = [
    { position: [0, 0, 0], set: setOf(rowCubes(0, 0, 0, 12)) },
  ];
  for (let n = 1; n < 40; n++) pool.push({ position: [n, 3, 3], set: setOf([{ at: [n % 16, 3, 3] }]) });

  const withGreedy = newAnalysis(pool.length, { maxCount: 3, seed: 1 });
  const bits = new VoxelBitset(DIMS);
  advanceGreedy(withGreedy, pool, bits, greedyRemaining(withGreedy, pool.length));
  advanceAnalysis(withGreedy, pool, bits, 1);

  const trialsOnly = newAnalysis(pool.length, { maxCount: 3, seed: 1 });
  advanceAnalysis(trialsOnly, pool, new VoxelBitset(DIMS), 1);

  for (let k = 0; k < 3; k++) {
    assert.ok(
      withGreedy.best[k]!.score >= trialsOnly.best[k]!.score,
      `greedy lost at ${k + 1} cameras`,
    );
  }
  assert.ok(withGreedy.best[0]!.score > trialsOnly.best[0]!.score);
  assert.equal(withGreedy.greedy.picked[0], 0);
});

test('a saturated pool comes out evenly spaced, not bunched', () => {
  // Every position reaches the same voxels, so every gain after the first is 0
  // and the separation tie-break is the only thing choosing: the picks walk to
  // the ends and then to the middle (§4.4).
  const state = runGreedy(saturatedPool(10), 3);
  assert.deepEqual(state.greedy.picked, [0, 9, 4]);
  assert.equal(state.best[2]!.separation, 4);
  assert.equal(state.best[2]!.score, state.best[0]!.score, 'a saturated pool gains nothing');
});

test('the greedy pass at one camera is the highest-count position (§4.6)', () => {
  const pool = twoRoomPool();
  const state = runGreedy(pool, 4);
  let top = 0;
  for (let i = 1; i < pool.length; i++) if (pool[i].set.count > pool[top].set.count) top = i;
  assert.equal(state.greedy.picked[0], top);
  assert.equal(state.best[0]!.score, pool[top].set.count);
  assert.equal(state.best[0]!.separation, Infinity, 'one camera has no pair');
});

test('the greedy pass is chunk-invariant and needs no seed', () => {
  const pool = twoRoomPool();
  const whole = runGreedy(pool, 6);
  const stepwise = runGreedy(pool, 6, 1);
  assert.deepEqual(stepwise.greedy.picked, whole.greedy.picked);
  assert.deepEqual(
    stepwise.best.map((b) => `${b!.score}:${b!.separation}:${b!.indices.join(',')}`),
    whole.best.map((b) => `${b!.score}:${b!.separation}:${b!.indices.join(',')}`),
  );

  // Same pool, different seed: the pass reads no PRNG, so nothing moves.
  const other = newAnalysis(pool.length, { maxCount: 6, seed: 99 });
  advanceGreedy(other, pool, new VoxelBitset(DIMS), 6);
  assert.deepEqual(other.greedy.picked, whole.greedy.picked);
});

test('separation decides equal scores, and never outranks a score', () => {
  // Equal scores: a saturated pool's 2-camera layouts all score the same, so
  // the curve keeps the widest pair rather than the first one offered.
  const saturated = saturatedPool(10);
  const spread = newAnalysis(saturated.length, { maxCount: 2, seed: 2 });
  const bits = new VoxelBitset(DIMS);
  advanceGreedy(spread, saturated, bits, 2);
  advanceAnalysis(spread, saturated, bits, 200);
  assert.equal(spread.best[1]!.separation, 9, 'a bunched pair of equal score won');

  // A higher score with a worse spread still wins: the second key breaks ties,
  // it does not trade coverage away (§4.4).
  const pool: AnalysisCandidate[] = [
    { position: [0, 0, 0], set: setOf([{ at: [0, 0, 0] }, { at: [1, 0, 0] }, { at: [2, 0, 0] }]) },
    { position: [1, 0, 0], set: setOf([{ at: [3, 0, 0] }]) },
    { position: [15, 0, 0], set: setOf([{ at: [0, 0, 0] }]) },
  ];
  const state = newAnalysis(pool.length, { maxCount: 2, seed: 4 });
  const b2 = new VoxelBitset(DIMS);
  advanceGreedy(state, pool, b2, 2);
  advanceAnalysis(state, pool, b2, 200);
  assert.equal(state.best[1]!.score, 4);
  assert.equal(state.best[1]!.separation, 1);
});

test('an empty pool greedily picks nothing rather than throwing', () => {
  const state = newAnalysis(0, { maxCount: 5, seed: 1 });
  advanceGreedy(state, [], new VoxelBitset(DIMS), 5);
  assert.equal(greedyRemaining(state, 0), 0);
  assert.equal(bestScore(state.best), 0);
});

// --- The knee (§4.5) ---------------------------------------------------------

test('the knee is the fewest cameras within epsilon of the best score found', () => {
  const pool = twoRoomPool();
  const bits = new VoxelBitset(DIMS);
  const state = newAnalysis(pool.length, { maxCount: 6, seed: 1 });
  advanceAnalysis(state, pool, bits, 300);

  const total = 1024; // voxels in the test grid — the score's denominator
  const top = bestScore(state.best);
  // A generous epsilon reaches down to a smaller count than a strict one.
  const strict = kneeOf(state.best, 0, total);
  const loose = kneeOf(state.best, 100, total);
  assert.ok(loose <= strict);
  assert.equal(loose, 1);
  // epsilon = 0 picks the first count that attains the maximum.
  assert.equal(state.best[strict - 1]!.score, top);
  if (strict > 1) assert.ok(state.best[strict - 2]!.score < top);
});

test('the knee is expressed in percentage points of the marked total', () => {
  const pool = twoRoomPool();
  const state = newAnalysis(pool.length, { maxCount: 6, seed: 1 });
  advanceAnalysis(state, pool, new VoxelBitset(DIMS), 300);
  // 1 pp of 1000 voxels is 10 voxels of slack; of 100 voxels it is 1.
  assert.ok(kneeOf(state.best, 1, 1000) <= kneeOf(state.best, 1, 100));
});

test('the knee is asked of the curve, not of a live analysis (§4.5)', () => {
  // The review column holds only the curve and recomputes the knee on every
  // tolerance edit, so `kneeOf` must read a bare array — which is also what lets
  // a tolerance edit cost a scan instead of `trials` trials.
  const curve = [
    { count: 1, score: 40, indices: [0] },
    { count: 2, score: 90, indices: [0, 1] },
    { count: 3, score: 99, indices: [0, 1, 2] },
    { count: 4, score: 100, indices: [0, 1, 2, 3] },
  ];
  assert.equal(bestScore(curve), 100);
  // Strict: the first count that attains the maximum.
  assert.equal(kneeOf(curve, 0, 100), 4);
  // 1 pp of 100 voxels is 1 voxel of slack, which count 3 already clears.
  assert.equal(kneeOf(curve, 1, 100), 3);
  assert.equal(kneeOf(curve, 10, 100), 2);
  assert.equal(kneeOf(curve, 100, 100), 1);
  // A curve with holes is scanned, not indexed — a cancel leaves nulls.
  assert.equal(kneeOf([null, curve[1], null, curve[3]], 10, 100), 2);
  // No curve at all: nothing to scan, and the count is its own length.
  assert.equal(kneeOf([], 1, 100), 0);
});

test('the count follows the knee until the slider is moved (§5.2)', () => {
  // Unpinned, the count *is* the live knee, so a tolerance edit re-suggests.
  assert.equal(selectedCount(false, null, 8), 8);
  assert.equal(selectedCount(false, 11, 6), 6, 'a stale pick does not outrank the knee');
  // Pinned, the tolerance moves the marked knee and leaves the count alone.
  assert.equal(selectedCount(true, 11, 6), 11);
  // Before any analysis there is no knee and no count.
  assert.equal(selectedCount(false, null, null), null);
});
