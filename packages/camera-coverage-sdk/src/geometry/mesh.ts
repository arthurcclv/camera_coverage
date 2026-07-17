/**
 * Scene mesh preparation (§5.1): NaN / degenerate triangle culling.
 * Degenerate = area < 1e-10 m².
 */

import type { SceneMesh, Vec3 } from '../types.ts';
import { cross, length, sub } from '../math.ts';

const AREA_EPS = 1e-10;

export interface CleanMesh {
  /** Triangle vertices, flattened: [ax,ay,az, bx,by,bz, cx,cy,cz] per triangle. */
  triVerts: Float32Array; // 9 floats per triangle
  triangleCount: number;
  removed: number;
  aabb: { min: Vec3; max: Vec3 };
}

export function cleanMesh(mesh: SceneMesh): CleanMesh {
  const { positions, indices } = mesh;
  if (indices.length % 3 !== 0) {
    throw new Error('SceneMesh.indices length must be a multiple of 3');
  }
  const triCount = indices.length / 3;
  const out = new Float32Array(triCount * 9);
  let kept = 0;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3 + 0] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;

    const a: Vec3 = [positions[ia], positions[ia + 1], positions[ia + 2]];
    const b: Vec3 = [positions[ib], positions[ib + 1], positions[ib + 2]];
    const c: Vec3 = [positions[ic], positions[ic + 1], positions[ic + 2]];

    if (!finite3(a) || !finite3(b) || !finite3(c)) continue;

    const area = 0.5 * length(cross(sub(b, a), sub(c, a)));
    if (area < AREA_EPS) continue;

    const base = kept * 9;
    out[base + 0] = a[0]; out[base + 1] = a[1]; out[base + 2] = a[2];
    out[base + 3] = b[0]; out[base + 4] = b[1]; out[base + 5] = b[2];
    out[base + 6] = c[0]; out[base + 7] = c[1]; out[base + 8] = c[2];

    for (const v of [a, b, c]) {
      for (let d = 0; d < 3; d++) {
        if (v[d] < min[d]) min[d] = v[d];
        if (v[d] > max[d]) max[d] = v[d];
      }
    }
    kept++;
  }

  if (kept === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  return {
    triVerts: out.subarray(0, kept * 9),
    triangleCount: kept,
    removed: triCount - kept,
    aabb: { min, max },
  };
}

function finite3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
