/**
 * Euler yaw/pitch/roll (degrees) <-> quaternion (xyzw) helpers.
 *
 * Order is 'YXZ' (yaw about Y, then pitch about local X, then roll about
 * local Z), matching the intuitive "aim, then tilt, then tilt-your-head"
 * mental model for a CCTV-style camera. Identity looks down -Z (Three.js /
 * SDK convention); yaw 180° looks down +Z, yaw -90° looks down +X.
 */
import { Euler, Quaternion } from 'three';
import type { Quat } from '@linkervision/camera-coverage-sdk';

export interface EulerAngles {
  yaw: number;
  pitch: number;
  roll: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function eulerToQuat({ yaw, pitch, roll }: EulerAngles): Quat {
  const e = new Euler(pitch * DEG2RAD, yaw * DEG2RAD, roll * DEG2RAD, 'YXZ');
  const q = new Quaternion().setFromEuler(e);
  return [q.x, q.y, q.z, q.w];
}

export function quatToEuler(q: Quat): EulerAngles {
  const e = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return {
    yaw: e.y * RAD2DEG,
    pitch: e.x * RAD2DEG,
    roll: e.z * RAD2DEG,
  };
}
