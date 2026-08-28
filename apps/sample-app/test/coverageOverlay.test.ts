import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessor, type ChunkResult } from '@linkervision/camera-coverage-sdk';
import { coverageFraction, hueToRgb, popcountWords } from '../src/scene/coverageOverlay.ts';

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

test('popcountWords counts every mask word, not just word 0', () => {
  assert.equal(popcountWords(new Uint32Array([0b1011])), 3);
  // cameras 32 and 34 only — word 0 empty
  assert.equal(popcountWords(new Uint32Array([0, 0b101])), 2);
  assert.equal(popcountWords(new Uint32Array([0xffffffff, 0xffffffff])), 64);
  assert.equal(popcountWords(new Uint32Array([0, 0, 0, 0])), 0);
});

/** Dense 2×1×1 chunk: voxel 0 seen by camera 33 only, voxel 1 blind. */
function highCameraChunk(): ChunkResult {
  const visibility = new Uint32Array([0, 0b10, 0, 0]); // 2 voxels × camWords 2
  const validity = new Uint32Array([0b11]); // both valid
  return {
    chunkId: 0,
    encoding: 'dense',
    dims: [2, 1, 1],
    origin: [0, 0, 0],
    voxelSize: 1,
    camWords: 2,
    mode: 1,
    visibility,
    validity,
    stats: { validCount: 2, coveredCount: 1, visibleCount: [] },
  };
}

test('a voxel seen only by a camera at index >= 32 is not read as a blind spot', () => {
  // Regression: the overlay used forEachLeaf's word-0 `mask`, so voxels covered
  // only by cameras 32+ got camCount 0 — invisible in Coverage mode and drawn as
  // false blind spots in Blind spots mode.
  const counts: number[] = [];
  accessor(highCameraChunk()).forEachLeaf((_min, _size, _mask, valid, maskWords) => {
    if (valid) counts.push(popcountWords(maskWords));
  });
  assert.deepEqual(counts, [1, 0], 'voxel 0 is seen by one camera; voxel 1 is blind');
  assert.ok(coverageFraction(counts[0], 40) > 0, 'covered voxel renders with intensity');
});

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

/** The instance count actually uploaded to the renderer — one per drawn voxel. */
function drawn(overlay: CoverageOverlay): number {
  const mesh = overlay.object.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh);
  return mesh ? (mesh as THREE.InstancedMesh).count : 0;
}

/** A dense 2×1×1 chunk with both voxels valid, seen by `cams` cameras. */
function simpleChunk(chunkId: number, cams: number): ChunkResult {
  const mask = cams === 0 ? 0 : (1 << cams) - 1;
  return {
    chunkId,
    encoding: 'dense',
    dims: [2, 1, 1],
    origin: [chunkId * 2, 0, 0],
    voxelSize: 1,
    camWords: 1,
    mode: 1,
    visibility: new Uint32Array([mask, mask]),
    validity: new Uint32Array([0b11]),
    stats: { validCount: 2, coveredCount: cams > 0 ? 2 : 0, visibleCount: [] },
  };
}

test('a re-sent chunk replaces its leaves rather than piling on (spec §9)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  overlay.addChunk(simpleChunk(0, 1));
  overlay.addChunk(simpleChunk(1, 1));
  overlay.flush();
  assert.equal(drawn(overlay), 4, 'two chunks × two voxels');

  // What an incremental run does: re-send chunk 0 only, without a reset.
  overlay.beginRun();
  overlay.addChunk(simpleChunk(0, 2));
  overlay.flush();
  assert.equal(drawn(overlay), 4, 'chunk 0 replaced, chunk 1 still standing');
  overlay.dispose();
});

test('an incremental run leaves untouched chunks in place (spec §8)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  for (let id = 0; id < 5; id++) overlay.addChunk(simpleChunk(id, 1));
  overlay.flush();
  assert.equal(drawn(overlay), 10);

  // The failure this guards: calling reset() on an incremental run would blank
  // the four chunks the run never re-sent, with no error anywhere.
  overlay.beginRun();
  overlay.addChunk(simpleChunk(2, 1));
  overlay.flush();
  assert.equal(drawn(overlay), 10);
  overlay.dispose();
});

test('the rebuild is deferred to flush, not run per chunk (spec §9)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  overlay.beginRun();
  overlay.addChunk(simpleChunk(0, 1));
  overlay.addChunk(simpleChunk(1, 1));
  // Nothing uploaded yet: rebuild walks *every* retained leaf, so doing it per
  // chunk is quadratic in chunk count.
  assert.equal(drawn(overlay), 0);
  overlay.flush();
  assert.equal(drawn(overlay), 4);
  overlay.dispose();
});

test('reset empties the overlay immediately, without waiting for a flush (spec §14.4)', () => {
  const overlay = new CoverageOverlay();
  overlay.reset();
  overlay.addChunk(simpleChunk(0, 1));
  overlay.flush();
  assert.equal(drawn(overlay), 2);

  // A scene replace clears the overlay with no run following it.
  overlay.reset();
  assert.equal(drawn(overlay), 0);
  overlay.dispose();
});
