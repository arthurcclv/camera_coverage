/**
 * Ray occlusion kernel (§8, §10.3).
 *
 * This is the CPU reference; the WGSL shader `shaders/pass2_visibility.wgsl`
 * implements the identical algorithm bit-for-bit so both backends agree.
 */

import type { Vec3 } from './types.ts';
import type { Bvh } from './geometry/bvh.ts';
import { BVH_INVALID, BVH_NODE_WORDS } from './geometry/bvh.ts';

const T_EPS = 1e-3; // §8 t_min / t_max margin
const DET_EPS = 1e-7; // §8 Möller–Trumbore determinant epsilon

/**
 * Occlusion (any-hit) query. Returns true if any triangle is hit strictly
 * within (tMin, tMax). No backface culling (§8).
 */
export function occluded(
  bvh: Bvh,
  origin: Vec3,
  dir: Vec3,
  tMin: number,
  tMax: number,
): boolean {
  if (bvh.triangleCount === 0) return false;

  const f32 = bvh.f32;
  const u32 = bvh.u32;
  const tri = bvh.triData;

  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = dir[0], dy = dir[1], dz = dir[2];
  const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz;

  let node = 0;
  while (node !== BVH_INVALID) {
    const base = node * BVH_NODE_WORDS;
    // Slab AABB test.
    let t0 = (f32[base + 0] - ox) * invx;
    let t1 = (f32[base + 4] - ox) * invx;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    let tn = Math.max(tMin, t0);
    let tf = Math.min(tMax, t1);

    t0 = (f32[base + 1] - oy) * invy;
    t1 = (f32[base + 5] - oy) * invy;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    tn = Math.max(tn, t0);
    tf = Math.min(tf, t1);

    t0 = (f32[base + 2] - oz) * invz;
    t1 = (f32[base + 6] - oz) * invz;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    tn = Math.max(tn, t0);
    tf = Math.min(tf, t1);

    const hit = tn <= tf;
    const miss = u32[base + 3];
    const prim = u32[base + 7];

    if (hit) {
      if (prim !== 0) {
        const first = prim & 0x0fffffff;
        const cnt = prim >>> 28;
        for (let t = 0; t < cnt; t++) {
          if (rayTri(tri, (first + t) * 12, ox, oy, oz, dx, dy, dz, tMin, tMax)) {
            return true; // any-hit early out
          }
        }
        node = miss;
      } else {
        node = node + 1; // implicit left child
      }
    } else {
      node = miss;
    }
  }
  return false;
}

function rayTri(
  tri: Float32Array,
  o: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
): boolean {
  const ax = tri[o + 0], ay = tri[o + 1], az = tri[o + 2];
  const bx = tri[o + 4], by = tri[o + 5], bz = tri[o + 6];
  const cx = tri[o + 8], cy = tri[o + 9], cz = tri[o + 10];

  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  // p = dir × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -DET_EPS && det < DET_EPS) return false; // parallel; no backface cull
  const invDet = 1 / det;

  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return false;

  // q = t × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return false;

  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > tMin && t < tMax;
}

export { T_EPS, DET_EPS };
