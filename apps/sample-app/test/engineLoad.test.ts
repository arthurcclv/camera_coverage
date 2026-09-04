import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineLoadAction } from '../src/engine/useEngine.ts';
import { poolBlocker } from '../src/placement/pool.ts';
import type { SceneCamera } from '../src/cameras/camera.ts';
import type { CameraConstraint, ConstraintGroup } from '../src/placement/region.ts';

const roomA = { id: 'A' };
const roomB = { id: 'B' };
const NOTHING_LOADED = { epoch: 1, room: null, voxelSize: null };

test('engineLoadAction: a fresh app starts a load (spec §8)', () => {
  assert.equal(engineLoadAction(NOTHING_LOADED, null, { epoch: 1, room: roomA, voxelSize: 0.5 }), 'start');
});

test('engineLoadAction: the pair the engine holds needs nothing (spec §8)', () => {
  assert.equal(
    engineLoadAction({ epoch: 1, room: roomA, voxelSize: 0.5 }, null, { epoch: 1, room: roomA, voxelSize: 0.5 }),
    'satisfied',
  );
});

test('engineLoadAction: a run in the same tick as the scene-load effect joins it (spec §8)', () => {
  // The single-flight guarantee: two `init` calls for one pair would be the
  // session's most expensive call, paid twice, over the same geometry.
  assert.equal(
    engineLoadAction(NOTHING_LOADED, { epoch: 1, room: roomA, voxelSize: 0.5 }, { epoch: 1, room: roomA, voxelSize: 0.5 }),
    'join',
  );
});

test('engineLoadAction: a differing voxel size or geometry never joins (spec §8, §6)', () => {
  assert.equal(
    engineLoadAction(NOTHING_LOADED, { epoch: 1, room: roomA, voxelSize: 0.5 }, { epoch: 1, room: roomA, voxelSize: 0.25 }),
    'start',
  );
  assert.equal(
    engineLoadAction(NOTHING_LOADED, { epoch: 1, room: roomA, voxelSize: 0.5 }, { epoch: 1, room: roomB, voxelSize: 0.5 }),
    'start',
  );
});

test('engineLoadAction: an import supersedes what the engine holds (spec §14.4)', () => {
  // `room` is compared by identity: a rebuilt geometry build is a new object, so a
  // voxel size that stayed the same cannot mask the swap.
  assert.equal(
    engineLoadAction({ epoch: 1, room: roomA, voxelSize: 0.5 }, null, { epoch: 1, room: roomB, voxelSize: 0.5 }),
    'start',
  );
});

test('engineLoadAction: a replaced worker never joins the terminated one (spec §8)', () => {
  // The `Initializing…` deadlock, as a test. StrictMode's dev remount terminates the
  // first worker mid-`init`, so that promise never settles; keyed on `(room,
  // voxelSize)` alone the remount read it as "already in flight" and awaited it
  // forever. The epoch makes the request a different one.
  assert.equal(
    engineLoadAction(NOTHING_LOADED, { epoch: 1, room: roomA, voxelSize: 0.5 }, { epoch: 2, room: roomA, voxelSize: 0.5 }),
    'start',
  );
});

test('engineLoadAction: a replaced worker holds nothing, whatever the old one loaded (spec §8)', () => {
  // The mirror-image failure: believing the new worker is loaded would leave the
  // placement tool enabled against an engine with no scene, and the build step would
  // come back as an SDK `INVALID_STATE`.
  assert.equal(
    engineLoadAction({ epoch: 1, room: roomA, voxelSize: 0.5 }, null, { epoch: 2, room: roomA, voxelSize: 0.5 }),
    'start',
  );
});

// --- the reason the load moved out of `handleRun` (`camera_placement.md` §10) ---

const group: ConstraintGroup = { id: 'g1', name: 'Group 1' };
const constraint: CameraConstraint = {
  id: 'c1',
  groupId: 'g1',
  name: 'Rail 1',
  kind: 'polyline',
  points: [
    [0, 2, 0],
    [4, 2, 0],
  ],
  distance: 0,
  enabled: true,
};

test('poolBlocker: a loaded engine clears the gate without a coverage run (spec §8)', () => {
  // What the eager load buys: readiness is reachable at startup. While `initAndLoad`
  // lived only inside `handleRun` this could only become true after a Run coverage
  // click, and the tool asked the user to wait for a load that had not started.
  const cameras: readonly SceneCamera[] = [];
  assert.equal(poolBlocker(cameras, group, [constraint], { engineReady: true }), null);
});

test('poolBlocker: an unloaded engine is still reported first (`camera_placement.md` §10)', () => {
  // Ahead of the no-group message, which misleads while the engine holds no scene.
  assert.equal(
    poolBlocker([], null, [], { engineReady: false }),
    'Wait for the engine to finish loading the scene.',
  );
});
