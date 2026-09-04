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
  REJECT_ATTEMPT_FACTOR,
} from '../src/placement/pool.ts';
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

// --- The split (§4.1) --------------------------------------------------------

test('poolSplit matches the worked example in §4.1', () => {
  // The spec's own table: weights 1 : 60 : 2400 at poolSize 200 give 1 : 5 : 194.
  // Rounding (not truncating) is what earns the rail its fifth position, and the
  // overshoot the post's floor-of-1 creates comes off the wall — the largest
  // weight — not off the rail.
  assert.deepEqual(poolSplit([post(), rail(), wall()], 200), [1, 5, 194]);
});

test('poolSplit weights by primitive measure and sums to poolSize', () => {
  const shares = poolSplit([post(), rail(), wall()], 200);
  // Weights 1 : 60 : 2400 — the wall takes almost all of it.
  assert.equal(shares.reduce((a, b) => a + b, 0), 200);
  assert.ok(shares[2] > shares[1] && shares[1] > shares[0]);
  assert.equal(shares[0], 1);
});

test('poolSplit floors every enabled constraint at 1, so a lone post is never starved', () => {
  // A post against a wall 2400× its measure would round to zero without the floor.
  const shares = poolSplit([post(), wall()], 50);
  assert.equal(shares[0], 1);
  assert.equal(shares.reduce((a, b) => a + b, 0), 50);
});

test('poolSplit gives one each when there are more constraints than positions', () => {
  const shares = poolSplit([post('a'), post('b'), post('c')], 2);
  assert.deepEqual(shares, [1, 1, 1]);
});

test('poolSplit shares evenly when nothing has a measure', () => {
  const shares = poolSplit([post('a'), post('b'), post('c'), post('d')], 20);
  assert.deepEqual(shares, [5, 5, 5, 5]);
});

test('poolSplit ignores distance — the split cannot collapse when d is 0', () => {
  const pinned = poolSplit([rail('r', 0), wall('w', 0)], 100);
  const loose = poolSplit([rail('r', 2), wall('w', 2)], 100);
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
  const a = planDraws(g200, cs);
  const b = planDraws(g260, cs);
  assert.equal(a.length, 200);
  assert.equal(b.length, 260);

  // Every position of the smaller pool appears in the larger one, unchanged.
  const key = (d: { constraintId: string; seqIndex: number; position: Vec3 }) =>
    `${d.constraintId}#${d.seqIndex}@${d.position.join(',')}`;
  const larger = new Set(b.map(key));
  for (const d of a) assert.ok(larger.has(key(d)), `lost ${key(d)}`);
});

test('an extension draws only what is new', () => {
  const cs = [post(), rail(), wall()];
  const shares = poolSplit(cs, 200);
  const held = new Map(cs.map((c, i) => [c.id, { kept: shares[i], nextSeq: shares[i] }]));
  const extra = planDraws(group({ poolSize: 260 }), cs, { held });
  assert.equal(extra.length, 60);
  // Nothing already built is redrawn.
  for (const d of extra) assert.ok(d.seqIndex >= (held.get(d.constraintId)?.nextSeq ?? 0));

  // And the kept prefix is bit-identical to what a full build step would have
  // produced — the whole basis for reusing it (§3.3.1).
  const full = planDraws(group({ poolSize: 260 }), cs);
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
  const shares = poolSplit(cs, 200);
  const held = new Map(
    cs.map((c, i) => [
      c.id,
      { kept: shares[i], nextSeq: shares[i] + (c.id === 'con-rail' ? 5 : 0) },
    ]),
  );
  const extra = planDraws(group({ poolSize: 260 }), cs, { held });
  assert.equal(extra.length, 60, 'the extension is still 60 positions, rejections or not');
  const railDraws = extra.filter((d) => d.constraintId === 'con-rail');
  const railHeld = held.get('con-rail')!;
  assert.equal(railDraws.length, poolSplit(cs, 260)[1] - railHeld.kept);
  for (const d of railDraws) {
    assert.ok(d.seqIndex >= railHeld.nextSeq, 'a rejected draw must never be planned again');
  }
});

test('a truncation builds nothing and keeps each constraint its first share', () => {
  const cs = [post(), rail(), wall()];
  const shares260 = poolSplit(cs, 260);
  const held = new Map(cs.map((c, i) => [c.id, { kept: shares260[i], nextSeq: shares260[i] }]));
  // Lowering the size: every share is already met or exceeded, so nothing is drawn.
  assert.equal(planDraws(group({ poolSize: 120 }), cs, { held }).length, 0);

  const keep = truncatedShares(group({ poolSize: 120 }), cs);
  assert.equal([...keep.values()].reduce((a, b) => a + b, 0), 120);
  cs.forEach((c, i) => assert.ok((keep.get(c.id) ?? 0) <= shares260[i]));
});

test('a moved fingerprint plans every draw again, whichever way the size went', () => {
  // `planDraws` is told nothing about fingerprints — the session drops `held`
  // entirely when one moves (§3.3.1), so both directions replan in full.
  const cs = [post(), rail(), wall()];
  assert.equal(planDraws(group({ poolSize: 260 }), cs).length, 260);
  assert.equal(planDraws(group({ poolSize: 120 }), cs).length, 120);
});

test('each constraint has its own sub-sequence, so editing one leaves the others alone', () => {
  const g = group({ poolSize: 90 });
  const before = planDraws(g, [post('p'), rail('r'), wall('w')]);
  // Reshape the wall: same ids elsewhere, so the rail and post must not move.
  const after = planDraws(g, [post('p'), rail('r'), wall('w', 0.3, [90, 40])]);
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
  const at = replacementDraw(g, c, share, share);
  assert.ok(at !== null);
  assert.equal(at!.seqIndex, share);
  // Spending the whole budget terminates the constraint rather than looping.
  assert.equal(replacementDraw(g, c, share * REJECT_ATTEMPT_FACTOR, share), null);
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
    const draw = replacementDraw(g, buried, spent, share);
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
  assert.equal(planDraws(g, [rail('con-1')]).length, 40);
});
