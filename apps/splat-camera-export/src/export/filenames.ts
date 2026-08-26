/**
 * Pure export filename construction (spec §9.2): `label.ext` — the camera's name,
 * sanitized for cross-platform filesystems and made unique within the batch.
 */

/** Characters illegal on Windows, plus the POSIX path separator. */
const ILLEGAL_CHARS = '<>:"/\\|?*';

/** Windows reserved device names — illegal as a bare filename even with an extension. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Whether a character must be replaced in a filename stem (§9.2): a control code, any
 * whitespace, or a filesystem-illegal character. A predicate rather than a regex
 * character class, so no adjacent pair of escapes can silently form a range.
 */
function isIllegalChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code <= 0x1f || code === 0x7f) return true;
  if (/\s/.test(ch)) return true;
  return ILLEGAL_CHARS.includes(ch);
}

/**
 * Sanitizes a camera label into a filename stem (§9.2). Returns `''` when nothing
 * usable survives, letting the caller fall back to the camera id and then `camera`.
 */
export function sanitizeStem(label: string): string {
  // Every illegal character becomes `-`, then runs of `-` collapse to one.
  const replaced = Array.from(label, (ch) => (isIllegalChar(ch) ? '-' : ch)).join('');
  let s = replaced.replace(/-{2,}/g, '-');
  // Windows silently drops trailing dots and spaces, and a leading/trailing `-`
  // reads as noise — strip both ends rather than let the filesystem quietly
  // rename the file for us.
  s = s.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  if (s.length === 0) return '';
  // A reserved name is reserved regardless of extension, so prefix it.
  if (RESERVED.has(s.toUpperCase())) return `_${s}`;
  return s;
}

export interface NamedCamera {
  id: string;
  /** The resolved display label (`cameraLabel`, §5.4). */
  label: string;
}

/**
 * Builds the filename for every camera in the batch, in file order (§9.2).
 *
 * The name is the camera's label alone, so an image is identifiable outside the zip.
 * Camera names are free text, so collisions are entirely possible: a duplicate gains a
 * `-2`, `-3`, … suffix before the extension, and comparison is **case-insensitive**
 * because the target filesystem may be.
 *
 * @param extension - without the dot, e.g. `png`.
 */
export function buildFilenames(cameras: readonly NamedCamera[], extension: string): string[] {
  const used = new Set<string>();
  return cameras.map((camera) => {
    const stem = sanitizeStem(camera.label) || sanitizeStem(camera.id) || 'camera';

    let candidate = `${stem}.${extension}`;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${stem}-${n}.${extension}`;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
