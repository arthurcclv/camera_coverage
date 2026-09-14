/**
 * Selected-camera editor (spec §5.1, §5.2): position + Euler yaw/pitch/roll +
 * FOV + range (far). The quaternion is the source of truth; Euler is
 * re-derived from it on every render rather than kept as separate local
 * state, so it never drifts.
 */
import { useTranslation } from 'react-i18next';
import { constraintLabel, type CameraConstraint } from '../placement/region.ts';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import { cameraLabel, type SceneCamera } from '../cameras/camera.ts';
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import { Slider } from './Slider.tsx';
import { Vec3Field } from './Vec3Field.tsx';

export interface CameraPanelProps {
  camera: SceneCamera | null;
  flagged: boolean;
  onChange(id: string, patch: Partial<CameraConfig>): void;
  /** Live display-name write (spec §5.6); never marks the result stale. */
  onRename(id: string, name: string): void;
  /** Toggle the aim lock (`aim_optimization.md` §4.5); never marks stale. */
  onToggleAimLock(id: string): void;
  /** Constraints this camera may be bound to (`camera_placement.md` §6.3). */
  constraints: readonly CameraConstraint[];
  /** Bind, rebind, or unbind — binding clamps the camera into its region (§6.3). */
  onBind(id: string, constraintId: string | null): void;
  /**
   * Move this camera to the best-scoring position on its own constraint (§4.6),
   * or null when it cannot run (unbound, or a session already holds the slots).
   */
  onReposition: (() => void) | null;
  /** Why Reposition is unavailable, for its tooltip (§10). */
  repositionBlocker: string | null;
}

export function CameraPanel({
  camera,
  flagged,
  onChange,
  onRename,
  onToggleAimLock,
  constraints,
  onBind,
  onReposition,
  repositionBlocker,
}: CameraPanelProps) {
  const { t } = useTranslation(['camera', 'common']);

  if (!camera) {
    return (
      <div className="panel">
        <p className="panel-title">{t('camera:cameraPanel.title')}</p>
        <div className="panel-body">
          <p className="hint">{t('camera:cameraPanel.emptyHint')}</p>
        </div>
      </div>
    );
  }

  const euler = quatToEuler(camera.rotation);
  const set = (patch: Partial<CameraConfig>) => onChange(camera.id, patch);
  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...camera.position] as [number, number, number];
    p[axis] = v;
    set({ position: p });
  };
  const setEuler = (patch: Partial<ReturnType<typeof quatToEuler>>) =>
    set({ rotation: eulerToQuat({ ...euler, ...patch }) });

  return (
    <div className="panel">
      <p className="panel-title">
        {t('camera:cameraPanel.titleWithName', { name: cameraLabel(camera) })}
        {flagged && (
          <span className="badge flagged" style={{ marginLeft: 8 }}>
            {t('camera:cameraPanel.insideGeometryBadge')}
          </span>
        )}
      </p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="camera-name">{t('common:name')}</label>
          <input
            id="camera-name"
            type="text"
            className="text-input"
            value={camera.name}
            placeholder={cameraLabel(camera)}
            onChange={(e) => onRename(camera.id, e.target.value)}
          />
        </div>

        {/* Position: free (former slider bounds were arbitrary UI extents), spec §5.2.1. */}
        <Vec3Field
          label={t('common:position')}
          digits={2}
          columns={[
            { label: 'X', value: camera.position[0], onCommit: (v) => setPosition(0, v) },
            { label: 'Y', value: camera.position[1], onCommit: (v) => setPosition(1, v) },
            { label: 'Z', value: camera.position[2], onCommit: (v) => setPosition(2, v) },
          ]}
        />

        {/* Rotation columns are axis-correct: X=pitch, Y=yaw, Z=roll (spec §5.1). Pitch
            is clamped ±89°; yaw/roll are free. */}
        <Vec3Field
          label={t('common:rotation')}
          digits={2}
          columns={[
            { label: 'X', value: euler.pitch, min: -89, max: 89, onCommit: (v) => setEuler({ pitch: v }) },
            { label: 'Y', value: euler.yaw, onCommit: (v) => setEuler({ yaw: v }) },
            { label: 'Z', value: euler.roll, onCommit: (v) => setEuler({ roll: v }) },
          ]}
        />

        <Slider label={t('camera:cameraPanel.fovLabel')} value={camera.fov} min={10} max={150} step={1} digits={2} onChange={(v) => set({ fov: v })} />
        <Slider label={t('camera:cameraPanel.rangeLabel')} value={camera.far ?? 50} min={0.5} max={100} step={0.1} onChange={(v) => set({ far: v })} />

        {/* The aim lock is app-only and changes nothing the engine computes, so
            it never marks the result stale (`aim_optimization.md` §4.5). */}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={camera.aimLocked === true}
            onChange={() => onToggleAimLock(camera.id)}
          />
          {t('camera:cameraPanel.lockAimLabel')}
        </label>

        {/* The binding is provenance *and* a clamp: while it is set, every write
            of this camera's position is projected into the constraint's region,
            so a reviewed layout cannot drift off its rail (`camera_placement.md`
            §6.3). */}
        <div className="row">
          <label htmlFor="cam-constraint">{t('camera:cameraPanel.constraintLabel')}</label>
          <select
            id="cam-constraint"
            className="text-input"
            value={camera.constraintId ?? ''}
            onChange={(e) => onBind(camera.id, e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{t('camera:cameraPanel.unboundOption')}</option>
            {constraints.map((c) => (
              <option key={c.id} value={c.id}>
                {constraintLabel(c)}
              </option>
            ))}
          </select>
        </div>
        {camera.constraintId !== undefined && (
          <>
            <p className="hint">{t('camera:cameraPanel.constraintClampedHint')}</p>
            <button
              type="button"
              className="btn secondary"
              disabled={onReposition === null}
              title={repositionBlocker ?? t('camera:cameraPanel.repositionTooltip')}
              onClick={() => onReposition?.()}
            >
              {t('camera:cameraPanel.repositionButton')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
