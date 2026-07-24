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
 * (§12.5, §13.4). `stale` only latches once a run has happened (`hasRunOnce`);
 * `samplingDirty` latches regardless.
 */
import type { CameraConfig, Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { SceneCamera } from '../cameras/camera.ts';
import type { Probe } from './probeVisibility.ts';
import { defaultSection, type Section } from './sectionHeatmap.ts';
import { defaultZoneName, type SamplingVolume, type Zone } from './samplingVolumes.ts';
import type { Scene } from './sceneModel.ts';
import type { Selection } from './viewportSelection.ts';
import {
  duplicateCamera,
  duplicateProbe,
  duplicateSection,
  duplicateVolume,
  duplicateZone,
  nextFreeId,
} from './entityDuplication.ts';
import type { TransformChange } from './sceneView/types.ts';

// Defaults for a camera spawned from the "+" menu (spec §5.5), matching the
// default rig's optics (`cameras/defaults.ts`).
const NEW_CAMERA = { fov: 60, aspect: 16 / 9, near: 0.1, far: 30 } as const;
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Entities addressable by a delete/duplicate action. */
export type EntityKind = 'camera' | 'probe' | 'section' | 'zone' | 'volume';

/** The persisted scene-document fields (the {@link Scene} minus its geometry). */
export type SceneDoc = Pick<
  Scene,
  'cameras' | 'probes' | 'sections' | 'clipSectionId' | 'zones' | 'volumes' | 'useZones'
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
  | { type: 'addVolume'; position: Vec3 }
  | { type: 'deleteEntity'; kind: EntityKind; id: string }
  | { type: 'duplicateEntity'; kind: EntityKind; id: string }
  | { type: 'changeCamera'; id: string; patch: Partial<CameraConfig> }
  | { type: 'changeProbe'; id: string; position: Vec3 }
  | { type: 'changeSection'; id: string; patch: Partial<Section> }
  | { type: 'changeVolume'; id: string; patch: Partial<SamplingVolume> }
  | { type: 'renameEntity'; kind: 'camera' | 'probe' | 'section' | 'zone'; id: string; name: string }
  | { type: 'toggleEnabled'; kind: 'camera' | 'section' | 'zone'; id: string }
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
        case 'zone': {
          // Removing a zone removes its volumes too (§4); it is a coverage input
          // only when it actually had volumes (an empty zone marks nothing).
          const hadVolumes = state.volumes.some((v) => v.zoneId === id);
          return {
            ...state,
            volumes: state.volumes.filter((v) => v.zoneId !== id),
            zones: state.zones.filter((z) => z.id !== id),
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

    case 'changeCamera':
      return {
        ...state,
        cameras: state.cameras.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c)),
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
      }
      return state;
    }

    case 'toggleEnabled': {
      const { kind, id } = action;
      if (kind === 'camera') {
        // Compute participation (spec §5.4) — a coverage input.
        return {
          ...state,
          cameras: state.cameras.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
          ...cameraInput(state),
        };
      }
      if (kind === 'section') {
        // Heatmap on/off — a client-side re-filter, never stale (spec §13).
        return { ...state, sections: state.sections.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)) };
      }
      // Zone enable — a client-side re-filter of the marked set, never stale (§7.3).
      return { ...state, zones: state.zones.map((z) => (z.id === id ? { ...z, enabled: !z.enabled } : z)) };
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
            cameras: state.cameras.map((c) => (c.id === change.id ? { ...c, position: change.position, rotation: change.rotation } : c)),
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
      }
      return state;
    }

    case 'selectionChanged':
      return { ...state, selection: action.selection };

    case 'generated':
      // Generate replaces the whole zone+volume set from the BVH (§3.4),
      // discarding hand-edits, and auto-selects the first new zone.
      return {
        ...state,
        zones: action.zones,
        volumes: action.volumes,
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
