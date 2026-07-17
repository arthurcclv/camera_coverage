import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageOpacity } from '../src/scene/coverageOverlay.ts';

const PEAK = 0.8;

test('voxel seen by all involved cameras reaches peak opacity', () => {
  assert.equal(coverageOpacity(4, 4, PEAK), PEAK);
});

test('voxel seen by no camera is fully transparent', () => {
  assert.equal(coverageOpacity(0, 4, PEAK), 0);
});

test('opacity interpolates linearly with the coverage fraction', () => {
  assert.equal(coverageOpacity(1, 4, PEAK), 0.25 * PEAK);
  assert.equal(coverageOpacity(2, 4, PEAK), 0.5 * PEAK);
  assert.equal(coverageOpacity(3, 4, PEAK), 0.75 * PEAK);
});

test('peak opacity is honoured (slider drives the ceiling)', () => {
  assert.equal(coverageOpacity(2, 4, 0.5), 0.25);
  assert.equal(coverageOpacity(4, 4, 0.5), 0.5);
});

test('fraction is clamped to [0, 1]', () => {
  // camCount exceeding the involved count (e.g. stale denominator) never
  // exceeds peak opacity.
  assert.equal(coverageOpacity(6, 4, PEAK), PEAK);
});

test('zero involved cameras does not divide by zero', () => {
  assert.equal(coverageOpacity(0, 0, PEAK), 0);
});

test('coverageOpacity treats blind spots (camCount 0) as transparent', () => {
  // The blind-spots-only override to peak opacity lives in rebuild(), not in
  // this pure mapping — here a 0-coverage voxel is transparent by design.
  assert.equal(coverageOpacity(0, 8, PEAK), 0);
});
