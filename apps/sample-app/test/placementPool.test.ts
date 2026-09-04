/**
 * The pool: the measure-weighted split, the prefix-stable draw, and the build step
 * descriptor (`camera_placement.md` §4.1, §4.2, §2.1, §13).
 *
 * The properties pinned here are the ones a user would experience as the tool
 * losing its work: a share that starves a constraint, a draw that reshuffles
 * when `poolSize` changes, and a build step that counts voxels no panel counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CAMERAS, type Quat, type Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  buildStepCameras,
  buildStepSpec,
  classifyBuildStep,
  drawPosition,
  enabledConstraints,
  bestSample,
  emptyPool,
  planDraws,
  poolBlocker,
  poolSummary,
  repositionBlocker,
  truncatedShares,
  poolSplit,
  replacementDraw,
  drawBasis,
  soloBasis,
  overlapSummary,
  overlapFraction,
  type DrawBasis,
  targetRevision,
  OVERLAP_SAMPLES,
  REJECT_ATTEMPT_FACTOR,
  POOL_SIZE_MAX,
} from '../src/placement/pool.ts';
import type { SamplingVolume } from '../src/scene/samplingVolumes.ts';
import { HALTON_DIMS, ballOffset, constraintOffset, halton, haltonPoint } from '../src/placement/halton.ts';
import {
  DEFAULT_TEMPLATE,
  inRegion,
  pointOnPrimitive,
  type CameraConstraint,
  type ConstraintGroup,
} from '../src/placement/region.ts';
import { CAPTURE_SLOTS, isCaptureCameraId } from '../src/optimize/cubeRig.ts';
import type { SceneCamera } from '../src/cameras/camera.ts';
import type { MarkedFilter } from '../src/scene/aggregateSpec.ts';

const IDENTITY: Quat = [0, 0, 0, 1];

function group(over: Partial<ConstraintGroup> = {}): ConstraintGroup {
  return {
    id: 'cg-1',
    name: 'Dock',
    enabled: true,
    fov: 60,
    far: 30,
    namePrefix: 'Dock',
    zoneIds: [],
    restrictScoring: true,
    restrictMounts: false,
    poolSize: 200,
    maxCount: 10,
    trials: 100,
    epsilon: 1,
    seed: 1,
    ...over,
  };
}

function post(id = 'con-post', position: Vec3 = [0, 5, 0], distance = 0): CameraConstraint {
  return { id, groupId: 'cg-1', name: '', enabled: true, distance, kind: 'point', position };
}

function rail(id = 'con-rail', distance = 0.4, length = 60): CameraConstraint {
  return {
    id,
    groupId: 'cg-1',
    name: '',
    enabled: true,
    distance,
    kind: 'polyline',
    points: [
      [0, 5, 0],
      [0, 5, length],
    ],
  };
}

function wall(id = 'con-wall', distance = 0.3, size: [number, number] = [60, 40]): CameraConstraint {
  return { id, groupId: 'cg-1', name: '', enabled: true, distance, kind: 'plane', position: [0, 5, 0], rotation: IDENTITY, size };
}

function camera(id: string): SceneCamera {
  return {
    id,
    name: '',
    enabled: true,
    position: [0, 0, 0],
    rotation: IDENTITY,
    fov: 60,
    far: 30,
  };
}

const NO_FILTER: MarkedFilter = { regions: [], maskRegions: [] };

/**
 * The §4.1 draw basis for a constraint list — every helper above builds an
 * enabled constraint of `cg-1`, so this is "these constraints at their primitive
 * measures" unless a mount filter is handed in.
 */
function basisFor(cs: CameraConstraint[], mountVolumes: SamplingVolume[] = [], g = group()): DrawBasis {
  return drawBasis(g, cs, mountVolumes);
}

// --- The split (§4.1) --------------------------------------------------------

test('poolSplit matches the worked example in §4.1', () => {
  // The spec's own table: weights 1 : 60 : 2400 at poolSize 200 give 1 : 5 : 194.
  // Rounding (not truncating) is what earns the rail its fifth position, and the
  // overshoot the post's floor-of-1 creates comes off the wall — the largest
  // weight — not off the rail.
  assert.deepEqual(poolSplit(basisFor([post(), rail(), wall()]), 200), [1, 5, 194]);
});

test('poolSplit weights by primitive measure and sums to poolSize', () => {
  const shares = poolSplit(basisFor([post(), rail(), wall()]), 200);
  // Weights 1 : 60 : 2400 — the wall takes almost all of it.
  assert.equal(shares.reduce((a, b) => a + b, 0), 200);
  assert.ok(shares[2] > shares[1] && shares[1] > shares[0]);
  assert.equal(shares[0], 1);
});

test('poolSplit floors every enabled constraint at 1, so a lone post is never starved', () => {
  // A post against a wall 2400× its measure would round to zero without the floor.
  const shares = poolSplit(basisFor([post(), wall()]), 50);
  assert.equal(shares[0], 1);
  assert.equal(shares.reduce((a, b) => a + b, 0), 50);
});

