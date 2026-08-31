/**
 * The six capture cameras that tile the sphere around one mount point
 * (`aim_optimization.md` §2.1, §3.1).
 *
 * They are ordinary `CameraConfig`s computed by the ordinary Pass 2, which is
 * the whole point: the panorama agrees with the engine's visibility because it
 * *is* the engine's visibility, not a second implementation of §8 that could
 * drift. Six 90° frusta at `aspect: 1` exactly cover all directions, so their
 * union is the mount point's reachable set.
 */
import type { CameraConfig, Quat } from '@linkervision/camera-coverage-sdk';
import { eulerToQuat } from '../cameras/math.ts';

/** Camera slots a session appends to the engine's list (§3.1). */
export const CAPTURE_SLOTS = 6;

export function captureCameraId(face: number): string {
  return `opt-cap-${face}`;
}

/** Whether an id names a session-only capture slot rather than a scene camera. */
export function isCaptureCameraId(id: string): boolean {
  return id.startsWith('opt-cap-');
}

/**
 * Face order `[−Z, −X, +Z, +X, +Y, −Y]` — the order `Panorama` indexes by.
 *
 * Identity looks down −Z and positive yaw turns left, so yaw 90° faces −X and
 * yaw −90° faces +X (`cameras/math.ts`). The pitch clamp of §5.2 is a UI rule
 * for editable cameras; these are not editable and take ±90° directly.
 */
export const CUBE_FACES: Quat[] = [
  eulerToQuat({ yaw: 0, pitch: 0, roll: 0 }),
  eulerToQuat({ yaw: 90, pitch: 0, roll: 0 }),
  eulerToQuat({ yaw: 180, pitch: 0, roll: 0 }),
  eulerToQuat({ yaw: -90, pitch: 0, roll: 0 }),
  eulerToQuat({ yaw: 0, pitch: 90, roll: 0 }),
  eulerToQuat({ yaw: 0, pitch: -90, roll: 0 }),
];

/**
 * The rig for one mount point.
 *
 * `near` and `far` are the optimized camera's own, so the reachable set is cut
 * at exactly the range that camera will be scored over — `far` is the app's only
 * lever on what counts as usefully visible (§1.3).
 */
export function captureRig(mount: Pick<CameraConfig, 'position' | 'near' | 'far'>): CameraConfig[] {
  return CUBE_FACES.map((rotation, face) => ({
    id: captureCameraId(face),
    position: mount.position,
    rotation,
    fov: 90,
    aspect: 1,
    near: mount.near ?? 0.1,
    far: mount.far ?? 50,
    enabled: true,
  }));
}
