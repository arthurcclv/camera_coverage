/**
 * Reduces a `GeometryObject[]` (spec §14.1) to the single world-space collision
 * mesh passed to `engine.loadScene` and the renderable Three.js group (spec
 * §14.6). `room`/`box` objects are synchronous; `gltf` objects are loaded via
 * `GLTFLoader` (`three/addons`, no new dependency — same import convention as
 * `viewport.ts`'s `OrbitControls`/`TransformControls`) and are therefore async.
 *
 * `buildStaticGeometrySync` is the fast path used for the default scene (which
 * never references a `gltf` asset) so `App.tsx` can seed its initial state
 * synchronously, exactly like the old `buildRoom()`.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { SceneMesh, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ClipBand } from './sectionHeatmap.ts';
import {
  boxTris,
  computeWorkspaceBounds,
  mergeTris,
  roomTris,
  transformTriMesh,
  type BoxGeometryObject,
  type GeometryObject,
  type GltfGeometryObject,
  type RoomGeometryObject,
  type TriMesh,
} from './geometryModel.ts';

export interface GeometryBuild {
  /** Merged geometry mesh, world space — pass directly to `engine.loadScene`. */
  sceneMesh: SceneMesh;
  /**
   * Renderable geometry, ready to add to the Three.js scene. A section's clip
   * cross-sections every mesh inside it by way of the meshes' own
   * `Material.clippingPlanes` (spec §13.9, `setGeometryClippingPlanes`).
   */
  group: THREE.Group;
  worldMin: Vec3;
  worldMax: Vec3;
}

/** Resolves a `gltf` object's `src` (already validated safe, spec §14.2) to file bytes. */
export type AssetResolver = (src: string) => Promise<ArrayBuffer>;

interface Materials {
  floorMat: THREE.Material;
  wallMat: THREE.Material;
  boxMat: THREE.Material;
}

function makeMaterials(): Materials {
  return {
    floorMat: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 }),
    wallMat: new THREE.MeshStandardMaterial({ color: 0xc7cdd6, roughness: 0.85 }),
    boxMat: new THREE.MeshStandardMaterial({ color: 0xb5652b, roughness: 0.7 }),
  };
}

function meshFromTris(tri: TriMesh, material: THREE.Material): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tri.positions.slice(), 3));
  geom.setIndex(new THREE.BufferAttribute(tri.indices.slice(), 1));
  geom.computeVertexNormals();
  return new THREE.Mesh(geom, material);
}

interface Pieces {
  collision: TriMesh[];
  render: THREE.Object3D[];
}

function buildRoomPieces(obj: RoomGeometryObject, mats: Materials): Pieces {
  const local = roomTris(obj.halfX, obj.halfZ, obj.height, obj.thickness); // [floor, wallN, wallS, wallE, wallW]
  const world = local.map((t) => transformTriMesh(t, obj.position, obj.rotation, obj.scale));
  return {
    collision: world,
    render: [meshFromTris(world[0], mats.floorMat), ...world.slice(1).map((w) => meshFromTris(w, mats.wallMat))],
  };
}

function buildBoxPieces(obj: BoxGeometryObject, mats: Materials): Pieces {
  const world = transformTriMesh(boxTris(obj.min, obj.max), obj.position, obj.rotation, obj.scale);
  return { collision: [world], render: [meshFromTris(world, mats.boxMat)] };
}

/**
 * Loads a `gltf` object's asset and reduces every mesh in its scene graph to a
 * world-space `TriMesh` — each mesh's geometry transformed by (object transform
 * × node world-matrix), per spec §14.6. Non-mesh nodes (lights/cameras) are
 * skipped for collision; the loaded scene graph itself (with the object
 * transform applied) is the render piece, materials intact.
 */
