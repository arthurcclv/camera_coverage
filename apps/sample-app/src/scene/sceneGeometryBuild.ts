/**
 * Reduces a `GeometryObject[]` (spec §14.1) to the single world-space collision
 * mesh passed to `engine.loadScene` and the renderable Three.js group (spec
 * §14.6). `room`/`box` objects are synchronous; `mesh` objects are loaded from
 * `assets/` via `GLTFLoader` (`three/addons`, no new dependency — same import
 * convention as `viewport.ts`'s `OrbitControls`/`TransformControls`) and are
 * therefore async.
 *
 * `buildStaticGeometrySync` is the fast path used for the default scene (which
 * never references an asset) so `App.tsx` can seed its initial state
 * synchronously, exactly like the old `buildRoom()`.
 *
 * Three rules this build enforces for `geometry_assets.md`:
 *
 * - **A disabled object contributes no triangles and no bounds** (§5.1). It keeps
 *   a render node, held **invisible**, so its gizmo still attaches and it can be
 *   moved and re-ticked — the splat rule, for the splat reason: a hidden object
 *   the user has just unticked must not draw itself back.
 * - **The render node keeps its object's transform** rather than baking it into
 *   vertices, because `TransformControls` drags that node (§7). Collision still
 *   bakes to world space — `engine.loadScene` takes one flat buffer (§14.6).
 * - **The merge is lazy** (§4.3): `sceneMesh` is computed on first read, so an
 *   edit costs a render rebuild and nothing else until the next Run asks for the
 *   collision mesh.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Quat, SceneMesh, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ClipBand } from './sectionHeatmap.ts';
import {
  boxTris,
  centerOfTris,
  mergeTris,
  pivotOffset,
  roomTris,
  transformTriMesh,
  WORKSPACE_MARGIN,
  type BoxGeometryObject,
  type GeometryTransform,
  type GeometryObject,
  type MeshGeometryObject,
  type RoomGeometryObject,
  type TriMesh,
} from './geometryModel.ts';

export interface GeometryBuild {
  /**
   * Merged geometry mesh, world space — pass directly to `engine.loadScene`.
   *
   * **Computed on first read and memoized** (`geometry_assets.md` §4.3): a
   * geometry edit rebuilds the render group immediately but must not re-merge
   * every triangle in the scene, which on a site model is a visible freeze per
   * gizmo nudge. Nothing between edits needs it — the viewport draws `group`,
   * and Place on surface raycasts it too — so the merge waits for the run.
   */
  readonly sceneMesh: SceneMesh;
  /**
   * Renderable geometry, ready to add to the Three.js scene. A section's clip
   * cross-sections every mesh inside it by way of the meshes' own
   * `Material.clippingPlanes` (spec §13.9, `setGeometryClippingPlanes`).
   */
  group: THREE.Group;
  worldMin: Vec3;
  worldMax: Vec3;
  /**
   * Per-object render nodes by geometry id — what `TransformControls` attaches
   * to for a selected geometry object (`geometry_assets.md` §7). A **disabled**
   * object keeps its node, invisible, so a row that is off can still be dragged
   * into place before being switched back on (§5.1).
   */
  objectNodes: Map<string, THREE.Object3D>;
  /**
   * True when no enabled object contributed a triangle (`geometry_assets.md`
   * §5.3). A legal scene — cameras aimed at a splat capture need none — but not
   * a measurable one, so `runBlocker` blocks the run and `worldMin`/`worldMax` hold
   * the fallback unit box below purely so the viewport has something to frame.
   */
  isEmpty: boolean;
  /**
   * Each object's triangles in its **own** frame, by id — what
   * {@link rebuildWithTransforms} re-bakes when only transforms changed, so a
   * gizmo drag never re-parses an asset and never rebuilds the scene graph.
   */
  localTris: Map<string, TriMesh[]>;
  /** The geometry list this build describes — {@link rebuildWithTransforms} diffs against it. */
  sourceGeometry: readonly GeometryObject[];
}

/**
 * The workspace a scene with **no geometry** reports (`geometry_assets.md`
 * §5.3). Nothing is measured against it — `runBlocker` refuses the run — and it
 * exists only so the viewport's camera framing and the orbit controls have a
 * finite box while the user builds a scene up from nothing.
 */
const EMPTY_WORKSPACE: { worldMin: Vec3; worldMax: Vec3 } = { worldMin: [-1, -1, -1], worldMax: [1, 1, 1] };

