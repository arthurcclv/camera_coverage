/**
 * The scene-document reducer (spec §5, §8.1, §12–§13; `sampling_volumes.md` §4).
 *
 * The single pure transition for everything the hierarchy's CRUD/rename/toggle
 * handlers, viewport selection, and transform drags used to mutate across ~34
 * scattered `App.tsx` handlers and effects. Collapsing them here gives one place
 * to reason about — and unit-test — the rules that used to hide in the wiring:
 * which edits mark the coverage result **stale**, which additionally dirty the
 * **sampled region set**, and how selection follows add/delete/duplicate.
 *
 * Pure: it allocates ids (`nextFreeId`) and calls the pure `entityDuplication`
 * helpers, but performs no I/O. Impure orchestration around a transition — the
 * geometry build + its disposal, the retained-chunk stores, the Generate BVH, the
 * engine, and the run-generation guard — stays in `App.tsx`, which dispatches
 * these actions and does the side effects (see ARCHITECTURE.md / DECISIONS.md).
 *
 * Stale rules (spec §8.1): a camera edit (add/delete/duplicate/move/optics/
 * enable, but not rename, §5.6) marks stale; a volume, `useZones`, or `zoneId`
 * edit marks stale and sampling-dirty; a probe or section edit, any rename,
 * adding an empty zone, and deleting or duplicating an empty zone mark neither
 * (§12.5, §13.4). A hierarchy **reorder** (§5.5.1) marks neither either — array
 * order is display-only. `stale` only latches once a run has happened
 * (`hasRunOnce`); `samplingDirty` latches regardless.
 */
