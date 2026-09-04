/**
 * Per-constraint viewport gizmos (`camera_placement.md` §6.1), and the placement
 * session's own overlay (§5.2, §6.2).
 *
 * A constraint draws as its **primitive plus its dilation**: a point as a handle
 * inside a translucent ball, a polyline as handles and tubes inside a capsule
 * chain, a plane as a rectangle inside a rounded slab.
 *
 * **The dilation is drawn exactly, not approximated.** The region is the
 * Minkowski sum of the primitive with a ball (§1.1), so a plane's is the core
 * slab *plus* four edge capsules *plus* four corner spheres — the bounding box
 * would claim the corners belong to the region when they do not, and a bare slab
 * would deny the rim that does. A gizmo that disagrees with `inRegion` is a
 * gizmo that teaches the user the wrong shape.
 *
 * The dilation meshes are rebuilt only when the constraint's **shape signature**
 * changes (kind, tolerance, vertex count, rectangle size), not on every frame:
 * every other update is a transform write, which is free.
 *
 * The keyed entry map, reconcile loop, pickHit, getAttachTarget, and dispose are
 * the shared `PickableGizmoSet` spine; this file owns the entry shape.
 *
 * `PlacementOverlay` lives here rather than in a file of its own because it draws
 * the same two things this file already builds — screen-space dots (`ScreenDots`)
 * and rebuilt `LineSegments` — for the pool scatter (§5.2) and the armed tool's
 * draft (§6.2). It is not part of the gizmo-set spine: it holds one group the
 * session shows and hides, with no keyed reconcile.
 */
import * as THREE from 'three';
import { PointsNodeMaterial } from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import { RenderOrder } from './renderOrder.ts';
import { PickableGizmoSet } from './gizmoSet.ts';
import type { CameraConstraint } from '../placement/region.ts';
import { NO_UNMOUNTABLE } from '../placement/pool.ts';
import { segmentPairs } from './polylineDraw.ts';

interface ConstraintEntry {
  /** Everything for this constraint; also the recursive pick body. */
  root: THREE.Group;
  /** The TransformControls target for a point (its handle) or a plane (its rect). */
  transformTarget: THREE.Object3D;
  /** Per-vertex handles for a polyline, in vertex order; empty otherwise. */
  handles: THREE.Mesh[];
  /** The translucent dilation, rebuilt on a shape change. */
  dilation: THREE.Group;
  /** What `dilation` was built for. */
  signature: string;
  /** False when the selected group's mount filter excludes this constraint (§4.1.1). */
  mountable: boolean;
}


const EDGE_COLOR = 0xc08bd0; // violet — distinct from cameras / probes / volumes
const SELECTED_COLOR = 0xffd23f;
const HANDLE_RADIUS = 0.12;
/** Screen-space diameter of a pool dot, in CSS pixels (§5.2). */
const DOT_SIZE = 4;
/**
 * Screen-space diameter of a draft vertex, in CSS pixels (§6.2). Larger than a
 * pool dot: there are a handful of them and they are the thing being drawn,
 * where the pool is a field of a thousand read as a whole.
 */
const DRAFT_DOT_SIZE = 7;
/** Instance buffers grow in powers of two from here, so a rebuild rarely recompiles. */
const MIN_DOT_CAPACITY = 256;
/** A draft's dot buffers start here (§6.2) — polylines are short. */
const MIN_DRAFT_DOT_CAPACITY = 16;
/** Object names, so a caller (and a test) can tell the overlay's parts apart. */
const POOL_DOTS_NAME = 'placement-pool-dots';
const DRAFT_DOTS_NAME = 'polyline-draft-vertices';
const DRAFT_LINE_NAME = 'polyline-draft-line';
const MOVES_NAME = 'placement-moves';

/** Shared unit geometries — one allocation for every constraint in the scene. */
const UNIT_SPHERE = new THREE.SphereGeometry(1, 16, 12);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const HANDLE_GEOMETRY = new THREE.SphereGeometry(HANDLE_RADIUS, 12, 8);

function shapeSignature(c: CameraConstraint): string {
  switch (c.kind) {
    case 'point':
      return `point|${c.distance}`;
    case 'polyline':
      return `polyline|${c.distance}|${c.points.map((p) => p.join(',')).join(';')}`;
    case 'plane':
      return `plane|${c.distance}|${c.size.join(',')}`;
  }
}

