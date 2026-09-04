/**
 * Rotating a vector by a quaternion, shared.
 *
 * The same pair shipped twice — once for the sampling volume's box-local frame
 * (§2.3, §7.1) and once for a camera constraint's plane-local frame
 * (`camera_placement.md` §3.2) — because the two arrived from different specs.
 * They were byte-identical, and a fix to one would have been a fix to only one.
 *
 * Kept out of Three.js deliberately: these run over plain `Vec3`/`Quat` tuples
 * in pure modules the tests reach without a renderer (`ai/CONVENTIONS.md`).
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

/** Rotate vector `v` by quaternion `q` (xyzw): v' = q·v·q⁻¹. */
export function applyQuat(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Rotate `v` by the conjugate of `q` — world direction into the local frame.
 *
 * For a unit quaternion the conjugate is the inverse, which is what makes this
 * the exact undo of `applyQuat`.
 */
export function applyQuatConj(q: Quat, v: Vec3): Vec3 {
  return applyQuat([-q[0], -q[1], -q[2], q[3]], v);
}
