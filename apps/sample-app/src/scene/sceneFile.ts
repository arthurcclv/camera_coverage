/**
 * Pure `scene.json` schema, validation, and (de)serialization (spec §14.3,
 * §14.8). No file I/O here — `sceneIO.ts` handles reading/writing/asset
 * resolution and is the only impure layer, kept thin so this module (the part
 * with real decision logic) is directly unit-testable.
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { SceneCamera } from '../cameras/camera.ts';
import {
  DEFAULT_CLIP_RANGE,
  MIN_CLIP_RANGE,
  SECTION_AGGREGATIONS,
  SECTION_ORIENTATIONS,
  type Section,
} from './sectionHeatmap.ts';
import type { Probe } from './probeVisibility.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Scene } from './sceneModel.ts';
import { defaultZoneName, type SamplingVolume, type Zone } from './samplingVolumes.ts';

/** Version written by {@link serializeScene}; bumped to 2 for zones/volumes (§14.3). */
export const SCENE_FILE_FORMAT_VERSION = 2;
/** Versions {@link parseSceneFile} accepts; a v1 file reads with empty zones/volumes (§14.8). */
export const SUPPORTED_FORMAT_VERSIONS = [1, 2] as const;

/** On-disk shape of a name-bearing entity: `name` is optional (§14.3 omit-on-write). */
type Serialized<T extends { name: string }> = Omit<T, 'name'> & { name?: string };

/**
 * On-disk camera shape (§14.3): `name` omitted when blank, and `enabled` omitted
 * when `true` (a camera is enabled by default, so only `enabled: false` is written).
 */
type SerializedCamera = Omit<SceneCamera, 'name' | 'enabled'> & { name?: string; enabled?: boolean };

export interface SceneFileJSON {
  formatVersion: number;
  geometry: GeometryObject[];
  /** App camera shape — `CameraConfig` fields plus optional `name`/`enabled` (§14.3). */
  cameras: SerializedCamera[];
  probes: Serialized<Probe>[];
  sections: Serialized<Section>[];
  /** Which section clips the scene (§13.9), or null. */
  clipSectionId: string | null;
  /** Region-of-interest zones (§14.3); each is `{ id, name }`. */
  zones: Zone[];
  /** Oriented sampling boxes (§14.3). */
  volumes: SamplingVolume[];
  /** Whether zones restrict coverage (§14.3); persisted analysis setting. */
  useZones: boolean;
}

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string };

/**
 * Rejects absolute paths, URLs/schemes (`http:`, `file:`, `data:`, ...), and any
 * `.`/`..` segment — a `gltf.src` must stay a plain relative path inside the
 * scene folder (spec §14.2).
 */
export function isSafeAssetPath(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0) return false;
  if (src.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return false;
  if (src.startsWith('/')) return false;
  const segments = src.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * The display `name` of a camera/probe/section entity (§5.6, §14.3): the trimmed
 * string, or `''` when absent/blank/non-string (which reads back as the default
 * `Camera N` / `Probe N` / `Section N`). Never an error.
 */
function readName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function hasTransform(o: Record<string, unknown>): boolean {
  return isVec3(o.position) && isQuat(o.rotation) && isVec3(o.scale);
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function parseGeometry(raw: unknown): GeometryObject[] | string {
  if (!Array.isArray(raw)) return 'geometry must be an array';
  const geometry: GeometryObject[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || !hasTransform(item)) return `geometry[${i}]: missing or invalid position/rotation/scale`;
    const { position, rotation, scale } = item as { position: Vec3; rotation: Quat; scale: Vec3 };
    switch (item.kind) {
      case 'room': {
        if (!isFiniteNumber(item.halfX) || !isFiniteNumber(item.halfZ) || !isFiniteNumber(item.height) || !isFiniteNumber(item.thickness)) {
          return `geometry[${i}]: room requires numeric halfX/halfZ/height/thickness`;
        }
        geometry.push({
          kind: 'room',
          halfX: item.halfX,
          halfZ: item.halfZ,
          height: item.height,
          thickness: item.thickness,
          position,
          rotation,
          scale,
        });
        break;
      }
      case 'box': {
        if (!isVec3(item.min) || !isVec3(item.max)) return `geometry[${i}]: box requires min/max as [x,y,z]`;
        geometry.push({ kind: 'box', min: item.min, max: item.max, position, rotation, scale });
        break;
      }
      case 'gltf': {
        if (typeof item.src !== 'string') return `geometry[${i}]: gltf requires a string src`;
        if (!isSafeAssetPath(item.src)) return `geometry[${i}]: unsafe gltf src "${item.src}"`;
        geometry.push({ kind: 'gltf', src: item.src, position, rotation, scale });
        break;
      }
      default:
        return `geometry[${i}]: unknown kind "${String(item.kind)}"`;
    }
  }
  return geometry;
}

function parseCameras(raw: unknown): SceneCamera[] | string {
  if (!Array.isArray(raw)) return 'cameras must be an array';
  const cameras: SceneCamera[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isVec3(item.position) || !isQuat(item.rotation) || !isFiniteNumber(item.fov)) {
      return `cameras[${i}]: requires id, position, rotation, fov`;
    }
    if (seenIds.has(item.id)) return `duplicate camera id "${item.id}"`;
    seenIds.add(item.id);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return `cameras[${i}]: enabled must be a boolean`;
    // `name` (§5.6) is optional on read; blank/missing reads as the default `Camera N`.
    // `enabled` (§5.4) is optional on read, defaulting to true when absent.
    const camera: SceneCamera = { id: item.id, name: readName(item.name), enabled: item.enabled !== false, position: item.position, rotation: item.rotation, fov: item.fov };
    if (item.aspect !== undefined) {
      if (!isFiniteNumber(item.aspect)) return `cameras[${i}]: aspect must be a number`;
      camera.aspect = item.aspect;
    }
    if (item.near !== undefined) {
      if (!isFiniteNumber(item.near)) return `cameras[${i}]: near must be a number`;
      camera.near = item.near;
    }
    if (item.far !== undefined) {
      if (!isFiniteNumber(item.far)) return `cameras[${i}]: far must be a number`;
      camera.far = item.far;
    }
    cameras.push(camera);
  }
  return cameras;
}

