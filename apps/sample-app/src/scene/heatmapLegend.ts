/**
 * Heatmap colorbar + legend scales (spec §13.5, §13.6) — the generic pieces the
 * floating `HeatmapLegend` renders, independent of any one heatmap. Two things live
 * here:
 *
 *  1. The **Turbo colormap** (a fixed piecewise-linear gradient) and its CSS-gradient
 *     form — the shared value→color mapping used both by the section heatmap texture
 *     (`sectionHeatmap.ts`) and by the legend bar.
 *  2. Two **legend-scale builders**, one per mode, each returning a `LegendScale`
 *     (caption + tick labels) over the *same* fixed gradient — only the labels change:
 *       - `sectionLegendScale` — **section mode**: a camera count (`0..N`) for
 *         mean/max/min, or a blind-voxel percentage for `blind` (§13.5).
 *       - `coverageLegendScale` — **coverage mode**: the plain coverage fraction
 *         `0..1` (§13.3), also the fallback the section scale uses before a run.
 *
 * A third builder, `chooseHeatmapLegend`, picks *which* legend the floating widget
 * shows (or none) from the current clip/overlay state — the section legend when an
 * enabled section is clipping and a run is retained, else the overlay legend when the
 * overlay is visible, else nothing (spec §13.6).
 *
 * All pure (no React / no THREE) so the tick math and the selection logic are
 * unit-testable (see `test/heatmapLegend.test.ts`). This module imports only *types*
 * from `sectionHeatmap.ts` / `coverageOverlay.ts`, so there is no runtime import cycle.
 */
import type { Section, SectionAggregation, SectionCellGrid } from './sectionHeatmap.ts';
import type { OverlayMode } from './coverageOverlay.ts';