async function buildGltfPieces(obj: GltfGeometryObject, resolveAsset: AssetResolver): Promise<Pieces> {
  const bytes = await resolveAsset(obj.src);
  const gltf: GLTF = await new GLTFLoader().parseAsync(bytes, '');

  const objectMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...obj.position),
    new THREE.Quaternion(...obj.rotation),
    new THREE.Vector3(...obj.scale),
  );

  gltf.scene.updateMatrixWorld(true);
  const collision: TriMesh[] = [];
  gltf.scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const positionAttr = node.geometry.getAttribute('position');
    if (!positionAttr) return;
    const finalMatrix = objectMatrix.clone().multiply(node.matrixWorld);
    const vertCount = positionAttr.count;
    const positions = new Float32Array(vertCount * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < vertCount; i++) {
      v.fromBufferAttribute(positionAttr, i).applyMatrix4(finalMatrix);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    const indexAttr = node.geometry.getIndex();
    const indices = indexAttr
      ? Uint32Array.from(indexAttr.array)
      : Uint32Array.from({ length: vertCount }, (_, i) => i);
    collision.push({ positions, indices });
  });

  gltf.scene.position.set(...obj.position);
  gltf.scene.quaternion.set(...obj.rotation);
  gltf.scene.scale.set(...obj.scale);
  return { collision, render: [gltf.scene] };
}

/**
 * Forces every mesh material under `root` to `THREE.DoubleSide` (spec §14.6). The
 * single source of truth for geometry render side — floor/box/wall primitives and
 * glTF meshes alike. glTF materials come from the file and may be arrays; this
 * overrides only their `side`, leaving every other property intact. Back-face
 * culling would otherwise hide surfaces viewed from behind (the open-top room from
 * inside, or a section clip cutaway exposing an interior face).
 */
export function forceDoubleSided(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) m.side = THREE.DoubleSide;
  });
}

function finishBuild(collisionPieces: TriMesh[], renderPieces: THREE.Object3D[]): GeometryBuild {
  const merged = mergeTris(collisionPieces);
  const { worldMin, worldMax } = computeWorkspaceBounds(merged);
  const group = new THREE.Group();
  // No clipping until a section clip sets planes (spec §13.9); the materials are
  // built with `clippingPlanes` unset, which is "not clipped".
  for (const piece of renderPieces) group.add(piece);
  forceDoubleSided(group);
  return { sceneMesh: { positions: merged.positions, indices: merged.indices }, group, worldMin, worldMax };
}

/**
 * Synchronous fast path: `room`/`box` objects only. `gltf` objects are silently
 * skipped — this path never loads assets. Safe for the default scene (spec
 * §14.1), which never references a `gltf` asset.
 */
export function buildStaticGeometrySync(geometry: GeometryObject[]): GeometryBuild {
  const mats = makeMaterials();
  const collisionPieces: TriMesh[] = [];
  const renderPieces: THREE.Object3D[] = [];
  for (const obj of geometry) {
    const pieces = obj.kind === 'room' ? buildRoomPieces(obj, mats) : obj.kind === 'box' ? buildBoxPieces(obj, mats) : null;
    if (!pieces) continue;
    collisionPieces.push(...pieces.collision);
    renderPieces.push(...pieces.render);
  }
  return finishBuild(collisionPieces, renderPieces);
}

/**
 * Full builder: `room`/`box` synchronously, `gltf` objects loaded via
 * `resolveAsset` (required whenever `geometry` contains a `gltf` object — the
 * default scene never does, so callers building only the default can omit it).
 */