test('poolSplit gives one each when there are more constraints than positions', () => {
  const shares = poolSplit(basisFor([post('a'), post('b'), post('c')]), 2);
  assert.deepEqual(shares, [1, 1, 1]);
});

test('poolSplit shares evenly when nothing has a measure', () => {
  const shares = poolSplit(basisFor([post('a'), post('b'), post('c'), post('d')]), 20);
  assert.deepEqual(shares, [5, 5, 5, 5]);
});

test('poolSplit ignores distance — the split cannot collapse when d is 0', () => {
  const pinned = poolSplit(basisFor([rail('r', 0), wall('w', 0)]), 100);
  const loose = poolSplit(basisFor([rail('r', 2), wall('w', 2)]), 100);
  assert.deepEqual(pinned, loose);
});

// --- The sequence (§4.1) -----------------------------------------------------

test('halton: the radical inverse of the first indices in base 2', () => {
  assert.equal(halton(0, 2), 0);
  assert.equal(halton(1, 2), 0.5);
  assert.equal(halton(2, 2), 0.25);
  assert.equal(halton(3, 2), 0.75);
  assert.equal(halton(4, 2), 0.125);
});

test('haltonPoint consumes a fixed five dimensions per position', () => {
  assert.equal(haltonPoint(7).length, HALTON_DIMS);
  assert.ok(haltonPoint(7).every((u) => u >= 0 && u < 1));
});

test('ballOffset stays inside the ball and is zero at radius 0', () => {
  assert.deepEqual(ballOffset(0, 0.4, 0.6, 0.7), [0, 0, 0]);
  for (let i = 1; i < 200; i++) {
    const [u, , a, b, c] = haltonPoint(i);
    const off = ballOffset(1.5, a, b, c);
    assert.ok(Math.hypot(off[0], off[1], off[2]) <= 1.5 + 1e-12, `sample ${i} (u=${u})`);
  }
});

test('constraintOffset is stable per id and separates two constraints', () => {
  assert.equal(constraintOffset(1, 'con-a'), constraintOffset(1, 'con-a'));
  assert.notEqual(constraintOffset(1, 'con-a'), constraintOffset(1, 'con-b'));
  assert.notEqual(constraintOffset(1, 'con-a'), constraintOffset(2, 'con-a'));
  assert.ok(constraintOffset(7, 'con-a') >= 1);
});

// --- The draw (§4.1) ---------------------------------------------------------

test('every drawn position lies inside its constraint region', () => {
  for (const c of [post('p', [1, 2, 3], 1.5), rail('r', 0.4), wall('w', 0.3), post('fixed', [4, 5, 6], 0)]) {
    for (let k = 0; k < 120; k++) {
      const p = drawPosition(c, 1, k);
      assert.equal(inRegion(p, c), true, `${c.kind} sample ${k}: ${p.join(',')}`);
    }
  }
});

test('the draw is prefix-stable: raising poolSize keeps every earlier position', () => {
  const g200 = group({ poolSize: 200 });
  const g260 = group({ poolSize: 260 });
  const cs = [post(), rail(), wall()];
  const a = planDraws(g200, basisFor(cs, [], g200));
  const b = planDraws(g260, basisFor(cs, [], g260));
  assert.equal(a.length, 200);
  assert.equal(b.length, 260);

  // Every position of the smaller pool appears in the larger one, unchanged.
  const key = (d: { constraintId: string; seqIndex: number; position: Vec3 }) =>
    `${d.constraintId}#${d.seqIndex}@${d.position.join(',')}`;
  const larger = new Set(b.map(key));
  for (const d of a) assert.ok(larger.has(key(d)), `lost ${key(d)}`);
});

test('the field ceiling is a size the draw actually holds up at (§5.1)', () => {
  // `Size` accepts up to POOL_SIZE_MAX, and the two properties the whole extend
  // path rests on have to survive there: the shares still sum, and the prefix a
  // smaller pool built is still the prefix of the bigger one.
  const cs = [post(), rail(), wall()];
  const gMax = group({ poolSize: POOL_SIZE_MAX });
  const shares = poolSplit(basisFor(cs, [], gMax), POOL_SIZE_MAX);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    POOL_SIZE_MAX,
  );

  const small = group({ poolSize: 1000 });
  const a = planDraws(small, basisFor(cs, [], small));
  const b = planDraws(gMax, basisFor(cs, [], gMax));
  assert.equal(a.length, 1000);
  assert.equal(b.length, POOL_SIZE_MAX);
  const key = (d: { constraintId: string; seqIndex: number; position: Vec3 }) =>
    `${d.constraintId}#${d.seqIndex}@${d.position.join(',')}`;
  const larger = new Set(b.map(key));
  for (const d of a) assert.ok(larger.has(key(d)), `lost ${key(d)}`);

  // And the extend from the old ceiling to the new one costs only the difference.
  const held = new Map(
    cs.map((c, i) => {
      const kept = poolSplit(basisFor(cs, [], small), 1000)[i];
      return [c.id, { kept, nextSeq: kept }];
    }),
  );
  assert.equal(planDraws(gMax, basisFor(cs, [], gMax), { held }).length, POOL_SIZE_MAX - 1000);
});

