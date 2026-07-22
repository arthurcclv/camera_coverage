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
   * stays in the scene (editable, dimmed gizmo) but is filtered out before
   * `setCameras()`. Stored on the entity so it round-trips in the scene file (§14.3).
   */
  enabled: boolean;
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

/** Strip the app-only `name`/`enabled`, yielding the plain SDK `CameraConfig` (spec §8). */
export function toCameraConfig(camera: SceneCamera): CameraConfig {
  const { name: _name, enabled: _enabled, ...config } = camera;
  return config;
}
