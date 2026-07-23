/**
 * Overlay controls (spec §6, §9.2): deliberately minimal — mode selector
 * (Coverage / Blind spots), intensity scale, plus the resolution slider.
 * Visibility on/off lives in the viewport's top-right toolbar (§2.4), not here.
 */
import type { OverlayMode, OverlayOptions } from '../scene/coverageOverlay.ts';
import { Slider } from './Slider.tsx';

export interface OverlayControlsProps {
  options: OverlayOptions;
  onOptionsChange(patch: Partial<OverlayOptions>): void;
  voxelSize: number;
  onVoxelSizeChange(v: number): void;
  estimatedVoxelCount: number;
}

const LOW_VOXEL_SIZE_WARNING = 0.2;

const MODES: { value: OverlayMode; label: string }[] = [
  { value: 'coverage', label: 'Coverage' },
  { value: 'blindspots', label: 'Blind spots' },
];

// Rainbow track for the overlay-color slider: full-saturation hsl swept 0..360°,
// matching hueToRgb() in coverageOverlay.ts (spec §9.2).
const HUE_GRADIENT = `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360]
  .map((h) => `hsl(${h}, 100%, 50%)`)
  .join(', ')})`;

export function OverlayControls({
  options,
  onOptionsChange,
  voxelSize,
  onVoxelSizeChange,
  estimatedVoxelCount,
}: OverlayControlsProps) {
  return (
    <div className="panel">
      <p className="panel-title">Resolution</p>
      <Slider label="Voxel size (m)" value={voxelSize} min={0.1} max={1.0} step={0.05} onChange={onVoxelSizeChange} />
      <p className="hint">
        ~{estimatedVoxelCount.toLocaleString()} voxels in the workspace AABB.
        {voxelSize <= LOW_VOXEL_SIZE_WARNING && (
          <> Fine grids can be slow on the CPU backend.</>
        )}
      </p>

      <p className="panel-title" style={{ marginTop: 12 }}>
        Coverage overlay
      </p>

      <div className="segmented" role="radiogroup" aria-label="Visualization mode">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={options.mode === m.value}
            className={`btn secondary${options.mode === m.value ? ' active' : ''}`}
            onClick={() => onOptionsChange({ mode: m.value })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <Slider
        label="Overlay color"
        value={options.overlayHue}
        min={0}
        max={360}
        step={1}
        digits={0}
        gradient={HUE_GRADIENT}
        onChange={(v) => onOptionsChange({ overlayHue: v })}
      />

      <Slider
        label="Intensity scale"
        value={options.intensityScale}
        min={0.02}
        max={2}
        step={0.02}
        onChange={(v) => onOptionsChange({ intensityScale: v })}
      />
    </div>
  );
}
