/**
 * Selected-camera editor (spec §5.1, §5.2): position + Euler yaw/pitch/roll +
 * FOV + range (far). The quaternion is the source of truth; Euler is
 * re-derived from it on every render rather than kept as separate local
 * state, so it never drifts.
 */
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
}

export function CameraPanel({ camera, flagged, onChange, onRename }: CameraPanelProps) {
  if (!camera) {
    return (
      <div className="panel">
        <p className="panel-title">Camera</p>
        <div className="panel-body">
          <p className="hint">Select a camera from the list or click its gizmo in the viewport.</p>
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
        Camera — {cameraLabel(camera)}
        {flagged && <span className="badge flagged" style={{ marginLeft: 8 }}>inside geometry</span>}
      </p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="camera-name">Name</label>
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
          label="Position"
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
          label="Rotation"
          digits={0}
          columns={[
            { label: 'X', value: euler.pitch, min: -89, max: 89, onCommit: (v) => setEuler({ pitch: v }) },
            { label: 'Y', value: euler.yaw, onCommit: (v) => setEuler({ yaw: v }) },
            { label: 'Z', value: euler.roll, onCommit: (v) => setEuler({ roll: v }) },
          ]}
        />

        <Slider label="FOV (vert.)" value={camera.fov} min={10} max={150} step={1} digits={0} onChange={(v) => set({ fov: v })} />
        <Slider label="Range (far)" value={camera.far ?? 50} min={0.5} max={100} step={0.1} onChange={(v) => set({ far: v })} />
      </div>
    </div>
  );
}