function parseProbes(raw: unknown): Probe[] | string {
  if (!Array.isArray(raw)) return 'probes must be an array';
  const probes: Probe[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isVec3(item.position)) return `probes[${i}]: requires id, position`;
    if (seenIds.has(item.id)) return `duplicate probe id "${item.id}"`;
    seenIds.add(item.id);
    // `name` (§12.1, §5.6) is optional on read; blank/missing reads as `Probe N`.
    probes.push({ id: item.id, position: item.position, name: readName(item.name) });
  }
  return probes;
}

function parseSections(raw: unknown): Section[] | string {
  if (!Array.isArray(raw)) return 'sections must be an array';
  const sections: Section[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    // `enabled` (current) or legacy `visible` (§14.3 back-compat).
    const enabledRaw = isRecord(item) ? (item.enabled ?? item.visible) : undefined;
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !SECTION_ORIENTATIONS.includes(item.orientation as never) ||
      !isFiniteNumber(item.min) ||
      !isFiniteNumber(item.max) ||
      !SECTION_AGGREGATIONS.includes(item.aggregation as never) ||
      typeof enabledRaw !== 'boolean'
    ) {
      return `sections[${i}]: requires id, orientation, min, max, aggregation, enabled`;
    }
    if (seenIds.has(item.id)) return `duplicate section id "${item.id}"`;
    seenIds.add(item.id);
    // `clipRange` (§13.9) is optional on read for back-compat: older files (and
    // files with no clip band set) default to a 2 m range. It is re-clamped to
    // the collapse-axis extent at render time (sectionClipBand). *Which* section
    // clips is the scene-level `clipSectionId`, parsed separately.
    const clipRange = isFiniteNumber(item.clipRange)
      ? Math.max(MIN_CLIP_RANGE, item.clipRange)
      : DEFAULT_CLIP_RANGE;
    sections.push({
      id: item.id,
      orientation: item.orientation as Section['orientation'],
      min: item.min,
      max: item.max,
      aggregation: item.aggregation as Section['aggregation'],
      enabled: enabledRaw,
      clipRange,
      // `name` (§13.1, §5.6) is optional on read; blank/missing reads as `Section N`.
      name: readName(item.name),
    });
  }
  return sections;
}

/** Parses `zones` (§14.3): each `{ id, name }`, ids unique, blank name → default. */
function parseZones(raw: unknown): Zone[] | string {
  if (raw === undefined) return []; // v1 file has none (§14.8)
  if (!Array.isArray(raw)) return 'zones must be an array';
  const zones: Zone[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string') return `zones[${i}]: requires a string id`;
    if (seenIds.has(item.id)) return `duplicate zone id "${item.id}"`;
    seenIds.add(item.id);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return `zones[${i}]: enabled must be a boolean`;
    // A missing/blank name reads as the default `Zone N`, never an error (§6.2, §14.8).
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    // `enabled` defaults to true when absent (§7.3).
    zones.push({ id: item.id, name: rawName.length > 0 ? rawName : defaultZoneName(item.id), enabled: item.enabled !== false });
  }
  return zones;
}

/**
 * Parses `volumes` (§14.3): each `{ id, zoneId, position, rotation, size }`, ids
 * unique, `size` components > 0, and every `zoneId` referencing an existing zone
 * (dangling reference rejected — referential integrity, §14.8).
 */