test('an extension draws only what is new', () => {
  const cs = [post(), rail(), wall()];
  const shares = poolSplit(basisFor(cs), 200);
  const held = new Map(cs.map((c, i) => [c.id, { kept: shares[i], nextSeq: shares[i] }]));
  const extra = planDraws(group({ poolSize: 260 }), basisFor(cs), { held });
  assert.equal(extra.length, 60);
  // Nothing already built is redrawn.
  for (const d of extra) assert.ok(d.seqIndex >= (held.get(d.constraintId)?.nextSeq ?? 0));

  // And the kept prefix is bit-identical to what a full build step would have
  // produced — the whole basis for reusing it (§3.3.1).
  const full = planDraws(group({ poolSize: 260 }), basisFor(cs));
  const key = (d: { constraintId: string; seqIndex: number; position: Vec3 }) =>
    `${d.constraintId}#${d.seqIndex}@${d.position.join(',')}`;
  const fullKeys = new Set(full.map(key));
  for (const d of extra) assert.ok(fullKeys.has(key(d)), `extension drew ${key(d)}, which a full plan would not`);
});

test('an extension after rejections needs both kept and nextSeq', () => {
  // The rail rejected 5 draws: it holds `share` positions but its sequence has
  // moved 5 further on (§4.2). Planning from `kept` would rebuild the five
  // known-bad draws; planning `share − nextSeq` would come up five short.
  const cs = [post(), rail(), wall()];
  const shares = poolSplit(basisFor(cs), 200);
  const held = new Map(
    cs.map((c, i) => [
      c.id,
      { kept: shares[i], nextSeq: shares[i] + (c.id === 'con-rail' ? 5 : 0) },
    ]),
  );
  const extra = planDraws(group({ poolSize: 260 }), basisFor(cs), { held });
  assert.equal(extra.length, 60, 'the extension is still 60 positions, rejections or not');
  const railDraws = extra.filter((d) => d.constraintId === 'con-rail');
  const railHeld = held.get('con-rail')!;
  assert.equal(railDraws.length, poolSplit(basisFor(cs), 260)[1] - railHeld.kept);
  for (const d of railDraws) {
    assert.ok(d.seqIndex >= railHeld.nextSeq, 'a rejected draw must never be planned again');
  }
});

test('a truncation builds nothing and keeps each constraint its first share', () => {
  const cs = [post(), rail(), wall()];
  const shares260 = poolSplit(basisFor(cs), 260);
  const held = new Map(cs.map((c, i) => [c.id, { kept: shares260[i], nextSeq: shares260[i] }]));
  // Lowering the size: every share is already met or exceeded, so nothing is drawn.
  assert.equal(planDraws(group({ poolSize: 120 }), basisFor(cs), { held }).length, 0);

  const keep = truncatedShares(group({ poolSize: 120 }), basisFor(cs));
  assert.equal([...keep.values()].reduce((a, b) => a + b, 0), 120);
  cs.forEach((c, i) => assert.ok((keep.get(c.id) ?? 0) <= shares260[i]));
});

test('a moved fingerprint plans every draw again, whichever way the size went', () => {
  // `planDraws` is told nothing about fingerprints — the session drops `held`
  // entirely when one moves (§3.3.1), so both directions replan in full.
  const cs = [post(), rail(), wall()];
  assert.equal(planDraws(group({ poolSize: 260 }), basisFor(cs)).length, 260);
  assert.equal(planDraws(group({ poolSize: 120 }), basisFor(cs)).length, 120);
});

test('each constraint has its own sub-sequence, so editing one leaves the others alone', () => {
  const g = group({ poolSize: 90 });
  const before = planDraws(g, basisFor([post('p'), rail('r'), wall('w')], [], g));
  // Reshape the wall: same ids elsewhere, so the rail and post must not move.
  const after = planDraws(g, basisFor([post('p'), rail('r'), wall('w', 0.3, [90, 40])], [], g));
  const only = (ds: typeof before, id: string) =>
    ds.filter((d) => d.constraintId === id).map((d) => d.position.join(','));
  assert.deepEqual(only(after, 'p'), only(before, 'p'));
  // The rail's *positions* are unchanged for the indices both plans contain.
  const n = Math.min(only(after, 'r').length, only(before, 'r').length);
  assert.deepEqual(only(after, 'r').slice(0, n), only(before, 'r').slice(0, n));
});