/**
 * The translucent violet used for every constraint *body* — a dilation shape and a
 * plane's rectangle alike (`VISUAL_DESIGN.md`: fill opacity 0.10).
 *
 * `userData.fill` marks it for the styling pass in `place`, which otherwise can't
 * tell a fill from an edge: it used to infer "is this translucent?" from parentage
 * (under `entry.dilation`) and force everything else to `opacity: 1`. A plane's
 * rectangle is a fill that is *not* a dilation, so it came out fully opaque — a solid
 * slab hiding the geometry behind it, where the point constraint's ball is see-through.
 * Marking the material is what makes the two cases the same case.
 */
function fillMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: EDGE_COLOR,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.userData.fill = true;
  return mat;
}

/**
 * The opacity a constraint body draws at (§6.1) — one ramp for every fill.
 *
 * `mountable` is false for a constraint that a selected group's mount filter
 * excludes entirely (`camera_placement.md` §3.1.2, §4.1.1): it is *there*, and
 * editable, but no draw can land on it. Dimming it to the disabled level is what
 * makes a wall with no zone overlap look different from a good one **before**
 * Build is pressed, rather than after minutes of GPU.
 */
export function fillOpacity(selected: boolean, enabled: boolean, mountable = true): number {
  if (!mountable) return selected ? 0.06 : 0.03;
  if (selected) return 0.16;
  return enabled ? 0.1 : 0.04;
}

export class ConstraintGizmoSet extends PickableGizmoSet<ConstraintEntry> {
  /** A constraint's body is several meshes, so the pick test descends (§6.1). */
  protected override pickRecursive = true;

  /**
   * Sync the gizmos to the current constraints. A disabled constraint dims: it
   * contributes no pool positions (§4.1) but is still there to be edited.
   */
  update(
    constraints: readonly CameraConstraint[],
    selectedId: string | null,
    selectedVertex: number | null,
    /**
     * Constraint ids the selected group's mount filter excludes (§4.1.1); they
     * dim. Empty means no filter, which is the ordinary case.
     */
    unmountable: ReadonlySet<string> = NO_UNMOUNTABLE,
  ): void {
    this.reconcile([...constraints], (entry, c) => {
      const selected = c.id === selectedId;
      entry.mountable = !unmountable.has(c.id);
      const signature = shapeSignature(c);
      if (entry.signature !== signature) {
        this.rebuild(entry, c);
        entry.signature = signature;
      }
      this.place(entry, c, selected, selected ? selectedVertex : null);
    });
  }

