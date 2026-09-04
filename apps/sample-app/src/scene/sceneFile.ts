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
  defaultFootprintForOrientation,
  MIN_CLIP_RANGE,
  SECTION_AGGREGATIONS,
  SECTION_ORIENTATIONS,
  type Section,
} from './sectionHeatmap.ts';
import type { Probe } from './probeVisibility.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Scene } from './sceneModel.ts';
import { defaultZoneName, type SamplingVolume, type Zone } from './samplingVolumes.ts';
import {
  constraintProblem,
  defaultConstraintName,
  defaultGroupName,
  groupProblem,
  type CameraConstraint,
  type ConstraintGroup,
  type ConstraintKind,
} from '../placement/region.ts';

/**
 * Version written by {@link serializeScene}: 2 for zones/volumes, 3 for camera
 * constraints (§14.3, `camera_placement.md` §9).
 */
export const SCENE_FILE_FORMAT_VERSION = 3;
/**
 * Versions {@link parseSceneFile} accepts (§14.8): a v1 file reads with empty
 * zones/volumes, and a v1 or v2 file with empty constraint groups/constraints.
 */
export const SUPPORTED_FORMAT_VERSIONS = [1, 2, 3] as const;

/** On-disk shape of a name-bearing entity: `name` is optional (§14.3 omit-on-write). */
type Serialized<T extends { name: string }> = Omit<T, 'name'> & { name?: string };

/**
 * On-disk camera shape (§14.3): `name` omitted when blank, and `enabled` omitted
 * when `true` (a camera is enabled by default, so only `enabled: false` is written).
 */
type SerializedCamera = Omit<SceneCamera, 'name' | 'enabled' | 'aimLocked'> & {
  name?: string;
  enabled?: boolean;
  aimLocked?: boolean;
  /** The constraint this camera is bound to (`camera_placement.md` §6.3); omitted when unbound. */
  constraintId?: string;
};

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
  /**
   * Camera-placement groups (§14.3, `camera_placement.md` §9). Each carries the
   * camera **template**, the pool size and the whole **strategy**, so a seeded analysis is
   * reproducible from the file that records its output.
   */
  constraintGroups: Serialized<ConstraintGroup>[];
  /** Mount regions belonging to groups (§14.3, `camera_placement.md` §9). */
  constraints: Serialized<CameraConstraint>[];
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
    if (item.aimLocked !== undefined && typeof item.aimLocked !== 'boolean') return `cameras[${i}]: aimLocked must be a boolean`;
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
    // `aimLocked` (aim_optimization.md §9) is optional on read, absent ⇒ false,
    // and only written when true — so it is back-compatible and needs no version
    // bump, exactly like `enabled` and `name`.
    if (item.aimLocked === true) camera.aimLocked = true;
    // `constraintId` (`camera_placement.md` §9) is optional on read and only
    // written when bound. Referential integrity is checked once the constraints
    // are parsed, since the arrays are read in file order.
    if (item.constraintId !== undefined) {
      if (typeof item.constraintId !== 'string') return `cameras[${i}]: constraintId must be a string`;
      camera.constraintId = item.constraintId;
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
    // Footprint bounds (§13.1) are optional on read (§14.3): a bound that is
    // absent/invalid becomes `NaN` here and is defaulted to the full workspace-AABB
    // extent by `resolveSectionFootprints` once the AABB is known (sceneIO), so
    // files predating finite footprints load spanning the whole workspace in-plane.
    sections.push({
      id: item.id,
      orientation: item.orientation as Section['orientation'],
      min: item.min,
      max: item.max,
      minA: isFiniteNumber(item.minA) ? item.minA : Number.NaN,
      maxA: isFiniteNumber(item.maxA) ? item.maxA : Number.NaN,
      minB: isFiniteNumber(item.minB) ? item.minB : Number.NaN,
      maxB: isFiniteNumber(item.maxB) ? item.maxB : Number.NaN,
      aggregation: item.aggregation as Section['aggregation'],
      enabled: enabledRaw,
      clipRange,
      // `name` (§13.1, §5.6) is optional on read; blank/missing reads as `Section N`.
      name: readName(item.name),
    });
  }
  return sections;
}

/**
 * Fills in any section footprint bound left `NaN` by {@link parseSceneFile} with
 * the full workspace-AABB extent along that in-plane axis (spec §14.3), resolved
 * per axis-pair. Called by `sceneIO` once the imported geometry's AABB is built,
 * since the default depends on the workspace bounds. A section with a complete
 * footprint is returned unchanged.
 */
