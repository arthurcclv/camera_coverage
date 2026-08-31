/**
 * `aim_optimization.md` §8 — the session's contract with the engine (§3.1).
 *
 * These are the rules that, when broken, produce a *plausible wrong number*
 * rather than a crash: a capture slot leaking into a zone's coverage, or the
 * optimized camera counting itself as one of the "others".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CAMERAS, camWords, packAggregate, validateAggregateSpec } from '@linkervision/camera-coverage-sdk';
import type { Quat } from '@linkervision/camera-coverage-sdk';

import type { SceneCamera } from '../src/cameras/camera.ts';
import type { MarkedFilter } from '../src/scene/aggregateSpec.ts';
import { eulerToQuat } from '../src/cameras/math.ts';
import { CAPTURE_SLOTS, captureCameraId, isCaptureCameraId } from '../src/optimize/cubeRig.ts';
import {
  captureSpec,
  displayCameraMask,
  isOptimizable,
  realCameraMask,
  sessionBlocker,
  sessionCameras,
} from '../src/optimize/session.ts';
import { REDUNDANCY_EXPONENT, blindWeights, scoreWeights, SCORE_SCALE } from '../src/optimize/weights.ts';

function makeCamera(id: string, over: Partial<SceneCamera> = {}): SceneCamera {
  return {
    id,
    name: '',
    enabled: true,
    position: [1, 2, 3],
    rotation: eulerToQuat({ yaw: 0, pitch: -20, roll: 0 }),
    fov: 60,
    aspect: 16 / 9,
    near: 0.1,
    far: 20,
    ...over,
  };
}

const NONE = new Map<string, Quat>();
/** No zones in use: the marked filter is empty, which the SDK reads as "all". */
const NO_FILTER: MarkedFilter = { regions: [], maskRegions: [] };
/** One rotated volume, marked — the shape `sampling_volumes.md` §7.1 samples conservatively. */
const ONE_ZONE: MarkedFilter = {
  regions: [{ center: [2, 1, 2], rotation: eulerToQuat({ yaw: 30, pitch: 0, roll: 0 }), halfSize: [1, 1, 2], groups: [0] }],
  maskRegions: [0],
};

test('§3.1: the session appends exactly six slots and leaves the scene list alone', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2')];
  const list = sessionCameras(cams, NONE, cams[0]);
  assert.equal(list.length, cams.length + CAPTURE_SLOTS);
  assert.deepEqual(list.slice(0, 2).map((c) => c.id), ['cam-1', 'cam-2']);
  for (let f = 0; f < CAPTURE_SLOTS; f++) {
    const slot = list[cams.length + f];
    assert.equal(slot.id, captureCameraId(f));
    assert.ok(isCaptureCameraId(slot.id));
    // A rig shares its mount's position and range: the reachable set it captures
    // must be the one the optimized camera will be scored over (§2.1).
    assert.deepEqual(slot.position, cams[0].position);
    assert.equal(slot.far, cams[0].far);
    assert.equal(slot.fov, 90);
    assert.equal(slot.aspect, 1);
  }
});

test('§3.1: the scene cameras keep their identity so incremental recompute survives', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2'), makeCamera('cam-3')];
  const a = sessionCameras(cams, NONE, cams[0]);
  const b = sessionCameras(cams, NONE, cams[2]);
  assert.equal(a.length, b.length, 'the list length changed between captures');
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id), 'ids or order changed between captures');
});

test('§3.1: an override reaches the engine without touching the scene entity', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2')];
  const moved = eulerToQuat({ yaw: 123, pitch: -5, roll: 0 });
  const list = sessionCameras(cams, new Map([['cam-2', moved]]), cams[0]);
  assert.deepEqual(list[1].rotation, moved);
  assert.deepEqual(cams[1].rotation, makeCamera('cam-2').rotation, 'the scene entity was mutated');
});