  /** The vertex nearest the ray on constraint `id`, or null (§6.1). */
  pickVertex(raycaster: THREE.Raycaster, id: string): number | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    let best: { vertex: number; distance: number } | null = null;
    entry.handles.forEach((handle, vertex) => {
      const hits = raycaster.intersectObject(handle, false);
      if (hits.length > 0 && (!best || hits[0].distance < best.distance)) {
        best = { vertex, distance: hits[0].distance };
      }
    });
    return best === null ? null : (best as { vertex: number }).vertex;
  }

  /** Read back a point's or plane's transform after a drag (§6.1). */
  readTransform(id: string): { position: Vec3; rotation: Quat; size: [number, number] } | undefined {
    const target = this.entries.get(id)?.transformTarget;
    if (!target) return undefined;
    const p = target.position;
    const q = target.quaternion;
    const s = target.scale;
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], size: [s.x, s.z] };
  }

  /** Read back one polyline vertex handle's position after a drag (§6.2). */
  readVertex(id: string, vertex: number): Vec3 | undefined {
    const handle = this.entries.get(id)?.handles[vertex];
    if (!handle) return undefined;
    const p = handle.position;
    return [p.x, p.y, p.z];
  }

  protected attachTargetOf(entry: ConstraintEntry): THREE.Object3D {
    return entry.transformTarget;
  }

  /**
   * The attach target for a polyline: the **selected vertex's** handle, since a
   * polyline has no whole-constraint transform (§6.1).
   */
  attachTargetForVertex(id: string, vertex: number): THREE.Object3D | undefined {
    return this.entries.get(id)?.handles[vertex];
  }

  protected pickTargetOf(entry: ConstraintEntry): THREE.Object3D {
    return entry.root;
  }

  protected createEntry(id: string): ConstraintEntry {
    const root = new THREE.Group();
    root.name = id;
    const dilation = new THREE.Group();
    root.add(dilation);
    this.group.add(root);
    return { root, transformTarget: root, handles: [], dilation, signature: '', mountable: true };
  }

  protected disposeEntry(entry: ConstraintEntry): void {
    this.group.remove(entry.root);
    entry.root.traverse((o) => {
      const mesh = o as THREE.Mesh | THREE.Line;
      // Unit geometries are shared and outlive every entry; only per-entry
      // geometry (a polyline's tubes and its line) is disposed here.
      if (mesh.geometry && !SHARED_GEOMETRY.has(mesh.geometry)) mesh.geometry.dispose();
      const material = (mesh as THREE.Mesh).material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else if (material) material.dispose();
    });
    entry.handles = [];
  }

  /** Rebuild the primitive meshes and the exact dilation for a shape change. */
  private rebuild(entry: ConstraintEntry, c: CameraConstraint): void {
    // Tear down everything but the root, then rebuild: a kind change makes the
    // previous body meaningless, and a shape change is rare enough that
    // rebuilding beats reconciling meshes one by one.
    for (const child of [...entry.root.children]) {
      entry.root.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry && !SHARED_GEOMETRY.has(mesh.geometry)) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else if (material) material.dispose();
      });
    }
    entry.handles = [];

    const dilation = new THREE.Group();
    dilation.renderOrder = RenderOrder.volumeFill;
    entry.dilation = dilation;
    entry.root.add(dilation);

    switch (c.kind) {
      case 'point': {
        const handle = new THREE.Mesh(HANDLE_GEOMETRY, new THREE.MeshBasicMaterial({ color: EDGE_COLOR }));
        handle.name = c.id;
        entry.root.add(handle);
        entry.transformTarget = handle;
        if (c.distance > 0) dilation.add(ball(c.distance));
        break;
      }
      case 'polyline': {
        // Handles are positioned in world space by `place`, so the root stays at
        // the origin and a vertex drag writes straight into the handle.
        for (const _p of c.points) {
          const handle = new THREE.Mesh(HANDLE_GEOMETRY, new THREE.MeshBasicMaterial({ color: EDGE_COLOR }));
          handle.name = c.id;
          entry.handles.push(handle);
          entry.root.add(handle);
        }
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(c.points.map((p) => new THREE.Vector3(...p))),
          new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.9 }),
        );
        entry.root.add(line);
        entry.transformTarget = entry.handles[0] ?? entry.root;
        if (c.distance > 0) {
          // A swept ball: a capsule per segment, a sphere per vertex. The
          // spheres are what make the joints round and the ends capped — exactly
          // what `distToPrimitive` measures (§3.2).
          for (const p of c.points) {
            const s = ball(c.distance);
            s.position.set(...p);
            dilation.add(s);
          }
          for (let i = 0; i + 1 < c.points.length; i++) {
            const seg = capsule(c.points[i], c.points[i + 1], c.distance);
            if (seg) dilation.add(seg);
          }
        }
        break;
      }
      case 'plane': {
        // The rect carries the transform: scale x/z are the rectangle's edges,
        // so TransformControls' scale handles write `size` directly (§6.1).
        const rect = new THREE.Mesh(UNIT_BOX, fillMaterial());
        rect.name = c.id;
        rect.scale.set(1, 0.001, 1); // a sheet, not a box — thickness comes from `distance`
        entry.root.add(rect);
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
          new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
        );
        rect.add(outline);
        entry.transformTarget = rect;
        if (c.distance > 0) dilation.add(roundedSlab(c.size[0], c.size[1], c.distance));
        break;
      }
    }
  }

  /** Write the current transforms and the selection styling (§6.1). */
  private place(
    entry: ConstraintEntry,
    c: CameraConstraint,
    selected: boolean,
    selectedVertex: number | null,
  ): void {
    const color = selected ? SELECTED_COLOR : EDGE_COLOR;
    switch (c.kind) {
      case 'point':
        entry.transformTarget.position.set(...c.position);
        entry.dilation.position.set(...c.position);
        entry.dilation.quaternion.identity();
        break;
      case 'polyline':
        entry.handles.forEach((handle, i) => {
          const p = c.points[i];
          if (p) handle.position.set(...p);
          const mat = handle.material as THREE.MeshBasicMaterial;
          mat.color.setHex(i === selectedVertex ? SELECTED_COLOR : color);
        });
        entry.dilation.position.set(0, 0, 0);
        entry.dilation.quaternion.identity();
        break;
      case 'plane': {
        const rect = entry.transformTarget;
        rect.position.set(...c.position);
        rect.quaternion.set(c.rotation[0], c.rotation[1], c.rotation[2], c.rotation[3]);
        rect.scale.set(c.size[0], 0.001, c.size[1]);
        entry.dilation.position.set(...c.position);
        entry.dilation.quaternion.copy(rect.quaternion);
        break;
      }
    }

    entry.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | undefined;
      if (!mat) return;
      // Every fill takes the same translucency ramp, whether it is a dilation or a
      // primitive body like a plane's rectangle — a constraint should read as
      // see-through the way the point constraint's ball does. Handles and lines are
      // the crisp part and stay opaque.
      if (mat.userData.fill === true) mat.opacity = fillOpacity(selected, c.enabled, entry.mountable);
      else if ('color' in mat) {
        (mat as THREE.MeshBasicMaterial).color.setHex(color);
        // A constraint no draw can land on reads like a disabled one, because
        // for a placement run that is exactly what it is (§4.1.1).
        const live = c.enabled && entry.mountable;
        mat.opacity = live ? 1 : 0.35;
        mat.transparent = !live;
      }
    });
  }
}

