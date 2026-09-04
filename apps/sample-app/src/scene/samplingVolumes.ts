/**
 * Sampling zones (region-of-interest analysis) — `sampling_volumes.md`.
 *
 * Pure data layer, no Three.js (gizmos live in `samplingVolumeGizmos.ts`). Owns:
 *  - the {@link Zone} / {@link SamplingVolume} entities (§2.1);
 *  - the oriented-box point-membership test (§2.3) and world-AABB of an OBB (§7.1);
 *  - BVH-seeded generation of zones+volumes (§3), reusing the SDK's own
 *    `cleanMesh`/`buildBvh` client-side so nothing new crosses the worker boundary;
 *  - the shape of a per-zone summary, and the one derivation that turns an SDK
 *    group accumulator into it (§7.2).
 *
 * The per-zone scan itself is **not** here any more: a zone is an aggregation
 * group and a volume is an aggregation region, both evaluated in the worker next
 * to the masks (`sampling_volumes.md` §7.2, `spec.md` §3.3). The marked-set
 * filter went the same way — it is `maskRegions` on the descriptor, not a
 * closure over voxel centers, because a closure cannot cross a Worker boundary.
 */
import {
  buildBvh,
  cleanMesh,
  type Bvh,
  type Quat,
  type RegionAccum,
  type SamplingRegion,
  type SceneMesh,
  type Vec3,
} from '@linkervision/camera-coverage-sdk';
import type { RunCameras } from './runCameras.ts';
import { applyQuat, applyQuatConj } from './quatMath.ts';

// --- Entities (§2.1) ---------------------------------------------------------

/** A user-placed, editable oriented box (OBB). Belongs to exactly one zone. */
export interface SamplingVolume {
  id: string; // 'volume-N', unique across all volumes
  zoneId: string; // the owning zone (exactly one, §2.2)
  position: Vec3; // box center, world meters
  rotation: Quat; // orientation [x,y,z,w]; identity = axis-aligned
  size: Vec3; // full edge lengths (m) along local X/Y/Z, all > 0
}

/** A named unit of volumes with its own coverage results. */
export interface Zone {
  id: string; // 'zone-N', unique, stable identity (never renamed)
  name: string; // user-editable display label (§6.2); defaults to 'Zone N'
  /**
   * Whether this zone contributes to the visualized/aggregated marked set (§7.3),
   * like a camera's enabled state or a section's. Independent per zone — the
   * marked set is the union of all **enabled** zones' volumes. Default true.
   */
  enabled: boolean;
}

/**
 * Absolute floor (~5 cm) under the per-axis minimum volume size (§5) — guards the
 * degenerate case where `voxelSize` itself is tiny.
 */
export const MIN_VOLUME_SIZE_FLOOR = 0.05;

/**
 * Minimum per-axis size of a volume (§5): **at least a voxel** (`≥ voxelSize`),
 * floored at {@link MIN_VOLUME_SIZE_FLOOR} so a box never degenerates below a
 * sampling voxel. Callers pass the current `voxelSize`; a volume smaller than a
 * voxel could sample nothing.
 */
export function minVolumeSize(voxelSize: number): number {
  return Math.max(voxelSize, MIN_VOLUME_SIZE_FLOOR);
}

/** The default 'Zone N' label derived from a `zone-N` id (§6.2). */
export function defaultZoneName(id: string): string {
  const m = /^zone-(\d+)$/.exec(id);
  return m ? `Zone ${m[1]}` : id;
}

/**
 * The label to display for a zone (§6.2): the trimmed `name`, or the default
 * `Zone N` when it is blank/all-whitespace. Never returns an empty string.
 */
export function zoneLabel(zone: Zone): string {
  const trimmed = zone.name.trim();
  return trimmed.length > 0 ? trimmed : defaultZoneName(zone.id);
}

// --- OBB math (§2.3, §7.1) ---------------------------------------------------

/** World point `p` inside oriented box `v`? (§2.3). */
export function inVolume(p: Vec3, v: SamplingVolume): boolean {
  const local = applyQuatConj(v.rotation, [p[0] - v.position[0], p[1] - v.position[1], p[2] - v.position[2]]);
  return (
    Math.abs(local[0]) <= v.size[0] / 2 &&
    Math.abs(local[1]) <= v.size[1] / 2 &&
    Math.abs(local[2]) <= v.size[2] / 2
  );
}

/** World point `p` inside any of a zone's volumes? (§2.3). */
export function inZone(p: Vec3, zoneVolumes: SamplingVolume[]): boolean {
  return zoneVolumes.some((v) => inVolume(p, v));
}

