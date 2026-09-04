/**
 * The score-vs-count plot's geometry, pure (`camera_placement.md` §5.2).
 *
 * Lifted out of `ui/PlacementReviewPanel.tsx` because the click handler and the
 * polyline have to agree: the plot starts after the axis gutter, so a click maps
 * from *there*, and a mapping that forgets the gutter picks every count a little
 * to the left. That is a round-trip property between two functions — exactly the
 * thing a unit test can pin and a rendered SVG cannot.
 */

/** Empty plot above the highest value, as a fraction of the axis range (§5.2). */
export const CURVE_HEADROOM = 0.1;

/** The plot box, in the viewBox units the SVG is drawn with. */
export const CURVE_PLOT = {
  w: 300,
  h: 118,
  /** Gutter reserved for the value axis and its tick labels. */
  axisW: 34,
  padRight: 6,
  padBottom: 4,
  padTop: 4,
} as const;

/**
 * The value the y-axis spans, given the highest value plotted (§5.2).
 *
 * Headroom is taken in *value* space rather than as a pixel pad, so it stays a
 * tenth of the axis whatever height the plot is given. The pool ceiling is an
 * asymptote at or near the top of the range, and drawn flush to the frame it
 * reads as a border rather than as the bound the curve approaches.
 */
export function curveRange(top: number): number {
  return top / (1 - CURVE_HEADROOM);
}

/** Where camera count `count` of `n` sits horizontally. */
export function curveX(count: number, n: number): number {
  const { w, axisW, padRight } = CURVE_PLOT;
  return axisW + ((count - 1) / Math.max(1, n - 1)) * (w - axisW - padRight);
}

/** Where a score sits vertically within `range`. */
export function curveY(score: number, range: number): number {
  const { h, padBottom, padTop } = CURVE_PLOT;
  return h - padBottom - (score / range) * (h - padBottom - padTop);
}

/**
 * The count a click picks, from its fraction across the *whole* SVG width.
 *
 * The inverse of `curveX`, and clamped to `[1, n]`: the axis gutter and the
 * right pad are both outside the plot, so a click in either lands on the nearest
 * real count rather than on a count that does not exist.
 */
export function countAtFraction(frac: number, n: number): number {
  const { w, axisW, padRight } = CURVE_PLOT;
  const t = (frac - axisW / w) / (1 - (axisW + padRight) / w);
  return Math.max(1, Math.min(n, Math.round(1 + t * (n - 1))));
}