/** Geometries shared across entries — never disposed with an entry. */
const SHARED_GEOMETRY = new Set<THREE.BufferGeometry>([UNIT_SPHERE, UNIT_BOX, HANDLE_GEOMETRY]);

function ball(radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT_SPHERE, fillMaterial());
  mesh.scale.setScalar(radius);
  mesh.renderOrder = RenderOrder.volumeFill;
  return mesh;
}

/** A capsule's cylindrical body between `a` and `b`; null for a zero-length segment. */
function capsule(a: Vec3, b: Vec3, radius: number): THREE.Mesh | null {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const length = dir.length();
  if (length === 0) return null;
  // The caps come from the per-vertex spheres, so this is the cylinder only —
  // no double-drawn hemispheres to darken every joint.
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 16, 1, true), fillMaterial());
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.renderOrder = RenderOrder.volumeFill;
  return mesh;
}

/**
 * The exact rounded slab for a plane constraint: the core box, four edge
 * cylinders along the rectangle's rim, and four corner spheres (§6.1).
 *
 * Local frame: the rectangle spans X and Z, the normal is Y — the same
 * convention `region.ts` uses, so the group can simply adopt the rect's
 * transform.
 */
function roundedSlab(u: number, v: number, d: number): THREE.Group {
  const group = new THREE.Group();
  const core = new THREE.Mesh(UNIT_BOX, fillMaterial());
  core.scale.set(u, 2 * d, v);
  core.renderOrder = RenderOrder.volumeFill;
  group.add(core);

  const hu = u / 2;
  const hv = v / 2;
  for (const [along, at] of [
    ['x', [0, 0, hv]],
    ['x', [0, 0, -hv]],
    ['z', [hu, 0, 0]],
    ['z', [-hu, 0, 0]],
  ] as const) {
    const length = along === 'x' ? u : v;
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(d, d, length, 12, 1, true), fillMaterial());
    // A cylinder is Y-up; rotate it onto the rim's axis.
    if (along === 'x') edge.rotation.z = Math.PI / 2;
    else edge.rotation.x = Math.PI / 2;
    edge.position.set(at[0], at[1], at[2]);
    edge.renderOrder = RenderOrder.volumeFill;
    group.add(edge);
  }
  for (const corner of [
    [hu, 0, hv],
    [hu, 0, -hv],
    [-hu, 0, hv],
    [-hu, 0, -hv],
  ] as const) {
    const sphere = ball(d);
    sphere.position.set(corner[0], corner[1], corner[2]);
    group.add(sphere);
  }
  return group;
}

/**
 * The pool scatter and the draft polyline (`camera_placement.md` §5.2, §6.2).
 *
 * Both are transient overlays rather than entities, so they live in one small
 * object the viewport shows and hides with the Constraints layer (`spec.md`
 * §2.4): the pool's positions shaded by their own reachable score, and the
 * in-progress polyline with its rubber-band segment.
 *
 * The scatter costs nothing — the data was already built — and it answers "where are
 * the good mounts on this wall", which is the question a user asks immediately
 * after seeing the curve.
 */