test('§2.2: the capture mask excludes the slots and the camera being optimized', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2'), makeCamera('cam-3', { enabled: false })];
  const spec = captureSpec(cams, NONE, cams[0], NO_FILTER);
  const total = cams.length + CAPTURE_SLOTS;
  assert.equal(spec.cameras!.length, camWords(total));

  const bit = (i: number) => (spec.cameras![i >>> 5] >>> (i & 31)) & 1;
  assert.equal(bit(0), 0, 'the optimized camera counted itself among the others');
  assert.equal(bit(1), 1, 'another enabled camera was dropped from n_others');
  assert.equal(bit(2), 0, 'a disabled camera was counted');
  for (let f = 0; f < CAPTURE_SLOTS; f++) {
    assert.equal(bit(cams.length + f), 0, `capture slot ${f} was counted in n_others`);
  }
});

test('§2.2: the capture declares one projection per slot, and the SDK accepts it', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2')];
  const spec = captureSpec(cams, NONE, cams[0], NO_FILTER);
  const total = cams.length + CAPTURE_SLOTS;

  assert.equal(spec.projections!.length, CAPTURE_SLOTS);
  spec.projections!.forEach((p, f) => {
    assert.equal(p.camera, cams.length + f, 'a projection named the wrong camera bit');
    assert.equal(p.viewProj.length, 16);
    assert.equal(p.weights.length, 2, 'score and blind planes');
    assert.equal(p.weights[0].length, total + 1, 'weight tables must be numCameras + 1 long');
  });
  // The descriptor has to pass the SDK's own §19.6 validation as built.
  validateAggregateSpec(spec, total);
  const packed = packAggregate(spec);
  assert.equal(packed.projectionCount, CAPTURE_SLOTS);
  assert.equal(
    packed.projectionBins,
    CAPTURE_SLOTS * 2 * spec.projections![0].resolution ** 2,
  );
});

test('§3.1: the display mask hides the slots and nothing else', () => {
  const cams = [makeCamera('cam-1'), makeCamera('cam-2', { enabled: false })];
  assert.equal(displayCameraMask(cams, false), undefined, 'a closed session must not filter');

  const mask = displayCameraMask(cams, true)!;
  assert.equal(mask.length, camWords(cams.length + CAPTURE_SLOTS));
  assert.equal(mask[0] & 1, 1, 'an enabled scene camera was hidden');
  assert.equal((mask[0] >>> 1) & 1, 0, 'a disabled camera should contribute nothing');
  for (let f = 0; f < CAPTURE_SLOTS; f++) {
    assert.equal((mask[0] >>> (cams.length + f)) & 1, 0, `capture slot ${f} leaked into the display`);
  }
});

test('§3.1: the slot budget and the "nothing to optimize" case are reported, not thrown', () => {
  const many = Array.from({ length: MAX_CAMERAS - CAPTURE_SLOTS }, (_, i) => makeCamera(`cam-${i}`));
  assert.equal(sessionBlocker(many), null, `${many.length} cameras should still fit`);

  const tooMany = [...many, makeCamera('cam-extra')];
  const blocked = sessionBlocker(tooMany);
  assert.match(blocked ?? '', /6 spare camera slots/);
  assert.match(blocked ?? '', new RegExp(`${tooMany.length} of ${MAX_CAMERAS}`));

  const allLocked = [makeCamera('cam-1', { aimLocked: true }), makeCamera('cam-2', { enabled: false })];
  assert.match(sessionBlocker(allLocked) ?? '', /No camera is available to optimize/);
});

test('§4.1, §4.5: only enabled and unlocked cameras are optimizable', () => {
  assert.equal(isOptimizable(makeCamera('a')), true);
  assert.equal(isOptimizable(makeCamera('a', { enabled: false })), false);
  assert.equal(isOptimizable(makeCamera('a', { aimLocked: true })), false);
});

