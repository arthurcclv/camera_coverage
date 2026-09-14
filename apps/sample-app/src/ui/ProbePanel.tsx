/**
 * Selected-probe editor + visibility readout (spec §12.3). Shown in place of the
 * camera panel when a probe is selected. A probe is a point — position only, no
 * orientation. The readout decodes the retained run's per-voxel mask at the
 * probe's location against that run's enabled cameras.
 */
import { Trans, useTranslation } from 'react-i18next';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { probeLabel, type Probe, type ProbeVisibilityResult } from '../scene/probeVisibility.ts';
import { Vec3Field } from './Vec3Field.tsx';

export interface ProbePanelProps {
  probe: Probe | null;
  /** Visibility query for this probe against the retained run (spec §12.2). */
  query: ProbeVisibilityResult | undefined;
  /** Whether any compute() has completed — gates the "Run coverage" message. */
  hasRunOnce: boolean;
  /** Whether the live scene has diverged from the retained run (spec §8.1). */
  stale: boolean;
  /** Camera id → display name (spec §5.6) for the visibility list. */
  cameraNameById: Map<string, string>;
  onChange(id: string, position: Vec3): void;
  /** Live display-name write (spec §5.6); never marks the result stale. */
  onRename(id: string, name: string): void;
  onSelectCamera(id: string): void;
}

export function ProbePanel({ probe, query, hasRunOnce, stale, cameraNameById, onChange, onRename, onSelectCamera }: ProbePanelProps) {
  const { t } = useTranslation(['camera', 'common']);

  if (!probe) return null;

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...probe.position] as Vec3;
    p[axis] = v;
    onChange(probe.id, p);
  };

  return (
    <div className="panel">
      <p className="panel-title">{t('camera:probePanel.titleWithName', { name: probeLabel(probe) })}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="probe-name">{t('common:name')}</label>
          <input
            id="probe-name"
            type="text"
            className="text-input"
            value={probe.name}
            placeholder={probeLabel(probe)}
            onChange={(e) => onRename(probe.id, e.target.value)}
          />
        </div>

        {/* Position: free (spec §5.2.1). Probe edits never mark the run stale (§12.5). */}
        <Vec3Field
          label={t('common:position')}
          digits={2}
          columns={[
            { label: 'X', value: probe.position[0], onCommit: (v) => setPosition(0, v) },
            { label: 'Y', value: probe.position[1], onCommit: (v) => setPosition(1, v) },
            { label: 'Z', value: probe.position[2], onCommit: (v) => setPosition(2, v) },
          ]}
        />

        {stale && hasRunOnce && (
          <p className="hint warn">{t('camera:probePanel.staleHint')}</p>
        )}

        <ProbeReadout probe={probe} query={query} hasRunOnce={hasRunOnce} cameraNameById={cameraNameById} onSelectCamera={onSelectCamera} />
      </div>
    </div>
  );
}

function ProbeReadout({
  query,
  hasRunOnce,
  cameraNameById,
  onSelectCamera,
}: {
  probe: Probe;
  query: ProbeVisibilityResult | undefined;
  hasRunOnce: boolean;
  cameraNameById: Map<string, string>;
  onSelectCamera(id: string): void;
}) {
  const { t } = useTranslation(['camera', 'common']);

  // States without usable data are never rendered as "0 of N" (spec §12.3).
  if (!hasRunOnce) return <p className="hint">{t('camera:probePanel.runCoverageHint')}</p>;
  if (!query || query.status !== 'ok') return <p className="hint">{t('camera:probePanel.noDataHint')}</p>;

  const { cameraIds, visible, seenCount } = query;
  return (
    <>
      <p className="probe-summary">
        <Trans
          t={t}
          i18nKey="camera:probePanel.summary"
          values={{ seen: seenCount, total: cameraIds.length }}
          components={{ b: <b /> }}
        />
      </p>
      <ul className="probe-vis-list">
        {cameraIds.map((id, n) => (
          <li
            key={id}
            className={`probe-vis-row${visible[n] ? ' visible' : ''}`}
            onClick={() => onSelectCamera(id)}
            title={t('camera:probePanel.selectCameraTooltip')}
          >
            <span className="mark">{visible[n] ? '✓' : '–'}</span>
            <span className="label">{cameraNameById.get(id) ?? id}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