/**
 * A pool dot's colour (§5.2): the ramp, and the exception for a chosen position.
 *
 * Pure, and separate from the overlay, because it is a **decision** rather than
 * rendering plumbing — a chosen position takes the selection colour outright
 * rather than a bright point on the ramp, so it stays distinguishable from a
 * merely high-scoring neighbour.
 *
 * `target` is written in place: this runs once per position, on every tick of
 * the count slider, over a pool of up to a thousand.
 */
export function poolDotColor(
  target: THREE.Color,
  count: number,
  top: number,
  chosen: boolean,
): THREE.Color {
  if (chosen) return target.set(SELECTED_COLOR);
  const t = top > 0 ? count / top : 0;
  return target.set(EDGE_COLOR).multiplyScalar(0.35 + 0.65 * t);
}

/**
 * A set of screen-space dots, drawn as one instanced `Sprite` (§5.2, §6.2).
 *
 * **A Sprite, not Points.** Under the WebGPU backend a `THREE.Points` draws point
 * primitives, and WebGPU's are **fixed at one pixel** — three's own
 * `PointsNodeMaterial` says so, and says the fix: use the material with a
 * `Sprite` and instancing. Drawn as Points the pool scatter was there, one pixel
 * wide, and invisible against the geometry; nothing about the data was wrong.
 *
 * **And screen-space sizing**, which is a second, independent reason a
 * world-space point size cannot work: the same overlay has to read on a 6 m demo
 * room and on the real 440 × 201 × 1120 m site, where a dot small enough for the
 * first is sub-pixel in the second (`camera_placement.md` §5.2).
 *
 * `depthWrite` is off because the dots are a *set*: they must not occlude each
 * other or the gizmos they sit on. `depthTest` stays on by default, so a pool
 * position behind a wall is hidden — which is information, not a defect. `onTop`
 * turns it off for a *draft*, whose dots sit exactly on the surface they were
 * clicked on and would otherwise z-fight it (`renderOrder.ts`).
 *
 * Shared by the pool scatter and the draft polyline's vertices because both
 * learned the same two lessons the hard way; the only differences are the dot
 * size, the starting capacity, and where the colour comes from.
 */
class ScreenDots {
  readonly sprite: THREE.Sprite;
  /** True when the set draws above the scene rather than depth-testing into it. */
  readonly onTop: boolean;
  /** Per-instance position and colour; grown in powers of two, reused otherwise. */
  private positions: THREE.InstancedBufferAttribute | null = null;
  private colors: THREE.InstancedBufferAttribute | null = null;
  private readonly scratch = new THREE.Color();
  /** Starting capacity; a constructor *parameter property* would not strip (`CONVENTIONS.md`). */
  private readonly minCapacity: number;

  constructor(name: string, size: number, minCapacity: number, opts: { onTop?: boolean } = {}) {
    this.minCapacity = minCapacity;
    this.onTop = opts.onTop === true;
    const material = new PointsNodeMaterial({
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      // A draft draws above the scene: its vertices sit exactly on the surface
      // they were clicked on, so depth-testing them against it is a coin flip
      // (`renderOrder.ts`). The pool keeps its depth test — a candidate position
      // behind a wall being hidden is information.
      depthTest: !this.onTop,
    });
    material.size = size;
    material.sizeAttenuation = false;
    this.sprite = new THREE.Sprite(material);
    this.sprite.name = name;
    // Each instance is placed by `positionNode`, so the sprite's own transform
    // stays at the origin — and culling it against that point would drop the
    // whole set the moment the origin left the frustum.
    this.sprite.frustumCulled = false;
    this.sprite.count = 0;
    this.sprite.renderOrder = this.onTop ? RenderOrder.draftOverlay : RenderOrder.volumeFill;
  }