/**
 * The volumes belonging to any of `zoneIds` — a constraint group's **target
 * volumes** (`camera_placement.md` §3.1.2).
 *
 * Ids naming no live zone simply match nothing, which is what lets the placement
 * side treat a stale reference as absent rather than as an error; the reducer
 * prunes them eagerly anyway (`camera_placement.md` §7).
 */
export function volumesOfZones(
  volumes: readonly SamplingVolume[],
  zoneIds: readonly string[],
): SamplingVolume[] {
  if (zoneIds.length === 0) return [];
  const wanted = new Set(zoneIds);
  return volumes.filter((v) => wanted.has(v.zoneId));
}

/** World point `p` inside any of these volumes? The §4.1.1 mount test. */
export function inAnyVolume(p: Vec3, volumes: readonly SamplingVolume[]): boolean {
  for (const v of volumes) if (inVolume(p, v)) return true;
  return false;
}

/** The world AABB of an oriented box: transform its 8 corners, take min/max (§7.1). */
export function obbWorldAabb(v: SamplingVolume): { min: Vec3; max: Vec3 } {
  const hx = v.size[0] / 2;
  const hy = v.size[1] / 2;
  const hz = v.size[2] / 2;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const world = applyQuat(v.rotation, [sx * hx, sy * hy, sz * hz]);
        for (let d = 0; d < 3; d++) {
          const c = v.position[d] + world[d];
          if (c < min[d]) min[d] = c;
          if (c > max[d]) max[d] = c;
        }
      }
    }
  }
  return { min, max };
}

/**
 * SDK sampling regions for a run (§7.1): the world AABB of every volume across
 * every zone (axis-aligned volumes give an exact box; rotated ones a conservative
 * superset refined client-side), or the full volume when zones are inactive.
 */
export function regionsFromVolumes(active: boolean, volumes: SamplingVolume[]): SamplingRegion[] {
  if (!active) return [{ type: 'full' }];
  return volumes.map((v) => {
    const { min, max } = obbWorldAabb(v);
    return { type: 'box', min, max };
  });
}

// --- BVH seeding (§3) --------------------------------------------------------

const BVH_NODE_WORDS = 8;
const BVH_INVALID = 0xffffffff;

/** Zone-level slider bounds & default (§3.4). */
export const MIN_ZONE_LEVEL = 0;
export const MAX_ZONE_LEVEL = 6;
export const DEFAULT_ZONE_LEVEL = 2;
/** Box-level slider bounds & default (§3.4); clamped to ≥ zoneLevel. */
export const MAX_BOX_LEVEL = 8;
export const DEFAULT_BOX_LEVEL = 4;

/**
 * Build the app-side BVH from the merged world-space collision mesh (§3.1) —
 * identical to the worker's (both use the default TS kernels). The caller caches
 * the result and re-{@link extractZonesAndVolumes} on level-slider changes,
 * invalidating only when scene geometry changes (§11).
 */
export function buildSceneBvh(sceneMesh: SceneMesh): Bvh {
  return buildBvh(cleanMesh(sceneMesh));
}

/**
 * Seed zones + volumes from the scene mesh's BVH (§3): build then cut at two
 * levels — a shallow **zone level** (one zone per node) and a finer **box level**
 * (each zone's subtree → volumes). Returns freshly-numbered `zone-N` / `volume-N`
 * entities; the caller replaces its whole set with the result (§3.4). An empty
 * scene yields nothing. (Convenience wrapper over {@link buildSceneBvh} +
 * {@link extractZonesAndVolumes}; callers that cache the BVH use those directly.)
 */
export function generateZonesAndVolumes(
  sceneMesh: SceneMesh,
  zoneLevel: number,
  boxLevel: number,
  voxelSize: number,
): { zones: Zone[]; volumes: SamplingVolume[] } {
  const bvh = buildSceneBvh(sceneMesh);
  return extractZonesAndVolumes(bvh.f32, bvh.u32, bvh.nodeCount, bvh.triangleCount, zoneLevel, boxLevel, voxelSize);
}

/**
 * The pure node-array walk behind {@link generateZonesAndVolumes} — split out so
 * it is unit-testable against a hand-built BVH node array without a mesh. `f32`
 * (AABB) and `u32` (miss link / prim) are the interleaved 8-word/node views
 * (`sampling_volumes.md` §3.2).
 */