export async function buildSceneGeometry(geometry: GeometryObject[], resolveAsset?: AssetResolver): Promise<GeometryBuild> {
  const mats = makeMaterials();
  const collisionPieces: TriMesh[] = [];
  const renderPieces: THREE.Object3D[] = [];
  for (const obj of geometry) {
    if (obj.kind === 'room') {
      const pieces = buildRoomPieces(obj, mats);
      collisionPieces.push(...pieces.collision);
      renderPieces.push(...pieces.render);
    } else if (obj.kind === 'box') {
      const pieces = buildBoxPieces(obj, mats);
      collisionPieces.push(...pieces.collision);
      renderPieces.push(...pieces.render);
    } else {
      if (!resolveAsset) throw new Error(`Cannot load gltf geometry "${obj.src}": no asset resolver was provided`);
      const pieces = await buildGltfPieces(obj, resolveAsset);
      collisionPieces.push(...pieces.collision);
      renderPieces.push(...pieces.render);
    }
  }
  return finishBuild(collisionPieces, renderPieces);
}

/**
 * The two world-space clipping planes for a section's clip band (spec §13.9).
 * They face inward along the band's collapse axis so their intersection (the
 * default `clipIntersection = false`) keeps only geometry inside `[min, max]`;
 * everything outside the band is clipped away.
 */
export function clipBandPlanes(band: ClipBand): THREE.Plane[] {
  const lo: [number, number, number] = [0, 0, 0];
  lo[band.axis] = 1; // keep points with coord >= band.min
  const hi: [number, number, number] = [0, 0, 0];
  hi[band.axis] = -1; // keep points with coord <= band.max
  return [
    new THREE.Plane(new THREE.Vector3(...lo), -band.min),
    new THREE.Plane(new THREE.Vector3(...hi), band.max),
  ];
}

/**
 * Apply (or clear) the clip's planes on a built geometry group (spec §13.9), by
 * writing them onto **every descendant mesh's material** — floor, walls, boxes,
 * and any glTF meshes. Pass an empty array to disable clipping.
 *
 * The renderer must have `localClippingEnabled` on for `Material.clippingPlanes`
 * to be read at all (`viewport.ts` sets it once).
 *
 * **This does not propagate.** The `ClippingGroup` this replaced clipped its whole
 * subtree from one node, so a mesh added later inherited the clip for free; per-
 * material state does not, and a material that never gets the planes written to it
 * simply renders uncut. Every path that produces new materials — a geometry
 * rebuild, and the import/reset swap of spec §14.4 — therefore has to call this
 * again. `SceneView.sync` does, keying on the room identity as well as the band.
 * `test/sceneGeometryBuild.test.ts` pins that.
 */
export function setGeometryClippingPlanes(build: GeometryBuild, planes: THREE.Plane[]): void {
  // An empty array reads as "no clipping" in three, so one assignment covers both
  // applying and clearing. The same array instance is shared by every material:
  // the planes are only ever replaced wholesale, never mutated in place.
  build.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) m.clippingPlanes = planes;
  });
}

function disposeMaterial(material: THREE.Material): void {
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
    const tex = (material as unknown as Record<string, unknown>)[key];
    if (tex instanceof THREE.Texture) tex.dispose();
  }
  material.dispose();
}

/**
 * Swap the rendered geometry: detach the outgoing build, **then** release it, then
 * attach the incoming one (spec §14.4).
 *
 * The order is the whole point. Disposing a build while its group is still in the
 * scene leaves the animation loop (`renderer.setAnimationLoop`) drawing meshes
 * whose GPU resources are already gone — and React's `useEffect` runs *after*
 * paint, so a dispose done in the state update is guaranteed to be followed by at
 * least one such frame. It shows up with a clip band active because those meshes
 * carry clipping planes: the renderer's cached programs for them are keyed on
 * material state that disposal has just invalidated, so the frame draws garbage
 * rather than nothing, and the bad cache entry outlives the frame.
 */
export function swapGeometry(scene: THREE.Object3D, prev: GeometryBuild | null, next: GeometryBuild): void {
  if (prev) {
    scene.remove(prev.group);
    disposeGeometryBuild(prev);
  }
  scene.add(next.group);
}

/** Releases GPU resources (geometries, materials, textures) held by a built group's meshes. */
export function disposeGeometryBuild(build: GeometryBuild): void {
  build.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) disposeMaterial(m);
  });
}
