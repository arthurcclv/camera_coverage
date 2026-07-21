/**
 * Default scene geometry (spec §4.1, §14.1): an enclosed room, open top, plus
 * freestanding box obstacles. `defaultGeometry()` is the `geometry` half of
 * `sceneModel.ts`'s `defaultScene()`; `scene/sceneGeometryBuild.ts` reduces it
 * (plus any imported `gltf` objects) to the single world-space triangle mesh
 * used both for `engine.loadScene` and Three.js rendering.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { identityTransform, type BoxGeometryObject, type GeometryObject, type RoomGeometryObject } from './geometryModel.ts';

export const ROOM_HALF_X = 10;
export const ROOM_HALF_Z = 10;
export const ROOM_HEIGHT = 6;
export const WALL_THICKNESS = 0.3;

const BOX_BOUNDS: Array<{ min: Vec3; max: Vec3 }> = [
  { min: [-7, 0, -7], max: [-4, 2.5, -4] },
  { min: [3, 0, -8], max: [6, 4, -5] },
  { min: [-2, 0, 1], max: [1, 1.8, 4] },
  { min: [4, 0, 3], max: [7, 3, 6] },
  { min: [-8, 0, 4], max: [-5.5, 3.5, 6.5] },
];

/** The default scene's geometry list (spec §14.1) — a room plus 5 box obstacles, identity transforms. */
export function defaultGeometry(): GeometryObject[] {
  const room: RoomGeometryObject = {
    kind: 'room',
    halfX: ROOM_HALF_X,
    halfZ: ROOM_HALF_Z,
    height: ROOM_HEIGHT,
    thickness: WALL_THICKNESS,
    ...identityTransform(),
  };
  const boxes: BoxGeometryObject[] = BOX_BOUNDS.map(({ min, max }) => ({
    kind: 'box',
    min,
    max,
    ...identityTransform(),
  }));
  return [room, ...boxes];
}
