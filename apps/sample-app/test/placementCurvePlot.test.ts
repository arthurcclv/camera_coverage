/**
 * The score-vs-count plot's geometry (`camera_placement.md` §5.2, §13).
 *
 * The property worth pinning is the **round trip**: a click at the fraction a
 * count is drawn at has to pick that same count back. The two mappings live in
 * different places in the component — the polyline and the click handler — and
 * when they disagree the plot still renders perfectly, it just selects the wrong
 * camera count, which is invisible until someone counts the dots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURVE_HEADROOM,
  CURVE_PLOT,
  countAtFraction,
  curveRange,
  curveX,
  curveY,
} from '../src/placement/curvePlot.ts';

test('a click at a count’s own position picks that count back', () => {
  for (const n of [1, 2, 5, 12, 40]) {
    for (let count = 1; count <= n; count++) {
      const frac = curveX(count, n) / CURVE_PLOT.w;
      assert.equal(countAtFraction(frac, n), count, `n=${n} count=${count}`);
    }
  }
});

test('a click in either margin lands on the nearest real count', () => {
  const n = 20;
  // Left of the axis gutter, and past the right pad: both outside the plot.
  assert.equal(countAtFraction(0, n), 1);
  assert.equal(countAtFraction(-0.5, n), 1);
  assert.equal(countAtFraction(1, n), n);
  assert.equal(countAtFraction(1.5, n), n);
});

test('the plot spans the axis gutter to the right pad, in order', () => {
  const n = 10;
  assert.equal(curveX(1, n), CURVE_PLOT.axisW);
  assert.equal(curveX(n, n), CURVE_PLOT.w - CURVE_PLOT.padRight);
  for (let count = 2; count <= n; count++) {
    assert.ok(curveX(count, n) > curveX(count - 1, n), 'counts advance rightward');
  }
  // A one-point curve has no width to divide; it sits at the axis rather than
  // dividing by zero.
  assert.equal(curveX(1, 1), CURVE_PLOT.axisW);
});

test('at least a tenth of the plot is left empty above the highest value', () => {
  const top = 4000;
  const range = curveRange(top);
  const yTop = curveY(top, range);
  const yZero = curveY(0, range);
  const plotH = yZero - yTop;
  const full = CURVE_PLOT.h - CURVE_PLOT.padBottom - CURVE_PLOT.padTop;
  // The highest value uses (1 - headroom) of the axis, so the empty band above
  // it is the headroom — and it is a fraction of the range, not a pixel pad, so
  // it holds at any `top`.
  assert.ok(Math.abs(plotH / full - (1 - CURVE_HEADROOM)) < 1e-12);
  assert.ok(yTop > CURVE_PLOT.padTop, 'the top value never sits flush against the frame');

  // Zero sits on the baseline, and a larger score is always drawn higher.
  assert.equal(yZero, CURVE_PLOT.h - CURVE_PLOT.padBottom);
  assert.ok(curveY(top, range) < curveY(top / 2, range));
});