/** Resolves a mesh object's `src` (already validated safe, spec §14.2) to file bytes. */
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
  /** World-space triangles for `engine.loadScene` — the object transform baked in (spec §14.6). */
  collision: TriMesh[];
  /**
   * The same triangles in the object's **own** frame, kept so a transform-only
   * edit re-bakes them instead of rebuilding anything (§4.3).
   */
  local: TriMesh[];
  /**
   * The object's render node, carrying the object transform on itself rather
   * than baked into its vertices, so `TransformControls` can drag it
   * (`geometry_assets.md` §7).
   */
  node: THREE.Object3D;
}

/**
 * A per-object node holding `children`, carrying the object's rotation and scale
 * and sitting at its **geometric centre** rather than at its origin
 * (`geometry_assets.md` §7).
 *
 * The node is what `TransformControls` attaches to, and an object's `position` is
 * the origin of its frame, not the middle of its shape: a default `box` is local
 * `min`/`max` at `position [0,0,0]`, so a node at the origin put the gizmo at the
 * world origin, metres from the box. The content is offset back by `-center`, so
 * every vertex lands exactly where it did; `setNodeTransform` and the readback
 * share {@link pivotOffset} so the two directions cannot drift.
 */
function nodeFor(obj: GeometryObject, children: THREE.Object3D[], localTris: TriMesh[]): THREE.Object3D {
  const node = new THREE.Group();
  node.name = obj.id;
  const center = centerOfTris(localTris);
  const content = new THREE.Group();
  content.position.set(-center[0], -center[1], -center[2]);
  for (const child of children) content.add(child);
  node.add(content);
  // Read back by `SceneView.emitTransform` and by `rebuildWithTransforms`, which
  // both need the centre to convert between the node's pose and the object's.
  node.userData.localCenter = center;
  setNodeTransform(node, obj);
  return node;
}

/**
 * Place a per-object node for its object: rotation and scale as given, position
 * shifted to the object's geometric centre (`geometry_assets.md` §7).
 */
export function setNodeTransform(node: THREE.Object3D, obj: GeometryTransform): void {
  const center = (node.userData.localCenter as Vec3 | undefined) ?? [0, 0, 0];
  const offset = pivotOffset(center, obj.rotation, obj.scale);
  node.position.set(obj.position[0] + offset[0], obj.position[1] + offset[1], obj.position[2] + offset[2]);
  node.quaternion.set(...obj.rotation);
  node.scale.set(...obj.scale);
}

/**
 * The object-space `position` a dragged node reports — the inverse of
 * {@link setNodeTransform} (`geometry_assets.md` §7).
 */
export function positionFromNode(node: THREE.Object3D): Vec3 {
  const center = (node.userData.localCenter as Vec3 | undefined) ?? [0, 0, 0];
  const rotation: Quat = [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w];
  const scale: Vec3 = [node.scale.x, node.scale.y, node.scale.z];
  const offset = pivotOffset(center, rotation, scale);
  return [node.position.x - offset[0], node.position.y - offset[1], node.position.z - offset[2]];
}

function buildRoomPieces(obj: RoomGeometryObject, mats: Materials): Pieces {
  const local = roomTris(obj.halfX, obj.halfZ, obj.height, obj.thickness); // [floor, wallN, wallS, wallE, wallW]
  return {
    collision: local.map((t) => transformTriMesh(t, obj.position, obj.rotation, obj.scale)),
    local,
    node: nodeFor(
      obj,
      [meshFromTris(local[0], mats.floorMat), ...local.slice(1).map((w) => meshFromTris(w, mats.wallMat))],
      local,
    ),
  };
}

function buildBoxPieces(obj: BoxGeometryObject, mats: Materials): Pieces {
  const local = boxTris(obj.min, obj.max);
  return {
    collision: [transformTriMesh(local, obj.position, obj.rotation, obj.scale)],
    local: [local],
    node: nodeFor(obj, [meshFromTris(local, mats.boxMat)], [local]),
  };
}

/**
 * Loads a `mesh` object's asset and reduces every mesh in its scene graph to a
 * world-space `TriMesh` — each mesh's geometry transformed by (object transform
 * × node world-matrix), per spec §14.6. Non-mesh nodes (lights/cameras) are
 * skipped for collision; the loaded scene graph is the render node's child,
 * materials intact, with the object transform on the node above it (§7).
 *
 * **glTF only, for now.** `.ply` and `.obj` arrive with the Add Geometry dialog
 * (`geometry_assets.md` §13, stage 2); a `src` with any other extension is
 * rejected here rather than silently contributing nothing, which would break
 * §14.6's "every geometry object contributes to occlusion".
 */
