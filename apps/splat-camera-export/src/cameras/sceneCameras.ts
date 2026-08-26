/**
 * Pure `scene.json` → {@link PreviewCamera}[] reader (spec §5).
 *
 * Deliberately narrow and tolerant (§5.1): it consumes `formatVersion` and
 * `cameras[]` and ignores every other key — `geometry`, `probes`, `sections`,
 * `zones`, `volumes`, `clipSectionId`, `useZones`, and anything a future format
 * version adds. This is a fresh module rather than an import from
 * `apps/sample-app/src` (cross-app source imports are forbidden) or an extraction
 * into the SDK (a headless coverage engine has no business knowing the app's file
 * format); see `ai/DECISIONS.md`.
 *
 * No file I/O here — the caller supplies already-parsed JSON.
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

/** The camera format versions this reader was written against (§5.1). */
export const KNOWN_FORMAT_VERSIONS = [1, 2] as const;

/** Defaults for the optional fields (§5.2). */
export const DEFAULT_ASPECT = 16 / 9;
export const DEFAULT_NEAR = 0.1;
/**
 * The default render `far` (§5.2). Not the `scene.json` `far`, which bounds the
 * volume a camera is credited with *covering* (~30 m) and would slice the visible
 * splat if used as a clip plane.
 */
export const DEFAULT_FAR = 1000;

/** A camera as this app uses it: the scene-frame pose plus projection (§5.2). */
export interface PreviewCamera {
  id: string;
  /** Trimmed; `''` when absent/blank — resolved for display by `cameraLabel` (§5.4). */
  name: string;
  position: Vec3;
  /** Normalized quaternion `[x, y, z, w]` (§3). */
  rotation: Quat;
  /** Vertical FOV in degrees, exclusive (0, 180) — maps 1:1 to PlayCanvas (§3). */
  fov: number;
  aspect: number;
  near: number;
  /** The value as authored. The render uses the far override instead (§5.2). */
  far: number;
  /** Whether the camera participates in coverage; defaults `true` (§5.2). */
  enabled: boolean;
}

export interface ReadResult {
  cameras: PreviewCamera[];
  /** Non-blocking notices (§11): an unknown future version, or an empty camera list. */
  notices: string[];
}

export type ReadCamerasResult = { ok: true } & ReadResult | { ok: false; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isVec3(x: unknown): x is Vec3 {
  return Array.isArray(x) && x.length === 3 && x.every(isFiniteNumber);
}

function isQuat(x: unknown): x is Quat {
  return Array.isArray(x) && x.length === 4 && x.every(isFiniteNumber);
}

/**
 * Unit-normalizes a quaternion. Returns `null` for a zero/degenerate length,
 * which carries no orientation and so is rejected rather than defaulted (§5.2).
 */
function normalizeQuat([x, y, z, w]: Quat): Quat | null {
  const len = Math.hypot(x, y, z, w);
  if (!Number.isFinite(len) || len < 1e-8) return null;
  return [x / len, y / len, z / len, w / len];
}

function fail(error: string): ReadCamerasResult {
  return { ok: false, error };
}

/** Reads one `cameras[i]` entry, or returns an error string naming the index and field (§5.3). */
function readCamera(raw: unknown, i: number): PreviewCamera | string {
  const at = `cameras[${i}]`;
  if (!isRecord(raw)) return `${at}: must be an object`;

  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return `${at}: id must be a non-empty string`;
  }
  if (!isVec3(raw.position)) return `${at}: position must be 3 finite numbers`;
  if (!isQuat(raw.rotation)) return `${at}: rotation must be 4 finite numbers`;

  const rotation = normalizeQuat(raw.rotation);
  if (rotation === null) return `${at}: rotation must be a non-zero quaternion`;

  if (!isFiniteNumber(raw.fov) || raw.fov <= 0 || raw.fov >= 180) {
    return `${at}: fov must be a number in (0, 180)`;
  }

  let aspect = DEFAULT_ASPECT;
  if (raw.aspect !== undefined) {
    if (!isFiniteNumber(raw.aspect) || raw.aspect <= 0) return `${at}: aspect must be a positive number`;
    aspect = raw.aspect;
  }

  let near = DEFAULT_NEAR;
  if (raw.near !== undefined) {
    if (!isFiniteNumber(raw.near) || raw.near <= 0) return `${at}: near must be a positive number`;
    near = raw.near;
  }

  let far = DEFAULT_FAR;
  if (raw.far !== undefined) {
    if (!isFiniteNumber(raw.far)) return `${at}: far must be a number`;
    if (raw.far <= near) return `${at}: far must be greater than near`;
    far = raw.far;
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return `${at}: enabled must be a boolean`;
    enabled = raw.enabled;
  }

  return {
    id: raw.id.trim(),
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    position: raw.position,
    rotation,
    fov: raw.fov,
    aspect,
    near,
    far,
    enabled,
  };
}

/**
 * Extracts the cameras from a parsed `scene.json` (§5). One invalid entry fails the
 * whole import (§5.3) — a partial camera set would silently under-export.
 */
export function readSceneCameras(raw: unknown): ReadCamerasResult {
  if (!isRecord(raw)) return fail('scene.json must be a JSON object');

  const version = raw.formatVersion;
  if (!isFiniteNumber(version) || !Number.isInteger(version) || version < 1) {
    return fail(`formatVersion must be a positive integer (found ${JSON.stringify(version)})`);
  }

  if (!Array.isArray(raw.cameras)) {
    return fail(`cameras must be an array (found ${JSON.stringify(raw.cameras)})`);
  }

  const notices: string[] = [];
  // A future version that only adds non-camera keys must keep working (§5.1).
  if (!(KNOWN_FORMAT_VERSIONS as readonly number[]).includes(version)) {
    notices.push(
      `scene.json formatVersion ${version} is newer than this app knows ` +
        `(${KNOWN_FORMAT_VERSIONS.join(', ')}); reading cameras anyway.`,
    );
  }

  const cameras: PreviewCamera[] = [];
  for (const [i, item] of raw.cameras.entries()) {
    const camera = readCamera(item, i);
    if (typeof camera === 'string') return fail(camera);
    cameras.push(camera);
  }

  if (cameras.length === 0) notices.push('scene.json contains no cameras.');

  return { ok: true, cameras, notices };
}