test('changing only distance keeps the primitive point a position was drawn from', () => {
  // The first two Halton dimensions locate the point on the primitive and the
  // last three the ball offset, so a d = 0 draw is the primitive point itself.
  const pinned = rail('r', 0);
  const loose = rail('r', 2);
  for (let k = 0; k < 20; k++) {
    const [u, v] = haltonPoint(constraintOffset(1, 'r') + k);
    assert.deepEqual(drawPosition(pinned, 1, k), pointOnPrimitive(pinned, u, v));
    // The loose draw is the same base point plus an offset within d.
    const p = drawPosition(loose, 1, k);
    const base = pointOnPrimitive(loose, u, v);
    assert.ok(Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2]) <= 2 + 1e-12);
  }
});

// --- Rejection (§4.2) --------------------------------------------------------

test('replacementDraw advances the sequence and stops at the attempt cap', () => {
  const g = group();
  const c = rail('r');
  const share = 5;
  const at = replacementDraw(g, c, share, share, soloBasis(c));
  assert.ok(at !== null);
  assert.equal(at!.seqIndex, share);
  // Spending the whole budget terminates the constraint rather than looping.
  assert.equal(replacementDraw(g, c, share * REJECT_ATTEMPT_FACTOR, share, soloBasis(c)), null);
});

test('a constraint sealed inside geometry terminates, and the readout names it', () => {
  // §13 asks for this case by name: a constraint buried in a sealed box, where
  // every drawn position sees nothing. The danger it guards is silence — a
  // constraint that contributes no position and never says so reads, in the
  // panel, as a constraint that simply drew badly.
  const g = group();
  const buried: CameraConstraint = { ...rail('con-buried'), name: 'Rail 2' };
  const share = 5;

  // The build step loop of §4.2, against an engine that ran fine and found nothing
  // — which is exactly what a position inside a wall produces.
  let spent = 0;
  let rejected = 0;
  const kept: number[] = [];
  for (;;) {
    const draw = replacementDraw(g, buried, spent, share, soloBasis(buried));
    if (draw === null) break;
    spent++;
    const outcome = classifyBuildStep(true, 0);
    assert.equal(outcome, 'rejected', 'a run that saw nothing is rejected, not failed');
    rejected++;
  }

  // The cap terminated the draw rather than looping forever on a constraint
  // that can never fill its share.
  assert.equal(spent, share * REJECT_ATTEMPT_FACTOR);
  assert.equal(kept.length, 0);

  // The pool proceeds without it, and the readout names it (§10).
  const pool = {
    ...emptyPool(g.id, 'fp', g.poolSize, g.seed),
    rejected,
    emptyConstraints: [buried.id],
    poolCeiling: 0,
    markedTotal: 0,
  };
  const text = poolSummary(pool, [buried]);
  assert.match(text, /Rail 2 saw nothing from any sampled position\./);
  assert.match(text, /15 rejected \(saw nothing\)/);
});

test('poolSummary falls back to the constraint id when the constraint is gone', () => {
  const g = group();
  const pool = { ...emptyPool(g.id, 'fp'), emptyConstraints: ['con-vanished'] };
  assert.match(poolSummary(pool, []), /con-vanished saw nothing from any sampled position\./);
});

// --- Blocking (§10) ----------------------------------------------------------

test('poolBlocker reports each §10 reason, in priority order', () => {
  const cs = [rail()];
  const few = [camera('cam-1')];
  assert.equal(poolBlocker(few, group(), cs), null);

  const full = Array.from({ length: MAX_CAMERAS - CAPTURE_SLOTS + 1 }, (_, i) => camera(`cam-${i}`));
  assert.match(poolBlocker(full, group(), cs)!, /spare camera slots/);
  assert.match(poolBlocker(few, group(), cs, { aimSessionOpen: true })!, /aim optimizer/);
  assert.match(poolBlocker(few, group(), cs, { samplingPending: true })!, /sampling change/);
  assert.match(poolBlocker(few, null, cs)!, /constraint group/);
  assert.match(poolBlocker(few, group(), [{ ...rail(), enabled: false }])!, /no enabled constraint/);
});

test('enabledConstraints takes this group only, enabled only', () => {
  const mine = rail('mine');
  const off = { ...wall('off'), enabled: false };
  const other = { ...post('other'), groupId: 'cg-2' };
  assert.deepEqual(
    enabledConstraints(group(), [mine, off, other]).map((c) => c.id),
    ['mine'],
  );
});

// --- The build step (§2.1) ------------------------------------------------------

