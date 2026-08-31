/**
 * `aim_optimization.md` §8 — the round loop's rules, with a scripted capture.
 *
 * `greedy.ts` takes `capture` and `apply` as parameters precisely so this file
 * needs no engine, no worker, and no GPU (§7.1). Every panorama below is built
 * by hand: a single hot bin in a known direction is enough to make the score of
 * any orientation predictable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Quat } from '@linkervision/camera-coverage-sdk';

import { eulerToQuat, quatToEuler } from '../src/cameras/math.ts';
import { buildPanorama, type Panorama } from '../src/optimize/panorama.ts';
import { MIN_GAIN, optimizeAims, proposeFor, type OptimizableCamera } from '../src/optimize/greedy.ts';
import { SCORE_SCALE } from '../src/optimize/weights.ts';
import { scoreOrientation } from '../src/optimize/search.ts';

const R = 8;
const LENS = { fov: 60, aspect: 16 / 9, roll: 0 };

/**
 * A panorama whose weight sits on one cube face.
 *
 * Face 0 is −Z (yaw 0), face 2 is +Z (yaw 180) — so "the value is on face 2"
 * means an optimizer that works must turn the camera around.
 */
function oneFace(face: number, score: number, blind: number): Panorama {
  const merged = Array.from({ length: 6 }, () => new Float64Array(2 * R * R));
  merged[face].fill(score, 0, R * R);
  merged[face].fill(blind, R * R);
  return buildPanorama(merged, R);
}

/** A Quat comparison that tolerates the sign ambiguity of quaternions. */
function sameOrientation(a: Quat, b: Quat): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(Math.abs(dot) - 1) < 1e-6;
}

function cam(id: string, yaw: number, optimizable = true): OptimizableCamera {
  return { id, rotation: eulerToQuat({ yaw, pitch: 0, roll: 0 }), lens: LENS, optimizable };
}

test('§4.4: a camera facing nothing is turned toward the value', () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  const p = proposeFor(cam('cam-1', 0), pano);
  assert.ok(p.moved, 'the proposal did not move');
  assert.ok(Math.abs(Math.abs(p.best.yaw) - 180) < 20, `expected a yaw near ±180, got ${p.best.yaw}`);
  assert.ok(p.best.score > p.current.score);
});

test('§4.3: roll is carried through untouched', () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  const rolled: OptimizableCamera = {
    ...cam('cam-1', 0),
    rotation: eulerToQuat({ yaw: 0, pitch: 0, roll: 17 }),
    lens: { ...LENS, roll: 17 },
  };
  const p = proposeFor(rolled, pano);
  assert.ok(p.moved);
  assert.ok(Math.abs(quatToEuler(p.rotation).roll - 17) < 1e-6, 'roll was rewritten');
});

test('§4.4: the blind gate rejects a higher-scoring candidate that abandons blind voxels', () => {
  // Face 0 (behind the camera's current aim is face 2) holds a few blind voxels;
  // face 2 holds more raw score but nothing blind. Ungated, face 2 wins.
  const merged = Array.from({ length: 6 }, () => new Float64Array(2 * R * R));
  merged[0].fill(SCORE_SCALE, 0, R * R);
  merged[0].fill(3, R * R);
  merged[2].fill(4 * SCORE_SCALE, 0, R * R);
  const pano = buildPanorama(merged, R);

  const facingBlind = cam('cam-1', 0);
  const p = proposeFor(facingBlind, pano);
  const cur = scoreOrientation(pano, facingBlind.rotation, LENS);
  assert.ok(cur.blind > 0, 'the fixture must start on blind voxels');
  assert.ok(
    p.best.blind >= cur.blind,
    `gate admitted a candidate seeing ${p.best.blind} blind voxels, down from ${cur.blind}`,
  );
  assert.ok(Math.abs(p.best.yaw) < 90, `the gate should have kept it near face 0; got ${p.best.yaw}`);
});

test('§4.4: a camera already at its optimum is not moved again', () => {
  // Note a uniform *bin* fill is not a uniform panorama: a cube face's bins do
  // not subtend equal solid angle, so filling every bin equally still rewards
  // orientations that catch more of them. The honest fixture for the threshold
  // is a camera that has already converged.
  const pano = oneFace(2, SCORE_SCALE, 1);
  const first = proposeFor(cam('cam-1', 0), pano);
  assert.ok(first.moved, 'the fixture must move on the first pass');

  const settled: OptimizableCamera = { ...cam('cam-1', 0), rotation: first.rotation };
  const second = proposeFor(settled, pano);
  assert.ok(second.gain < MIN_GAIN, `a converged camera still gained ${second.gain}`);
  assert.equal(second.moved, false);
  // …and a rejected proposal hands back the camera's own rotation rather than
  // rebuilding one from rounded Euler angles.
  assert.ok(sameOrientation(second.rotation, settled.rotation));
});

test('§4.1: hierarchy order is respected, and locked / disabled cameras are skipped', async () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  const list = [cam('cam-1', 0), cam('cam-2', 0, false), cam('cam-3', 0)];
  const captured: string[] = [];
  const applied: string[] = [];

  const result = await optimizeAims(() => list, {
    capture: async (c) => {
      captured.push(c.id);
      return pano;
    },
    apply: (c, rotation) => {
      applied.push(c.id);
      const i = list.findIndex((x) => x.id === c.id);
      list[i] = { ...list[i], rotation };
    },
  });

  assert.deepEqual(captured.slice(0, 2), ['cam-1', 'cam-3'], 'order or skipping is wrong');
  assert.deepEqual(applied.slice(0, 2), ['cam-1', 'cam-3']);
  assert.ok(!captured.includes('cam-2'), 'a non-optimizable camera was captured');
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(result.proposals.map((p) => p.cameraId), ['cam-1', 'cam-3']);
});

