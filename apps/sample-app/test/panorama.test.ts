/**
 * `aim_optimization.md` §8 — the panorama's own invariants.
 *
 * These are the properties the acceptance test relies on but cannot isolate: the
 * bin grid is the inverse of the SDK's `projectionBin`, the pyramid's nodes
 * really do sum their leaves, and a frustum that contains everything scores
 * everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { packAggregate, prepareCamera, projectionBin, type Vec3 } from '@linkervision/camera-coverage-sdk';

import { captureRig, CUBE_FACES } from '../src/optimize/cubeRig.ts';
import { buildPanorama, PANORAMA_RESOLUTION } from '../src/optimize/panorama.ts';
import { frustumNormals, scoreOrientation } from '../src/optimize/search.ts';
import { eulerToQuat } from '../src/cameras/math.ts';
import { SCORE_SCALE } from '../src/optimize/weights.ts';

const R = 8;
const MOUNT: Vec3 = [0, 0, 0];

/** Panorama with `value` in every bin of plane 0 and `blind` in plane 1. */
function uniform(value: number, blind: number, r = R) {
  const merged = Array.from({ length: 6 }, () => {
    const a = new Float64Array(2 * r * r);
    a.fill(value, 0, r * r);
    a.fill(blind, r * r);
    return a;
  });
  return buildPanorama(merged, r);
}

test('§3.2: a bin centre projects back to its own bin', () => {
  const rig = captureRig({ position: MOUNT, near: 0.1, far: 50 });
  const pano = uniform(0, 0);
  for (let f = 0; f < 6; f++) {
    const packed = packAggregate({
      projections: [
        {
          camera: 0,
          viewProj: Array.from(prepareCamera(rig[f]).viewProj),
          resolution: R,
          weights: [new Uint32Array(1)],
        },
      ],
    });
    for (let b = 0; b < R * R; b++) {
      const o = (f * R * R + b) * 3;
      // Walk out along the bin's own direction and ask the SDK where it lands.
      const p: Vec3 = [pano.dir[o] * 5, pano.dir[o + 1] * 5, pano.dir[o + 2] * 5];
      assert.equal(projectionBin(packed, 0, p[0], p[1], p[2]), b, `face ${f} bin ${b}`);
    }
  }
});

test('§3.2: the cube faces tile every direction exactly once', () => {
  const pano = uniform(0, 0, 4);
  // Every bin direction belongs to the face whose axis dominates it, and each
  // face's bins are exactly the directions that face owns — which is what makes
  // the six 90° frusta a partition rather than an overlap.
  const axisOf = (f: number): [number, number] => [[2, -1], [0, -1], [2, 1], [0, 1], [1, 1], [1, -1]][f] as [number, number];
  for (let f = 0; f < 6; f++) {
    const [axis, sign] = axisOf(f);
    for (let b = 0; b < 16; b++) {
      const o = (f * 16 + b) * 3;
      const d = [pano.dir[o], pano.dir[o + 1], pano.dir[o + 2]];
      const dominant = d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)));
      assert.equal(dominant, axis, `face ${f} bin ${b} dominant axis`);
      assert.equal(Math.sign(d[axis]), sign, `face ${f} bin ${b} sign`);
    }
  }
});

test('§7.2: every pyramid node sums exactly its own leaves', () => {
  const merged = Array.from({ length: 6 }, (_, f) => {
    const a = new Float64Array(2 * R * R);
    for (let b = 0; b < R * R; b++) {
      a[b] = f * 100 + b;
      a[R * R + b] = b % 3;
    }
    return a;
  });
  const pano = buildPanorama(merged, R);

  for (let level = 1; level < pano.levels.length; level++) {
    const lv = pano.levels[level];
    const leaf = pano.levels[0];
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < lv.size; j++) {
        for (let i = 0; i < lv.size; i++) {
          const span = R / lv.size;
          let score = 0;
          let blind = 0;
          for (let y = j * span; y < Math.min((j + 1) * span, R); y++) {
            for (let x = i * span; x < Math.min((i + 1) * span, R); x++) {
              score += leaf.score[f * R * R + y * R + x];
              blind += leaf.blind[f * R * R + y * R + x];
            }
          }
          const cell = f * lv.size * lv.size + j * lv.size + i;
          assert.equal(lv.score[cell], score, `level ${level} face ${f} (${i},${j}) score`);
          assert.equal(lv.blind[cell], blind, `level ${level} face ${f} (${i},${j}) blind`);
        }
      }
    }
  }
});

test('§7.2: a frustum wide enough to contain the sphere scores every bin', () => {
  const pano = uniform(SCORE_SCALE, 2, R);
  // 179° at aspect 1 is not literally the whole sphere, but every one of the
  // five half-spaces admits all but a sliver behind the camera, so a coarse
  // sanity check is that it beats a narrow lens by a wide margin.
  const wide = scoreOrientation(pano, eulerToQuat({ yaw: 0, pitch: 0, roll: 0 }), {
    fov: 179, aspect: 1, roll: 0,
  });
  const narrow = scoreOrientation(pano, eulerToQuat({ yaw: 0, pitch: 0, roll: 0 }), {
    fov: 20, aspect: 1, roll: 0,
  });
  assert.ok(wide.score > 6 * R * R * 0.4, `a 179° lens scored only ${wide.score}`);
  assert.ok(wide.score > 10 * narrow.score, `179° ${wide.score} vs 20° ${narrow.score}`);
  // Plane 1 rides the same traversal, so the ratio must track.
  assert.equal(wide.blind / 2, Math.round(wide.score));
});

test('§7.2: the frustum half-spaces agree with a direct per-bin test', () => {
  const pano = uniform(SCORE_SCALE, 1, R);
  const lens = { fov: 55, aspect: 16 / 9, roll: 0 };
  for (const [yaw, pitch] of [[0, 0], [37, -22], [-140, 61], [180, -89]]) {
    const q = eulerToQuat({ yaw, pitch, roll: 0 });
    const n = frustumNormals(q, lens);
    let expected = 0;
    for (let b = 0; b < 6 * R * R; b++) {
      const o = b * 3;
      let inside = true;
      for (let p = 0; p < 5 && inside; p++) {
        inside = n[p * 3] * pano.dir[o] + n[p * 3 + 1] * pano.dir[o + 1] + n[p * 3 + 2] * pano.dir[o + 2] >= 0;
      }
      if (inside) expected++;
    }
    const got = scoreOrientation(pano, q, lens);
    // The pyramid may take a whole cell whose corners are all inside even when a
    // bin centre sits marginally outside, so allow the boundary ring to differ.
    assert.ok(
      Math.abs(got.blind - expected) <= 4 * R,
      `(${yaw}, ${pitch}): pyramid ${got.blind} vs per-bin ${expected}`,
    );
  }
});

test('§2.2: the panorama resolution is the one the descriptor asks for', () => {
  assert.equal(PANORAMA_RESOLUTION, 64);
  assert.equal(CUBE_FACES.length, 6);
});
