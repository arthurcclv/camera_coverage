/**
 * Exact triangle–AABB overlap via the Separating Axis Theorem (§6.2).
 * Akenine-Möller "Fast 3D Triangle-Box Overlap Testing", 13 axes.
 */

import type { Vec3 } from '../types.ts';

export function triangleOverlapsAabb(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  boxCenter: Vec3,
  boxHalf: Vec3,
): boolean {
  // Move triangle so the box is centred at the origin.
  const v0: Vec3 = [a[0] - boxCenter[0], a[1] - boxCenter[1], a[2] - boxCenter[2]];
  const v1: Vec3 = [b[0] - boxCenter[0], b[1] - boxCenter[1], b[2] - boxCenter[2]];
  const v2: Vec3 = [c[0] - boxCenter[0], c[1] - boxCenter[1], c[2] - boxCenter[2]];

  const e0: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e1: Vec3 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
  const e2: Vec3 = [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]];

  // 9 cross-product axes (edge × box axis).
  const edges = [e0, e1, e2];
  for (const e of edges) {
    // axis = X(1,0,0) × e = (0,-e.z,e.y)
    if (axisTest(0, -e[2], e[1], v0, v1, v2, boxHalf)) return false;
    // axis = Y(0,1,0) × e = (e.z,0,-e.x)
    if (axisTest(e[2], 0, -e[0], v0, v1, v2, boxHalf)) return false;
    // axis = Z(0,0,1) × e = (-e.y,e.x,0)
    if (axisTest(-e[1], e[0], 0, v0, v1, v2, boxHalf)) return false;
  }

  // 3 box face normals (AABB of the triangle vs the box).
  for (let d = 0; d < 3; d++) {
    const mn = Math.min(v0[d], v1[d], v2[d]);
    const mx = Math.max(v0[d], v1[d], v2[d]);
    if (mn > boxHalf[d] || mx < -boxHalf[d]) return false;
  }

  // 1 triangle face normal.
  const n: Vec3 = [
    e0[1] * e1[2] - e0[2] * e1[1],
    e0[2] * e1[0] - e0[0] * e1[2],
    e0[0] * e1[1] - e0[1] * e1[0],
  ];
  const d0 = n[0] * v0[0] + n[1] * v0[1] + n[2] * v0[2];
  const r =
    Math.abs(n[0]) * boxHalf[0] +
    Math.abs(n[1]) * boxHalf[1] +
    Math.abs(n[2]) * boxHalf[2];
  if (d0 > r || d0 < -r) return false;

  return true;
}

function axisTest(
  ax: number,
  ay: number,
  az: number,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  h: Vec3,
): boolean {
  // Returns true if the axis (ax,ay,az) is a separating axis.
  if (ax === 0 && ay === 0 && az === 0) return false; // degenerate axis, skip
  const p0 = ax * v0[0] + ay * v0[1] + az * v0[2];
  const p1 = ax * v1[0] + ay * v1[1] + az * v1[2];
  const p2 = ax * v2[0] + ay * v2[1] + az * v2[2];
  const min = Math.min(p0, p1, p2);
  const max = Math.max(p0, p1, p2);
  const r = Math.abs(ax) * h[0] + Math.abs(ay) * h[1] + Math.abs(az) * h[2];
  return min > r || max < -r;
}
