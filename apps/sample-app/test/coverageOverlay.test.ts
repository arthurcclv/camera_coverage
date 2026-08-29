import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageFraction, hueToRgb } from '../src/scene/coverageOverlay.ts';

test('voxel seen by all involved cameras has coverage fraction 1', () => {
  assert.equal(coverageFraction(4, 4), 1);
});

test('blind spot (no camera) has coverage fraction 0', () => {
  assert.equal(coverageFraction(0, 4), 0);
});

test('coverage fraction is the linear share of involved cameras', () => {
  assert.equal(coverageFraction(1, 4), 0.25);
  assert.equal(coverageFraction(2, 4), 0.5);
  assert.equal(coverageFraction(3, 4), 0.75);
});

test('fraction is clamped to [0, 1] when camCount exceeds the denominator', () => {
  // e.g. a stale involvedCameraCount never yields a fraction above 1.
  assert.equal(coverageFraction(6, 4), 1);
});

test('zero involved cameras does not divide by zero', () => {
  assert.equal(coverageFraction(0, 0), 0);
});

// --- Camera count above 32 cameras (§9, SDK spec §7.1/§9.5) -----------------

// --- Overlay color (spec §9.2): hue → hsl(hue,100%,50%) RGB -----------------

function approx(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `${a} vs ${b}`);
}

test('primary/secondary hues map to the expected saturated RGB', () => {
  approx(hueToRgb(0), [1, 0, 0]); // red (default)
  approx(hueToRgb(120), [0, 1, 0]); // green
  approx(hueToRgb(240), [0, 0, 1]); // blue
  approx(hueToRgb(60), [1, 1, 0]); // yellow
  approx(hueToRgb(180), [0, 1, 1]); // cyan
  approx(hueToRgb(300), [1, 0, 1]); // magenta
});

test('hue is periodic: 360 wraps to 0 and negatives normalize', () => {
  approx(hueToRgb(360), hueToRgb(0));
  approx(hueToRgb(-120), hueToRgb(240));
  approx(hueToRgb(480), hueToRgb(120));
});

test('every hue is fully saturated: one channel 1, one 0', () => {
  for (let h = 0; h < 360; h += 15) {
    const rgb = hueToRgb(h);
    assert.ok(Math.max(...rgb) > 1 - 1e-9, `max at hue ${h}: ${rgb}`);
    assert.ok(Math.min(...rgb) < 1e-9, `min at hue ${h}: ${rgb}`);
  }
});

// --- Chunk-keyed retention + batched rebuild (spec §8, §9) ------------------

import * as THREE from 'three';
import { CoverageOverlay } from '../src/scene/coverageOverlay.ts';
import { MAX_INSTANCES } from '../src/scene/volumetric.ts';
import type { AggregateResult } from '@linkervision/camera-coverage-sdk';

/** The instance count actually uploaded to the renderer — one per drawn voxel. */
function drawn(overlay: CoverageOverlay): number {
  const mesh = overlay.object.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh);
  return mesh ? (mesh as THREE.InstancedMesh).count : 0;
}

/**
 * One chunk's `leafCounts` aggregation (spec §3.3): a 2×1×1 chunk whose two
 * voxels are valid and seen by `cams` cameras. Deliberately **unmerged** — two
 * single-voxel leaves rather than one cube — so the counts below read as
 * instances, which is what the overlay is being asserted on.
 */
function counts(chunkId: number, cams: number): AggregateResult {
  return {
    chunkId,
    leafCounts: {
      index: Uint32Array.of(0, 1),
      size: Uint16Array.of(1, 1),
      count: Uint8Array.of(cams, cams),
    },
  };
}

/** Feed one chunk's counts, supplying the geometry SceneView would. */
function add(overlay: CoverageOverlay, chunkId: number, cams: number): void {
  overlay.addResult(counts(chunkId, cams), [chunkId * 2, 0, 0], [2, 1, 1], 1);
}

test('a re-sent chunk replaces its counts rather than piling on (spec §9)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  add(overlay, 0, 1);
  add(overlay, 1, 1);
  overlay.flush();
  assert.equal(drawn(overlay), 4, 'two chunks × two voxels');

  // What an incremental run does: re-send chunk 0 only, without a reset.
  overlay.beginRun();
  add(overlay, 0, 2);
  overlay.flush();
  assert.equal(drawn(overlay), 4, 'chunk 0 replaced, chunk 1 still standing');
  overlay.dispose();
});

