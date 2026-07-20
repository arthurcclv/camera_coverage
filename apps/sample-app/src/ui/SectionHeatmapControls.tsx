/**
 * Global section-heatmap controls (spec §13.6): the shared Turbo colormap and
 * its 0..1 legend. There is no per-section colormap choice (spec §14 "Out of
 * scope") — this block is a fixed legend, not a picker.
 */
import { turboCssGradient } from '../scene/sectionHeatmap.ts';

export function SectionHeatmapControls() {
  return (
    <div className="panel">
      <p className="panel-title">Section heatmap</p>
      <p className="hint">Colormap: Turbo</p>
      <div className="legend-bar" style={{ background: turboCssGradient() }} />
      <div className="legend-labels">
        <span>0</span>
        <span>1</span>
      </div>
    </div>
  );
}
