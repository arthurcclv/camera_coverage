/**
 * Overlay controls (spec §6, §9.2): deliberately minimal — mode selector
 * (Coverage / Blind spots), intensity scale, plus the resolution slider.
 * Visibility on/off lives in the viewport's top-right toolbar (§2.4), not here.
 */
import { useTranslation } from 'react-i18next';
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

const MODES: { value: OverlayMode; labelKey: string }[] = [
  { value: 'coverage', labelKey: 'modeCoverage' },
  { value: 'blindspots', labelKey: 'modeBlindSpots' },
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
  const { t } = useTranslation('common');
  return (
    <div className="panel">
      <p className="panel-title">{t('resolution')}</p>
      <Slider label={t('voxelSizeLabel')} value={voxelSize} min={0.1} max={1.0} step={0.05} onChange={onVoxelSizeChange} />
      <p className="hint">
        {t('voxelCountHint', { count: estimatedVoxelCount.toLocaleString() })}
        {voxelSize <= LOW_VOXEL_SIZE_WARNING && <> {t('fineGridSlowHint')}</>}
      </p>

      <p className="panel-title" style={{ marginTop: 12 }}>
        {t('coverageOverlay')}
      </p>

      <div className="segmented" role="radiogroup" aria-label={t('visualizationMode')}>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={options.mode === m.value}
            className={`btn secondary${options.mode === m.value ? ' active' : ''}`}
            onClick={() => onOptionsChange({ mode: m.value })}
          >
            {t(m.labelKey)}
          </button>
        ))}
      </div>

      <Slider
        label={t('overlayColor')}
        value={options.overlayHue}
        min={0}
        max={360}
        step={1}
        digits={0}
        gradient={HUE_GRADIENT}
        onChange={(v) => onOptionsChange({ overlayHue: v })}
      />

      <Slider
        label={t('intensityScale')}
        value={options.intensityScale}
        min={0.02}
        max={2}
        step={0.02}
        onChange={(v) => onOptionsChange({ intensityScale: v })}
      />
    </div>
  );
}