test('an incremental run leaves untouched chunks in place (spec §8)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  for (let id = 0; id < 5; id++) add(overlay, id, 1);
  overlay.flush();
  assert.equal(drawn(overlay), 10);

  // The failure this guards: calling reset() on an incremental run would blank
  // the four chunks the run never re-sent, with no error anywhere.
  overlay.beginRun();
  add(overlay, 2, 1);
  overlay.flush();
  assert.equal(drawn(overlay), 10);
  overlay.dispose();
});

test('the rebuild is deferred to flush, not run per chunk (spec §9)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  overlay.beginRun();
  add(overlay, 0, 1);
  add(overlay, 1, 1);
  // Nothing uploaded yet: rebuild walks *every* retained chunk, so doing it per
  // chunk is quadratic in chunk count.
  assert.equal(drawn(overlay), 0);
  overlay.flush();
  assert.equal(drawn(overlay), 4);
  overlay.dispose();
});

test('reset empties the overlay immediately, without waiting for a flush (spec §14.4)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  add(overlay, 0, 1);
  overlay.flush();
  assert.equal(drawn(overlay), 2);

  // A scene replace clears the overlay with no run following it.
  overlay.reset();
  assert.equal(drawn(overlay), 0);
  overlay.dispose();
});

test('a merged leaf draws one instance covering its whole cube (spec §3.3, §9)', () => {
  // One 2-voxel cube at the chunk's origin: its center is a full voxel in, not
  // half — getting that wrong offsets the whole overlay by half a leaf.
  const overlay = new CoverageOverlay();
  overlay.reset();
  overlay.addResult(
    { chunkId: 0, leafCounts: { index: Uint32Array.of(0), size: Uint16Array.of(2), count: Uint8Array.of(1) } },
    [10, 20, 30],
    [4, 4, 4],
    0.5,
  );
  overlay.flush();
  assert.equal(drawn(overlay), 1, 'one leaf ⇒ one instance, not eight');

  const mesh = overlay.object.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  const scale = new THREE.Vector3().setFromMatrixScale(m);
  // 2 voxels × 0.5 m = 1 m cube, centred half an edge in from the chunk origin.
  assert.ok(Math.abs(scale.x - 1) < 1e-6, `edge ${scale.x}`);
  assert.deepEqual(
    [pos.x, pos.y, pos.z].map((v) => Math.round(v * 1e6) / 1e6),
    [10.5, 20.5, 30.5],
  );
  overlay.dispose();
});

test('blind-spots mode keys off the leaf count, dropping covered leaves (spec §9.1)', () => {
  const overlay = new CoverageOverlay();
  overlay.setOptions({ mode: 'blindspots', involvedCameraCount: 4 });
  overlay.reset();
  overlay.addResult(
    {
      chunkId: 0,
      leafCounts: { index: Uint32Array.of(0, 1, 2), size: Uint16Array.of(1, 1, 1), count: Uint8Array.of(0, 2, 0) },
    },
    [0, 0, 0],
    [4, 1, 1],
    1,
  );
  overlay.flush();
  assert.equal(drawn(overlay), 2, 'only the two blind leaves');
  overlay.dispose();
});

test('the instance cap truncates instead of losing the GPU device', () => {
  // An InstancedMesh carries 64 B of matrix per instance; unbounded, a large
  // scene walks past a device's default 256 MiB buffer limit and the device is
  // lost. Truncation is reported so the caller can say so.
  const overlay = new CoverageOverlay();
  overlay.reset();
  const n = MAX_INSTANCES + 1000;
  overlay.addResult(
    {
      chunkId: 0,
      leafCounts: {
        index: Uint32Array.from({ length: n }, (_, i) => i),
        size: new Uint16Array(n).fill(1),
        count: new Uint8Array(n).fill(1),
      },
    },
    [0, 0, 0],
    [n, 1, 1],
    1,
  );
  overlay.flush();
  assert.equal(drawn(overlay), MAX_INSTANCES);
  assert.equal(overlay.droppedLeaves, 1000, 'the overflow is reported, not silent');
  overlay.dispose();
});
