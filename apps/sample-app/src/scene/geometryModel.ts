/**
 * Geometry data model (spec §14.1, §14.3, `geometry_assets.md` §2) + pure
 * triangle-mesh math shared by the default room and by imported **mesh**
 * geometry (§14.6). No Three.js state mutation here — `transformTriMesh` builds
 * new typed arrays; callers own `THREE.BufferGeometry`/materials.
 *
 * A geometry object is the **inverse of a splat** (`geometry_assets.md` §1.1):
 * it contributes triangles to the merged collision mesh and bounds to the
 * workspace AABB, so every edit to one marks the coverage result stale.
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

export interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Common transform every geometry object carries (spec §14.3). Identity for the default scene. */
export interface GeometryTransform {
  position: Vec3;
  rotation: Quat;
  /**
   * **Per-axis.** A triangle mesh takes a non-uniform scale correctly — the
   * uniform-scale restriction a splat carries exists only because scaling a
   * Gaussian's covariance non-uniformly shears it (`gaussian_splats.md` §2.1),
   * and no triangle has a covariance (`geometry_assets.md` §7).
   */
  scale: Vec3;
}

/**
 * What every geometry object carries besides its shape (`geometry_assets.md`
 * §2.1): the identity a hierarchy row selects by, the label it shows, and the
 * flag that decides whether the object is in the scene at all.
 *
 * `enabled: false` is **not** a draw toggle: the object contributes no triangles
 * and no bounds either (§5.1). That is the one checkbox in this app whose
 * position changes a coverage number, and it is why toggling one marks the
 * result stale.
 */
export interface GeometryBase extends GeometryTransform {
  /** `geom-N`. */
  id: string;
  /** User-edited display label; blank falls back to {@link geometryLabel}. */
  name: string;
  /** Whether the object is in the scene — drawn *and* measured (§5.1). */
  enabled: boolean;
}

export interface RoomGeometryObject extends GeometryBase {
  kind: 'room';
  halfX: number;
  halfZ: number;
  height: number;
  thickness: number;
}

export interface BoxGeometryObject extends GeometryBase {
  kind: 'box';
  /** Axis-aligned bounds in the object's local frame (spec §14.3). */
  min: Vec3;
  max: Vec3;
}

/**
 * One asset-backed object (`geometry_assets.md` §2.2) — the single kind for all
 * four accepted formats, with the loader chosen by the `src` extension.
 *
 * **Not a kind per format.** `'gltf' | 'ply' | 'obj'` would be three branches
 * doing the same thing, and a file's `kind` could then contradict its own
 * extension — a state nothing can resolve. Legacy `kind: "gltf"` files read as
 * this (`sceneFile.ts`), so there is one name for asset-backed geometry at any
 * moment rather than two depending on when the file was written.
 */
export interface MeshGeometryObject extends GeometryBase {
  kind: 'mesh';
  /** Path relative to the scene folder root (spec §14.2), e.g. `assets/site/rack.obj`. */
  src: string;
}

export type GeometryObject = RoomGeometryObject | BoxGeometryObject | MeshGeometryObject;

/** The mesh-asset extensions the app accepts (`geometry_assets.md` §3.1). */
export const MESH_EXTENSIONS = ['.glb', '.gltf', '.ply', '.obj'] as const;

/** Whether a file name carries one of the accepted mesh extensions (§3.1). */
export function isMeshFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return MESH_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/** A fresh identity transform (own arrays, safe to attach to any geometry object). */
export function identityTransform(): GeometryTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

/** The last path segment of a folder-relative `src` (`assets/site.glb` → `site.glb`). */
export function basename(src: string): string {
  const at = src.lastIndexOf('/');
  return at < 0 ? src : src.slice(at + 1);
}

/** The ordinal-fallback word for each kind (`geometry_assets.md` §2.4). */
const KIND_WORD: Record<GeometryObject['kind'], string> = { room: 'Room', box: 'Box', mesh: 'Mesh' };

