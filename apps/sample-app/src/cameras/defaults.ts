/**
 * Default camera rig (spec §5): 10 CCTV-style cameras around the room
 * perimeter, mounted high near the wall tops, angled inward and downward.
 */
import { ROOM_HALF_X, ROOM_HALF_Z, ROOM_HEIGHT } from '../scene/buildRoom.ts';
import type { SceneCamera } from './camera.ts';
import { eulerToQuat } from './math.ts';

const MOUNT_HEIGHT = ROOM_HEIGHT - 0.6; // 5.4m
const INSET = 0.4; // pull mount point in from the wall face, avoids sitting in wall geometry
const PITCH_DOWN = -28; // degrees below horizontal
const FOV = 60;
const ASPECT = 16 / 9;
const NEAR = 0.1;
const FAR = 30;

function cam(id: string, position: [number, number, number], yaw: number): SceneCamera {
  return {
    id,
    // Default cameras carry a blank name (spec §14.1) — they display as `Camera N`.
    name: '',
    position,
    rotation: eulerToQuat({ yaw, pitch: PITCH_DOWN, roll: 0 }),
    fov: FOV,
    aspect: ASPECT,
    near: NEAR,
    far: FAR,
  };
}

export function defaultCameras(): SceneCamera[] {
  const zFront = -ROOM_HALF_Z + INSET; // -Z wall, looks toward +Z (yaw 180)
  const zBack = ROOM_HALF_Z - INSET; // +Z wall, looks toward -Z (yaw 0)
  const xLeft = -ROOM_HALF_X + INSET; // -X wall, looks toward +X (yaw -90)
  const xRight = ROOM_HALF_X - INSET; // +X wall, looks toward -X (yaw 90)

  return [
    cam('cam-1', [-6, MOUNT_HEIGHT, zFront], 180),
    cam('cam-2', [0, MOUNT_HEIGHT, zFront], 180),
    cam('cam-3', [6, MOUNT_HEIGHT, zFront], 180),

    cam('cam-4', [-6, MOUNT_HEIGHT, zBack], 0),
    cam('cam-5', [0, MOUNT_HEIGHT, zBack], 0),
    cam('cam-6', [6, MOUNT_HEIGHT, zBack], 0),

    cam('cam-7', [xLeft, MOUNT_HEIGHT, -5], -90),
    cam('cam-8', [xLeft, MOUNT_HEIGHT, 5], -90),

    cam('cam-9', [xRight, MOUNT_HEIGHT, -5], 90),
    cam('cam-10', [xRight, MOUNT_HEIGHT, 5], 90),
  ];
}
