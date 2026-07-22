/**
 * Selected-section editor (spec §13.6): orientation, a thickness slider
 * (centered on the section's current position), aggregation, and the Clip
 * toggle button + reveal-range slider (§13.9). Shown in place of the
 * camera/probe panel when a section is selected.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  defaultRangeForOrientation,
  MAX_SECTION_THICKNESS,
  maxClipRange,
  MIN_CLIP_RANGE,
  MIN_SECTION_THICKNESS,
  sectionCenter,
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
  /** Whether this section is the one currently clipping the scene (spec §13.9). */
  clipActive: boolean;
  /** Toggle this section as the clipping section (spec §13.9). */
  onToggleClip(id: string): void;
}

const ORIENTATION_LABELS: Record<SectionOrientation, string> = {
  horizontal: 'Horizontal',
  'vertical-x': 'Vertical X',
  'vertical-z': 'Vertical Z',
};

const AGGREGATION_LABELS: Record<SectionAggregation, string> = {
  mean: 'Mean',
  max: 'Max',
  min: 'Min',
  blind: 'Blind',
};

export function SectionPanel({ section, worldMin, worldMax, onChange, clipActive, onToggleClip }: SectionPanelProps) {
  if (!section) return null;

  const setOrientation = (orientation: SectionOrientation) => {
    if (orientation === section.orientation) return;
    // Resetting to the new axis's full (clamped) extent (spec §5.5) — the old
    // min/max are in the previous collapse axis's units and would otherwise be
    // a meaningless (or out-of-bounds) range on the new one. The clip range
    // is likewise clamped to the new normal's extent (spec §13.9).
    const { min, max } = defaultRangeForOrientation(worldMin, worldMax, orientation);
    const clipRange = Math.min(section.clipRange, maxClipRange(worldMin, worldMax, orientation));
    onChange(section.id, { orientation, min, max, clipRange });
  };

  const center = sectionCenter(section);
  const thickness = section.max - section.min;

  const setThickness = (newThickness: number) => {
    onChange(section.id, { min: center - newThickness / 2, max: center + newThickness / 2 });
  };

  const clipMax = maxClipRange(worldMin, worldMax, section.orientation);

  return (
    <div className="panel">
      <p className="panel-title">Section — {section.id}</p>

      <div className="panel-body">
        <p className="hint">Orientation</p>
        <div className="segmented" role="radiogroup" aria-label="Section orientation">
          {SECTION_ORIENTATIONS.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={section.orientation === o}
              className={`btn secondary${section.orientation === o ? ' active' : ''}`}
              onClick={() => setOrientation(o)}
            >
              {ORIENTATION_LABELS[o]}
            </button>
          ))}
        </div>

        <Slider
          label="Thickness (m)"
          value={thickness}
          min={MIN_SECTION_THICKNESS}
          max={MAX_SECTION_THICKNESS}
          step={0.1}
          onChange={setThickness}
        />
        <p className="hint">Centered at {center.toFixed(2)} m; changing thickness keeps the center fixed.</p>

        <p className="hint" style={{ marginTop: 10 }}>
          Aggregation
        </p>
        <div className="segmented" role="radiogroup" aria-label="Section aggregation">
          {SECTION_AGGREGATIONS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={section.aggregation === a}
              className={`btn secondary${section.aggregation === a ? ' active' : ''}`}
              onClick={() => onChange(section.id, { aggregation: a })}
            >
              {AGGREGATION_LABELS[a]}
            </button>
          ))}
        </div>

        <p className="hint" style={{ marginTop: 10 }}>
          Clip
        </p>
        <button
          type="button"
          aria-pressed={clipActive}
          className={`btn secondary block${clipActive ? ' active' : ''}`}
          onClick={() => onToggleClip(section.id)}
        >
          Clip
        </button>

        <Slider
          label="Reveal range (m)"
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