test('buildStepCameras appends the rig at the candidate, sharing the group range', () => {
  const cams = [camera('cam-1'), camera('cam-2')];
  const list = buildStepCameras(cams, group({ far: 45 }), [3, 6, 9]);
  assert.equal(list.length, cams.length + CAPTURE_SLOTS);
  // The scene cameras keep their ids and order, so a build step stays eligible for
  // incremental recompute (SDK §13.1).
  assert.deepEqual(list.slice(0, 2).map((c) => c.id), ['cam-1', 'cam-2']);
  for (const rig of list.slice(2)) {
    assert.ok(isCaptureCameraId(rig.id));
    assert.deepEqual(rig.position, [3, 6, 9]);
    // `near` is the placement-wide constant, not a group field (§3.1.1).
    assert.equal(rig.near, DEFAULT_TEMPLATE.near);
    assert.equal(rig.far, 45);
    assert.equal(rig.fov, 90);
    assert.equal(rig.aspect, 1);
  }
});

test('buildStepSpec counts the rig bits only', () => {
  const spec = buildStepSpec(3, NO_FILTER);
  const mask = spec.cameras!;
  const bit = (i: number) => (mask[i >>> 5] >>> (i & 31)) & 1;
  for (let i = 0; i < 3; i++) assert.equal(bit(i), 0, `scene camera ${i} must not count`);
  for (let i = 3; i < 3 + CAPTURE_SLOTS; i++) assert.equal(bit(i), 1, `rig slot ${i} must count`);
});

test('buildStepSpec carries the display descriptor\'s marked filter, not a rebuilt one', () => {
  const marked: MarkedFilter = {
    regions: [
      { center: [0, 0, 0], rotation: IDENTITY, halfSize: [2, 2, 2], groups: [0] },
      { center: [9, 0, 0], rotation: IDENTITY, halfSize: [1, 1, 1], groups: [1] },
    ],
    maskRegions: [0],
  };
  const spec = buildStepSpec(2, marked);
  // Handed over by reference: the two descriptors cannot disagree about what
  // "counted" means (§3.3).
  assert.equal(spec.regions, marked.regions);
  assert.deepEqual(spec.leafCounts!.maskRegions, [0]);
});

test('buildStepSpec omits the filter when there are no regions to name', () => {
  // The SDK rejects `maskRegions` on a descriptor declaring no regions (§19.6).
  const spec = buildStepSpec(2, NO_FILTER);
  assert.deepEqual(spec.leafCounts!.maskRegions, []);
});

// --- Failure vs. rejection (§4.2) -------------------------------------------

test('a build step that never ran is a failure, not a rejection', () => {
  // The regression this function exists for: `engine.compute` reports failure by
  // returning null rather than throwing, and a failed run yields no chunks — so
  // "no chunks" alone cannot mean "this position saw nothing". Conflating them
  // made a broken engine look like the rejection rule firing on every draw,
  // leaving the session holding the capture slots with no error raised.
  assert.equal(classifyBuildStep(false, 0), 'failed');
  assert.equal(classifyBuildStep(false, 500), 'failed');
  assert.equal(classifyBuildStep(true, 0), 'rejected');
  assert.equal(classifyBuildStep(true, 1), 'kept');
});

test('poolBlocker refuses a build step before the engine has a scene, first of all', () => {
  // A build step is the one entry point that bypasses the app's Run gate, so it
  // needs its own readiness check — and it comes first, because every other
  // blocker's message would be misleading while the engine holds no scene.
  const scene = [camera('cam-1')];
  assert.match(poolBlocker(scene, group(), [rail()], { engineReady: false })!, /finish loading/);
  assert.match(
    poolBlocker(scene, null, [], { engineReady: false, samplingPending: true })!,
    /finish loading/,
  );
  // Omitted or true ⇒ no opinion, so existing callers are unaffected.
  assert.equal(poolBlocker(scene, group(), [rail()], { engineReady: true }), null);
  assert.equal(poolBlocker(scene, group(), [rail()]), null);
});

// --- Repositioning a bound camera (§4.6) -------------------------------------

test('a reposition moves to the highest-count position, ties going to the earlier draw', () => {
  // §4.6: "moves the camera to the highest-`count` position — a `maxCount = 1`
  // search, which needs no trials at all because a one-camera layout's score is
  // just that position's own `count`."
  const at = (x: number, count: number) => ({ position: [x, 0, 0] as Vec3, count });
  assert.deepEqual(bestSample([at(0, 3), at(1, 9), at(2, 4)]), at(1, 9));

  // A tie keeps the earlier draw, so a re-run on an unchanged scene does not
  // shuffle the camera between two equally good positions.
  assert.deepEqual(bestSample([at(0, 5), at(1, 5)]), at(0, 5));

  // Positions that saw nothing are not candidates, and an all-blind constraint
  // yields no move at all rather than a blind one.
  assert.deepEqual(bestSample([at(0, 0), at(1, 7), at(2, 0)]), at(1, 7));
  assert.equal(bestSample([at(0, 0), at(1, 0)]), null);
  assert.equal(bestSample([]), null);
});

