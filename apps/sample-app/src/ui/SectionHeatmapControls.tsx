/**
 * Section-heatmap legend (spec §13.6): the shared Turbo colorbar, rendered as a
 * compact floating overlay (§2.2) — just the caption, the fixed Turbo gradient,
 * and its numeric ticks (no block title, no "Colormap: Turbo" label). The gradient
 * is fixed, but the caption and ticks adapt to the **currently-selected section's
 * aggregation** (§13.5) — a camera count (0..N) for mean/max/min, a percentage for
 * blind, or the plain coverage fraction as a fallback when no section is selected /
 * no run has completed. There is no per-section colormap choice (spec §14 "Out of
 * scope").
 */
import { sectionLegendScale, turboCssGradient, type SectionAggregation } from '../scene/sectionHeatmap.ts';

export interface SectionHeatmapControlsProps {
  /** Selected section's aggregation, or null when nothing is selected (spec §13.6). */
  aggregation: SectionAggregation | null;
  /** Enabled-camera count of the retained run the selected section reflects, or
   * null before a run — drives the camera-count scale's `N` (spec §13.6). */
  cameraCount: number | null;
}

export function SectionHeatmapControls({ aggregation, cameraCount }: SectionHeatmapControlsProps) {
  const scale = sectionLegendScale(aggregation, cameraCount);
  return (
    <div className="panel">
      <p className="hint">{scale.caption}</p>
      <div className="legend-bar" style={{ background: turboCssGradient() }} />
      <div className="legend-labels">
        {scale.ticks.map((tick, i) => {
          // Anchor endpoints to the bar edges; center interior ticks on their position.
          const transform = tick.pos <= 0 ? 'none' : tick.pos >= 1 ? 'translateX(-100%)' : 'translateX(-50%)';
          return (
            <span key={i} className="legend-tick" style={{ left: `${tick.pos * 100}%`, transform }}>
              {tick.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
