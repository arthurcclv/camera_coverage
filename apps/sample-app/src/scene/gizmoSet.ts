/**
 * Shared spine for the per-entity gizmo sets (spec §5.3, §12.4, §13;
 * `sampling_volumes.md` §5).
 *
 * Cameras, probes, sections, and sampling volumes each render a keyed collection
 * of Three.js objects that is reconciled against the current scene on every
 * `update`: create an entry the first time an id is seen, mutate it in place
 * afterwards, and dispose it when the id disappears. That create/update/sweep
 * loop — plus the `entries` map, the group the objects hang under, `dispose`, and
 * `getAttachTarget` — is identical across all four sets, so it lives here once and
 * each set supplies only its own entry shape and per-entry mesh work.
 *
 * `GizmoSet` is the non-pickable spine (sections are selected from the hierarchy
 * row, never the viewport — spec §13.8). `PickableGizmoSet` adds the nearest-hit
 * `pickHit` raycast shared by the three sets that *are* viewport-pickable
 * (cameras, probes, volumes). SceneView holds the pickable three behind the
 * minimal `GizmoPicker` type so it can arbitrate a click across them regardless of
 * their differing entry shapes (`pick.ts` reduces the hits to the nearest).
 */
import * as THREE from 'three';

/** One gizmo-set ray hit: the entity id it would select and its ray distance. */
export interface GizmoHit {
  id: string;
  distance: number;
}

/**
 * The one capability SceneView needs from a pickable set: nearest hit under a
 * raycaster, or null. Lets SceneView keep the three pickable sets in one registry
 * despite their differing entry generics (`PickableGizmoSet` satisfies it).
 */
export interface GizmoPicker {
  pickHit(raycaster: THREE.Raycaster): GizmoHit | null;
}

/**
 * A keyed set of Three.js gizmo entries reconciled against the scene. Subclasses
 * own the entry shape `E` and supply the three per-entry primitives (build,
 * teardown, attach target); the base owns the map, the group, the reconcile loop,
 * `getAttachTarget`, and `dispose`.
 */
export abstract class GizmoSet<E> {
  /** Root the set's objects hang under; SceneView adds this to the scene once. */
  readonly group = new THREE.Group();
  protected entries = new Map<string, E>();

  /** Build the objects for a newly-seen id and add them to `group`. */
  protected abstract createEntry(id: string): E;
  /** Remove an entry's objects from `group` and free their GPU resources. */
  protected abstract disposeEntry(entry: E): void;
  /** The TransformControls attach target within an entry. */
  protected abstract attachTargetOf(entry: E): THREE.Object3D;

  /**
   * Reconcile `entries` against `items`: create on first sight, run `update` in
   * place, and dispose any entry whose id is no longer present. `update` carries
   * the per-set state (selection, flags, enabled zones, …) that each `update`
   * signature differs by, so only the shared skeleton lives here.
   */
  protected reconcile<I extends { id: string }>(items: I[], update: (entry: E, item: I) => void): void {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.id);
      let entry = this.entries.get(item.id);
      if (!entry) {
        entry = this.createEntry(item.id);
        this.entries.set(item.id, entry);
      }
      update(entry, item);
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
  }

  /** The entity's TransformControls attach target, or undefined if not present. */
  getAttachTarget(id: string): THREE.Object3D | undefined {
    const entry = this.entries.get(id);
    return entry ? this.attachTargetOf(entry) : undefined;
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
  }
}

/**
 * A `GizmoSet` whose entries are viewport-pickable (spec §5.2, §12.4;
 * `sampling_volumes.md` §5). Adds the nearest-hit raycast shared by the camera,
 * probe, and volume sets; subclasses point it at the entry's pick body.
 */
export abstract class PickableGizmoSet<E> extends GizmoSet<E> implements GizmoPicker {
  /** The raycast target (pick body) within an entry. */
  protected abstract pickTargetOf(entry: E): THREE.Object3D;

  /**
   * Nearest hit id + its ray distance, or null. The distance lets a caller pick
   * the single nearest hit across every pickable set (spec §5.2, `pick.ts`).
   */
  pickHit(raycaster: THREE.Raycaster): GizmoHit | null {
    let best: GizmoHit | null = null;
    for (const [id, entry] of this.entries) {
      const hits = raycaster.intersectObject(this.pickTargetOf(entry), false);
      if (hits.length > 0 && (!best || hits[0].distance < best.distance)) {
        best = { id, distance: hits[0].distance };
      }
    }
    return best;
  }
}
