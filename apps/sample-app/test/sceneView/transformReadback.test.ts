import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floorVolumeSize,
  sectionBoundsFromCenters,
} from '../../src/scene/sceneView/transformReadback.ts';
import type { Section } from '../../src/scene/sectionHeatmap.ts';

test('floorVolumeSize clamps each axis to at least one voxel (sampling_volumes §5)', () => {
  // voxelSize 0.5 dominates the 0.05 hard floor, so the floor is 0.5.
  assert.deepEqual(floorVolumeSize([0.1, 2, 0.4], 0.5), [0.5, 2, 0.5]);
});

test('floorVolumeSize leaves above-floor sizes untouched', () => {
  assert.deepEqual(floorVolumeSize([3, 4, 5], 0.5), [3, 4, 5]);
});

test('floorVolumeSize falls back to the 0.05 hard floor for a tiny voxel', () => {
  // voxelSize 0.01 < 0.05 ⇒ floor is the MIN_VOLUME_SIZE_FLOOR of 0.05.
  assert.deepEqual(floorVolumeSize([0.01, 0.01, 10], 0.01), [0.05, 0.05, 10]);
});

const section = (bounds: Partial<Section>): Section => ({
  id: 'section-1',
  orientation: 'horizontal',
  min: 0,
  max: 2, // half-thickness 1
  minA: 0,
  maxA: 4, // half-extent 2
  minB: 0,
  maxB: 6, // half-extent 3
  aggregation: 'mean',
  enabled: true,
  clipRange: 1,
  name: '',
  ...bounds,
});

test('sectionBoundsFromCenters re-centers each bound-pair on the drag, keeping extents (spec §13.8)', () => {
  const out = sectionBoundsFromCenters(section({}), { mid: 5, centerA: 10, centerB: 20 });
  // Each pair keeps its half-extent (1 / 2 / 3) and re-centers on the dragged center.
  assert.deepEqual(out, { min: 4, max: 6, minA: 8, maxA: 12, minB: 17, maxB: 23 });
});

test('sectionBoundsFromCenters preserves thickness/width/height exactly', () => {
  const current = section({ min: 1, max: 4, minA: -2, maxA: 2, minB: 5, maxB: 5 });
  const out = sectionBoundsFromCenters(current, { mid: 0, centerA: 0, centerB: 0 });
  assert.equal(out.max - out.min, current.max - current.min); // thickness 3
  assert.equal(out.maxA - out.minA, current.maxA - current.minA); // width 4
  assert.equal(out.maxB - out.minB, current.maxB - current.minB); // height 0
});
