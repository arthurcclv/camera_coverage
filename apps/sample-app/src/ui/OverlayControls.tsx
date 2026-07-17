/**
 * Overlay viz toggles + opacity + resolution slider (spec §6, §9).
 */
import type { OverlayOptions } from '../scene/coverageOverlay.ts';
import { Slider } from './Slider.tsx';

export interface OverlayControlsProps {
  options: OverlayOptions;
  onOptionsChange(patch: Partial<OverlayOptions>): void;
  voxelSize: number;
  onVoxelSizeChange(v: number): void;
  estimatedVoxelCount: number;
  numCameras: number;
}

const LOW_VOXEL_SIZE_WARNING = 0.2;

export function OverlayControls({
  options,
  onOptionsChange,
  voxelSize,
  onVoxelSizeChange,
  estimatedVoxelCount,
  numCameras,
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
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={options.visible}
          onChange={(e) => onOptionsChange({ visible: e.target.checked })}
        />
        Show overlay
      </label>
      <Slider
        label="Peak opacity (fully covered)"
        value={options.opacity}
        min={0.02}
        max={1}
        step={0.02}
        onChange={(v) => onOptionsChange({ opacity: v })}
      />
      <p className="hint">
        Voxels are white; opacity scales with the fraction of enabled cameras
        that see them (transparent = none, peak = all).
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={options.hideWellCovered}
          disabled={options.blindSpotsOnly}
          onChange={(e) => onOptionsChange({ hideWellCovered: e.target.checked })}
        />
        Hide well-covered voxels (camera count &gt; threshold)
      </label>
      <Slider
        label="Threshold"
        value={options.wellCoveredThreshold}
        min={0}
        max={numCameras}
        step={1}
        digits={0}
        disabled={!options.hideWellCovered || options.blindSpotsOnly}
        onChange={(v) => onOptionsChange({ wellCoveredThreshold: v })}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={options.blindSpotsOnly}
          onChange={(e) => onOptionsChange({ blindSpotsOnly: e.target.checked })}
        />
        Blind spots only (0 cameras)
      </label>
    </div>
  );
}
