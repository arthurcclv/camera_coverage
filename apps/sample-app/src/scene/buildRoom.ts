/**
 * Enclosed room + box obstacles (spec §4): a single indexed triangle mesh
 * (world space, meters, Y up) used both for `engine.loadScene` and for the
 * Three.js room geometry. Floor + 4 walls, open top, plus freestanding boxes.
 */
import * as THREE from 'three';
import type { SceneMesh, Vec3 } from '@linkervision/camera-coverage-sdk';

export const ROOM_HALF_X = 10;
export const ROOM_HALF_Z = 10;
export const ROOM_HEIGHT = 6;
export const WALL_THICKNESS = 0.3;

export interface BoxObstacle {
  min: Vec3;
  max: Vec3;
}

export const BOX_OBSTACLES: BoxObstacle[] = [
  { min: [-7, 0, -7], max: [-4, 2.5, -4] },
  { min: [3, 0, -8], max: [6, 4, -5] },
  { min: [-2, 0, 1], max: [1, 1.8, 4] },
  { min: [4, 0, 3], max: [7, 3, 6] },
  { min: [-8, 0, 4], max: [-5.5, 3.5, 6.5] },
];

/** Workspace AABB: the room's footprint with a small margin (spec §4.2). */
export const WORKSPACE_MIN: Vec3 = [-ROOM_HALF_X - WALL_THICKNESS - 0.5, -WALL_THICKNESS - 0.5, -ROOM_HALF_Z - WALL_THICKNESS - 0.5];
export const WORKSPACE_MAX: Vec3 = [ROOM_HALF_X + WALL_THICKNESS + 0.5, ROOM_HEIGHT + 0.5, ROOM_HALF_Z + WALL_THICKNESS + 0.5];

interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Axis-aligned box, 6 faces x 4 verts (flat-shaded), CCW winding viewed from outside. */
function boxTris(min: Vec3, max: Vec3): TriMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const verts: number[] = [];
  const idx: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const base = verts.length / 3;
    verts.push(...a, ...b, ...c, ...d);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // +Y
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -Z
  return { positions: new Float32Array(verts), indices: new Uint32Array(idx) };
}

function mergeTris(pieces: TriMesh[]): TriMesh {
  let vertCount = 0;
  let idxCount = 0;
  for (const p of pieces) {
    vertCount += p.positions.length;
    idxCount += p.indices.length;
  }
  const positions = new Float32Array(vertCount);
  const indices = new Uint32Array(idxCount);
  let vOff = 0;
  let iOff = 0;
  let baseVertex = 0;
  for (const p of pieces) {
    positions.set(p.positions, vOff);
    for (let i = 0; i < p.indices.length; i++) indices[iOff + i] = p.indices[i] + baseVertex;
    vOff += p.positions.length;
    iOff += p.indices.length;
    baseVertex += p.positions.length / 3;
  }
  return { positions, indices };
}

function meshFromTris(tri: TriMesh, material: THREE.Material): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tri.positions.slice(), 3));
  geom.setIndex(new THREE.BufferAttribute(tri.indices.slice(), 1));
  geom.computeVertexNormals();
  return new THREE.Mesh(geom, material);
}

export interface RoomBuild {
  /** Merged room + obstacles mesh, world space — pass directly to loadScene. */
  sceneMesh: SceneMesh;
  /** Renderable room + obstacles, ready to add to the Three.js scene. */
  group: THREE.Group;
  worldMin: Vec3;
  worldMax: Vec3;
  boxes: BoxObstacle[];
}

export function buildRoom(): RoomBuild {
  const t = WALL_THICKNESS;
  const hx = ROOM_HALF_X;
  const hz = ROOM_HALF_Z;
  const h = ROOM_HEIGHT;

  const floor = boxTris([-hx - t, -t, -hz - t], [hx + t, 0, hz + t]);
  const wallN = boxTris([-hx - t, 0, hz], [hx + t, h, hz + t]);
  const wallS = boxTris([-hx - t, 0, -hz - t], [hx + t, h, -hz]);
  const wallE = boxTris([hx, 0, -hz], [hx + t, h, hz]);
  const wallW = boxTris([-hx - t, 0, -hz], [-hx, h, hz]);
  const boxes = BOX_OBSTACLES.map((b) => boxTris(b.min, b.max));

  const pieces = [floor, wallN, wallS, wallE, wallW, ...boxes];
  const sceneMesh = mergeTris(pieces);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xc7cdd6, roughness: 0.85, side: THREE.DoubleSide });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xb5652b, roughness: 0.7 });

  const group = new THREE.Group();
  group.add(meshFromTris(floor, floorMat));
  for (const w of [wallN, wallS, wallE, wallW]) group.add(meshFromTris(w, wallMat));
  for (const b of boxes) group.add(meshFromTris(b, boxMat));

  return {
    sceneMesh: { positions: sceneMesh.positions, indices: sceneMesh.indices },
    group,
    worldMin: WORKSPACE_MIN,
    worldMax: WORKSPACE_MAX,
    boxes: BOX_OBSTACLES,
  };
}
