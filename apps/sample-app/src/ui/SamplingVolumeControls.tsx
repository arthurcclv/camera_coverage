/**
 * Global sampling-volume tool controls (`sampling_volumes.md` §6.3): a "Sampling
 * Zones" block above the StatsPanel (it governs the coverage denominator).
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
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('volumes');
  const { useZones, marked } = props;
  const pct = marked && marked.full > 0 ? Math.round((marked.marked / marked.full) * 100) : null;

  return (
    <div className="panel">
      <p className="panel-title">{t('samplingVolumeControls.title')}</p>

      <label className="checkbox-row">
        <input type="checkbox" checked={useZones} onChange={(e) => props.onUseZonesChange(e.target.checked)} />
        <span>{t('samplingVolumeControls.restrictLabel')}</span>
      </label>

      <button type="button" className="btn secondary block" onClick={props.onGenerate}>
        {t('samplingVolumeControls.generateButton')}
      </button>

      <Slider
        label={t('samplingVolumeControls.zoneLevelLabel')}
        value={props.zoneLevel}
        min={MIN_ZONE_LEVEL}
        max={MAX_ZONE_LEVEL}
        step={1}
        digits={0}
        integer
        onChange={props.onZoneLevelChange}
      />
      <Slider
        label={t('samplingVolumeControls.boxLevelLabel')}
        value={props.boxLevel}
        min={props.zoneLevel}
        max={MAX_BOX_LEVEL}
        step={1}
        digits={0}
        integer
        onChange={props.onBoxLevelChange}
      />

      <div className="stat-line spaced">
        <span>{t('samplingVolumeControls.markedVoxelsLabel')}</span>
        <b>
          {marked
            ? pct !== null
              ? t('samplingVolumeControls.markedValue', { count: marked.marked.toLocaleString(), pct })
              : marked.marked.toLocaleString()
            : t('samplingVolumeControls.runHint')}
        </b>
      </div>
    </div>
  );
}