test('reposition is blocked by its own two rules, then by every §10 pool rule', () => {
  const c = rail('con-1');
  const g = group();
  const bound: SceneCamera = { ...camera('cam-1'), constraintId: 'con-1' };

  assert.equal(repositionBlocker(bound, [bound], [c], [g]), null);

  // Its own two rules first.
  assert.equal(
    repositionBlocker(camera('cam-1'), [bound], [c], [g]),
    'Bind this camera to a constraint first.',
  );
  assert.equal(
    repositionBlocker({ ...bound, constraintId: 'con-gone' }, [bound], [c], [g]),
    "This camera's constraint no longer exists.",
  );

  // Then §10's, inherited whole: a reposition is a build step of one constraint.
  assert.equal(
    repositionBlocker(bound, [bound], [c], [g], { engineReady: false }),
    'Wait for the engine to finish loading the scene.',
  );
  assert.equal(
    repositionBlocker(bound, [bound], [c], [g], { aimSessionOpen: true }),
    'Close the aim optimizer before placing cameras.',
  );
  assert.equal(
    repositionBlocker(bound, [bound], [c], [g], { samplingPending: true }),
    'Run coverage once to apply the sampling change, then build the candidate positions.',
  );
  const full = Array.from({ length: MAX_CAMERAS - CAPTURE_SLOTS + 1 }, (_, i) => camera(`cam-${i}`));
  assert.match(repositionBlocker(bound, full, [c], [g]) ?? '', /spare camera slots/);
});

test('a lone constraint takes the whole pool budget, so a reposition samples poolSize positions', () => {
  // §4.6: "its `poolSize` share scaled up to the group's `poolSize`, since it is
  // the only constraint being sampled."
  const g = group({ poolSize: 40 });
  assert.equal(planDraws(g, basisFor([rail('con-1')], [], g)).length, 40);
});


// --- The mount filter and the effective measure (§4.1.1) ---------------------

/** An axis-aligned target volume; `zoneId` is what `volumesOfZones` matches on. */
function box(zoneId: string, position: Vec3, size: Vec3): SamplingVolume {
  return { id: `v-${zoneId}-${position.join('_')}`, zoneId, position, rotation: IDENTITY, size };
}

/** A box covering the rail's first 6 m of its 60 m run — a 10% overlap. */
const RAIL_TIP: SamplingVolume = box('zone-1', [0, 5, 3], [2, 2, 6]);
/** A box swallowing everything the fixtures place. */
const EVERYTHING: SamplingVolume = box('zone-1', [0, 5, 30], [400, 400, 400]);

test('overlapFraction estimates a constraint by running its own draw (§4.1.1)', () => {
  const g = group();
  // Wholly inside ⇒ 1, wholly outside ⇒ 0, and no volumes at all ⇒ 0.
  assert.equal(overlapFraction(rail(), g.seed, [EVERYTHING]), 1);
  assert.equal(overlapFraction(rail(), g.seed, [box('zone-1', [500, 5, 0], [2, 2, 2])]), 0);
  assert.equal(overlapFraction(rail(), g.seed, []), 0);
  // A 6 m window on a 60 m rail is ~10% of its arc length, and the estimate is a
  // measurement of the sampler rather than of the primitive, so it lands near it.
  const tip = overlapFraction(rail(), g.seed, [RAIL_TIP]);
  assert.ok(tip > 0.03 && tip < 0.2, `expected ~0.1, got ${tip}`);
});

test('overlapFraction honours `distance`, which a primitive-only estimator would not', () => {
  // The rail sits at z ∈ [0, 60] on the line x = 0. This box is 1 m to the side
  // of it and never touches the primitive — but `distance = 2` reaches in, so
  // real draws land inside and the constraint is genuinely usable.
  const beside = box('zone-1', [1.4, 5, 30], [1.2, 4, 60]);
  assert.equal(overlapFraction(rail('con-rail', 0), 1, [beside]), 0);
  assert.ok(overlapFraction(rail('con-rail', 2), 1, [beside]) > 0);
});

test('overlapFraction is deterministic under `seed` and moves with it', () => {
  const a = overlapFraction(rail(), 1, [RAIL_TIP]);
  assert.equal(overlapFraction(rail(), 1, [RAIL_TIP]), a);
  // A different seed is a different sub-sequence, so the estimate is a different
  // sample of the same quantity — close, but not the same number.
  assert.notEqual(overlapFraction(rail(), 99, [RAIL_TIP]), a);
  assert.ok(Math.abs(overlapFraction(rail(), 99, [RAIL_TIP]) - a) < 0.15);
});

test('drawBasis without a mount filter is the pre-feature behaviour exactly', () => {
  const cs = [post(), rail(), wall()];
  const basis = drawBasis(group(), cs, []);
  assert.deepEqual(basis.constraints.map((c) => c.id), cs.map((c) => c.id));
  assert.deepEqual(basis.weights, [1, 60, 2400]);
  assert.deepEqual(basis.overlaps, []);
  assert.deepEqual(poolSplit(basis, 200), poolSplit(basisFor(cs), 200));
});