export function resolveSectionFootprints(sections: Section[], worldMin: Vec3, worldMax: Vec3): Section[] {
  return sections.map((s) => {
    const aSet = Number.isFinite(s.minA) && Number.isFinite(s.maxA);
    const bSet = Number.isFinite(s.minB) && Number.isFinite(s.maxB);
    if (aSet && bSet) return s;
    const full = defaultFootprintForOrientation(worldMin, worldMax, s.orientation);
    return {
      ...s,
      minA: aSet ? s.minA : full.minA,
      maxA: aSet ? s.maxA : full.maxA,
      minB: bSet ? s.minB : full.minB,
      maxB: bSet ? s.maxB : full.maxB,
    };
  });
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

const CONSTRAINT_KINDS: ConstraintKind[] = ['point', 'polyline', 'plane'];

/**
 * Parses `constraintGroups` (§14.3, `camera_placement.md` §9): each carries the
 * camera template, the pool size, the strategy and its **target zones**, ids
 * unique, blank name → default.
 *
 * Takes the parsed `zones` so a `zoneIds` entry naming no live zone can be
 * dropped, as `parseVolumes` already drops an orphan volume.
 *
 * All three are validated by `groupProblem` — the same predicate
 * the panels use — so an imported group and a hand-edited one are rejected for
 * the same reasons, in the same words.
 */
function parseConstraintGroups(raw: unknown, zones: Zone[]): ConstraintGroup[] | string {
  const liveZones = new Set(zones.map((z) => z.id));
  if (raw === undefined) return []; // v1/v2 file (§14.8)
  if (!Array.isArray(raw)) return 'constraintGroups must be an array';
  const groups: ConstraintGroup[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string') return `constraintGroups[${i}]: requires a string id`;
    if (seenIds.has(item.id)) return `duplicate constraint group id "${item.id}"`;
    seenIds.add(item.id);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      return `constraintGroups[${i}]: enabled must be a boolean`;
    }
    if (item.namePrefix !== undefined && typeof item.namePrefix !== 'string') {
      return `constraintGroups[${i}]: namePrefix must be a string`;
    }
    // `aspect` and `near` are deliberately absent: a group carried them before
    // they became placement-wide constants (`camera_placement.md` §3.1.1), so an
    // older file's keys are read past rather than validated or kept.
    const numbers = ['fov', 'far', 'poolSize', 'maxCount', 'trials', 'epsilon', 'seed'] as const;
    for (const key of numbers) {
      if (!isFiniteNumber(item[key])) return `constraintGroups[${i}]: ${key} must be a number`;
    }
    // Target zones (`camera_placement.md` §3.1.2, §9) are **optional on read**:
    // a v3 file written before the feature has none, and the defaults reproduce
    // its behaviour exactly. Additive, so no version bump.
    if (item.zoneIds !== undefined && !Array.isArray(item.zoneIds)) {
      return `constraintGroups[${i}]: zoneIds must be an array`;
    }
    for (const flag of ['restrictScoring', 'restrictMounts'] as const) {
      if (item[flag] !== undefined && typeof item[flag] !== 'boolean') {
        return `constraintGroups[${i}]: ${flag} must be a boolean`;
      }
    }
    // An id naming no live zone is **dropped**, not rejected — the same
    // treatment `parseVolumes` gives a dangling `zoneId`. A scene that
    // legitimately lost a zone through editing must still reload.
    const zoneIds = Array.isArray(item.zoneIds)
      ? [...new Set((item.zoneIds as unknown[]).filter((z): z is string => typeof z === 'string'))].filter(
          (z) => liveZones.has(z),
        )
      : [];
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const group: ConstraintGroup = {
      id: item.id,
      name: rawName.length > 0 ? rawName : defaultGroupName(item.id),
      enabled: item.enabled !== false,
      fov: item.fov as number,
      far: item.far as number,
      namePrefix: typeof item.namePrefix === 'string' ? item.namePrefix : '',
      zoneIds,
      restrictScoring: item.restrictScoring !== false,
      restrictMounts: item.restrictMounts === true,
      poolSize: item.poolSize as number,
      maxCount: item.maxCount as number,
      trials: item.trials as number,
      epsilon: item.epsilon as number,
      seed: item.seed as number,
    };
    const problem = groupProblem(group);
    if (problem) return `constraintGroups[${i}]: ${problem}`;
    groups.push(group);
  }
  return groups;
}

/**
 * Parses `constraints` (§14.3, `camera_placement.md` §9): each `{ id, groupId,
 * name, enabled, kind, distance }` plus its per-kind geometry, ids unique, every
 * `groupId` resolving to a parsed group.
 */
