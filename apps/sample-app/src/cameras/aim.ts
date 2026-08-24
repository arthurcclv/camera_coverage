/**
 * Aim-drag math for the **Selected** view (spec §2.4.1, §5.2): turning a pointer
 * drag inside the camera's own image into a new camera orientation.
 *
 * Kept pure and separate from the gesture plumbing in `scene/sceneView/` so the
 * mapping, the pitch clamp, and roll preservation are unit-tested directly
 * (test/aim.test.ts). Composes the Euler/quaternion helpers in `./math.ts`, whose
 * `YXZ` order is what makes yaw-then-pitch the natural decomposition here.
 */
import type { EulerAngles } from './math.ts';

/** Pitch clamp shared with the rotation fields (spec §5.1, §5.2.1). */
export const MAX_PITCH_DEG = 89;

/** The rendered size of the camera's *true* image — the frame guide, in CSS px. */
export interface ImageSize {
  width: number;
  height: number;
}

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH_DEG, Math.max(-MAX_PITCH_DEG, pitch));
}

/** Horizontal FOV (degrees) implied by a vertical FOV and an aspect ratio. */
export function horizontalFov(fov: number, aspect: number): number {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return (Math.atan(Math.tan((fov * Math.PI) / 360) * safeAspect) * 360) / Math.PI;
}

/**
 * The orientation after dragging by (`dx`, `dy`) CSS pixels in the Selected view
 * (spec §5.2).
 *
 * **Mouselook: the aim follows the pointer.** Dragging right turns the camera
 * right — yaw *decreases*, given the −Z forward convention in `./math.ts` where
 * positive yaw turns left — and dragging down tilts it down. The scene therefore
 * sweeps opposite the drag.
 *
 * Degrees per pixel come from the camera's own FOV over the rendered image size,
 * so a drag spanning the image sweeps exactly one field of view: a narrow lens
 * gets fine control and a wide lens coarse control, with no sensitivity constant
 * to tune.
 *
 * Only yaw and pitch move: **pitch is clamped to ±89°** and **roll passes through
 * untouched**, the same invariants the rotation fields enforce (§5.1, §5.2.1), so
 * the horizon stays level as a mounted camera's does and the panel can always
 * represent the result. The clamp is reached routinely rather than exceptionally
 * here — the default rig already sits at −28° and downward is the common drag —
 * so it must saturate cleanly, which is exactly what `clampPitch` does.
 */
export function aimDelta(
  euler: EulerAngles,
  dx: number,
  dy: number,
  fov: number,
  aspect: number,
  image: ImageSize,
): EulerAngles {
  const width = image.width > 0 ? image.width : 1;
  const height = image.height > 0 ? image.height : 1;
  return {
    yaw: euler.yaw - dx * (horizontalFov(fov, aspect) / width),
    pitch: clampPitch(euler.pitch - dy * (fov / height)),
    roll: euler.roll,
  };
}
