/**
 * The placement session's contract with the engine (`camera_placement.md` §3.4,
 * §2.1, §13).
 *
 * What is pinned here is the part a unit test can reach without a GPU: that the
 * build-step descriptor is one the SDK actually accepts, that the six shared
 * capture slots are accounted for, and that a build step never mutates a scene
 * entity — a session's whole promise is that Discard is exact (§5.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CAMERAS, validateAggregateSpec, type Quat } from '@linkervision/camera-coverage-sdk';
import { buildStepCameras, buildStepSpec, poolBlocker, rigCameraMask } from '../src/placement/pool.ts';
import { CAPTURE_SLOTS, captureCameraId } from '../src/optimize/cubeRig.ts';
import { displayCameraMask, sessionBlocker } from '../src/optimize/session.ts';
import type { CameraConstraint, ConstraintGroup } from '../src/placement/region.ts';
import type { SceneCamera } from '../src/cameras/camera.ts';
import type { MarkedFilter } from '../src/scene/aggregateSpec.ts';

const IDENTITY: Quat = [0, 0, 0, 1];

function camera(id: string): SceneCamera {
  return {
    id,
    name: '',
    enabled: true,
    position: [1, 2, 3],
    rotation: IDENTITY,
    fov: 60,
    far: 30,
  };
}

function group(over: Partial<ConstraintGroup> = {}): ConstraintGroup {
  return {
    id: 'cg-1',
    name: 'Dock',
    enabled: true,
    fov: 60,
    far: 30,
    namePrefix: '',
    poolSize: 20,
    maxCount: 4,
    trials: 10,
    epsilon: 1,
    seed: 1,
    ...over,
  };
}

const rail: CameraConstraint = {
  id: 'con-1',
  groupId: 'cg-1',
  name: 'Rail',
  enabled: true,
  distance: 0.4,
  kind: 'polyline',
  points: [
    [0, 5, 0],
    [0, 5, 10],
  ],
};

const marked: MarkedFilter = {
  regions: [{ center: [0, 0, 0], rotation: IDENTITY, halfSize: [4, 2, 4], groups: [0] }],
  maskRegions: [0],
};

// --- The descriptor the SDK must accept (§2.1, SDK §19.6) --------------------

test('the build-step descriptor passes the SDK\'s own validation, as built', () => {
  const scene = [camera('cam-1'), camera('cam-2')];
  const spec = buildStepSpec(scene.length, marked);
  // Validated against the *session* camera count, which is what the engine will
  // hold during a build step — the `cameras` mask is CAM_WORDS-sized for that list.
  validateAggregateSpec(spec, scene.length + CAPTURE_SLOTS);
});

test('the build-step descriptor is accepted with no marked filter at all', () => {
  // A scene not using zones declares no regions, and the SDK rejects a
  // `maskRegions` filter on a descriptor that declares none (SDK §19.6).
  const spec = buildStepSpec(2, { regions: [], maskRegions: [] });
  validateAggregateSpec(spec, 2 + CAPTURE_SLOTS);
});

test('the rig mask names exactly the six slots, and no scene camera', () => {
  const mask = rigCameraMask(40);
  const bit = (i: number) => (mask[i >>> 5] >>> (i & 31)) & 1;
  for (let i = 0; i < 40; i++) assert.equal(bit(i), 0, `scene camera ${i}`);
  for (let i = 40; i < 40 + CAPTURE_SLOTS; i++) assert.equal(bit(i), 1, `slot ${i}`);
  // Spanning a word boundary is the case a single-word mask would get wrong.
  assert.ok(mask.length >= 2);
});

// --- The shared slots (§3.4) -------------------------------------------------

test('placement needs the same six spare slots the aim optimizer does', () => {
  const almostFull = Array.from({ length: MAX_CAMERAS - CAPTURE_SLOTS }, (_, i) => camera(`cam-${i}`));
  assert.equal(poolBlocker(almostFull, group(), [rail]), null);
  assert.equal(sessionBlocker(almostFull), null);

  const full = [...almostFull, camera('one-more')];
  assert.match(poolBlocker(full, group(), [rail])!, /6 spare camera slots/);
  assert.match(sessionBlocker(full)!, /6 spare camera slots/);
});

test('the two sessions are mutually exclusive — they claim the same slot ids', () => {
  // Sharing the ids is deliberate (§3.4): a feature with its own six would
  // double every scene's spare-slot requirement for two tools nobody runs at
  // once. The exclusion is what makes that safe.
  const scene = [camera('cam-1')];
  assert.match(poolBlocker(scene, group(), [rail], { aimSessionOpen: true })!, /aim optimizer/);
  const rigIds = buildStepCameras(scene, group(), [0, 0, 0])
    .slice(scene.length)
    .map((c) => c.id);
  assert.deepEqual(rigIds, [0, 1, 2, 3, 4, 5].map(captureCameraId));
});

test('a pending sampling edit blocks a build step, which inherits the validity mask', () => {
  assert.match(
    poolBlocker([camera('cam-1')], group(), [rail], { samplingPending: true })!,
    /Run coverage once/,
  );
});

// --- A build step is non-destructive (§5.3) ------------------------------------

test('building the build-step camera list never mutates a scene camera', () => {
  const scene = [camera('cam-1'), camera('cam-2')];
  const before = JSON.parse(JSON.stringify(scene));
  buildStepCameras(scene, group({ far: 60 }), [7, 8, 9]);
  assert.deepEqual(JSON.parse(JSON.stringify(scene)), before);
});

test('the scene cameras keep their ids and order, so a build step stays incremental', () => {
  // SDK §13.1 declines incremental recompute when the ordered camera *ids*
  // change, so only the six slots may move between build steps (§2.1).
  const scene = [camera('cam-1'), camera('cam-2'), camera('cam-3')];
  const a = buildStepCameras(scene, group(), [0, 0, 0]).map((c) => c.id);
  const b = buildStepCameras(scene, group(), [50, 0, 0]).map((c) => c.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a.slice(0, 3), ['cam-1', 'cam-2', 'cam-3']);
});

test('the display mask hides the slots while either session holds them', () => {
  const scene = [camera('cam-1'), camera('cam-2')];
  const mask = displayCameraMask(scene, true)!;
  const bit = (i: number) => (mask[i >>> 5] >>> (i & 31)) & 1;
  assert.equal(bit(0), 1);
  assert.equal(bit(1), 1);
  for (let i = 2; i < 2 + CAPTURE_SLOTS; i++) assert.equal(bit(i), 0, `slot ${i} must not count`);
  // No session open ⇒ no filter at all, so the descriptor stays as the scene built it.
  assert.equal(displayCameraMask(scene, false), undefined);
});