  /**
   * Draw one dot per item. The accessors avoid an intermediate array: the pool
   * runs to a thousand items and this is called on every tick of the count
   * slider. `colorAt` is handed one scratch colour to write and return, for the
   * same reason.
   */
  set<T>(
    items: readonly T[],
    positionAt: (item: T, index: number) => Vec3,
    colorAt: (item: T, index: number, target: THREE.Color) => THREE.Color,
  ): void {
    const n = items.length;
    this.sprite.visible = n > 0;
    this.sprite.count = n;
    if (n === 0) return;
    this.ensureCapacity(n);
    const xyz = this.positions!.array as Float32Array;
    const rgb = this.colors!.array as Float32Array;
    items.forEach((item, i) => {
      xyz.set(positionAt(item, i), i * 3);
      const color = colorAt(item, i, this.scratch);
      rgb[i * 3] = color.r;
      rgb[i * 3 + 1] = color.g;
      rgb[i * 3 + 2] = color.b;
    });
    this.positions!.needsUpdate = true;
    this.colors!.needsUpdate = true;
  }

  /**
   * Grow the instance buffers, rebuilding the material's nodes only when they
   * actually move.
   *
   * Re-pointing `positionNode`/`colorNode` recompiles the shader, and the pool's
   * `set` runs on every tick of the count slider — so the buffers are sized in
   * powers of two and written in place, and a recompile happens once per set that
   * outgrows the last one rather than once per tick.
   */
  private ensureCapacity(n: number): void {
    const have = this.positions ? this.positions.count : 0;
    if (n <= have) return;
    let capacity = Math.max(this.minCapacity, have);
    while (capacity < n) capacity *= 2;
    this.positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const material = this.sprite.material as PointsNodeMaterial;
    material.positionNode = instancedBufferAttribute(this.positions);
    material.colorNode = instancedBufferAttribute(this.colors);
    material.needsUpdate = true;
  }

  dispose(): void {
    (this.sprite.material as THREE.Material).dispose();
  }
}

/**
 * A geometry for a line whose points arrive later — **already carrying a
 * `position` attribute**, and one degenerate segment long.
 *
 * This is the whole reason the draft polyline was invisible, three attempts
 * running. `PlacementOverlay` is built once and lives in the scene, while its
 * draft and move lines are filled in on demand; the render loop is already
 * running by then, so a geometry created bare is *rendered* bare at least once.
 * On that first frame three's WebGPU path resolves the object's vertex buffers
 * from `geometry.attributes` and caches them on the render object — an empty
 * list, and an empty `attributesId` map with it. `needsGeometryUpdate` then
 * re-checks only the attributes in that map, so a `position` attribute *added*
 * afterwards is never noticed: the object keeps a pipeline with no vertex buffer
 * for the rest of its life and draws nothing, with no error and nothing wrong
 * with the data. Every other line in this app (`probeGizmos`, `sectionGizmos`,
 * the committed polyline) happens to build its geometry attributes-first and so
 * never hit this.
 *
 * Starting with a real attribute puts `position` in that map, so each later
 * `setAttribute` is a change three does see and the render object is rebuilt.
 * The two zero vertices draw nothing themselves — and the object starts hidden
 * regardless (`CONVENTIONS.md`).
 */
function emptyLineGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  return geometry;
}

export class PlacementOverlay {
  readonly group = new THREE.Group();
  private readonly scatter = new ScreenDots(POOL_DOTS_NAME, DOT_SIZE, MIN_DOT_CAPACITY);
  /**
   * The draft's committed vertices (§6.2). Drawn as dots so the polyline being
   * drawn shows what it *is* — a set of clicked points — rather than only the
   * line through them, which reads as one segment until the second click and
   * leaves the user unsure the first click registered at all.
   */
  private readonly draftDots = new ScreenDots(DRAFT_DOTS_NAME, DRAFT_DOT_SIZE, MIN_DRAFT_DOT_CAPACITY, {
    onTop: true,
  });
  private readonly draft: THREE.LineSegments;
  private readonly draftGeometry = emptyLineGeometry();
  private readonly moves: THREE.LineSegments;
  private readonly movesGeometry = emptyLineGeometry();