test('the effective-measure split moves the pool from the wall to the rail (§4.1.1)', () => {
  // The wall spans x,z ∈ [-30, 30]; this box keeps a 6 m strip of it, ~10% of the
  // area, while swallowing the whole 60 m rail and the post.
  const strip = box('zone-1', [0, 5, 30], [6, 6, 400]);
  const cs = [post(), rail(), wall()];
  const g = group();

  // Unfiltered, the wall's 2400 m² claims 194 of 200 (the spec's worked example).
  assert.deepEqual(poolSplit(basisFor(cs), 200), [1, 5, 194]);

  const basis = drawBasis(g, cs, [strip]);
  const shares = poolSplit(basis, 200);
  assert.equal(shares.reduce((a, b) => a + b, 0), 200);
  // Every constraint survives — the wall keeps a plurality, since a tenth of
  // 2400 m² is still forty times the rail's 60 m. What changes is the *ratio*:
  // the wall is now weighted by its usable area, so the rail takes back an order
  // of magnitude of the pool it was starved of. Asserting the shift rather than
  // an absolute share is the point — the absolute number is just arithmetic on
  // the fixture, while the shift is the behaviour the filter exists to produce.
  assert.equal(basis.constraints.length, 3);
  const wallShare = shares[basis.constraints.findIndex((c) => c.id === 'con-wall')];
  const railShare = shares[basis.constraints.findIndex((c) => c.id === 'con-rail')];
  const before = 194 / 5;
  const after = wallShare / railShare;
  assert.ok(wallShare < 194, `wall kept ${wallShare}, no better than unfiltered`);
  assert.ok(railShare > 5, `rail kept only ${railShare}`);
  assert.ok(after < before / 5, `wall:rail went ${before.toFixed(1)} → ${after.toFixed(1)}`);
});

test('a zero-overlap constraint is dropped and its floor redistributed (§4.1.1)', () => {
  const far = rail('con-far');
  // Only the post is inside; the rail is 500 m away in x.
  const onlyPost = box('zone-1', [0, 5, 0], [1, 1, 1]);
  const cs = [post(), { ...far, points: [[500, 5, 0], [500, 5, 60]] } as CameraConstraint];
  const basis = drawBasis(group(), cs, [onlyPost]);

  assert.deepEqual(basis.constraints.map((c) => c.id), ['con-post']);
  // The dropped one is still *reported*, at 0% — that is the §5.1 readout's whole
  // job, and the difference between "the tool is broken" and "my rail isn't in
  // the zone".
  assert.equal(basis.overlaps.length, 2);
  assert.equal(basis.overlaps.find((o) => o.constraintId === 'con-far')!.fraction, 0);
  // It takes no floor of 1: the shares still sum to `poolSize`.
  const shares = poolSplit(basis, 200);
  assert.equal(shares.reduce((a, b) => a + b, 0), 200);
});

test('every drawn position satisfies inRegion *and* the mount filter (§4.1.1)', () => {
  const strip = box('zone-1', [0, 5, 45], [80, 8, 30]);
  const cs = [rail(), wall()];
  const g = group({ poolSize: 40 });
  const basis = drawBasis(g, cs, [strip]);
  const draws = planDraws(g, basis, {
    weights: basis.weights,
    mountVolumes: basis.mountVolumes,
  });
  assert.ok(draws.length > 0);
  for (const d of draws) {
    const c = cs.find((x) => x.id === d.constraintId)!;
    assert.ok(inRegion(d.position, c), `${d.constraintId}#${d.seqIndex} left its region`);
    // The OBB test the mount filter runs, restated rather than imported, so a
    // sign flip in `inVolume` could not make this pass by agreeing with itself.
    const local = [d.position[0] - strip.position[0], d.position[1] - strip.position[1], d.position[2] - strip.position[2]];
    assert.ok(
      Math.abs(local[0]) <= strip.size[0] / 2 &&
        Math.abs(local[1]) <= strip.size[1] / 2 &&
        Math.abs(local[2]) <= strip.size[2] / 2,
      `${d.constraintId}#${d.seqIndex} landed outside the target zone`,
    );
  }
});

test('the mount filter preserves prefix-stability, so Extend still works (§3.3.1)', () => {
  const strip = box('zone-1', [0, 5, 45], [80, 8, 30]);
  const cs = [rail(), wall()];
  const small = group({ poolSize: 20 });
  const big = group({ poolSize: 60 });
  const basisS = drawBasis(small, cs, [strip]);
  const basisB = drawBasis(big, cs, [strip]);
  // The estimate does not depend on `poolSize`, so both plan against the same
  // weights — which is what makes the prefix claim meaningful at all.
  assert.deepEqual(basisS.weights, basisB.weights);

  const key = (d: { constraintId: string; seqIndex: number }) => `${d.constraintId}#${d.seqIndex}`;
  const drawsS = planDraws(small, basisS);
  const drawsB = planDraws(big, basisB);
  // Per constraint, the small pool's kept draws are a verbatim prefix of the big
  // one's: rejection sampling skips the same indices in the same order.
  for (const c of cs) {
    const a = drawsS.filter((d) => d.constraintId === c.id).map(key);
    const b = drawsB.filter((d) => d.constraintId === c.id).map(key);
    assert.deepEqual(b.slice(0, a.length), a, `${c.id} reshuffled between pool sizes`);
  }
});

