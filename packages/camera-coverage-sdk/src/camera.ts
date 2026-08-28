/**
 * Camera model (§7). Quaternions are resolved on the CPU into a viewProj
 * matrix; the GPU only ever sees the fixed 96-byte Camera struct.
 */

import type { CameraConfig, Vec3 } from './types.ts';
import {
  composeTRS,
  invert,
  multiply,
  perspectiveZO,
  transformVec4,
  type Mat4,
} from './math.ts';

export const CAMERA_STRUCT_BYTES = 96; // §7
export const CAMERA_STRUCT_F32 = CAMERA_STRUCT_BYTES / 4; // 24

export interface PreparedCamera {
  id: string;
  position: Vec3;
  near: number;
  far: number;
  viewProj: Mat4;
  /** Six frustum planes [a,b,c,d] with n·p + d ≥ 0 inside, for AABB pre-cull. */
  planes: Float32Array; // 6 * 4
  /** `CameraConfig.enabled` resolved (§5.2); false ⇒ cleared from every activeMask. */
  enabled: boolean;
}

/** CAM_WORDS = ceil(numCameras / 32), clamped to ≥ 1 (§7.1). */
export function camWords(numCameras: number): number {
  return Math.max(1, Math.ceil(numCameras / 32));
}

function extractFrustumPlanes(vp: Mat4): Float32Array {
  // Gribb–Hartmann, for clip z ∈ [0,1] (WebGPU). vp is column-major m[col*4+row].
  const m = vp;
  const get = (row: number, col: number) => m[col * 4 + row];
  const planes = new Float32Array(24);
  const set = (idx: number, a: number, b: number, c: number, d: number) => {
    // normalize by plane normal length so distances are metric (conservative test unaffected)
    const inv = 1 / Math.hypot(a, b, c);
    planes[idx * 4 + 0] = a * inv;
    planes[idx * 4 + 1] = b * inv;
    planes[idx * 4 + 2] = c * inv;
    planes[idx * 4 + 3] = d * inv;
  };
  const r0 = [get(0, 0), get(0, 1), get(0, 2), get(0, 3)];
  const r1 = [get(1, 0), get(1, 1), get(1, 2), get(1, 3)];
  const r2 = [get(2, 0), get(2, 1), get(2, 2), get(2, 3)];
  const r3 = [get(3, 0), get(3, 1), get(3, 2), get(3, 3)];
  // left:  w + x, right: w - x, bottom: w + y, top: w - y (x,y clip in [-w,w])
  set(0, r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]);
  set(1, r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]);
  set(2, r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]);
  set(3, r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]);
  // near: z (z ≥ 0), far: w - z (z ≤ w)  — ZO clip
  set(4, r2[0], r2[1], r2[2], r2[3]);
  set(5, r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]);
  return planes;
}

export function prepareCamera(cam: CameraConfig): PreparedCamera {
  const aspect = cam.aspect ?? 16 / 9;
  const near = cam.near ?? 0.1;
  const far = cam.far ?? 50;
  const fovY = (cam.fov * Math.PI) / 180;

  const world = composeTRS(cam.position, cam.rotation);
  const view = invert(world);
  if (!view) throw new Error(`Camera ${cam.id}: non-invertible transform`);
  const proj = perspectiveZO(fovY, aspect, near, far);
  const viewProj = multiply(proj, view);

  return {
    id: cam.id,
    position: cam.position,
    near,
    far,
    viewProj,
    enabled: cam.enabled !== false,
    planes: extractFrustumPlanes(viewProj),
  };
}

/** Pack cameras into the GPU storage buffer layout (§7). */
export function packCameras(cams: PreparedCamera[]): Float32Array {
  const buf = new Float32Array(cams.length * CAMERA_STRUCT_F32);
  for (let c = 0; c < cams.length; c++) {
    const base = c * CAMERA_STRUCT_F32;
    buf.set(cams[c].viewProj, base); // 0..15
    buf[base + 16] = cams[c].position[0];
    buf[base + 17] = cams[c].position[1];
    buf[base + 18] = cams[c].position[2];
    buf[base + 19] = 0;
    buf[base + 20] = cams[c].near;
    buf[base + 21] = cams[c].far;
    buf[base + 22] = 0;
    buf[base + 23] = 0;
  }
  return buf;
}

/** Frustum containment test for a world point (§7.2). */
export function pointInFrustum(cam: PreparedCamera, p: Vec3): boolean {
  const c = transformVec4(cam.viewProj, p);
  const w = c[3];
  return (
    Math.abs(c[0]) <= w &&
    Math.abs(c[1]) <= w &&
    c[2] >= 0 &&
    c[2] <= w
  );
}

/**
 * Conservative frustum vs AABB test for chunk-level camera pre-cull (§7.2).
 * Returns true if the AABB is not entirely outside any single frustum plane.
 */
export function frustumIntersectsAabb(
  cam: PreparedCamera,
  min: Vec3,
  max: Vec3,
): boolean {
  const pl = cam.planes;
  for (let i = 0; i < 6; i++) {
    const a = pl[i * 4 + 0];
    const b = pl[i * 4 + 1];
    const c = pl[i * 4 + 2];
    const d = pl[i * 4 + 3];
    // Positive-vertex (p-vertex): the AABB corner farthest along the plane normal.
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return false; // fully outside this plane
  }
  return true;
}
