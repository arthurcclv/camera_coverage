/**
 * Selected-section editor (spec §13.6): orientation, a thickness slider
 * (centered on the section's current position), aggregation, and the Clip
 * toggle button + reveal-range slider (§13.9). Shown in place of the
 * camera/probe panel when a section is selected.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { useTranslation } from 'react-i18next';
import {
  defaultFootprintForOrientation,
  defaultRangeForOrientation,
  footprintSliderMax,
  inPlaneExtent,
  MAX_SECTION_THICKNESS,
  maxClipRange,
  MIN_CLIP_RANGE,
  MIN_SECTION_FOOTPRINT,
  MIN_SECTION_THICKNESS,
  sectionCenter,
  sectionCenterA,
  sectionCenterB,
  sectionLabel,
  SECTION_AGGREGATIONS,
  SECTION_ORIENTATIONS,
  type Section,
  type SectionAggregation,
  type SectionOrientation,
} from '../scene/sectionHeatmap.ts';
import { Slider } from './Slider.tsx';

export interface SectionPanelProps {
  section: Section | null;
  worldMin: Vec3;
  worldMax: Vec3;
  onChange(id: string, patch: Partial<Section>): void;
  /** Live display-name write (spec §5.6); never marks the result stale. */
  onRename(id: string, name: string): void;
  /** Whether this section is the one currently clipping the scene (spec §13.9). */
  clipActive: boolean;
  /** Toggle this section as the clipping section (spec §13.9). */
  onToggleClip(id: string): void;
}

const ORIENTATION_LABEL_KEYS: Record<SectionOrientation, string> = {
  horizontal: 'orientationValue.horizontal',
  'vertical-x': 'orientationValue.verticalX',
  'vertical-z': 'orientationValue.verticalZ',
};

const AGGREGATION_LABEL_KEYS: Record<SectionAggregation, string> = {
  mean: 'aggregationValue.mean',
  max: 'aggregationValue.max',
  min: 'aggregationValue.min',
  blind: 'aggregationValue.blind',
};

// Footprint slider labels name the actual world axis per orientation (spec §13.6),
// so a horizontal section's two horizontal axes are never mislabeled "height".
const FOOTPRINT_LABEL_KEYS: Record<SectionOrientation, { a: string; b: string }> = {
  horizontal: { a: 'sectionPanel.footprint.horizontalA', b: 'sectionPanel.footprint.horizontalB' },
  'vertical-x': { a: 'sectionPanel.footprint.verticalXA', b: 'sectionPanel.footprint.verticalXB' },
  'vertical-z': { a: 'sectionPanel.footprint.verticalZA', b: 'sectionPanel.footprint.verticalZB' },
};

