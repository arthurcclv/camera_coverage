/**
 * Selected-volume editor (`sampling_volumes.md` §6.1). Position X/Y/Z, rotation
 * yaw/pitch/roll (Euler⇄quat via `cameras/math.ts`, the quaternion is the source
 * of truth), size X/Y/Z (floored per §5), and a Zone dropdown to reassign the
 * volume to another zone. Every edit marks the result stale (§4.2); delete is via
 * the hierarchy context menu (§4).
 */
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import { minVolumeSize, zoneLabel, type SamplingVolume, type Zone } from '../scene/samplingVolumes.ts';
import { Vec3Field } from './Vec3Field.tsx';

export interface VolumePanelProps {
  volume: SamplingVolume | null;
  zones: Zone[];
  /** Current sampling resolution — the per-axis size floor is `≥ voxelSize` (§5). */
  voxelSize: number;
  onChange(id: string, patch: Partial<SamplingVolume>): void;
}

export function VolumePanel({ volume, zones, voxelSize, onChange }: VolumePanelProps) {
  if (!volume) return null;

  const zone = zones.find((z) => z.id === volume.zoneId);
  const euler = quatToEuler(volume.rotation);
  const minSize = minVolumeSize(voxelSize);
  const set = (patch: Partial<SamplingVolume>) => onChange(volume.id, patch);
  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...volume.position] as [number, number, number];
    p[axis] = v;
    set({ position: p });
  };
  const setSize = (axis: 0 | 1 | 2, v: number) => {
    const s = [...volume.size] as [number, number, number];
    s[axis] = Math.max(minSize, v);
    set({ size: s });
  };
  const setEuler = (patch: Partial<ReturnType<typeof quatToEuler>>) => set({ rotation: eulerToQuat({ ...euler, ...patch }) });

  return (
    <div className="panel">
      <p className="panel-title">
        Volume — {volume.id}
        {zone && <span className="badge zone">{zoneLabel(zone)}</span>}
      </p>

      <div className="panel-body">
        <p className="hint">Zone</p>
        <div className="row">
          <label htmlFor="volume-zone">Zone</label>
          <select
            id="volume-zone"
            className="select"
            value={volume.zoneId}
            onChange={(e) => set({ zoneId: e.target.value })}
          >
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {zoneLabel(z)}
              </option>
            ))}
          </select>
        </div>

        {/* Position: free (spec §5.2.1). */}
        <Vec3Field
          label="Position"
          digits={2}
          columns={[
            { label: 'X', value: volume.position[0], onCommit: (v) => setPosition(0, v) },
            { label: 'Y', value: volume.position[1], onCommit: (v) => setPosition(1, v) },
            { label: 'Z', value: volume.position[2], onCommit: (v) => setPosition(2, v) },
          ]}
        />

        {/* Rotation columns axis-correct: X=pitch, Y=yaw, Z=roll (spec §5.1). */}
        <Vec3Field
          label="Rotation"
          digits={2}
          columns={[
            { label: 'X', value: euler.pitch, min: -89, max: 89, onCommit: (v) => setEuler({ pitch: v }) },
            { label: 'Y', value: euler.yaw, onCommit: (v) => setEuler({ yaw: v }) },
            { label: 'Z', value: euler.roll, onCommit: (v) => setEuler({ roll: v }) },
          ]}
        />

        {/* Size floored at the per-axis minimum (spec §5); setSize floors again defensively. */}
        <Vec3Field
          label="Size"
          digits={2}
          columns={[
            { label: 'X', value: volume.size[0], min: minSize, onCommit: (v) => setSize(0, v) },
            { label: 'Y', value: volume.size[1], min: minSize, onCommit: (v) => setSize(1, v) },
            { label: 'Z', value: volume.size[2], min: minSize, onCommit: (v) => setSize(2, v) },
          ]}
        />
      </div>
    </div>
  );
}
