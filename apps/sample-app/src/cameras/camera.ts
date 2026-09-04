/**
 * App camera entity + name helpers (spec §5.6).
 *
 * The app models a camera as its own entity — the SDK's {@link CameraConfig}
 * extended with an editable display `name` — so the name rides on the camera
 * object like a probe's or section's, not in a side map. The SDK never sees the
 * name: {@link toCameraConfig} drops it at the `setCameras()` boundary (spec §8,
 * §14.1), the one place the engine type is required.
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';

/** A camera as the app stores it: `CameraConfig` plus a display `name` (§5.6). */
export interface SceneCamera extends CameraConfig {
  /** User-editable display label (§5.6); may be blank → falls back to `Camera N`. */
  name: string;
  /**
   * Whether the camera participates in `compute()` (spec §5.4). A disabled camera
   * stays in the scene (editable, dimmed gizmo) and **is** passed to
   * `setCameras()` — carrying this flag, so it keeps its mask-bit index while
   * contributing nothing. Required here where the SDK's is optional, so the app
   * always states it. Stored on the entity so it round-trips in the scene file (§14.3).
   */
  enabled: boolean;
  /**
   * Excluded from the aim optimizer (`aim_optimization.md` §4.5). Absent ⇒ false.
   *
   * The answer to "this camera's angle is fixed by contract": the optimizer has
   * no angular constraints of its own beyond the pitch clamp, because a camera
   * turned at a wall already scores near zero — a lock is for the orientations
   * that are *good* and still must not change.
   */
  aimLocked?: boolean;
  /**
   * The camera constraint this camera is bound to (`camera_placement.md` §6.3),
   * or absent when unbound.
   *
   * Two things at once: **provenance** for a camera the placement tool created,
   * and a **clamp** — every write of a bound camera's position is projected into
   * that constraint's region, so a reviewed layout cannot drift into places
   * where no mount exists. Deleting the constraint unbinds the camera; the
   * camera and its position stay.
   */
  constraintId?: string;
}

/** The default `Camera N` label derived from a `cam-N` id (§5.6). */
export function defaultCameraName(id: string): string {
  const m = /^cam-(\d+)$/.exec(id);
  return m ? `Camera ${m[1]}` : id;
}

/**
 * The label to display for a camera (§5.6): the trimmed `name`, or the default
 * `Camera N` when it is blank/all-whitespace. Never returns an empty string.
 */
export function cameraLabel(camera: SceneCamera): string {
  const trimmed = camera.name.trim();
  return trimmed.length > 0 ? trimmed : defaultCameraName(camera.id);
}

/** Strip the app-only fields, yielding the plain SDK `CameraConfig` (spec §8). */
export function toCameraConfig(camera: SceneCamera): CameraConfig {
  // `enabled` is *kept*: since spec §5.4 the engine needs it to hold the camera's
  // mask-bit slot open. `name`, `aimLocked`, and `constraintId` are app-only.
  const { name: _name, aimLocked: _aimLocked, constraintId: _constraintId, ...config } = camera;
  return config;
}