test('replacementDraw skips out-of-zone draws without spending the GPU budget (§4.1.1)', () => {
  const g = group();
  const r = rail();
  const tip = box('zone-1', [0, 5, 3], [2, 2, 6]);
  // Unfiltered, the replacement is the very next sequence index.
  assert.equal(replacementDraw(g, r, 5, 10, soloBasis(r))!.seqIndex, 5);
  // Filtered, it is the next index that *passes* — later, and still inside.
  const next = replacementDraw(g, r, 5, 10, soloBasis(r, [tip]))!;
  assert.ok(next.seqIndex >= 5);
  assert.ok(next.position[2] >= 0 && next.position[2] <= 6);
  // The GPU cap is still the authority: past `share × REJECT_ATTEMPT_FACTOR`
  // there is no replacement, filter or no filter.
  assert.equal(replacementDraw(g, r, 10 * REJECT_ATTEMPT_FACTOR, 10, soloBasis(r, [tip])), null);
});

test('targetRevision is order-insensitive and follows the listed volumes (§3.3.1)', () => {
  const vols = [box('zone-1', [0, 5, 0], [2, 2, 2]), box('zone-2', [9, 5, 0], [2, 2, 2])];
  // `zoneIds` is a set: a reorder must not discard minutes of GPU.
  assert.equal(targetRevision(['zone-1', 'zone-2'], vols), targetRevision(['zone-2', 'zone-1'], vols));
  // An unlisted zone's volume moving changes nothing...
  const movedOther = [vols[0], { ...vols[1], position: [99, 5, 0] as Vec3 }];
  assert.equal(targetRevision(['zone-1'], vols), targetRevision(['zone-1'], movedOther));
  // ...while a listed one's does, because every cached set was filtered by it.
  const movedListed = [{ ...vols[0], position: [99, 5, 0] as Vec3 }, vols[1]];
  assert.notEqual(targetRevision(['zone-1'], vols), targetRevision(['zone-1'], movedListed));
  // No target ⇒ no contribution, which is what leaves an untargeted group on the
  // app's own marked revision.
  assert.equal(targetRevision([], vols), '');
});

test('overlapSummary reports a percentage per constraint, not a discard count (§5.1)', () => {
  // The line the Build card and the group card both show. It is a function of the
  // *estimate*, not of a pool, which is what puts it on screen before Build.
  const cs = [rail('con-rail'), wall('con-wall')];
  const text = overlapSummary(
    [
      { constraintId: 'con-rail', fraction: 1 },
      { constraintId: 'con-wall', fraction: 0.04 },
    ],
    cs,
  )!;
  assert.match(text, /100%/);
  assert.match(text, /4%/);
  assert.match(text, /con-rail|Rail|Polyline/i, 'the constraint is named, not just numbered');
  assert.equal(overlapSummary([], cs), null, 'no mount filter, no line');

  // A zero is *listed*, never dropped: §4.1.1's whole remedy is seeing `0%` beside
  // a `4%`.
  assert.match(overlapSummary([{ constraintId: 'con-wall', fraction: 0 }], cs)!, /0%/);
});

test('poolSummary carries §10’s empty-pool line, and leaves the percentages to overlapSummary', () => {
  const cs = [rail('con-rail'), wall('con-wall')];
  const pool = {
    ...emptyPool('cg-1', 'fp', 200, 1),
    markedTotal: 1000,
    poolCeiling: 500,
    overlaps: [
      { constraintId: 'con-rail', fraction: 1 },
      { constraintId: 'con-wall', fraction: 0.04 },
    ],
  };
  const text = poolSummary(pool, cs);
  assert.doesNotMatch(text, /100%/, 'the percentages are the card’s own line, shown before Build too');
  assert.doesNotMatch(text, /overlaps this group's target zones/);

  // Every constraint at zero is the §10 "warn but allow" case: Build ran, the
  // pool is empty, and the readout says exactly why.
  const none = poolSummary(
    { ...pool, overlaps: pool.overlaps.map((o) => ({ ...o, fraction: 0 })) },
    cs,
  );
  assert.match(none, /No constraint overlaps this group's target zones/);
});

test('OVERLAP_SAMPLES is large enough to resolve a 1% overlap (§4.1.1)', () => {
  // The §4.1.1 claim the zero-drop rule rests on: a dropped constraint had well
  // under ~1% usable extent. At 256 draws a 1% overlap is ~2.5 expected hits.
  assert.ok(OVERLAP_SAMPLES >= 256);
});
