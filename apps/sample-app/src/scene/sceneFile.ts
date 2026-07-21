/**
 * Pure `scene.json` schema, validation, and (de)serialization (spec §14.3,
 * §14.8). No file I/O here — `sceneIO.ts` handles reading/writing/asset
 * resolution and is the only impure layer, kept thin so this module (the part
 * with real decision logic) is directly unit-testable.
 */
import type { CameraConfig, Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import { SECTION_AGGREGATIONS, SECTION_ORIENTATIONS, type Section } from './sectionHeatmap.ts';
import type { Probe } from './probeVisibility.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Scene } from './sceneModel.ts';

export const SCENE_FILE_FORMAT_VERSION = 1;

export interface SceneFileJSON {
  formatVersion: number;
  geometry: GeometryObject[];
  cameras: CameraConfig[];
  probes: Probe[];
  sections: Section[];
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

function parseCameras(raw: unknown): CameraConfig[] | string {
  if (!Array.isArray(raw)) return 'cameras must be an array';
  const cameras: CameraConfig[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isVec3(item.position) || !isQuat(item.rotation) || !isFiniteNumber(item.fov)) {
      return `cameras[${i}]: requires id, position, rotation, fov`;
    }
    if (seenIds.has(item.id)) return `duplicate camera id "${item.id}"`;
    seenIds.add(item.id);
    const camera: CameraConfig = { id: item.id, position: item.position, rotation: item.rotation, fov: item.fov };
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
    probes.push({ id: item.id, position: item.position });
  }
  return probes;
}

function parseSections(raw: unknown): Section[] | string {
  if (!Array.isArray(raw)) return 'sections must be an array';
  const sections: Section[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !SECTION_ORIENTATIONS.includes(item.orientation as never) ||
      !isFiniteNumber(item.min) ||
      !isFiniteNumber(item.max) ||
      !SECTION_AGGREGATIONS.includes(item.aggregation as never) ||
      typeof item.visible !== 'boolean'
    ) {
      return `sections[${i}]: requires id, orientation, min, max, aggregation, visible`;
    }
    if (seenIds.has(item.id)) return `duplicate section id "${item.id}"`;
    seenIds.add(item.id);
    sections.push({
      id: item.id,
      orientation: item.orientation as Section['orientation'],
      min: item.min,
      max: item.max,
      aggregation: item.aggregation as Section['aggregation'],
      visible: item.visible,
    });
  }
  return sections;
}

/**
 * Validates and parses a `scene.json` document (spec §14.4, §14.8) — schema,
 * `formatVersion`, geometry `kind`s + asset-path safety, and id uniqueness
 * within each of `cameras`/`probes`/`sections` (geometry objects carry no id,
 * per the format — only those three categories do). Never throws; the caller
 * (`sceneIO.ts`) decides how to surface `{ ok: false }`.
 */
export function parseSceneFile(json: unknown): ParseResult {
  if (!isRecord(json)) return fail('scene.json must be a JSON object');
  if (json.formatVersion !== SCENE_FILE_FORMAT_VERSION) {
    return fail(`unsupported scene.json formatVersion "${String(json.formatVersion)}" (expected ${SCENE_FILE_FORMAT_VERSION})`);
  }

  const geometry = parseGeometry(json.geometry);
  if (typeof geometry === 'string') return fail(geometry);

  const cameras = parseCameras(json.cameras);
  if (typeof cameras === 'string') return fail(cameras);

  const probes = parseProbes(json.probes);
  if (typeof probes === 'string') return fail(probes);

  const sections = parseSections(json.sections);
  if (typeof sections === 'string') return fail(sections);

  return { ok: true, scene: { geometry, cameras, probes, sections } };
}

/** Serializes a `Scene` to the `scene.json` shape (spec §14.5) — a plain data copy. */
export function serializeScene(scene: Scene): SceneFileJSON {
  return {
    formatVersion: SCENE_FILE_FORMAT_VERSION,
    geometry: scene.geometry,
    cameras: scene.cameras,
    probes: scene.probes,
    sections: scene.sections,
  };
}
