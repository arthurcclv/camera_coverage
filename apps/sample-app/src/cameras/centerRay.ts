/**
 * Center-ray intersection against the merged collision mesh (spec §15.3) — the
 * ray half of the camera info export, and pure.
 *
 * It runs in `cameraInfoWorker.ts`, off the main thread, over the same
 * world-space `SceneMesh` the engine occludes against (`GeometryBuild.sceneMesh`,
 * §14.6) — so it depends on **no** Three.js, no scene graph, and no render state.
 * That is what makes the whole of §15.3 unit-testable (`test/centerRay.test.ts`),
 * which the earlier `SceneView` raycast was not.
 *
 * **Brute force on purpose.** One pass over every triangle per camera: ~96 rays
 * against a few million triangles is seconds in a worker, where nothing is
 * waiting on it. The app already builds an SDK BVH of this same mesh for zone
 * generation (`scene/samplingVolumes.ts` `buildSceneBvh`), and traversing that
 * instead is the available upgrade if this ever needs to be interactive — see
 * `ai/DECISIONS.md`.
 *
 * **No backface culling.** Scene geometry renders and occludes as
 * double-sided (§14.6), so a wall hit from behind is a hit. A camera buried in
 * geometry (`CAMERA_INSIDE_GEOMETRY`, §11) therefore reports the inside of
 * whatever it is buried in, which is the truth about where its ray stops.
 */
import type { Quat, SceneMesh, Vec3 } from '@linkervision/camera-coverage-sdk';

/** Below this a ray is parallel to the triangle's plane and cannot hit it. */
const PARALLEL_EPS = 1e-12;
/** Hits closer than this are the ray's own origin, not a surface ahead of it. */
const MIN_DISTANCE = 1e-9;

/**
 * A camera's forward direction: the stored quaternion applied to `(0, 0, −1)`,
 * the −Z convention identity looks down (spec §5.1). Normalized.
 *
 * Written out rather than delegated to `three`'s `Vector3.applyQuaternion` so
 * this module — and so the worker — carries no Three.js at all.
 */
export function cameraForward(rotation: Quat): Vec3 {
  const [x, y, z, w] = rotation;
  // The rotation matrix's third column is R·(0,0,1) = [2(xz+wy), 2(yz-wx),
  // 1-2(x²+y²)]; forward is its negation. `test/centerRay.test.ts` checks this
  // against `three`'s own `applyQuaternion`, which is the only reason it is safe
  // to hand-roll here — it keeps Three.js out of the worker bundle entirely.
  const fx = -2 * (x * z + w * y);
  const fy = 2 * (w * x - y * z);
  const fz = 2 * (x * x + y * y) - 1;
  // The quaternion may be slightly off unit after repeated gizmo drags.
  const len = Math.hypot(fx, fy, fz) || 1;
  return [fx / len, fy / len, fz / len];
}

/**
 * The nearest point where the ray meets the mesh, or `null` when it meets
 * nothing (spec §15.3). Unbounded: no `near`, no `far`, no maximum distance.
 *
 * Möller–Trumbore per triangle, keeping the smallest positive `t`.
 */
export function nearestHit(mesh: SceneMesh, origin: Vec3, direction: Vec3): Vec3 | null {
  const { positions, indices } = mesh;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = direction;
  let best = Infinity;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const e1x = positions[b] - ax;
    const e1y = positions[b + 1] - ay;
    const e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax;
    const e2y = positions[c + 1] - ay;
    const e2z = positions[c + 2] - az;

    // p = direction × e2; det = e1 · p. A det of either sign is a hit: geometry
    // is double-sided, so backfaces are not culled.
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -PARALLEL_EPS && det < PARALLEL_EPS) continue;

    const inv = 1 / det;
    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;

    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > MIN_DISTANCE && t < best) best = t;
  }

  if (best === Infinity) return null;
  return [ox + dx * best, oy + dy * best, oz + dz * best];
}

/** The pose a center ray is cast from — a camera's position and orientation. */
export interface RayPose {
  position: Vec3;
  rotation: Quat;
}

/**
 * Every pose's center-ray hit, parallel to `poses`, `null` for a miss
 * (spec §15.3). A mesh with no triangles misses everything, which is the right
 * answer for a scene whose only content is a splat capture.
 */
export function centerRayHits(mesh: SceneMesh, poses: readonly RayPose[]): (Vec3 | null)[] {
  return poses.map((pose) => nearestHit(mesh, pose.position, cameraForward(pose.rotation)));
}
