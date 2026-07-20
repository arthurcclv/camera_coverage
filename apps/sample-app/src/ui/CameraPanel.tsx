/**
 * Selected-camera editor (spec §5.1, §5.2): position + Euler yaw/pitch/roll +
 * FOV + range (far). The quaternion is the source of truth; Euler is
 * re-derived from it on every render rather than kept as separate local
 * state, so it never drifts.
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import { Slider } from './Slider.tsx';

export interface CameraPanelProps {
  camera: CameraConfig | null;
  flagged: boolean;
  onChange(id: string, patch: Partial<CameraConfig>): void;
}

export function CameraPanel({ camera, flagged, onChange }: CameraPanelProps) {
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
        Camera — {camera.id}
        {flagged && <span className="badge flagged" style={{ marginLeft: 8 }}>inside geometry</span>}
      </p>

      <div className="panel-body">
        <Slider label="Pos X" value={camera.position[0]} min={-12} max={12} step={0.1} onChange={(v) => setPosition(0, v)} />
        <Slider label="Pos Y" value={camera.position[1]} min={0} max={6.5} step={0.1} onChange={(v) => setPosition(1, v)} />
        <Slider label="Pos Z" value={camera.position[2]} min={-12} max={12} step={0.1} onChange={(v) => setPosition(2, v)} />

        <Slider label="Yaw" value={euler.yaw} min={-180} max={180} step={1} digits={0} onChange={(v) => setEuler({ yaw: v })} />
        <Slider label="Pitch" value={euler.pitch} min={-89} max={89} step={1} digits={0} onChange={(v) => setEuler({ pitch: v })} />
        <Slider label="Roll" value={euler.roll} min={-180} max={180} step={1} digits={0} onChange={(v) => setEuler({ roll: v })} />

        <Slider label="FOV (vert.)" value={camera.fov} min={10} max={150} step={1} digits={0} onChange={(v) => set({ fov: v })} />
        <Slider label="Range (far)" value={camera.far ?? 50} min={0.5} max={100} step={0.1} onChange={(v) => set({ far: v })} />
      </div>
    </div>
  );
}