test('§2.2: the weight tables encode 1/(n+1)^α and the blind indicator', () => {
  const score = scoreWeights(4);
  assert.equal(score.length, 5);
  assert.equal(score[0], SCORE_SCALE);
  for (let n = 0; n <= 4; n++) {
    // Read the exponent rather than hard-coding a ratio, so raising it is a
    // one-line change and not a test rewrite (§1.1).
    assert.equal(score[n], Math.round(SCORE_SCALE / Math.pow(n + 1, REDUNDANCY_EXPONENT)));
  }

  const blind = blindWeights(4);
  assert.deepEqual(Array.from(blind), [1, 0, 0, 0, 0]);

  // A bin cannot overflow u32 before it holds far more voxels than one can
  // plausibly hold: the worst case is ~72k (a 1.4° bin at 50 m, 0.1 m voxels,
  // whole depth column visible), and the ceiling is 262,144 (§2.2).
  assert.equal(SCORE_SCALE * 262_144, 2 ** 32);

  // Every entry is the harmonic increment `H(n+1) − H(n)` to within the fixed
  // point — the §1.2 identity that makes the greedy loop monotone in Φ. Asserted
  // on the *table the shader sums*, not on a re-derivation of H.
  const wide = scoreWeights(127, 1);
  for (let n = 0; n <= 127; n++) {
    const exact = 1 / (n + 1);
    assert.ok(
      Math.abs(wide[n] / SCORE_SCALE - exact) <= exact * 0.008 + 1 / SCORE_SCALE,
      `n = ${n}: table ${wide[n] / SCORE_SCALE} vs ${exact}`,
    );
  }
});

test('§3.1: only the mask is used to hide slots — realCameraMask never sees them', () => {
  const cams = [makeCamera('cam-1')];
  const mask = realCameraMask(cams, cams.length + CAPTURE_SLOTS);
  assert.equal(mask[0], 0b1);
});

test('§2.2: a capture scores the *counted* set, not the sampled one', () => {
  // The bug: `setSampling` bounds what is computed with the conservative AABBs of
  // the rotated volumes (`sampling_volumes.md` §7.1), and disabled zones stay in
  // that set. Only the marked filter says what is counted, so a capture that
  // omitted it optimized over AABB slop and over zones the user switched off.
  const cams = [makeCamera('cam-1'), makeCamera('cam-2')];
  const spec = captureSpec(cams, NONE, cams[0], ONE_ZONE);

  assert.deepEqual(spec.regions, ONE_ZONE.regions, 'the filter’s regions must ride along');
  for (const p of spec.projections!) {
    assert.deepEqual(p.maskRegions, ONE_ZONE.maskRegions, 'a projection ignored the marked filter');
  }
  // The SDK rejects a filter naming regions the descriptor does not declare, so
  // the two halves have to travel together (SDK spec §19.6).
  validateAggregateSpec(spec, cams.length + CAPTURE_SLOTS);
});

test('§2.2: no zones in use means no filter, which the SDK reads as "count everything"', () => {
  const cams = [makeCamera('cam-1')];
  const spec = captureSpec(cams, NONE, cams[0], NO_FILTER);
  assert.deepEqual(spec.regions, []);
  for (const p of spec.projections!) assert.deepEqual(p.maskRegions, []);
  validateAggregateSpec(spec, cams.length + CAPTURE_SLOTS);
});

test('§3.1: a pending sampling edit blocks a session, because a capture never calls setSampling', () => {
  const cams = [makeCamera('cam-1')];
  assert.equal(sessionBlocker(cams, false), null);
  assert.match(sessionBlocker(cams, true) ?? '', /Run coverage once to apply the sampling change/);
  // The slot budget still wins over it: that one cannot be fixed by running.
  const tooMany = Array.from({ length: MAX_CAMERAS }, (_, i) => makeCamera(`cam-${i}`));
  assert.match(sessionBlocker(tooMany, true) ?? '', /spare camera slots/);
});

test('§6.2: nothing-to-apply is a property of the accepted rotations, not the row count', () => {
  // The regression this pins: `Apply` was gated on a count derived from the
  // proposal rows, which disagreed with the session's accepted rotations exactly
  // when the greedy loop converged. The rule is that the gate reads the same
  // state Apply writes — `sessionCameras` is that state's only consumer, so an
  // override present here is by definition something to apply.
  const cams = [makeCamera('cam-1'), makeCamera('cam-2')];
  const moved = eulerToQuat({ yaw: 90, pitch: -10, roll: 0 });

  const none = sessionCameras(cams, NONE, null);
  assert.deepEqual(none.map((c) => c.rotation), cams.map((c) => c.rotation));

  const withOverride = sessionCameras(cams, new Map([['cam-2', moved]]), null);
  assert.deepEqual(withOverride[1].rotation, moved);
  assert.deepEqual(withOverride[0].rotation, cams[0].rotation, 'an unrelated camera moved');
});
