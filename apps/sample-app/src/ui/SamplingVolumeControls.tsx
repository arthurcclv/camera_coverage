/**
 * Global sampling-volume tool controls (`sampling_volumes.md` §6.3): a "Sampling
 * Volumes" block above the StatsPanel (it governs the coverage denominator).
 *
 * - **Restrict coverage to zones** — the `useZones` toggle (§2.2), default off.
 * - **Generate from geometry** — re-seeds the whole zone+volume set from the BVH
 *   (§3), replacing any hand-edits.
 * - **Zone level / Box level** sliders (§3.4); box level is clamped ≥ zone level.
 * - **Marked voxels** — the enabled-zones union size and its share of the full
 *   volume (§6.3), the tool's payoff.
 *
 * Which zones are enabled is controlled from the hierarchy row checkboxes (§4.1,
 * §7.3), not here.
 */
import { MAX_BOX_LEVEL, MAX_ZONE_LEVEL, MIN_ZONE_LEVEL } from '../scene/samplingVolumes.ts';
import { Slider } from './Slider.tsx';

export interface SamplingVolumeControlsProps {
  useZones: boolean;
  onUseZonesChange(v: boolean): void;
  zoneLevel: number;
  boxLevel: number;
  onZoneLevelChange(v: number): void;
  onBoxLevelChange(v: number): void;
  onGenerate(): void;
  /** Enabled-union size vs full valid volume, or null before the first run (§6.3). */
  marked: { marked: number; full: number } | null;
}

export function SamplingVolumeControls(props: SamplingVolumeControlsProps) {
  const { useZones, marked } = props;
  const pct = marked && marked.full > 0 ? Math.round((marked.marked / marked.full) * 100) : null;

  return (
    <div className="panel">
      <p className="panel-title">Sampling volumes</p>

      <label className="checkbox-row">
        <input type="checkbox" checked={useZones} onChange={(e) => props.onUseZonesChange(e.target.checked)} />
        <span>Restrict coverage to zones</span>
      </label>

      <button type="button" className="btn secondary block" onClick={props.onGenerate}>
        Generate from geometry
      </button>

      <Slider
        label="Zone level"
        value={props.zoneLevel}
        min={MIN_ZONE_LEVEL}
        max={MAX_ZONE_LEVEL}
        step={1}
        digits={0}
        onChange={props.onZoneLevelChange}
      />
      <Slider
        label="Box level"
        value={props.boxLevel}
        min={props.zoneLevel}
        max={MAX_BOX_LEVEL}
        step={1}
        digits={0}
        onChange={props.onBoxLevelChange}
      />

      <div className="stat-line spaced">
        <span>Marked voxels</span>
        <b>
          {marked
            ? pct !== null
              ? `${marked.marked.toLocaleString()} · ${pct}% of full`
              : marked.marked.toLocaleString()
            : 'Run coverage'}
        </b>
      </div>
    </div>
  );
}
