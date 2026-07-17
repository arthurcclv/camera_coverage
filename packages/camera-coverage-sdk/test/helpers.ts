/**
 * Test scene builders and small utilities.
 */

import type { CameraConfig, SceneMesh, Vec3 } from '../src/types.ts';

/** Identity quaternion: camera looks down -Z (glTF convention). */
export const LOOK_NEG_Z: [number, number, number, number] = [0, 0, 0, 1];
/** 180° about Y: camera looks down +Z. */
export const LOOK_POS_Z: [number, number, number, number] = [0, 1, 0, 0];

export function camera(
  id: string,
  position: Vec3,
  rotation: [number, number, number, number] = LOOK_NEG_Z,
  extra: Partial<CameraConfig> = {},
): CameraConfig {
  return { id, position, rotation, fov: 90, aspect: 1, near: 0.1, far: 50, ...extra };
}

/** An axis-aligned quad (two triangles) perpendicular to +Z at plane z. */
export function wallZ(z: number, x0: number, x1: number, y0: number, y1: number): SceneMesh {
  const positions = new Float32Array([
    x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, indices };
}

/** A closed axis-aligned box (12 triangles) from min to max. */
export function box(min: Vec3, max: Vec3): SceneMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: number[] = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // 0-3 z0
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // 4-7 z1
  ];
  const positions = new Float32Array(v);
  const quad = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
  // Each face lists its 4 corners in cyclic order (winding irrelevant: no
  // backface cull) so the two triangles tile the quad with no gap.
  const indices = new Uint32Array([
    ...quad(0, 1, 2, 3), // -z
    ...quad(4, 5, 6, 7), // +z
    ...quad(0, 4, 7, 3), // -x
    ...quad(1, 5, 6, 2), // +x
    ...quad(0, 1, 5, 4), // -y
    ...quad(3, 2, 6, 7), // +y
  ]);
  return { positions, indices };
}

export function voxelIndexOf(worldMin: Vec3, voxelSize: number, p: Vec3): [number, number, number] {
  return [
    Math.floor((p[0] - worldMin[0]) / voxelSize),
    Math.floor((p[1] - worldMin[1]) / voxelSize),
    Math.floor((p[2] - worldMin[2]) / voxelSize),
  ];
}

export function voxelCenterOf(
  worldMin: Vec3,
  voxelSize: number,
  ijk: [number, number, number],
): Vec3 {
  return [
    worldMin[0] + (ijk[0] + 0.5) * voxelSize,
    worldMin[1] + (ijk[1] + 0.5) * voxelSize,
    worldMin[2] + (ijk[2] + 0.5) * voxelSize,
  ];
}
