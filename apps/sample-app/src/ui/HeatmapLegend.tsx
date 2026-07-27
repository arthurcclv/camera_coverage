/**
 * Heatmap legend (spec §2.2, §13.6): a compact floating colorbar — just the caption,
 * the colorbar gradient, and its numeric ticks (no block title, no colormap name).
 * Purely presentational: it renders whatever `LegendScale` it is handed, gradient and
 * all. The caller picks which via `chooseHeatmapLegend` (`heatmapLegend.ts`) — a section
 * scale (camera count / blind %) for the clipping section, the coverage overlay's hue
 * ramp, or nothing — and only mounts this component when that returns a non-`null` scale.
 */
import type { LegendScale } from '../scene/heatmapLegend.ts';

export interface HeatmapLegendProps {
  /** The caption, colorbar gradient, and tick labels to render (spec §13.6). */
  scale: LegendScale;
}

export function HeatmapLegend({ scale }: HeatmapLegendProps) {
  return (
    <div className="panel">
      <p className="hint">{scale.caption}</p>
      <div className="legend-bar" style={{ background: scale.gradient }} />
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
