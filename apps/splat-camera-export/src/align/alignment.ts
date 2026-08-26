/**
 * The splat→scene registration transform (spec §7) — pure model, Euler/quaternion
 * conversion, presets, and `alignment.json` (de)serialization.
 *
 * A capture reconstructed by COLMAP/3DGS training sits in an arbitrary frame at
 * arbitrary scale; the imported cameras sit in the room's metric Y-up frame.
 * Without this registration the two have no spatial relationship (§7).
 */
import { Quat as PcQuat } from 'playcanvas';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

/**
 * A similarity transform taking the splat into the scene frame (§7.1). Uniform
 * scale only — a non-uniform scale would shear the Gaussians.
 */
export interface Alignment {
  position: Vec3;
  rotation: Quat;
  /** Uniform, strictly positive. */
  scale: number;
}

export const IDENTITY_ALIGNMENT: Alignment = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: 1,
};

/**
 * Euler angles in degrees, in whatever order the engine's own `Quat` uses. The
 * conversions below **delegate to PlayCanvas** rather than reimplementing the
 * formulae: these numbers are typed into a panel that drives an entity's rotation,
 * so they must agree with `setLocalEulerAngles` exactly. A hand-rolled pair is easy
 * to get subtly wrong — a mismatched convention round-trips 180° about X to 0°.
 */
export interface EulerDegrees {
  x: number;
  y: number;
  z: number;
}

/** Euler degrees → unit quaternion `[x, y, z, w]`, via the engine's convention. */
export function eulerToQuat({ x, y, z }: EulerDegrees): Quat {
  const q = new PcQuat();
  q.setFromEulerAngles(x, y, z);
  return [q.x, q.y, q.z, q.w];
}

/**
 * Unit quaternion → Euler degrees, the inverse of {@link eulerToQuat} up to the
 * usual multiple-representation ambiguity (a rotation has more than one Euler
 * spelling, so the round-trip preserves the rotation, not necessarily the digits).
 */
export function quatToEuler([x, y, z, w]: Quat): EulerDegrees {
  const e = new PcQuat(x, y, z, w).getEulerAngles();
  return { x: e.x, y: e.y, z: e.z };
}

/**
 * The `Flip 180° Z` rotation — the standard correction for a 3DGS capture, which
 * loads Y-down relative to a Y-up viewer (§7.2). Negates X and Y.
 *
 * A 180° rotation about **X** also un-flips Y and is the textbook COLMAP→glTF basis
 * change, but it differs from this one by a 180° yaw (it negates Y and Z instead), so
 * the two leave the scene facing opposite ways. Z is what the PlayCanvas gsplat
 * pipeline expects and is the app's convention.
 */
export const FLIP_Z_ROTATION: Quat = [0, 0, 1, 0];

/**
 * The `Flip 180° Z` preset (§7.2), applied as a *replacement* of the rotation rather
 * than a composition, so pressing it twice is idempotent instead of drifting back to
 * identity.
 */
export function flipZPreset(current: Alignment): Alignment {
  return { ...current, rotation: FLIP_Z_ROTATION };
}

/** True when the rotation is (numerically) the `Flip 180° Z` rotation — drives the button's pressed state. */
export function isFlippedZ({ rotation }: Alignment): boolean {
  return Math.abs(Math.abs(rotation[2]) - 1) < 1e-6;
}

/**
 * The starting alignment for a capture with no saved registration (§7.3): every 3DGS
 * file is presumed Y-down and gets the {@link flipZPreset} rotation, since that is the
 * overwhelmingly common case and identity left nearly every real capture upside-down.
 *
 * Rotation only — position stays `[0,0,0]` and scale `1`. This is a convention, not a
 * measurement of the file's contents, so the caller announces it (§7.3) rather than
 * transforming the user's data silently.
 */
export function defaultAlignment(): Alignment {
  return flipZPreset(IDENTITY_ALIGNMENT);
}

export type ParseAlignmentResult = { ok: true; alignment: Alignment } | { ok: false; error: string };

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Parses an `alignment.json` (§7.3). Strict: this is a correctness-critical transform. */
export function parseAlignment(raw: unknown): ParseAlignmentResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'alignment.json must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;

  const position = o.position;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(isFiniteNumber)) {
    return { ok: false, error: 'alignment.position must be 3 finite numbers' };
  }

  const rotation = o.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(isFiniteNumber)) {
    return { ok: false, error: 'alignment.rotation must be 4 finite numbers' };
  }
  const len = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (len < 1e-8) return { ok: false, error: 'alignment.rotation must be a non-zero quaternion' };

  if (!isFiniteNumber(o.scale) || o.scale <= 0) {
    return { ok: false, error: 'alignment.scale must be a positive number' };
  }

  return {
    ok: true,
    alignment: {
      position: position as Vec3,
      rotation: [rotation[0] / len, rotation[1] / len, rotation[2] / len, rotation[3] / len],
      scale: o.scale,
    },
  };
}

/** The `alignment.json` payload (§7.3). */
export function serializeAlignment(alignment: Alignment): string {
  return `${JSON.stringify(alignment, null, 2)}\n`;
}

/**
 * The `localStorage` key for a capture's alignment (§7.3) — keyed by filename and
 * byte size so a different capture with the same name does not inherit a stale
 * registration.
 */
export function alignmentStorageKey(filename: string, byteSize: number): string {
  return `${ALIGNMENT_STORAGE_PREFIX}:${filename}:${byteSize}`;
}

/**
 * Versioned key prefix (§7.4).
 *
 * `v1` entries were written by a build that persisted the *auto-applied default* as
 * though it were a user choice, which made the default permanently unchangeable for any
 * capture already opened once. Those entries cannot be distinguished from real choices,
 * so the version bump orphans them rather than trusting them.
 */
export const ALIGNMENT_STORAGE_PREFIX = 'splat-camera-export:alignment:v2';
