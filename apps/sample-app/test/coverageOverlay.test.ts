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