// --- Turbo-style colormap (spec §13.5): dark blue (0) through cyan, green,
// yellow, orange, to red (1). Piecewise-linear over a fixed set of control
// points rather than a fitted polynomial, so the curve is exact-by-construction
// and easy to verify (see test/heatmapLegend.test.ts). -------------------------
const TURBO_STOPS: [number, number, number][] = [
  [0.19, 0.07, 0.23], // 0.00 — dark blue/violet
  [0.16, 0.40, 0.85], // 0.14 — blue
  [0.14, 0.65, 0.86], // 0.29 — cyan
  [0.17, 0.82, 0.56], // 0.43 — teal-green
  [0.52, 0.86, 0.27], // 0.57 — green
  [0.86, 0.80, 0.20], // 0.71 — yellow
  [0.97, 0.55, 0.17], // 0.86 — orange
  [0.62, 0.09, 0.06], // 1.00 — dark red
];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Turbo-style colormap: value 0..1 -> RGB components 0..1 (spec §13.5). */
export function turboColormap(t: number): [number, number, number] {
  const x = clamp01(t) * (TURBO_STOPS.length - 1);
  const i0 = Math.min(TURBO_STOPS.length - 2, Math.floor(x));
  const i1 = i0 + 1;
  const f = x - i0;
  const a = TURBO_STOPS[i0];
  const b = TURBO_STOPS[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** CSS `linear-gradient` string over the same control points, for the legend bar (spec §13.6). */
export function turboCssGradient(): string {
  const n = TURBO_STOPS.length - 1;
  const stops = TURBO_STOPS.map(([r, g, b], i) => {
    const pct = (i / n) * 100;
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}) ${pct}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// --- Legend scale (spec §13.6): the colorbar's Turbo gradient is fixed, but its
// tick labels + caption read in the units of the current mode. Value→color is
// always the same linear 0..1 Turbo mapping; only the labels change. -----------

/** One legend tick: its label and its fractional position (0..1) along the bar. */
export interface LegendTick {
  label: string;
  /** Position along the colorbar, 0 (left) .. 1 (right). */
  pos: number;
}

/**
 * A legend's caption, ticks, and gradient, with the caption still an i18n key
 * (spec §18.4, `common` namespace) rather than display text — this module is
 * pure/engine-free and does not resolve `t()`. `App.tsx` is the only caller,
 * and turns one into the resolved `LegendScale` `HeatmapLegend.tsx` renders.
 */
export interface LegendScaleTemplate {
  captionKey: string;
  ticks: LegendTick[];
  /** CSS `background` for the colorbar — the fixed Turbo gradient for section /
   * coverage-fraction scales, or the overlay's hue-intensity ramp (§9.2). */
  gradient: string;
}

/** A `LegendScaleTemplate` with its caption resolved to display text (spec §18.4). */
export interface LegendScale {
  caption: string;
  ticks: LegendTick[];
  gradient: string;
}

/** "Nice" step (1,2,5,10,…) for `count` camera-count ticks yielding ~5–9 labels. */
function niceCameraStep(count: number): number {
  const rawStep = count / 8; // aim for at most ~8 intervals
  const nice = [1, 2, 5, 10, 20, 25, 50, 100];
  for (const s of nice) if (s >= rawStep) return s;
  return nice[nice.length - 1];
}

const FRACTION_TICKS = [0, 0.25, 0.5, 0.75, 1];

/**
 * **Coverage mode** (spec §13.3, §13.6): the plain coverage fraction `0..1`
 * (ticks `0/0.25/0.5/0.75/1`), caption "Coverage fraction". Used when no section
 * drives the legend, and as the fallback of `sectionLegendScale` before a run.
 */
export function coverageLegendScale(): LegendScaleTemplate {
  return {
    captionKey: 'legendCoverageFraction',
    ticks: FRACTION_TICKS.map((f) => ({ label: String(f), pos: f })),
    gradient: turboCssGradient(),
  };
}

/**
 * **Coverage-overlay mode** (spec §9.1, §9.2, §13.6): the legend for the voxel
 * coverage overlay, which is drawn in a single user-picked hue whose *intensity*
 * (not color) encodes the value — so this legend uses the overlay's own hue ramp,
 * not the Turbo colormap. `hsl(hue, 100%, 50%)` mirrors `hueToRgb` (§9.2).
 *  - `coverage`   — intensity = coverage fraction: a transparent → full-hue ramp,
 *    labeled coverage fraction `0..1`.
 *  - `blindspots` — blind voxels draw at fixed full intensity: a solid full-hue
 *    swatch, no numeric scale.
 */
export function overlayLegendScale(overlayHue: number, mode: OverlayMode): LegendScaleTemplate {
  const solid = `hsl(${overlayHue}, 100%, 50%)`;
  if (mode === 'blindspots') {
    return {
      captionKey: 'legendBlindSpots',
      ticks: [],
      gradient: `linear-gradient(to right, ${solid}, ${solid})`,
    };
  }
  return {
    captionKey: 'legendCoverageFraction',
    ticks: FRACTION_TICKS.map((f) => ({ label: String(f), pos: f })),
    gradient: `linear-gradient(to right, hsla(${overlayHue}, 100%, 50%, 0), hsla(${overlayHue}, 100%, 50%, 1))`,
  };
}

/**
 * **Section mode** (spec §13.6): the caption + tick labels for a section's
 * aggregation. Camera-count and blind scales require an aggregation *and* a
 * completed run (`cameraCount != null && > 0`); otherwise it delegates to
 * `coverageLegendScale()` (the plain fraction), since `N` is unknown.
 */
export function sectionLegendScale(
  aggregation: SectionAggregation | null,
  cameraCount: number | null,
): LegendScaleTemplate {
  if (aggregation != null && cameraCount != null && cameraCount > 0) {
    if (aggregation === 'blind') {
      return {
        captionKey: 'legendBlindVoxelShare',
        ticks: [0, 0.5, 1].map((f) => ({ label: `${Math.round(f * 100)}%`, pos: f })),
        gradient: turboCssGradient(),
      };
    }
    // mean / max / min — camera count 0..N at an adaptive integer step. Coverage
    // fraction maps linearly to color, so count k sits at position k / N.
    const n = cameraCount;
    const step = niceCameraStep(n);
    const counts: number[] = [];
    for (let k = 0; k <= n; k += step) counts.push(k);
    const last = counts[counts.length - 1];
    if (last !== n) {
      // Ensure N is the final label; drop the penultimate tick if it would crowd it.
      if (n - last < step) counts.pop();
      counts.push(n);
    }
    return {
      captionKey: 'legendCamerasSeeingVoxel',
      ticks: counts.map((k) => ({ label: String(k), pos: k / n })),
      gradient: turboCssGradient(),
    };
  }
  return coverageLegendScale();
}

/** Overlay state the legend selector needs — a subset of `OverlayOptions` (§9). */
export interface OverlayLegendState {
  visible: boolean;
  overlayHue: number;
  mode: OverlayMode;
}

/**
 * Pick the floating legend the widget shows, or `null` to hide it (spec §13.6).
 *
 * The legend always describes the **clipping section** — never the current selection.
 * `clipSection` is the enabled section clipping the *visible* section layer (the
 * caller resolves it via `sectionLegendVisible`), or `null` when no section is
 * clipping. `clipGrid` is that section's retained cell grid, or `null` before a run.
 *
 *  - An enabled section is clipping (`clipSection != null`) → **section mode**: show the
 *    section legend keyed to *its* aggregation and the retained run's camera count, but
 *    only once a run is retained (`clipGrid != null`). Before a run the plane draws
 *    nothing, so the widget is hidden (`null`) rather than showing a placeholder — and
 *    it does **not** fall through to the overlay legend.
 *  - Otherwise → the overlay legend when the overlay is visible, else `null`.
 */
export function chooseHeatmapLegend(
  clipSection: Section | null,
  clipGrid: SectionCellGrid | null,
  overlay: OverlayLegendState,
): LegendScaleTemplate | null {
  if (clipSection != null) {
    return clipGrid != null
      ? sectionLegendScale(clipSection.aggregation, clipGrid.cameraIds.length)
      : null;
  }
  return overlay.visible ? overlayLegendScale(overlay.overlayHue, overlay.mode) : null;
}