test('§4.2: the loop stops on a round that moves nothing, and ΔΦ sums the accepted deltas', async () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  const list = [cam('cam-1', 0)];
  let rounds = 0;

  const result = await optimizeAims(() => list, {
    capture: async () => pano,
    apply: (c, rotation) => {
      const i = list.findIndex((x) => x.id === c.id);
      list[i] = { ...list[i], rotation };
    },
    onProgress: ({ round }) => { rounds = Math.max(rounds, round); },
  });

  // Round 1 turns it around; round 2 finds it already there and moves nothing.
  assert.equal(rounds, 2, `expected two rounds, ran ${rounds}`);
  assert.equal(result.rounds, 2);
  const accepted = result.proposals.filter((p) => p.moved);
  const expected = accepted.reduce((s, p) => s + (p.best.score - p.current.score), 0);
  // `proposals` holds the *latest* proposal per camera, which for a converged
  // camera is the no-move one — so ΔΦ is the round-1 delta and strictly positive.
  assert.ok(result.deltaPhi > 0, 'ΔΦ did not move');
  assert.ok(expected <= result.deltaPhi + 1e-9);
  assert.equal(result.canceled, false);
});

test('§6.1: Cancel stops at the next camera boundary and reports it', async () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  const list = [cam('cam-1', 0), cam('cam-2', 0), cam('cam-3', 0)];
  let seen = 0;

  const result = await optimizeAims(() => list, {
    capture: async () => {
      seen++;
      return pano;
    },
    apply: (c, rotation) => {
      const i = list.findIndex((x) => x.id === c.id);
      list[i] = { ...list[i], rotation };
    },
    aborted: () => seen >= 2,
  });

  assert.equal(result.canceled, true);
  assert.equal(seen, 2, 'the loop ran past the abort');
  assert.equal(result.proposals.length, 2, 'proposals from before the abort were dropped');
});

test('§4.4: a camera that currently sees nothing accepts any positive score', () => {
  const pano = oneFace(2, SCORE_SCALE, 1);
  // Facing face 4 (+Y, straight up): the current score is exactly zero.
  const up: OptimizableCamera = {
    id: 'cam-1',
    rotation: eulerToQuat({ yaw: 0, pitch: 89, roll: 0 }),
    lens: LENS,
    optimizable: true,
  };
  const p = proposeFor(up, pano);
  assert.equal(p.current.score, 0);
  assert.equal(p.gain, Infinity);
  assert.ok(p.moved);
});

test('§4.5: a locked camera never yields a proposal', async () => {
  const list = [cam('cam-1', 0, false)];
  const result = await optimizeAims(() => list, {
    capture: async () => { throw new Error('a locked camera was captured'); },
    apply: () => { throw new Error('a locked camera was applied'); },
  });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.deltaPhi, 0);
});

test('§6.2: a camera moved in an early round is still reported as moved after convergence', async () => {
  // The regression: the loop converges by running a round in which nothing moves,
  // and that round used to overwrite every camera's entry with its own no-move
  // proposal. The summary then said "No camera improved by more than 1%" and
  // disabled Apply — while the accepted rotations were sitting in the session,
  // visible in the viewport. It failed on exactly the successful case, and only
  // looked right when the loop ran out of rounds still moving.
  const pano = oneFace(2, SCORE_SCALE, 1);
  const list = [cam('cam-1', 0), cam('cam-2', 0)];
  const rounds: number[] = [];

  const result = await optimizeAims(() => list, {
    capture: async () => pano,
    apply: (c, rotation) => {
      const i = list.findIndex((x) => x.id === c.id);
      list[i] = { ...list[i], rotation };
    },
    onProgress: ({ round }) => rounds.push(round),
  });

  assert.ok(Math.max(...rounds) >= 2, 'the fixture must reach a converging second round');
  assert.equal(result.proposals.length, 2);
  for (const p of result.proposals) {
    assert.equal(p.moved, true, `${p.cameraId} was re-aimed but reported as not moved`);
    assert.ok(p.gain >= MIN_GAIN, `${p.cameraId} reported gain ${p.gain}`);
  }
});

test('§6.2: a reported proposal spans the whole run — original aim to final aim', async () => {
  // `current` must be where the camera started, not where the last round found
  // it; otherwise the summary's before/after columns describe one round rather
  // than the run the user is about to apply.
  const pano = oneFace(2, SCORE_SCALE, 1);
  const start = cam('cam-1', 0);
  const list = [{ ...start }];

  const result = await optimizeAims(() => list, {
    capture: async () => pano,
    apply: (c, rotation) => { list[0] = { ...list[0], rotation }; },
  });

  const p = result.proposals[0];
  const startEuler = quatToEuler(start.rotation);
  assert.ok(Math.abs(p.current.yaw - startEuler.yaw) < 1e-6, `current.yaw ${p.current.yaw} is not the original`);
  assert.ok(sameOrientation(p.rotation, list[0].rotation), 'the reported rotation is not the final one');
  assert.ok(p.best.score > p.current.score);
});