/**
 * A geometry row's display label (`geometry_assets.md` §2.4): its own `name`,
 * else — for a **mesh** — the basename of its `src`, else the ordinal **within
 * its own kind**.
 *
 * A mesh follows the splat rule and for the same reason (`spec.md` §14.2, "the
 * filename is the scene's name"): an asset-backed object's identity is its file,
 * so two unnamed rows on two files stay distinguishable and a duplicated row
 * reads as a duplicate. A room or a box has no file, so it takes `Room 1` /
 * `Box 3` — numbered per kind, because `Geometry 4` says nothing about what the
 * row is.
 *
 * `ordinal` is the object's 1-based position **among objects of its own kind**;
 * {@link geometryLabels} is what computes it for a whole list.
 */
export function geometryLabel(object: GeometryObject, ordinal: number): string {
  const trimmed = object.name.trim();
  if (trimmed.length > 0) return trimmed;
  if (object.kind === 'mesh') return basename(object.src);
  return `${KIND_WORD[object.kind]} ${ordinal}`;
}

/** Every object's label, with the per-kind ordinals resolved (`geometry_assets.md` §2.4). */
export function geometryLabels(objects: readonly GeometryObject[]): string[] {
  const seen = new Map<GeometryObject['kind'], number>();
  return objects.map((o) => {
    const ordinal = (seen.get(o.kind) ?? 0) + 1;
    seen.set(o.kind, ordinal);
    return geometryLabel(o, ordinal);
  });
}

/** Axis-aligned box, 6 faces x 4 verts (flat-shaded), CCW winding viewed from outside. */
export function boxTris(min: Vec3, max: Vec3): TriMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const verts: number[] = [];
  const idx: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const base = verts.length / 3;
    verts.push(...a, ...b, ...c, ...d);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // +Y
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -Z
  return { positions: new Float32Array(verts), indices: new Uint32Array(idx) };
}

/** Floor + 4 walls, open top, parameterized (spec §4.1, §14.3's `room` kind). */
export function roomTris(halfX: number, halfZ: number, height: number, thickness: number): TriMesh[] {
  const t = thickness;
  const hx = halfX;
  const hz = halfZ;
  const h = height;
  const floor = boxTris([-hx - t, -t, -hz - t], [hx + t, 0, hz + t]);
  const wallN = boxTris([-hx - t, 0, hz], [hx + t, h, hz + t]);
  const wallS = boxTris([-hx - t, 0, -hz - t], [hx + t, h, -hz]);
  const wallE = boxTris([hx, 0, -hz], [hx + t, h, hz]);
  const wallW = boxTris([-hx - t, 0, -hz], [-hx, h, hz]);
  return [floor, wallN, wallS, wallE, wallW];
}

export function mergeTris(pieces: TriMesh[]): TriMesh {
  let vertCount = 0;
  let idxCount = 0;
  for (const p of pieces) {
    vertCount += p.positions.length;
    idxCount += p.indices.length;
  }
  const positions = new Float32Array(vertCount);
  const indices = new Uint32Array(idxCount);
  let vOff = 0;
  let iOff = 0;
  let baseVertex = 0;
  for (const p of pieces) {
    positions.set(p.positions, vOff);
    for (let i = 0; i < p.indices.length; i++) indices[iOff + i] = p.indices[i] + baseVertex;
    vOff += p.positions.length;
    iOff += p.indices.length;
    baseVertex += p.positions.length / 3;
  }
  return { positions, indices };
}

/**
 * Bakes a geometry object's `position`/`rotation`/`scale` into world-space vertex
 * positions (spec §14.6 — collision geometry has no per-object transform of its
 * own, so every piece is flattened into one world-space buffer). Indices are
 * unchanged.
 */