function parseConstraints(raw: unknown, groups: ConstraintGroup[]): CameraConstraint[] | string {
  if (raw === undefined) return []; // v1/v2 file (§14.8)
  if (!Array.isArray(raw)) return 'constraints must be an array';
  const groupIds = new Set(groups.map((g) => g.id));
  const constraints: CameraConstraint[] = [];
  const seenIds = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.groupId !== 'string') {
      return `constraints[${i}]: requires id and groupId`;
    }
    if (seenIds.has(item.id)) return `duplicate constraint id "${item.id}"`;
    seenIds.add(item.id);
    if (!groupIds.has(item.groupId)) {
      return `constraints[${i}]: groupId "${item.groupId}" references no constraint group`;
    }
    if (!CONSTRAINT_KINDS.includes(item.kind as never)) {
      return `constraints[${i}]: kind must be one of ${CONSTRAINT_KINDS.join(', ')}`;
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      return `constraints[${i}]: enabled must be a boolean`;
    }
    if (!isFiniteNumber(item.distance)) return `constraints[${i}]: distance must be a number`;
    const rawName = typeof item.name === 'string' ? item.name.trim() : '';
    const base = {
      id: item.id,
      groupId: item.groupId,
      name: rawName.length > 0 ? rawName : defaultConstraintName(item.id),
      enabled: item.enabled !== false,
      distance: item.distance,
    };
    let constraint: CameraConstraint;
    switch (item.kind as ConstraintKind) {
      case 'point':
        if (!isVec3(item.position)) return `constraints[${i}]: point requires position`;
        constraint = { ...base, kind: 'point', position: item.position };
        break;
      case 'polyline':
        if (!Array.isArray(item.points) || !item.points.every(isVec3)) {
          return `constraints[${i}]: polyline requires an array of [x,y,z] points`;
        }
        constraint = { ...base, kind: 'polyline', points: item.points as Vec3[] };
        break;
      case 'plane': {
        const size = item.size;
        if (!isVec3(item.position) || !isQuat(item.rotation)) {
          return `constraints[${i}]: plane requires position and rotation`;
        }
        if (!Array.isArray(size) || size.length !== 2 || !size.every(isFiniteNumber)) {
          return `constraints[${i}]: plane requires a two-number size`;
        }
        constraint = {
          ...base,
          kind: 'plane',
          position: item.position,
          rotation: item.rotation,
          size: [size[0], size[1]],
        };
        break;
      }
    }
    const problem = constraintProblem(constraint);
    if (problem) return `constraints[${i}]: ${problem}`;
    constraints.push(constraint);
  }
  return constraints;
}

/**
 * Validates and parses a `scene.json` document (spec §14.4, §14.8) — schema,
 * `formatVersion` (accepts 1, 2 and 3; a v1 file reads with empty zones/volumes
 * and `useZones` false, a v1/v2 file with no constraint groups), geometry
 * `kind`s + asset-path safety, id uniqueness within each id-bearing category,
 * and the `volume.zoneId` / `constraint.groupId` / `camera.constraintId`
 * referential integrity. Never throws; the caller (`sceneIO.ts`) decides how to
 * surface `{ ok: false }`.
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

  const constraintGroups = parseConstraintGroups(json.constraintGroups, zones);
  if (typeof constraintGroups === 'string') return fail(constraintGroups);

  const constraints = parseConstraints(json.constraints, constraintGroups);
  if (typeof constraints === 'string') return fail(constraints);

  // A camera's binding is checked here rather than in `parseCameras`, which runs
  // before the constraints exist. A dangling binding is rejected outright: it
  // would otherwise read as an unclamped camera the user believes is on a rail
  // (`camera_placement.md` §6.3, spec §14.8).
  const constraintIds = new Set(constraints.map((c) => c.id));
  for (const camera of cameras) {
    if (camera.constraintId !== undefined && !constraintIds.has(camera.constraintId)) {
      return fail(`camera "${camera.id}": constraintId "${camera.constraintId}" references no constraint`);
    }
  }

  // Which section clips (§13.9): optional, default null; an id that names no
  // loaded section is coerced to null so a stale reference never clips nothing.
  const clipSectionId =
    typeof json.clipSectionId === 'string' && sections.some((s) => s.id === json.clipSectionId)
      ? json.clipSectionId
      : null;

  return {
    ok: true,
    scene: {
      geometry,
      cameras,
      probes,
      sections,
      clipSectionId,
      zones,
      volumes,
      useZones,
      constraintGroups,
      constraints,
    },
  };
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
 * additionally omits `enabled` when `true` and `aimLocked` when falsy, so a
 * default camera carries neither key (§14.3, `aim_optimization.md` §9).
 */
function serializeCamera(camera: SceneCamera): SerializedCamera {
  const stripped = stripBlankName(camera);
  const withoutLock = camera.aimLocked
    ? stripped
    : (() => {
        const { aimLocked: _aimLocked, ...rest } = stripped;
        return rest;
      })();
  // `constraintId` is written only when bound (`camera_placement.md` §9).
  const withoutBinding =
    camera.constraintId !== undefined
      ? withoutLock
      : (() => {
          const { constraintId: _constraintId, ...rest } = withoutLock;
          return rest;
        })();
  if (camera.enabled) {
    const { enabled: _enabled, ...rest } = withoutBinding;
    return rest;
  }
  return withoutBinding;
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
    // Groups and constraints carry user-edited names, stripped when blank like
    // every other entity (§14.3). The strategy rides on the group, so a
    // seeded search reproduces from the file (`camera_placement.md` §9).
    constraintGroups: scene.constraintGroups.map(stripBlankName),
    constraints: scene.constraints.map(stripBlankName),
  };
}
