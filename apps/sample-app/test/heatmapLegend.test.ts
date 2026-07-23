import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageLegendScale,
  overlayLegendScale,
  sectionLegendScale,
  turboColormap,
  turboCssGradient,
} from '../src/scene/heatmapLegend.ts';

// --- Turbo colormap (spec §13.5) ---------------------------------------------

test('turboColormap: blue end (t=0) stays distinct from black; red end (t=1) is red-dominant', () => {
  const [r0, , b0] = turboColormap(0);
  assert.ok(b0 > r0, 'low end should be blue-dominant, not black');
  assert.ok(b0 > 0.05);
  const [r1, , b1] = turboColormap(1);
  assert.ok(r1 > b1, 'high end should be red-dominant');
});

test('turboCssGradient starts blue and ends red, one stop per control point', () => {
  const gradient = turboCssGradient();
  assert.match(gradient, /^linear-gradient\(to right, /);
  const [r0, g0, b0] = turboColormap(0);
  const [r1, g1, b1] = turboColormap(1);
  assert.ok(gradient.includes(`rgb(${Math.round(r0 * 255)}, ${Math.round(g0 * 255)}, ${Math.round(b0 * 255)}) 0%`));
  assert.ok(gradient.includes(`rgb(${Math.round(r1 * 255)}, ${Math.round(g1 * 255)}, ${Math.round(b1 * 255)}) 100%`));
});

test('turboColormap interpolates linearly between control points', () => {
  const [r0, g0, b0] = turboColormap(0);
  assert.ok(Math.abs(r0 - 0.19) < 1e-9 && Math.abs(g0 - 0.07) < 1e-9 && Math.abs(b0 - 0.23) < 1e-9);
  const [r1, g1, b1] = turboColormap(1);
  assert.ok(Math.abs(r1 - 0.62) < 1e-9 && Math.abs(g1 - 0.09) < 1e-9 && Math.abs(b1 - 0.06) < 1e-9);
});

test('turboColormap clamps outside [0, 1]', () => {
  assert.deepEqual(turboColormap(-5), turboColormap(0));
  assert.deepEqual(turboColormap(5), turboColormap(1));
});

// --- coverageLegendScale (Turbo coverage fraction, spec §13.3, §13.6) --------

test('coverageLegendScale: plain coverage fraction 0..1 over the Turbo gradient', () => {
  const scale = coverageLegendScale();
  assert.equal(scale.caption, 'Coverage fraction');
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '0.25', '0.5', '0.75', '1']);
  assert.deepEqual(scale.ticks.map((t) => t.pos), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(scale.gradient, turboCssGradient());
});

// --- overlayLegendScale (coverage-overlay hue mode, spec §9.1, §9.2, §13.6) --

test('overlayLegendScale: coverage mode is a transparent→full-hue ramp labeled 0..1', () => {
  const scale = overlayLegendScale(210, 'coverage');
  assert.equal(scale.caption, 'Coverage fraction');
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '0.25', '0.5', '0.75', '1']);
  assert.deepEqual(scale.ticks.map((t) => t.pos), [0, 0.25, 0.5, 0.75, 1]);
  // Ramp uses the given hue, from alpha 0 (blind) to alpha 1 (full coverage).
  assert.match(scale.gradient, /^linear-gradient\(to right, /);
  assert.ok(scale.gradient.includes('hsla(210, 100%, 50%, 0)'));
  assert.ok(scale.gradient.includes('hsla(210, 100%, 50%, 1)'));
  assert.notEqual(scale.gradient, turboCssGradient());
});

test('overlayLegendScale: blindspots mode is a solid full-hue swatch with no numeric ticks', () => {
  const scale = overlayLegendScale(120, 'blindspots');
  assert.equal(scale.caption, 'Blind spots');
  assert.deepEqual(scale.ticks, []);
  // Solid full-hue bar (same color at both ends), reflecting fixed full intensity.
  assert.equal(scale.gradient, 'linear-gradient(to right, hsl(120, 100%, 50%), hsl(120, 100%, 50%))');
});

test('overlayLegendScale: the ramp tracks the overlay hue', () => {
  assert.ok(overlayLegendScale(0, 'coverage').gradient.includes('hsla(0, 100%, 50%, 1)'));
  assert.ok(overlayLegendScale(300, 'coverage').gradient.includes('hsla(300, 100%, 50%, 1)'));
});

// --- sectionLegendScale (section mode, spec §13.6) ---------------------------

test('sectionLegendScale: no aggregation / no run falls back to the coverage-fraction scale', () => {
  const noSel = sectionLegendScale(null, 10);
  const noRun = sectionLegendScale('mean', null);
  const zeroCams = sectionLegendScale('mean', 0);
  for (const scale of [noSel, noRun, zeroCams]) {
    assert.deepEqual(scale, coverageLegendScale());
  }
});

test('sectionLegendScale: blind shows a 0..100% share scale regardless of camera count', () => {
  const scale = sectionLegendScale('blind', 10);
  assert.equal(scale.caption, 'Blind-voxel share');
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0%', '50%', '100%']);
  assert.deepEqual(scale.ticks.map((t) => t.pos), [0, 0.5, 1]);
});

test('sectionLegendScale: coverage aggregations show whole camera counts, 0..N', () => {
  for (const agg of ['mean', 'max', 'min'] as const) {
    const scale = sectionLegendScale(agg, 8);
    assert.equal(scale.caption, 'Cameras seeing voxel');
    // N=8 → step 1 → every integer 0..8
    assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    // Count k sits at position k/N (linear), first at 0, last at 1.
    assert.equal(scale.ticks[0].pos, 0);
    assert.equal(scale.ticks[scale.ticks.length - 1].pos, 1);
    assert.ok(Math.abs(scale.ticks[4].pos - 0.5) < 1e-9);
  }
});

test('sectionLegendScale: adaptive step keeps ~5-9 ticks and always includes 0 and N', () => {
  for (const n of [1, 2, 4, 7, 10, 15, 50, 100, 128]) {
    const scale = sectionLegendScale('mean', n);
    const labels = scale.ticks.map((t) => Number(t.label));
    assert.equal(labels[0], 0, `N=${n} starts at 0`);
    assert.equal(labels[labels.length - 1], n, `N=${n} ends at N`);
    assert.ok(scale.ticks.length <= 10, `N=${n} not overcrowded (${scale.ticks.length} ticks)`);
    // Labels are whole numbers, strictly increasing, correctly positioned.
    for (let i = 0; i < scale.ticks.length; i++) {
      assert.ok(Number.isInteger(labels[i]), `N=${n} label ${labels[i]} is integer`);
      assert.ok(Math.abs(scale.ticks[i].pos - labels[i] / n) < 1e-9, `N=${n} tick ${labels[i]} positioned at k/N`);
      if (i > 0) assert.ok(labels[i] > labels[i - 1], `N=${n} strictly increasing`);
    }
  }
});

test('sectionLegendScale: N=100 uses a nice step of 20', () => {
  const scale = sectionLegendScale('max', 100);
  assert.deepEqual(scale.ticks.map((t) => t.label), ['0', '20', '40', '60', '80', '100']);
});
