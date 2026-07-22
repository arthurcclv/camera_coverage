/**
 * Selected-probe editor + visibility readout (spec §12.3). Shown in place of the
 * camera panel when a probe is selected. A probe is a point — position only, no
 * orientation. The readout decodes the retained run's per-voxel mask at the
 * probe's location against that run's enabled cameras.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { probeLabel, type Probe, type ProbeVisibilityResult } from '../scene/probeVisibility.ts';
import { Slider } from './Slider.tsx';

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
  if (!probe) return null;

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...probe.position] as Vec3;
    p[axis] = v;
    onChange(probe.id, p);
  };

  return (
    <div className="panel">
      <p className="panel-title">Probe — {probeLabel(probe)}</p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="probe-name">Name</label>
          <input
            id="probe-name"
            type="text"
            className="text-input"
            value={probe.name}
            placeholder={probeLabel(probe)}
            onChange={(e) => onRename(probe.id, e.target.value)}
          />
        </div>

        <Slider label="Pos X" value={probe.position[0]} min={-12} max={12} step={0.1} onChange={(v) => setPosition(0, v)} />
        <Slider label="Pos Y" value={probe.position[1]} min={0} max={6.5} step={0.1} onChange={(v) => setPosition(1, v)} />
        <Slider label="Pos Z" value={probe.position[2]} min={-12} max={12} step={0.1} onChange={(v) => setPosition(2, v)} />

        {stale && hasRunOnce && (
          <p className="hint warn">⚠ Coverage out of date — recompute</p>
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
  // States without usable data are never rendered as "0 of N" (spec §12.3).
  if (!hasRunOnce) return <p className="hint">Run coverage to see visibility.</p>;
  if (!query || query.status !== 'ok') return <p className="hint">No coverage data at this point.</p>;

  const { cameraIds, visible, seenCount } = query;
  return (
    <>
      <p className="probe-summary">
        Seen by <b>{seenCount}</b> of <b>{cameraIds.length}</b> cameras
      </p>
      <ul className="probe-vis-list">
        {cameraIds.map((id, n) => (
          <li
            key={id}
            className={`probe-vis-row${visible[n] ? ' visible' : ''}`}
            onClick={() => onSelectCamera(id)}
            title="Select camera"
          >
            <span className="mark">{visible[n] ? '✓' : '–'}</span>
            <span className="label">{cameraNameById.get(id) ?? id}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