export function SectionPanel({ section, worldMin, worldMax, onChange, onRename, clipActive, onToggleClip }: SectionPanelProps) {
  const { t } = useTranslation(['sections', 'common']);
  if (!section) return null;

  const setOrientation = (orientation: SectionOrientation) => {
    if (orientation === section.orientation) return;
    // Resetting to the new axis's defaults (spec §13.2): the old thickness and
    // footprint bounds are in the previous axes' units and would be meaningless
    // (or out of bounds) on the new orientation. Thickness → full (clamped) extent
    // of the new normal; footprint → full extent of the new in-plane axes; clip
    // range → clamped to the new normal's extent (spec §13.9).
    const { min, max } = defaultRangeForOrientation(worldMin, worldMax, orientation);
    const footprint = defaultFootprintForOrientation(worldMin, worldMax, orientation);
    const clipRange = Math.min(section.clipRange, maxClipRange(worldMin, worldMax, orientation));
    onChange(section.id, { orientation, min, max, ...footprint, clipRange });
  };

  const center = sectionCenter(section);
  const thickness = section.max - section.min;

  const setThickness = (newThickness: number) => {
    onChange(section.id, { min: center - newThickness / 2, max: center + newThickness / 2 });
  };

  // Footprint (width/height) sliders (spec §13.2): each keeps the footprint's
  // center on its axis fixed and grows/shrinks symmetrically, like thickness.
  const { a: extentA, b: extentB } = inPlaneExtent(worldMin, worldMax, section.orientation);
  const widthMax = footprintSliderMax(extentA);
  const heightMax = footprintSliderMax(extentB);
  const centerA = sectionCenterA(section);
  const centerB = sectionCenterB(section);
  const width = section.maxA - section.minA;
  const height = section.maxB - section.minB;
  const footprintLabelKeys = FOOTPRINT_LABEL_KEYS[section.orientation];

  const setWidth = (w: number) => {
    onChange(section.id, { minA: centerA - w / 2, maxA: centerA + w / 2 });
  };
  const setHeight = (h: number) => {
    onChange(section.id, { minB: centerB - h / 2, maxB: centerB + h / 2 });
  };

  const clipMax = maxClipRange(worldMin, worldMax, section.orientation);

  return (
    <div className="panel">
      <p className="panel-title">{t('sectionPanel.title', { label: sectionLabel(section) })}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="section-name">{t('common:name')}</label>
          <input
            id="section-name"
            type="text"
            className="text-input"
            value={section.name}
            placeholder={sectionLabel(section)}
            onChange={(e) => onRename(section.id, e.target.value)}
          />
        </div>

        <p className="hint">{t('sectionPanel.orientationHint')}</p>
        <div className="segmented" role="radiogroup" aria-label={t('sectionPanel.orientationGroupLabel')}>
          {SECTION_ORIENTATIONS.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={section.orientation === o}
              className={`btn secondary${section.orientation === o ? ' active' : ''}`}
              onClick={() => setOrientation(o)}
            >
              {t(ORIENTATION_LABEL_KEYS[o])}
            </button>
          ))}
        </div>

        <Slider
          label={t('sectionPanel.thicknessLabel')}
          value={thickness}
          min={MIN_SECTION_THICKNESS}
          max={MAX_SECTION_THICKNESS}
          step={0.1}
          onChange={setThickness}
        />
        <p className="hint">{t('sectionPanel.thicknessHint', { center: center.toFixed(2) })}</p>

        <Slider
          label={t(footprintLabelKeys.a)}
          value={Math.min(width, widthMax)}
          min={MIN_SECTION_FOOTPRINT}
          max={widthMax}
          step={0.1}
          onChange={setWidth}
        />
        <Slider
          label={t(footprintLabelKeys.b)}
          value={Math.min(height, heightMax)}
          min={MIN_SECTION_FOOTPRINT}
          max={heightMax}
          step={0.1}
          onChange={setHeight}
        />
        <p className="hint">{t('sectionPanel.footprintHint', { a: centerA.toFixed(2), b: centerB.toFixed(2) })}</p>

        <p className="hint" style={{ marginTop: 10 }}>
          {t('sectionPanel.aggregationHint')}
        </p>
        <div className="segmented" role="radiogroup" aria-label={t('sectionPanel.aggregationGroupLabel')}>
          {SECTION_AGGREGATIONS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={section.aggregation === a}
              className={`btn secondary${section.aggregation === a ? ' active' : ''}`}
              onClick={() => onChange(section.id, { aggregation: a })}
            >
              {t(AGGREGATION_LABEL_KEYS[a])}
            </button>
          ))}
        </div>

        <p className="hint" style={{ marginTop: 10 }}>
          {t('sectionPanel.clipHint')}
        </p>
        <button
          type="button"
          aria-pressed={clipActive}
          className={`btn secondary block${clipActive ? ' active' : ''}`}
          onClick={() => onToggleClip(section.id)}
        >
          {t('sectionPanel.clipButton')}
        </button>

        <Slider
          label={t('sectionPanel.revealRangeLabel')}
          value={Math.min(section.clipRange, clipMax)}
          min={MIN_CLIP_RANGE}
          max={clipMax}
          step={0.1}
          onChange={(v) => onChange(section.id, { clipRange: v })}
        />
      </div>
    </div>
  );
}