import type { CameraConfig, Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from './probeVisibility.ts';
import { defaultSection, type Section } from './sectionHeatmap.ts';
import { defaultZoneName, type SamplingVolume, type Zone } from './samplingVolumes.ts';
import {
  defaultConstraint,
  defaultConstraintGroup,
  projectIntoRegion,
  type CameraConstraint,
  type ConstraintGroup,
  type ConstraintKind,
} from '../placement/region.ts';
import type { Scene } from './sceneModel.ts';
import type { Selection } from './viewportSelection.ts';
import {
  duplicateCamera,
  duplicateConstraint,
  duplicateConstraintGroup,
  duplicateProbe,
  duplicateSection,
  duplicateVolume,
  duplicateZone,
  nextFreeId,
} from './entityDuplication.ts';
import { moveBefore, moveConstraintBefore, moveVolumeBefore } from './reorder.ts';
import type { TransformChange } from './sceneView/types.ts';

// Defaults for a camera spawned from the "+" menu (spec §5.5), matching the
// default rig's optics (`cameras/defaults.ts`).
const NEW_CAMERA = { fov: 60, aspect: 16 / 9, near: 0.1, far: 30 } as const;
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * Drop every target-zone id a group holds that `keep` rejects
 * (`camera_placement.md` §3.1.2, §7).
 *
 * Returns the **same array** when nothing changed, so a delete that touched no
 * group cannot invalidate a pool: the fingerprint reads `zoneIds`, and a fresh
 * array of identical strings would still hash the same, but identity-stable
 * state keeps React's memoized derivations from re-running for nothing.
 */
function pruneTargetZones(
  groups: ConstraintGroup[],
  keep: (zoneId: string) => boolean,
): ConstraintGroup[] {
  if (!groups.some((g) => g.zoneIds.some((z) => !keep(z)))) return groups;
  return groups.map((g) =>
    g.zoneIds.every((z) => keep(z)) ? g : { ...g, zoneIds: g.zoneIds.filter(keep) },
  );
}

/** Entities addressable by a delete/duplicate action. */
export type EntityKind = 'camera' | 'probe' | 'section' | 'zone' | 'volume' | 'constraintGroup' | 'constraint';

/** The persisted scene-document fields (the {@link Scene} minus its geometry). */
export type SceneDoc = Pick<
  Scene,
  | 'cameras'
  | 'probes'
  | 'sections'
  | 'clipSectionId'
  | 'zones'
  | 'volumes'
  | 'useZones'
  | 'constraintGroups'
  | 'constraints'
>;

/**
 * The editable scene document plus its transient UI/dirtiness flags. Geometry
 * (`room`/`geometryObjects`), `voxelSize`, run outputs, and the run-generation
 * guard live in `App.tsx`, not here.
 */
export interface SceneDocState extends SceneDoc {
  selection: Selection;
  collapsedIds: Set<string>;
  /** Coverage result is out of date vs. the current inputs (spec §8.1). */
  stale: boolean;
  /** At least one run has completed — gates whether an edit latches `stale`. */
  hasRunOnce: boolean;
  /** The sampled region set changed and the next run must re-`setSampling` (§8). */
  samplingDirty: boolean;
}

export type SceneAction =
  | { type: 'addCamera'; position: Vec3 }
  | { type: 'addProbe'; position: Vec3 }
  | { type: 'addSection'; worldMin: Vec3; worldMax: Vec3 }
  | { type: 'addZone' }
  /** New constraint group (`camera_placement.md` §7). */
  | { type: 'addConstraintGroup' }
  /**
   * New constraint in the targeted group. `points` is the draw mode's committed
   * vertex list (`camera_placement.md` §6.2); omitted for a point or plane,
   * which spawn at `position`.
   */
  | { type: 'addConstraint'; kind: ConstraintKind; position: Vec3; points?: Vec3[] }
  | { type: 'addVolume'; position: Vec3 }
  | { type: 'deleteEntity'; kind: EntityKind; id: string }
  | { type: 'duplicateEntity'; kind: EntityKind; id: string }
  /** Hierarchy drag-reorder (§5.5.1): move `id` before sibling `beforeId`, or last when null. */
  | { type: 'reorderEntity'; kind: EntityKind; id: string; beforeId: string | null }
  | { type: 'changeCamera'; id: string; patch: Partial<CameraConfig> }
  /**
   * Toggle a camera's aim lock (`aim_optimization.md` §4.5). Separate from
   * `changeCamera` because the flag is app-only and changes nothing the engine
   * computes, so it must **not** mark the result stale.
   */
  | { type: 'toggleAimLock'; id: string }
  /**
   * Adopt the optimizer's proposals (`aim_optimization.md` §6.2). One action
   * rather than one per camera: the whole set is one edit, and dispatching N
   * would mark the result stale N times and fire N auto-runs.
   */
  | { type: 'applyAims'; rotations: ReadonlyMap<string, Quat> }
  | { type: 'changeProbe'; id: string; position: Vec3 }
  | { type: 'changeSection'; id: string; patch: Partial<Section> }
  | { type: 'changeVolume'; id: string; patch: Partial<SamplingVolume> }
  | { type: 'changeConstraintGroup'; id: string; patch: Partial<ConstraintGroup> }
  | { type: 'changeConstraint'; id: string; patch: Partial<CameraConstraint> }
  /** Move one polyline vertex (`camera_placement.md` §6.2). */
  | { type: 'moveConstraintVertex'; id: string; vertex: number; position: Vec3 }
  /** Insert a vertex at `at` — a segment click, or the panel's insert row (§6.2). */
  | { type: 'insertConstraintVertex'; id: string; at: number; position: Vec3 }
  /** Delete a vertex; refused on a 2-vertex polyline rather than silently converting (§6.2). */
  | { type: 'deleteConstraintVertex'; id: string; vertex: number }
  /**
   * Bind, rebind, or unbind a camera (`camera_placement.md` §6.3). Binding
   * clamps the camera into its new region at once — a binding that left the
   * camera off its rail would not be a constraint.
   */
  | { type: 'bindCamera'; id: string; constraintId: string | null }
  /**
   * Adopt a placement plan (`camera_placement.md` §5.3): re-arrange the group's
   * cameras onto the chosen positions, create only what the group could not
   * staff, and delete the surplus the chosen count does not need.
   *
   * One action rather than one per camera: the whole plan is one edit, and
   * dispatching N would mark the result stale N times and fire N auto-runs.
   */
  | {
      type: 'applyPlacement';
      /** Per moved camera: its id and exactly the fields §5.3.3 overwrites. */
      moves: { cameraId: string; position: Vec3; constraintId: string; near: number; far: number }[];
      creates: SceneCamera[];
      /** Camera ids the plan makes surplus — `enabled: false`, kept (§5.3.1). */
      disables: string[];
    }
  | {
      type: 'renameEntity';
      kind: 'camera' | 'probe' | 'section' | 'zone' | 'constraintGroup' | 'constraint';
      id: string;
      name: string;
    }
  | { type: 'toggleEnabled'; kind: 'camera' | 'section' | 'zone' | 'constraintGroup' | 'constraint'; id: string }
  | { type: 'toggleSectionClip'; id: string }
  | { type: 'toggleCollapse'; id: string }
  | { type: 'toggleUseZones'; value: boolean }
  | { type: 'transformApplied'; change: TransformChange }
  | { type: 'selectionChanged'; selection: Selection }
  | { type: 'generated'; zones: Zone[]; volumes: SamplingVolume[] }
  | { type: 'markStale' }
  | { type: 'samplingApplied' }
  | { type: 'runCompleted' }
  | { type: 'sceneReplaced'; doc: SceneDoc };

/** Initial document state from a {@link Scene} (spec §14.1): first camera selected, nothing collapsed, clean. */
export function initSceneState(scene: Scene): SceneDocState {
  return {
    cameras: scene.cameras,
    probes: scene.probes,
    sections: scene.sections,
    clipSectionId: scene.clipSectionId,
    zones: scene.zones,
    volumes: scene.volumes,
    useZones: scene.useZones,
    constraintGroups: scene.constraintGroups,
    constraints: scene.constraints,
    selection: scene.cameras[0] ? { kind: 'camera', id: scene.cameras[0].id } : null,
    collapsedIds: new Set(),
    stale: false,
    hasRunOnce: false,
    samplingDirty: false,
  };
}

// A camera edit is a coverage input: it latches `stale` once a run has happened
// (spec §8.1). Renames are excluded by the caller, not here.
const cameraInput = (s: SceneDocState) => (s.hasRunOnce ? { stale: true } : null);
// A volume/`useZones`/`zoneId` edit also dirties the sampled region set (§8);
// `samplingDirty` latches regardless of whether a run has happened yet.
const samplingInput = (s: SceneDocState) => ({ samplingDirty: true, ...(s.hasRunOnce ? { stale: true } : null) });

/**
 * Project a bound camera's position into its constraint's region
 * (`camera_placement.md` §6.3).
 *
 * Applied on **every** write of a camera's position — a gizmo drag, a committed
 * numeric field, place-on-surface, a bind — so a reviewed layout cannot drift
 * into places where no mount exists. An unbound camera, or one whose constraint
 * has been deleted, is returned untouched: a dangling binding must not freeze a
 * camera in place.
 */
function clampToConstraint(camera: SceneCamera, constraints: readonly CameraConstraint[]): SceneCamera {
  if (camera.constraintId === undefined) return camera;
  const c = constraints.find((x) => x.id === camera.constraintId);
  if (!c) return camera;
  return { ...camera, position: projectIntoRegion(camera.position, c) };
}

/** Drop the binding of every camera whose constraint `gone` names (§6.3). */
function unbindFrom(cameras: SceneCamera[], gone: (constraintId: string) => boolean): SceneCamera[] {
  if (!cameras.some((c) => c.constraintId !== undefined && gone(c.constraintId))) return cameras;
  return cameras.map((c) => {
    if (c.constraintId === undefined || !gone(c.constraintId)) return c;
    const { constraintId: _drop, ...rest } = c;
    return rest as SceneCamera;
  });
}

/**
 * Re-clamp the cameras bound to a constraint that just changed shape (§6.3).
 *
 * Reshaping a rail can leave a camera mounted on it outside its own region, so
 * the clamp runs again — and because that **moves a camera**, it is a coverage
 * input and marks the result stale, exactly as dragging it would. Returns an
 * empty patch when nothing actually moved, so a reshape that keeps every bound
 * camera inside costs no state churn and no recompute.
 */
function reclamp(
  state: SceneDocState,
  constraints: readonly CameraConstraint[],
  constraintId: string,
): Partial<SceneDocState> {
  if (!state.cameras.some((c) => c.constraintId === constraintId)) return {};
  const cameras = state.cameras.map((c) =>
    c.constraintId === constraintId ? clampToConstraint(c, constraints) : c,
  );
  const moved = cameras.some((c, i) => {
    const was = state.cameras[i].position;
    return c.position[0] !== was[0] || c.position[1] !== was[1] || c.position[2] !== was[2];
  });
  return moved ? { cameras, ...(state.hasRunOnce ? { stale: true } : null) } : {};
}

/** Rewrite one polyline constraint's vertices; identity for any other kind. */
function mapPolyline(
  constraints: CameraConstraint[],
  id: string,
  f: (points: Vec3[]) => Vec3[],
): CameraConstraint[] {
  const at = constraints.findIndex((c) => c.id === id);
  if (at < 0) return constraints;
  const c = constraints[at];
  if (c.kind !== 'polyline') return constraints;
  const points = f(c.points);
  if (points === c.points) return constraints;
  const next = constraints.slice();
  next[at] = { ...c, points };
  return next;
}

/** Clear the selection iff it points at the entity being removed. */
function selectionAfterDelete(selection: Selection, kind: EntityKind, id: string): Selection {
  return selection?.kind === kind && selection.id === id ? null : selection;
}

export function sceneReducer(state: SceneDocState, action: SceneAction): SceneDocState {
  switch (action.type) {
    case 'addCamera': {
      const id = nextFreeId('cam', state.cameras.map((c) => c.id));
      const camera: SceneCamera = {
        id,
        name: '',
        enabled: true,
        position: [...action.position] as Vec3,
        rotation: [...IDENTITY_QUAT] as Quat,
        ...NEW_CAMERA,
      };
      return { ...state, cameras: [...state.cameras, camera], selection: { kind: 'camera', id }, ...cameraInput(state) };
    }

    case 'addProbe': {
      const id = nextFreeId('probe', state.probes.map((p) => p.id));
      const probe: Probe = { id, name: '', position: [...action.position] as Vec3 };
      // A probe is never a coverage input (spec §12.5).
      return { ...state, probes: [...state.probes, probe], selection: { kind: 'probe', id } };
    }

    case 'addSection': {
      const id = nextFreeId('section', state.sections.map((s) => s.id));
      const section = defaultSection(id, action.worldMin, action.worldMax);
      // Adding a section never marks coverage stale (spec §8.1, §13.4).
      return { ...state, sections: [...state.sections, section], selection: { kind: 'section', id } };
    }

    case 'addZone': {
      const id = nextFreeId('zone', state.zones.map((z) => z.id));
      // An empty zone marks no voxels, so it is not a coverage input (§4).
      return { ...state, zones: [...state.zones, { id, name: defaultZoneName(id), enabled: true }], selection: { kind: 'zone', id } };
    }

    case 'addConstraintGroup': {
      const id = nextFreeId('cg', state.constraintGroups.map((g) => g.id));
      // A constraint is not an analysis input (`camera_placement.md` §1.1), so
      // nothing here marks the coverage result stale — deliberately unlike a zone.
      return {
        ...state,
        constraintGroups: [...state.constraintGroups, defaultConstraintGroup(id)],
        selection: { kind: 'constraintGroup', id },
      };
    }

    case 'addConstraint': {
      // Target group: the selected group, or the selected constraint's group, or
      // the first group, creating "Group 1" if none exist (§7).
      const sel = state.selection;
      let groups = state.constraintGroups;
      let targetGroupId =
        sel?.kind === 'constraintGroup'
          ? sel.id
          : sel?.kind === 'constraint'
            ? state.constraints.find((c) => c.id === sel.id)?.groupId ?? null
            : null;
      if (targetGroupId === null || !groups.some((g) => g.id === targetGroupId)) {
        targetGroupId = groups[0]?.id ?? null;
      }
      if (targetGroupId === null) {
        const groupId = nextFreeId('cg', groups.map((g) => g.id));
        groups = [...groups, defaultConstraintGroup(groupId)];
        targetGroupId = groupId;
      }
      const id = nextFreeId('con', state.constraints.map((c) => c.id));
      const constraint = defaultConstraint(id, targetGroupId, action.kind, action.position, action.points);
      return {
        ...state,
        constraintGroups: groups,
        constraints: [...state.constraints, constraint],
        selection: { kind: 'constraint', id },
      };
    }

    case 'addVolume': {
      // Target zone: the selected zone, or the selected volume's zone, or the
      // first zone, creating "Zone 1" if none exist (`sampling_volumes.md` §4).
      const sel = state.selection;
      let zones = state.zones;
      let targetZoneId =
        sel?.kind === 'zone'
          ? sel.id
          : sel?.kind === 'volume'
            ? state.volumes.find((v) => v.id === sel.id)?.zoneId ?? null
            : null;
      if (targetZoneId === null || !zones.some((z) => z.id === targetZoneId)) {
        targetZoneId = zones[0]?.id ?? null;
      }
      if (targetZoneId === null) {
        const zoneId = nextFreeId('zone', zones.map((z) => z.id));
        zones = [...zones, { id: zoneId, name: defaultZoneName(zoneId), enabled: true }];
        targetZoneId = zoneId;
      }
      const id = nextFreeId('volume', state.volumes.map((v) => v.id));
      const volume: SamplingVolume = {
        id,
        zoneId: targetZoneId,
        position: [...action.position] as Vec3,
        rotation: [...IDENTITY_QUAT] as Quat,
        size: [1, 1, 1],
      };
      return { ...state, zones, volumes: [...state.volumes, volume], selection: { kind: 'volume', id }, ...samplingInput(state) };
    }

    case 'deleteEntity': {
      const { kind, id } = action;
      const selection = selectionAfterDelete(state.selection, kind, id);
      switch (kind) {
        case 'camera':
          return { ...state, cameras: state.cameras.filter((c) => c.id !== id), selection, ...cameraInput(state) };
        case 'probe':
          return { ...state, probes: state.probes.filter((p) => p.id !== id), selection };
        case 'section':
          // Deleting the clipping section clears the clip (spec §13.9).
          return {
            ...state,
            sections: state.sections.filter((s) => s.id !== id),
            clipSectionId: state.clipSectionId === id ? null : state.clipSectionId,
            selection,
          };
        case 'volume':
          return { ...state, volumes: state.volumes.filter((v) => v.id !== id), selection, ...samplingInput(state) };
        case 'constraint':
          // Deleting a constraint **unbinds** every camera that referenced it;
          // the cameras and their positions stay (`camera_placement.md` §6.3).
          return {
            ...state,
            constraints: state.constraints.filter((c) => c.id !== id),
            cameras: unbindFrom(state.cameras, (cid) => cid === id),
            selection,
          };
        case 'constraintGroup': {
          // Removing a group removes its constraints too, and unbinds theirs (§7).
          const gone = new Set(state.constraints.filter((c) => c.groupId === id).map((c) => c.id));
          return {
            ...state,
            constraints: state.constraints.filter((c) => c.groupId !== id),
            constraintGroups: state.constraintGroups.filter((g) => g.id !== id),
            cameras: unbindFrom(state.cameras, (cid) => gone.has(cid)),
            selection: selection?.kind === 'constraint' && gone.has(selection.id) ? null : selection,
          };
        }
        case 'zone': {
          // Removing a zone removes its volumes too (§4); it is a coverage input
          // only when it actually had volumes (an empty zone marks nothing).
          const hadVolumes = state.volumes.some((v) => v.zoneId === id);
          return {
            ...state,
            volumes: state.volumes.filter((v) => v.zoneId !== id),
            zones: state.zones.filter((z) => z.id !== id),
            // A deleted zone is pruned from every group that targeted it
            // (`camera_placement.md` §3.1.2, §7) — the same eager unbinding
            // `clipSectionId` and a camera's `constraintId` already get. A group
            // left with an empty list falls back to the app's marked set rather
            // than becoming unusable.
            constraintGroups: pruneTargetZones(state.constraintGroups, (z) => z !== id),
            selection,
            ...(hadVolumes ? samplingInput(state) : null),
          };
        }
      }
      return state;
    }

    case 'duplicateEntity': {
      const { kind, id } = action;
      switch (kind) {
        case 'camera': {
          const copy = duplicateCamera(state.cameras, id);
          if (!copy) return state;
          return { ...state, cameras: [...state.cameras, copy], selection: { kind: 'camera', id: copy.id }, ...cameraInput(state) };
        }
        case 'probe': {
          const copy = duplicateProbe(state.probes, id);
          if (!copy) return state;
          return { ...state, probes: [...state.probes, copy], selection: { kind: 'probe', id: copy.id } };
        }
        case 'section': {
          const copy = duplicateSection(state.sections, id);
          if (!copy) return state;
          return { ...state, sections: [...state.sections, copy], selection: { kind: 'section', id: copy.id } };
        }
        case 'volume': {
          const copy = duplicateVolume(state.volumes, id);
          if (!copy) return state;
          return { ...state, volumes: [...state.volumes, copy], selection: { kind: 'volume', id: copy.id }, ...samplingInput(state) };
        }
        case 'constraint': {
          const copy = duplicateConstraint(state.constraints, id);
          if (!copy) return state;
          return {
            ...state,
            constraints: [...state.constraints, copy],
            selection: { kind: 'constraint', id: copy.id },
          };
        }
        case 'constraintGroup': {
          const copy = duplicateConstraintGroup(state.constraintGroups, state.constraints, id);
          if (!copy) return state;
          return {
            ...state,
            constraintGroups: [...state.constraintGroups, copy.group],
            constraints: [...state.constraints, ...copy.constraints],
            selection: { kind: 'constraintGroup', id: copy.group.id },
          };
        }
        case 'zone': {
          const copy = duplicateZone(state.zones, state.volumes, id);
          if (!copy) return state;
          // The copy is a coverage input only when it brought volumes with it.
          return {
            ...state,
            zones: [...state.zones, copy.zone],
            volumes: copy.volumes.length > 0 ? [...state.volumes, ...copy.volumes] : state.volumes,
            selection: { kind: 'zone', id: copy.zone.id },
            ...(copy.volumes.length > 0 ? samplingInput(state) : null),
          };
        }
      }
      return state;
    }

    // Hierarchy drag-reorder (§5.5.1). Order *is* the persistence — these arrays
    // serialize in order (§14.3) — so a reorder is just a splice. It marks neither
    // `stale` nor `samplingDirty`: array order is display-only and results are
    // keyed by entity id, not position (§8.1). Selection is untouched, so the
    // detail panel and the viewport gizmo stay put. `moveBefore`/`moveVolumeBefore`
    // return the input array on a no-op, so an illegal or null move is identity.
    case 'reorderEntity': {
      const { kind, id, beforeId } = action;
      switch (kind) {
        case 'camera':
          return { ...state, cameras: moveBefore(state.cameras, id, beforeId) };
        case 'probe':
          return { ...state, probes: moveBefore(state.probes, id, beforeId) };
        case 'section':
          return { ...state, sections: moveBefore(state.sections, id, beforeId) };
        case 'zone':
          return { ...state, zones: moveBefore(state.zones, id, beforeId) };
        case 'volume':
          return { ...state, volumes: moveVolumeBefore(state.volumes, id, beforeId) };
        case 'constraintGroup':
          return { ...state, constraintGroups: moveBefore(state.constraintGroups, id, beforeId) };
        case 'constraint':
          return { ...state, constraints: moveConstraintBefore(state.constraints, id, beforeId) };
      }
      return state;
    }

    case 'changeCamera':
      return {
        ...state,
        cameras: state.cameras.map((c) =>
          c.id === action.id ? clampToConstraint({ ...c, ...action.patch }, state.constraints) : c,
        ),
        ...cameraInput(state),
      };

    case 'toggleAimLock':
      // App-only flag: no `cameraInput`, so it never marks the result stale.
      return {
        ...state,
        cameras: state.cameras.map((c) => (c.id === action.id ? { ...c, aimLocked: !c.aimLocked } : c)),
      };

    case 'applyAims':
      return {
        ...state,
        cameras: state.cameras.map((c) => {
          const rotation = action.rotations.get(c.id);
          return rotation ? { ...c, rotation } : c;
        }),
        ...cameraInput(state),
      };

    case 'changeProbe':
      // Moving a probe never marks results stale (spec §12.5).
      return { ...state, probes: state.probes.map((p) => (p.id === action.id ? { ...p, position: action.position } : p)) };

    case 'changeSection':
      // Editing a section never marks coverage stale (spec §8.1, §13.4).
      return { ...state, sections: state.sections.map((s) => (s.id === action.id ? { ...s, ...action.patch } : s)) };

    case 'changeVolume':
      return {
        ...state,
        volumes: state.volumes.map((v) => (v.id === action.id ? { ...v, ...action.patch } : v)),
        ...samplingInput(state),
      };

    case 'changeConstraintGroup':
      // The template, the pool size and the strategy are analysis inputs, never coverage inputs
      // (`camera_placement.md` §1.1) — a `far` edit invalidates the *pool*
      // (§3.3.1), which the placement session notices for itself.
      return {
        ...state,
        constraintGroups: state.constraintGroups.map((g) => (g.id === action.id ? { ...g, ...action.patch } : g)),
      };

    case 'changeConstraint': {
      const constraints = state.constraints.map((c) =>
        c.id === action.id ? ({ ...c, ...action.patch } as CameraConstraint) : c,
      );
      // Reshaping a constraint can leave a camera bound to it outside its region,
      // so every bound camera is re-clamped (§6.3). This is a *camera* position
      // edit, so it marks stale exactly as a drag would.
      return { ...state, constraints, ...reclamp(state, constraints, action.id) };
    }

    case 'moveConstraintVertex': {
      const constraints = mapPolyline(state.constraints, action.id, (points) =>
        points.map((p, i) => (i === action.vertex ? ([...action.position] as Vec3) : p)),
      );
      if (constraints === state.constraints) return state;
      return { ...state, constraints, ...reclamp(state, constraints, action.id) };
    }

    case 'insertConstraintVertex': {
      const constraints = mapPolyline(state.constraints, action.id, (points) => {
        const at = Math.max(0, Math.min(action.at, points.length));
        return [...points.slice(0, at), [...action.position] as Vec3, ...points.slice(at)];
      });
      if (constraints === state.constraints) return state;
      return { ...state, constraints, ...reclamp(state, constraints, action.id) };
    }

    case 'deleteConstraintVertex': {
      const constraints = mapPolyline(state.constraints, action.id, (points) =>
        // Refused rather than silently converted to a point (§6.2).
        points.length <= 2 ? points : points.filter((_, i) => i !== action.vertex),
      );
      if (constraints === state.constraints) return state;
      return { ...state, constraints, ...reclamp(state, constraints, action.id) };
    }

    case 'bindCamera': {
      const { id, constraintId } = action;
      return {
        ...state,
        cameras: state.cameras.map((c) => {
          if (c.id !== id) return c;
          const next: SceneCamera = { ...c };
          if (constraintId === null) delete next.constraintId;
          else next.constraintId = constraintId;
          return clampToConstraint(next, state.constraints);
        }),
        ...cameraInput(state),
      };
    }

    case 'applyPlacement': {
      // One state update for the whole plan — one staleness mark, one auto-run
      // (`camera_placement.md` §5.3).
      const { moves, creates, disables } = action;
      const switchedOff = new Set(disables);
      const moveById = new Map(moves.map((m) => [m.cameraId, m]));
      const cameras = state.cameras.map((c) => {
        // The surplus is switched off where it stands (§5.3.1) — nothing else
        // about it changes, so the eye toggle in the hierarchy undoes this.
        if (switchedOff.has(c.id)) return c.enabled ? { ...c, enabled: false } : c;
        const move = moveById.get(c.id);
        if (!move) return c;
        // Exactly what the search depended on (§5.3.3): the position, the
        // binding, and the range the pool was built at — plus `enabled`,
        // because an earlier Apply may have switched this very camera off and a
        // layout scored at N cameras has to be N *contributing* cameras.
        // `name`, `rotation`, `fov`, `aspect`, and `aimLocked` are the camera's
        // own and are left alone — the search never depended on them.
        return clampToConstraint(
          {
            ...c,
            position: move.position,
            constraintId: move.constraintId,
            near: move.near,
            far: move.far,
            enabled: true,
          },
          state.constraints,
        );
      });
      const created = creates.map((c) => clampToConstraint(c, state.constraints));
      // Nothing is removed, so the selection always survives: a re-arrange does
      // not yank the inspector off what the user was looking at, and a camera
      // the plan switched off stays selected and inspectable (§5.3.1).
      const selection = state.selection;
      return {
        ...state,
        cameras: [...cameras, ...created],
        selection: selection ?? (created[0] ? { kind: 'camera', id: created[0].id } : null),
        ...cameraInput(state),
      };
    }

    case 'renameEntity': {
      // A rename is a pure display-label write — never a coverage input, for any
      // entity, including cameras (spec §5.6).
      const { kind, id, name } = action;
      switch (kind) {
        case 'camera':
          return { ...state, cameras: state.cameras.map((c) => (c.id === id ? { ...c, name } : c)) };
        case 'probe':
          return { ...state, probes: state.probes.map((p) => (p.id === id ? { ...p, name } : p)) };
        case 'section':
          return { ...state, sections: state.sections.map((s) => (s.id === id ? { ...s, name } : s)) };
        case 'zone':
          return { ...state, zones: state.zones.map((z) => (z.id === id ? { ...z, name } : z)) };
        case 'constraintGroup':
          return {
            ...state,
            constraintGroups: state.constraintGroups.map((g) => (g.id === id ? { ...g, name } : g)),
          };
        case 'constraint':
          return { ...state, constraints: state.constraints.map((c) => (c.id === id ? { ...c, name } : c)) };
      }
      return state;
    }

    case 'toggleEnabled': {
      const { kind, id } = action;
      // Exhaustive per case, never defaulted: the trailing `else` this replaced
      // claimed `zone` *and* every kind added to the union after it, so a new
      // toggleable entity would have silently flipped a zone's flag instead of
      // its own (see `ui/entityMenu.ts` for the same bug shipped).
      switch (kind) {
        case 'camera':
          // Compute participation (spec §5.4) — a coverage input.
          return {
            ...state,
            cameras: state.cameras.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
            ...cameraInput(state),
          };
        case 'section':
          // Heatmap on/off — a client-side re-filter, never stale (spec §13).
          return { ...state, sections: state.sections.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) };
        case 'zone':
          // A client-side re-filter of the marked set, never stale (§7.3).
          return { ...state, zones: state.zones.map((z) => (z.id === id ? { ...z, enabled: !z.enabled } : z)) };
        case 'constraintGroup':
          // A disabled group is skipped by the search; it changes no coverage
          // number, so it can never be stale (`camera_placement.md` §1.1, §3.1).
          return {
            ...state,
            constraintGroups: state.constraintGroups.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)),
          };
        case 'constraint':
          // A disabled constraint contributes no pool positions (§4.1).
          return {
            ...state,
            constraints: state.constraints.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
          };
      }
      return state;
    }

    case 'toggleSectionClip':
      // Make this section the sole clip, or turn clipping off if it already is
      // (spec §13.9). Never a coverage input.
      return { ...state, clipSectionId: state.clipSectionId === action.id ? null : action.id };

    case 'toggleCollapse': {
      const collapsedIds = new Set(state.collapsedIds);
      if (collapsedIds.has(action.id)) collapsedIds.delete(action.id);
      else collapsedIds.add(action.id);
      return { ...state, collapsedIds };
    }

    case 'toggleUseZones':
      return { ...state, useZones: action.value, ...samplingInput(state) };

    case 'transformApplied': {
      // A resolved gizmo drag (spec §12.4, §13.8). A camera move is a coverage
      // input; a probe/section move is not; a volume move dirties the sampled set.
      const { change } = action;
      switch (change.kind) {
        case 'camera':
          return {
            ...state,
            cameras: state.cameras.map((c) =>
              c.id === change.id
                ? clampToConstraint({ ...c, position: change.position, rotation: change.rotation }, state.constraints)
                : c,
            ),
            ...cameraInput(state),
          };
        case 'probe':
          return { ...state, probes: state.probes.map((p) => (p.id === change.id ? { ...p, position: change.position } : p)) };
        case 'volume':
          return {
            ...state,
            volumes: state.volumes.map((v) => (v.id === change.id ? { ...v, position: change.position, rotation: change.rotation, size: change.size } : v)),
            ...samplingInput(state),
          };
        case 'section':
          return {
            ...state,
            sections: state.sections.map((s) =>
              s.id === change.id
                ? { ...s, min: change.min, max: change.max, minA: change.minA, maxA: change.maxA, minB: change.minB, maxB: change.maxB }
                : s,
            ),
          };
        case 'constraint': {
          const constraints = state.constraints.map((c) => {
            if (c.id !== change.id) return c;
            const moved = { ...c, position: change.position };
            if (c.kind === 'plane') {
              return {
                ...moved,
                rotation: change.rotation ?? c.rotation,
                size: change.size ?? c.size,
              } as CameraConstraint;
            }
            return moved as CameraConstraint;
          });
          return { ...state, constraints, ...reclamp(state, constraints, change.id) };
        }
        case 'constraintVertex': {
          const constraints = mapPolyline(state.constraints, change.id, (points) =>
            points.map((p, i) => (i === change.vertex ? ([...change.position] as Vec3) : p)),
          );
          if (constraints === state.constraints) return state;
          return { ...state, constraints, ...reclamp(state, constraints, change.id) };
        }
      }
      return state;
    }

    case 'selectionChanged':
      return { ...state, selection: action.selection };

    case 'generated':
      // Generate replaces the whole zone+volume set from the BVH (§3.4),
      // discarding hand-edits, and auto-selects the first new zone.
      //
      // It also **clears every constraint group's target zones**
      // (`camera_placement.md` §3.1.2, §7): the replacement re-numbers from
      // `zone-1`, so `zone-3` still exists afterwards and names a *different*
      // box. Pruning by liveness would never fire, and the group would silently
      // retarget to unrelated geometry — so the references are treated as
      // destroyed, which is what they are.
      return {
        ...state,
        zones: action.zones,
        volumes: action.volumes,
        constraintGroups: pruneTargetZones(state.constraintGroups, () => false),
        selection: action.zones[0] ? { kind: 'zone', id: action.zones[0].id } : null,
        ...samplingInput(state),
      };

    case 'markStale':
      // A resolution change (debounced `voxelSize`) is a coverage input (spec §8.1).
      return state.hasRunOnce ? { ...state, stale: true } : state;

    case 'samplingApplied':
      // The run re-applied the sampled region set (§8); clear the dirty flag.
      return { ...state, samplingDirty: false };

    case 'runCompleted':
      // A completed run makes the result current (spec §8.1).
      return { ...state, stale: false, hasRunOnce: true };

    case 'sceneReplaced':
      // Import replaces the whole document (spec §14.4); reset run flags and force
      // a sampling re-apply, keep collapse state (stale ids are harmless), select
      // the first camera. Geometry/store disposal is App's job around this dispatch.
      return {
        ...state,
        ...action.doc,
        selection: action.doc.cameras[0] ? { kind: 'camera', id: action.doc.cameras[0].id } : null,
        stale: false,
        hasRunOnce: false,
        samplingDirty: true,
      };
  }
}