  constructor() {
    // **Solid `LineSegments` over explicit endpoint pairs, rebuilt per update**,
    // over a geometry that starts with a `position` attribute — see
    // `emptyLineGeometry`, which is what actually made this line appear. A
    // `LineDashedMaterial` draft was invisible before it (it discards fragments
    // by a `lineDistance` attribute), as was one cut to length by `setDrawRange`;
    // both also sat on a bare geometry, so neither had a fair trial.
    //
    // `depthTest: false` + the topmost render order: a draft vertex sits *on* the
    // surface it was clicked on, so a depth-tested line through two of them is
    // coplanar with that wall and z-fights itself away (`renderOrder.ts`).
    this.draft = new THREE.LineSegments(
      this.draftGeometry,
      new THREE.LineBasicMaterial({
        color: SELECTED_COLOR,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.draft.name = DRAFT_LINE_NAME;
    this.draft.renderOrder = RenderOrder.draftOverlay;
    // Hidden until there is a segment: the frames before the first `setDraft`
    // would otherwise draw the placeholder geometry's degenerate segment.
    this.draft.visible = false;
    // A draft is transient and small, and it must never blink out because a
    // just-replaced attribute left the bounding sphere a frame behind.
    this.draft.frustumCulled = false;
    // One segment per moved camera, from where it stands today to where the plan
    // sends it (`camera_placement.md` §5.2). Apply re-arranges rather than
    // appends, so a preview that showed only new cameras would hide half of what
    // is about to happen.
    this.moves = new THREE.LineSegments(
      this.movesGeometry,
      new THREE.LineBasicMaterial({ color: SELECTED_COLOR, transparent: true, opacity: 0.8 }),
    );
    this.moves.name = MOVES_NAME;
    this.moves.renderOrder = RenderOrder.volumeFill;
    this.moves.visible = false;
    this.group.add(this.scatter.sprite);
    this.group.add(this.draft);
    this.group.add(this.draftDots.sprite);
    this.group.add(this.moves);
  }

  /**
   * Show the pool as dots shaded from dim to bright by each position's own
   * reachable count, with the chosen layout's positions brightest.
   */
  setPool(
    positions: readonly { position: Vec3; count: number }[],
    chosen: ReadonlySet<number>,
  ): void {
    const top = positions.length === 0 ? 0 : Math.max(1, ...positions.map((p) => p.count));
    this.scatter.set(
      positions,
      (p) => p.position,
      (p, i, target) => poolDotColor(target, p.count, top, chosen.has(i)),
    );
  }

  /** Draw one segment per planned camera move (§5.2, §5.3). */
  setMoves(lines: readonly { from: Vec3; to: Vec3 }[]): void {
    this.moves.visible = lines.length > 0;
    if (lines.length === 0) return;
    const xyz = new Float32Array(lines.length * 6);
    lines.forEach((l, i) => {
      xyz.set(l.from, i * 6);
      xyz.set(l.to, i * 6 + 3);
    });
    this.movesGeometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    this.movesGeometry.computeBoundingSphere();
  }

  /**
   * Draw the in-progress polyline, including its rubber-band segment (§6.2).
   *
   * `points` are the polyline's vertices, the last of which may be the cursor;
   * `segmentPairs` turns them into the endpoint pairs drawn between them.
   *
   * **A fresh attribute per update, sized exactly**, like `setMoves`, replacing
   * the placeholder `emptyLineGeometry` put there — which is what lets three's
   * WebGPU path notice the change at all. `setFromPoints` is not an option
   * (three r159+ writes into the existing buffer and refuses to grow it, so
   * every vertex past the second was dropped), nor is a grown buffer cut down by
   * `setDrawRange`. A draft is a handful of segments under the cursor, so the
   * allocation costs nothing next to being invisible.
   */
  setDraft(points: readonly Vec3[]): void {
    const pairs = segmentPairs(points);
    this.draft.visible = pairs.length > 0;
    if (pairs.length === 0) return;
    const xyz = new Float32Array(pairs.length * 3);
    pairs.forEach((p, i) => xyz.set(p, i * 3));
    this.draftGeometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    this.draftGeometry.computeBoundingSphere();
  }

  /**
   * Draw the draft's committed vertices (§6.2) — the cursor is **not** among them:
   * it is where the *next* vertex would go, and a dot there would claim a vertex
   * the user has not clicked.
   */
  setDraftVertices(points: readonly Vec3[]): void {
    this.draftDots.set(
      points,
      (p) => p,
      (_p, _i, target) => target.set(SELECTED_COLOR),
    );
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.scatter.dispose();
    this.draftDots.dispose();
    this.draftGeometry.dispose();
    (this.draft.material as THREE.Material).dispose();
    this.movesGeometry.dispose();
    (this.moves.material as THREE.Material).dispose();
  }
}