async function buildMeshPieces(obj: MeshGeometryObject, resolveAsset: AssetResolver): Promise<Pieces> {
  const lower = obj.src.toLowerCase();
  if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
    throw new Error(`Cannot load mesh geometry "${obj.src}": only .glb/.gltf are supported yet`);
  }
  const bytes = await resolveAsset(obj.src);
  const gltf: GLTF = await new GLTFLoader().parseAsync(bytes, '');

  gltf.scene.updateMatrixWorld(true);
  // Reduced in the **object's own frame** (each mesh by its node's world matrix
  // within the asset, and no more): the object transform is applied by
  // `transformTriMesh` below, so a later move/rotate/scale re-bakes these same
  // triangles without re-parsing the asset (§4.3).
  const local: TriMesh[] = [];
  gltf.scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const positionAttr = node.geometry.getAttribute('position');
    if (!positionAttr) return;
    const vertCount = positionAttr.count;
    const positions = new Float32Array(vertCount * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < vertCount; i++) {
      v.fromBufferAttribute(positionAttr, i).applyMatrix4(node.matrixWorld);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    const indexAttr = node.geometry.getIndex();
    const indices = indexAttr
      ? Uint32Array.from(indexAttr.array)
      : Uint32Array.from({ length: vertCount }, (_, i) => i);
    local.push({ positions, indices });
  });
  const collision = local.map((t) => transformTriMesh(t, obj.position, obj.rotation, obj.scale));

  // A mesh asset's local triangles are the same buffers, un-baked: the object
  // matrix is dropped from `finalMatrix` so a later transform edit can re-bake
  // them without re-parsing the asset (§4.3).
  return { collision, local, node: nodeFor(obj, [gltf.scene], local) };
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

/**
 * The union AABB of the collision pieces, **without merging them**
 * (`geometry_assets.md` §4.3): bounds are wanted on every edit (the viewport
 * frames them, sections spawn into them, the stats panel reports them) while the
 * merge is wanted only by a run.
 */
function boundsOfPieces(pieces: TriMesh[]): { worldMin: Vec3; worldMax: Vec3 } | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const piece of pieces) {
    const { positions } = piece;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (min === null || max === null) {
        min = [x, y, z];
        max = [x, y, z];
        continue;
      }
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  if (min === null || max === null) return null;
  const margin = WORKSPACE_MARGIN;
  return {
    worldMin: [min[0] - margin, min[1] - margin, min[2] - margin],
    worldMax: [max[0] + margin, max[1] + margin, max[2] + margin],
  };
}

function finishBuild(
  collisionPieces: TriMesh[],
  nodes: Map<string, THREE.Object3D>,
  localTris: Map<string, TriMesh[]>,
  sourceGeometry: readonly GeometryObject[],
  group = new THREE.Group(),
): GeometryBuild {
  const bounds = boundsOfPieces(collisionPieces) ?? EMPTY_WORKSPACE;
  // No clipping until a section clip sets planes (spec §13.9); the materials are
  // built with `clippingPlanes` unset, which is "not clipped". A reused group
  // already holds its nodes (and its clip planes) — see `rebuildWithTransforms`.
  if (group.children.length === 0) {
    for (const node of nodes.values()) group.add(node);
    forceDoubleSided(group);
  }
  // The merge runs on first read of `sceneMesh` and is kept thereafter (§4.3).
  let merged: SceneMesh | null = null;
  return {
    get sceneMesh(): SceneMesh {
      if (merged === null) {
        const tris = mergeTris(collisionPieces);
        merged = { positions: tris.positions, indices: tris.indices };
      }
      return merged;
    },
    group,
    worldMin: bounds.worldMin,
    worldMax: bounds.worldMax,
    objectNodes: nodes,
    isEmpty: collisionPieces.length === 0,
    localTris,
    sourceGeometry,
  };
}

/**
 * Whether two geometry lists differ **only** in their transforms — same objects,
 * same order, same shapes, same enabled flags.
 *
 * That is the case a gizmo drag produces, and it is the one case that must not
 * touch the scene graph (`geometry_assets.md` §4.3): `objectChange` fires per
 * frame, so a rebuild there would dispose the very node under the gizmo and the
 * drag would die on its first pixel.
 */
function onlyTransformsChanged(prev: readonly GeometryObject[], next: readonly GeometryObject[]): boolean {
  if (prev.length !== next.length) return false;
  return prev.every((a, i) => {
    const b = next[i];
    if (a.id !== b.id || a.kind !== b.kind || a.enabled !== b.enabled) return false;
    if (a.kind === 'mesh' && b.kind === 'mesh') return a.src === b.src;
    if (a.kind === 'box' && b.kind === 'box') return sameVec(a.min, b.min) && sameVec(a.max, b.max);
    if (a.kind === 'room' && b.kind === 'room') {
      return a.halfX === b.halfX && a.halfZ === b.halfZ && a.height === b.height && a.thickness === b.thickness;
    }
    return false;
  });
}