function parseVolumes(raw: unknown, zones: Zone[]): SamplingVolume[] | string {
  if (raw === undefined) return []; // v1 file has none (§14.8)
  if (!Array.isArray(raw)) return 'volumes must be an array';
  const zoneIds = new Set(zones.map((z) => z.id));
  const volumes: SamplingVolume[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.zoneId !== 'string' || !isVec3(item.position) || !isQuat(item.rotation) || !isVec3(item.size)) {
      return `volumes[${i}]: requires id, zoneId, position, rotation, size`;
    }
    if (seenIds.has(item.id)) return `duplicate volume id "${item.id}"`;
    seenIds.add(item.id);
    if (!zoneIds.has(item.zoneId)) return `volumes[${i}]: zoneId "${item.zoneId}" references no zone`;
    if (!(item.size[0] > 0 && item.size[1] > 0 && item.size[2] > 0)) return `volumes[${i}]: size components must be > 0`;
    volumes.push({ id: item.id, zoneId: item.zoneId, position: item.position, rotation: item.rotation, size: item.size });
  }
  return volumes;
}

/**
 * Validates and parses a `scene.json` document (spec §14.4, §14.8) — schema,
 * `formatVersion` (accepts 1 and 2; a v1 file reads with empty zones/volumes and
 * `useZones` false), geometry `kind`s + asset-path safety, id uniqueness within
 * each id-bearing category, and `volume.zoneId` referential integrity. Never
 * throws; the caller (`sceneIO.ts`) decides how to surface `{ ok: false }`.
 */
export function parseSceneFile(json: unknown): ParseResult {
  if (!isRecord(json)) return fail('scene.json must be a JSON object');
  if (typeof json.formatVersion !== 'number' || !SUPPORTED_FORMAT_VERSIONS.includes(json.formatVersion as never)) {
    return fail(`unsupported scene.json formatVersion "${String(json.formatVersion)}" (expected ${SUPPORTED_FORMAT_VERSIONS.join(' or ')})`);
  }

  const geometry = parseGeometry(json.geometry);
  if (typeof geometry === 'string') return fail(geometry);

  const cameras = parseCameras(json.cameras);
  if (typeof cameras === 'string') return fail(cameras);

  const probes = parseProbes(json.probes);
  if (typeof probes === 'string') return fail(probes);

  const sections = parseSections(json.sections);
  if (typeof sections === 'string') return fail(sections);

  const zones = parseZones(json.zones);
  if (typeof zones === 'string') return fail(zones);

  const volumes = parseVolumes(json.volumes, zones);
  if (typeof volumes === 'string') return fail(volumes);

  // Analysis setting; persisted, default false when absent (§14.3).
  if (json.useZones !== undefined && typeof json.useZones !== 'boolean') return fail('useZones must be a boolean');
  const useZones = json.useZones === true;

  // Which section clips (§13.9): optional, default null; an id that names no
  // loaded section is coerced to null so a stale reference never clips nothing.
  const clipSectionId =
    typeof json.clipSectionId === 'string' && sections.some((s) => s.id === json.clipSectionId)
      ? json.clipSectionId
      : null;

  return { ok: true, scene: { geometry, cameras, probes, sections, clipSectionId, zones, volumes, useZones } };
}

/**
 * Drops a blank display `name` so it is **omitted on write** (§14.3): an unnamed
 * entity has no `name` key (and reads back as its default), keeping files tidy. A
 * non-blank name is written trimmed.
 */
function stripBlankName<T extends { name: string }>(entity: T): Serialized<T> {
  const { name, ...rest } = entity;
  const trimmed = name.trim();
  return trimmed.length > 0 ? { ...rest, name: trimmed } : rest;
}

/**
 * Serializes a camera (§14.3): drops a blank `name` (like other entities) and
 * additionally omits `enabled` when `true`, so an enabled camera has no `enabled`
 * key and only `enabled: false` is written.
 */
function serializeCamera(camera: SceneCamera): SerializedCamera {
  const stripped = stripBlankName(camera);
  if (camera.enabled) {
    const { enabled: _enabled, ...rest } = stripped;
    return rest;
  }
  return stripped;
}

/** Serializes a `Scene` to the `scene.json` shape (spec §14.5) — a plain data copy. */
export function serializeScene(scene: Scene): SceneFileJSON {
  return {
    formatVersion: SCENE_FILE_FORMAT_VERSION,
    geometry: scene.geometry,
    // Camera/probe/section display names ride on the entity; blank names are
    // omitted on write (§5.6, §14.3). A camera's `enabled` is omitted when true.
    cameras: scene.cameras.map(serializeCamera),
    probes: scene.probes.map(stripBlankName),
    sections: scene.sections.map(stripBlankName),
    clipSectionId: scene.clipSectionId,
    zones: scene.zones,
    volumes: scene.volumes,
    useZones: scene.useZones,
  };
}