export function extractZonesAndVolumes(
  f32: Float32Array,
  u32: Uint32Array,
  nodeCount: number,
  triangleCount: number,
  zoneLevel: number,
  boxLevel: number,
  voxelSize: number,
): { zones: Zone[]; volumes: SamplingVolume[] } {
  const zones: Zone[] = [];
  const volumes: SamplingVolume[] = [];
  const minSize = minVolumeSize(voxelSize);
  // Empty scene: the flatten leaves a single sentinel root (inverted AABB); it
  // yields no zone (§3.4).
  if (nodeCount === 0 || triangleCount === 0) return { zones, volumes };

  const clampedBox = Math.max(boxLevel, zoneLevel);
  let zoneCount = 0;
  let volumeCount = 0;

  const isLeaf = (node: number): boolean => u32[node * BVH_NODE_WORDS + 7] !== 0;
  const rightOf = (node: number): number => u32[(node + 1) * BVH_NODE_WORDS + 3];
  const isSentinel = (node: number): boolean => {
    const b = node * BVH_NODE_WORDS;
    // The empty-scene sentinel is an inverted AABB (min 1e30, max -1e30).
    return f32[b] > f32[b + 4];
  };

  const cutBoxes = (node: number, level: number, zoneId: string): void => {
    if (isLeaf(node) || level === clampedBox) {
      const b = node * BVH_NODE_WORDS;
      const size: Vec3 = [
        Math.max(minSize, f32[b + 4] - f32[b]),
        Math.max(minSize, f32[b + 5] - f32[b + 1]),
        Math.max(minSize, f32[b + 6] - f32[b + 2]),
      ];
      volumeCount += 1;
      volumes.push({
        id: `volume-${volumeCount}`,
        zoneId,
        position: [(f32[b] + f32[b + 4]) / 2, (f32[b + 1] + f32[b + 5]) / 2, (f32[b + 2] + f32[b + 6]) / 2],
        rotation: [0, 0, 0, 1],
        size,
      });
      return;
    }
    const left = node + 1;
    const right = rightOf(node);
    cutBoxes(left, level + 1, zoneId);
    cutBoxes(right, level + 1, zoneId);
  };

  const cutZones = (node: number, level: number): void => {
    if (isSentinel(node)) return;
    if (isLeaf(node) || level === zoneLevel) {
      zoneCount += 1;
      const id = `zone-${zoneCount}`;
      zones.push({ id, name: defaultZoneName(id), enabled: true });
      cutBoxes(node, level, id);
      return;
    }
    const left = node + 1;
    const right = rightOf(node);
    cutZones(left, level + 1);
    cutZones(right, level + 1);
  };

  cutZones(0, 0);
  return { zones, volumes };
}

// --- Per-zone aggregation (§7.2) ---------------------------------------------

/** The per-zone (or all-zones union) coverage summary over `M(z)` (§7.2, §7.4). */
export interface ZoneSummary {
  /** Valid voxels in the marked set — `|M(z)|`. */
  validVoxels: number;
  /** Fraction covered by ≥1 camera. 0 when `validVoxels === 0`. */
  overallRate: number;
  /** Valid voxels no enabled camera sees. */
  blindVoxels: number;
  /** Per enabled camera: fraction of `M(z)` it sees. */
  perCamera: { id: string; coverageRate: number }[];
}

/** The full client-side aggregation result for one run (§7.2, §7.4, §6.3). */
export interface ZoneCoverage {
  /** One summary per zone id, over `M(z)` — for every zone, enabled or not. */
  perZone: Map<string, ZoneSummary>;
  /** The **enabled**-zones union summary (each voxel counted once) — drives the
   * overlay/sections/main stats (§7.3, §7.4). */
  enabledUnion: ZoneSummary;
}

/**
 * Turn one group's accumulator into a {@link ZoneSummary} (§7.2).
 *
 * `null` means the zone declared no group — it holds no volumes, or it fell past
 * the descriptor's zone cap (`spec.md` §3.3). Either way the honest answer is an
 * all-zero summary, which the panel already renders as "no marked voxels",
 * rather than a missing entry every caller would have to handle.
 *
 * `seen` is indexed by **mask-bit index**, not by position among the enabled
 * cameras: a disabled camera keeps its slot (`spec.md` §5.4), so `cams.bits` is
 * what bridges the two.
 */
export function summaryFromAccum(a: RegionAccum | null, cams: RunCameras): ZoneSummary {
  const valid = a?.valid ?? 0;
  return {
    validVoxels: valid,
    overallRate: valid > 0 ? a!.covered / valid : 0,
    blindVoxels: a?.blind ?? 0,
    perCamera: cams.ids.map((id, n) => ({
      id,
      coverageRate: valid > 0 ? a!.seen[cams.bits[n]] / valid : 0,
    })),
  };
}