function sameVec(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * A build for `geometry` that **reuses the current one's scene graph** when only
 * transforms changed, or `null` when the structure did (`geometry_assets.md`
 * §4.3).
 *
 * The render nodes carry their objects' transforms, so a move/rotate/scale needs
 * no new geometry at all — only the node's TRS, plus a fresh build **identity**
 * so the engine re-inits at the next run (`handleRun` compares the build it last
 * loaded against the current one). Re-baking the collision triangles from the
 * cached local ones costs a pass over the vertices and no parse.
 */
export function rebuildWithTransforms(prev: GeometryBuild, geometry: readonly GeometryObject[]): GeometryBuild | null {
  if (!onlyTransformsChanged(prev.sourceGeometry, geometry)) return null;

  const collisionPieces: TriMesh[] = [];
  for (const obj of geometry) {
    const node = prev.objectNodes.get(obj.id);
    if (node) setNodeTransform(node, obj);
    // `enabled` is part of the structural check above, so every object here is
    // enabled: unticking takes the full-rebuild path, which is what re-reads a
    // mesh's asset when it is ticked back on (§5.1).
    if (!obj.enabled) continue;
    for (const local of prev.localTris.get(obj.id) ?? []) {
      collisionPieces.push(transformTriMesh(local, obj.position, obj.rotation, obj.scale));
    }
  }
  return finishBuild(collisionPieces, prev.objectNodes, prev.localTris, geometry, prev.group);
}

/**
 * Synchronous fast path: `room`/`box` objects only. `mesh` objects are silently
 * skipped — this path never loads assets. Safe for the default scene (spec
 * §14.1), which never references an asset.
 *
 * **A disabled object contributes nothing** (`geometry_assets.md` §5.1) — no
 * triangles and no bounds — while keeping an invisible node, so it is still
 * draggable from its row.
 */
export function buildStaticGeometrySync(geometry: GeometryObject[]): GeometryBuild {
  const mats = makeMaterials();
  const collisionPieces: TriMesh[] = [];
  const nodes = new Map<string, THREE.Object3D>();
  const localTris = new Map<string, TriMesh[]>();
  for (const obj of geometry) {
    const pieces = obj.kind === 'room' ? buildRoomPieces(obj, mats) : obj.kind === 'box' ? buildBoxPieces(obj, mats) : null;
    if (!pieces) continue;
    // Disabled: drawn nowhere and measured nowhere, but still addressable (§5.1).
    if (obj.enabled) collisionPieces.push(...pieces.collision);
    else pieces.node.visible = false;
    nodes.set(obj.id, pieces.node);
    localTris.set(obj.id, pieces.local);
  }
  return finishBuild(collisionPieces, nodes, localTris, geometry);
}

/**
 * Full builder: `room`/`box` synchronously, `mesh` objects loaded via
 * `resolveAsset` (required whenever `geometry` contains a `mesh` object — the
 * default scene never does, so callers building only the default can omit it).
 *
 * **A disabled object contributes nothing** (`geometry_assets.md` §5.1), and its
 * asset is not even read: an unticked object costs nothing at all.
 */
export async function buildSceneGeometry(geometry: GeometryObject[], resolveAsset?: AssetResolver): Promise<GeometryBuild> {
  const mats = makeMaterials();
  const collisionPieces: TriMesh[] = [];
  const nodes = new Map<string, THREE.Object3D>();
  const localTris = new Map<string, TriMesh[]>();
  for (const obj of geometry) {
    let pieces: Pieces;
    if (obj.kind === 'room') {
      pieces = buildRoomPieces(obj, mats);
    } else if (obj.kind === 'box') {
      pieces = buildBoxPieces(obj, mats);
    } else {
      if (!resolveAsset) throw new Error(`Cannot load mesh geometry "${obj.src}": no asset resolver was provided`);
      // A disabled mesh's asset is not read at all: an unticked object costs
      // nothing, and the node it keeps is an empty one (§5.1).
      pieces = obj.enabled ? await buildMeshPieces(obj, resolveAsset) : { collision: [], local: [], node: nodeFor(obj, [], []) };
    }
    if (obj.enabled) collisionPieces.push(...pieces.collision);
    else pieces.node.visible = false;
    nodes.set(obj.id, pieces.node);
    localTris.set(obj.id, pieces.local);
  }
  return finishBuild(collisionPieces, nodes, localTris, geometry);
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
  // A transform-only rebuild **reuses the scene graph** (`rebuildWithTransforms`,
  // `geometry_assets.md` §4.3): same group, same nodes, new identity. Detaching
  // and disposing here would free the meshes the gizmo is mid-drag on.
  if (prev?.group === next.group) return;
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
