/**
 * Camera display-name resolution (spec §5.4). Mirrors the coverage app's
 * `cam-N` → `Camera N` fallback so labels match between the two apps.
 */

/** The default `Camera N` label derived from a `cam-N` id; any other id form is its own label. */
export function defaultCameraName(id: string): string {
  const m = /^cam-(\d+)$/.exec(id);
  return m ? `Camera ${m[1]}` : id;
}

/**
 * The label to display for a camera (§5.4): the trimmed `name`, or the default
 * `Camera N` when it is blank/all-whitespace. Never returns an empty string
 * (given a non-empty id, which the reader guarantees — §5.2).
 */
export function cameraLabel(camera: { id: string; name: string }): string {
  const trimmed = camera.name.trim();
  return trimmed.length > 0 ? trimmed : defaultCameraName(camera.id);
}
