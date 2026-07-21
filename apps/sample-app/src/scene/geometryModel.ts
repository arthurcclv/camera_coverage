/**
 * Geometry data model (spec §14.1, §14.3) + pure triangle-mesh math shared by
 * the default room and by imported `gltf` geometry (§14.6). No Three.js state
 * mutation here — `transformTriMesh` builds new typed arrays; callers own
 * `THREE.BufferGeometry`/materials.
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
  scale: Vec3;
}

export interface RoomGeometryObject extends GeometryTransform {
  kind: 'room';
  halfX: number;
  halfZ: number;
  height: number;
  thickness: number;
}

export interface BoxGeometryObject extends GeometryTransform {
  kind: 'box';
  /** Axis-aligned bounds in the object's local frame (spec §14.3). */
  min: Vec3;
  max: Vec3;
}

export interface GltfGeometryObject extends GeometryTransform {
  kind: 'gltf';
  /** Path relative to the scene folder root (spec §14.2). */
  src: string;
}

export type GeometryObject = RoomGeometryObject | BoxGeometryObject | GltfGeometryObject;

/** A fresh identity transform (own arrays, safe to attach to any geometry object). */
export function identityTransform(): GeometryTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
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

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** World-space AABB of a triangle mesh's vertices. Throws on an empty mesh. */
export function computeAabb(mesh: TriMesh): Aabb {
  const { positions } = mesh;
  if (positions.length === 0) throw new Error('computeAabb: empty mesh');
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
 * margin on every side (spec §4.2's "small margin", 0.5 m).
 */
export function computeWorkspaceBounds(mesh: TriMesh, margin = 0.5): { worldMin: Vec3; worldMax: Vec3 } {
  const { min, max } = computeAabb(mesh);
  return {
    worldMin: [min[0] - margin, min[1] - margin, min[2] - margin],
    worldMax: [max[0] + margin, max[1] + margin, max[2] + margin],
  };
}