export function transformTriMesh(tri: TriMesh, position: Vec3, rotation: Quat, scale: Vec3): TriMesh {
  const [px, py, pz] = position;
  const [qx, qy, qz, qw] = rotation;
  const [sx, sy, sz] = scale;

  // Quaternion → rotation matrix columns (standard formula), applied per-vertex
  // alongside scale + translation without allocating a Three.js Matrix4/Vector3
  // per vertex.
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;

  const m00 = 1 - 2 * (yy + zz), m01 = 2 * (xy - wz), m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz), m11 = 1 - 2 * (xx + zz), m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy), m21 = 2 * (yz + wx), m22 = 1 - 2 * (xx + yy);

  const src = tri.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i] * sx;
    const y = src[i + 1] * sy;
    const z = src[i + 2] * sz;
    out[i] = m00 * x + m01 * y + m02 * z + px;
    out[i + 1] = m10 * x + m11 * y + m12 * z + py;
    out[i + 2] = m20 * x + m21 * y + m22 * z + pz;
  }
  return { positions: out, indices: tri.indices };
}

/** Spec §4.2's "small margin" on every side of the geometry's own bounds. */
export const WORKSPACE_MARGIN = 0.5;

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * World-space AABB of a triangle mesh's vertices, or **null for an empty mesh**
 * (`geometry_assets.md` §5.3).
 *
 * The empty case is reachable now that geometry is authored in the app: deleting
 * or unticking the last object leaves nothing to bound. It is a legal scene — a
 * layout of cameras aimed at a splat capture needs no triangles — so this reports
 * "no workspace" rather than throwing, and the Run gate (`runBlocker`) is what stops
 * a measurement against nothing.
 */
export function computeAabb(mesh: TriMesh): Aabb | null {
  const { positions } = mesh;
  if (positions.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Workspace AABB derived from the merged scene mesh (spec §14.6): the mesh's own
 * bounds — which already include wall thickness for room geometry — plus a flat
 * margin on every side (spec §4.2's "small margin", 0.5 m). **Null** when there
 * is no geometry at all (`geometry_assets.md` §5.3).
 */
export function computeWorkspaceBounds(mesh: TriMesh, margin = WORKSPACE_MARGIN): { worldMin: Vec3; worldMax: Vec3 } | null {
  const aabb = computeAabb(mesh);
  if (!aabb) return null;
  const { min, max } = aabb;
  return {
    worldMin: [min[0] - margin, min[1] - margin, min[2] - margin],
    worldMax: [max[0] + margin, max[1] + margin, max[2] + margin],
  };
}

/**
 * Where a geometry object's **gizmo pivot** sits relative to its origin
 * (`geometry_assets.md` §7): the object's local geometric centre, carried
 * through its own scale and rotation.
 *
 * A geometry object's `position` is the origin of its *frame*, not the middle of
 * its shape — a default `box` is defined by local `min`/`max` and sits at
 * `position [0,0,0]`, so attaching the gizmo to the object's origin put it at
 * the world origin, metres away from the box it was meant to move. The same is
 * true of any imported asset authored off its own origin.
 *
 * So the render node is placed at `position + pivotOffset(...)` and its content
 * is offset back by `-center`, which leaves every vertex exactly where it was
 * while putting the gizmo **on the object**. The readback subtracts the same
 * offset to recover `position`, which is why this is one pure function rather
 * than two sign conventions in two files.
 */
export function pivotOffset(center: Vec3, rotation: Quat, scale: Vec3): Vec3 {
  const [cx, cy, cz] = [center[0] * scale[0], center[1] * scale[1], center[2] * scale[2]];
  const [qx, qy, qz, qw] = rotation;
  // v + 2 * q_vec × (q_vec × v + w * v) — the standard quaternion rotation, without
  // allocating a Three.js Quaternion/Vector3 pair per call.
  const tx = 2 * (qy * cz - qz * cy);
  const ty = 2 * (qz * cx - qx * cz);
  const tz = 2 * (qx * cy - qy * cx);
  return [
    cx + qw * tx + (qy * tz - qz * ty),
    cy + qw * ty + (qz * tx - qx * tz),
    cz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** The centre of a set of triangle meshes' shared AABB, or the origin when there are none. */
export function centerOfTris(pieces: readonly TriMesh[]): Vec3 {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const { positions } of pieces) {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (min === null || max === null) {
        min = [x, y, z];
        max = [x, y, z];
        continue;
      }
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  if (min === null || max === null) return [0, 0, 0];
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}
