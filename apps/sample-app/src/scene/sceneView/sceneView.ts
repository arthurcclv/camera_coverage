/**
 * SceneView — the imperative Three.js bridge (spec §2.2–2.4, §5, §12.4, §13).
 *
 * React (App.tsx) owns the canonical state; this module owns everything Three.js:
 * the viewport, all gizmo sets, the coverage overlay, the pick raycaster, and the
 * pointer/transform listeners. It presents one small interface —
 * `create` · `sync` · `onSelect` · `onTransform` · reset/addCoverageChunk ·
 * `dispose` — behind which the ~21 state-mirror refs, the 175-line mount effect,
 * and the ten single-value push effects that used to live in App.tsx all
 * collapse.
 *
 * `sync(state)` takes one immutable snapshot and fans it out to the scene objects.
 * It **diffs each field against the previous snapshot by reference**, so an
 * expensive op (overlay rebuild, sightline rebuild, ortho auto-fit) runs on
 * exactly the same change it did when it was its own `useEffect` — App passes
 * every field as stable React state or `useMemo` output, so reference identity
 * mirrors the old dependency arrays. The first `sync` (no previous snapshot)
 * applies everything, which is the async-mount catch-up.
 *
 * The decision logic this bridge owns is pure and tested elsewhere: nearest-hit
 * arbitration (`pick.ts`), the transform readback math (`transformReadback.ts`),
 * and the click-vs-drag rule (`../viewportSelection.ts`).
 */
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

import { createViewport, type RenderBackend, type Viewport } from '../viewport.ts';
import { CameraGizmoSet } from '../cameraGizmos.ts';
import { ProbeGizmoSet } from '../probeGizmos.ts';
import { SectionGizmoSet } from '../sectionGizmos.ts';
import { SamplingVolumeGizmoSet } from '../samplingVolumeGizmos.ts';
import { CoverageOverlay, type OverlayOptions } from '../coverageOverlay.ts';
import { threeSpace, type TransformSpace } from '../transformSpace.ts';
import { axisMapping, type ClipBand, type Section, type SectionCellGrid } from '../sectionHeatmap.ts';
import { clipBandPlanes, setGeometryClippingPlanes, type GeometryBuild } from '../sceneGeometryBuild.ts';
import { selectionAfterClick, type PointerPos, type Selection } from '../viewportSelection.ts';
import type { MarkedFilter, SamplingVolume } from '../samplingVolumes.ts';
import type { SceneCamera } from '../../cameras/camera.ts';
import type { Probe } from '../probeVisibility.ts';
import type { ChunkResult } from '@linkervision/camera-coverage-sdk';
import type { ViewId } from '../viewCameras.ts';

import { nearestHit, type PickCandidate } from './pick.ts';
import { floorVolumeSize, sectionBoundsFromCenters } from './transformReadback.ts';
import type { TransformChange } from './types.ts';

export type { TransformChange } from './types.ts';

/**
 * One immutable snapshot of everything the scene reflects (spec §2.4, §5, §9,
 * §12.4, §13). App builds this from its state and passes it to `sync`; every
 * field must be referentially stable between genuine changes (React state or
 * `useMemo`) so SceneView's per-field diff mirrors the old effect dependencies.
 */
export interface SceneViewState {
  /** The built geometry (collision mesh + renderable group + bounds). Its group is added/swapped here. */
  room: GeometryBuild;
  cameras: SceneCamera[];
  probes: Probe[];
  sections: Section[];
  volumes: SamplingVolume[];
  selection: Selection;
  flaggedCameras: ReadonlySet<string>;
  /** Per-section computed cell grids (spec §13.4); `useMemo` in App. */
  sectionCellGrids: ReadonlyMap<string, SectionCellGrid | null>;
  /** Ids of enabled zones — dims volumes of disabled zones (spec §5); `useMemo`. */
  enabledZoneIds: ReadonlySet<string>;
  /** Union-of-enabled-zones marked filter, or null for full volume (§7.3); `useMemo`. */
  markedFilter: MarkedFilter | null;
  overlayOptions: OverlayOptions;
  transformMode: 'translate' | 'rotate' | 'scale';
  transformSpace: TransformSpace;
  activeView: ViewId;
  gizmosVisible: boolean;
  zonesVisible: boolean;
  sectionsVisible: boolean;
  stale: boolean;
  /** Voxel size — the floor for a dragged volume's size (`sampling_volumes.md` §5). */
  voxelSize: number;
  /** Clip band along the clipping section's normal, or null (spec §13.9); `useMemo`. */
  clipBand: ClipBand | null;
  /** Sightlines from the selected probe to the cameras that see it, or null (§12.4); `useMemo`. */
  sightlines: { from: Vec3; targets: Vec3[] } | null;
}

const camId = (s: Selection): string | null => (s?.kind === 'camera' ? s.id : null);
const probeId = (s: Selection): string | null => (s?.kind === 'probe' ? s.id : null);
const volumeId = (s: Selection): string | null => (s?.kind === 'volume' ? s.id : null);

export class SceneView {
  private readonly viewport: Viewport;
  private readonly gizmos: CameraGizmoSet;
  private readonly probeGizmos: ProbeGizmoSet;
  private readonly sectionGizmos: SectionGizmoSet;
  private readonly volumeGizmos: SamplingVolumeGizmoSet;
  private readonly overlay: CoverageOverlay;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly down: PointerPos = { x: 0, y: 0 };

  private prev: SceneViewState | null = null;
  private selectHandler: ((selection: Selection) => void) | null = null;
  private transformHandler: ((change: TransformChange) => void) | null = null;

  private readonly onPointerDown: (ev: PointerEvent) => void;
  private readonly onClick: (ev: MouseEvent) => void;
  private readonly onObjectChange: () => void;

  private constructor(viewport: Viewport) {
    this.viewport = viewport;
    this.gizmos = new CameraGizmoSet();
    this.probeGizmos = new ProbeGizmoSet();
    this.sectionGizmos = new SectionGizmoSet();
    this.volumeGizmos = new SamplingVolumeGizmoSet();
    this.overlay = new CoverageOverlay();

    // The geometry group itself is added by the first `sync` (room swap path), so
    // the initial add and every later import/reset swap go through one code path.
    viewport.scene.add(this.gizmos.group);
    viewport.scene.add(this.probeGizmos.group);
    viewport.scene.add(this.sectionGizmos.group);
    viewport.scene.add(this.volumeGizmos.group);
    viewport.scene.add(this.overlay.object);

    // A genuine click selects the picked gizmo (or deselects on a miss); the click
    // that fires at the end of an orbit/TransformControls drag leaves the selection
    // unchanged (spec §5.2, see ../viewportSelection.ts).
    this.onPointerDown = (ev) => {
      this.down.x = ev.clientX;
      this.down.y = ev.clientY;
    };
    this.onClick = (ev) => {
      const rect = viewport.renderer.domElement.getBoundingClientRect();
      this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, viewport.activeCamera);
      // Nearest hit across cameras, probes, and volumes (spec §5.2, §12.4;
      // `sampling_volumes.md` §5). Hidden camera gizmos are not clickable (spec
      // §2.4). Zones/sections have no viewport body.
      const candidates: PickCandidate[] = [];
      const camHit = this.prev?.gizmosVisible ? this.gizmos.pickHit(this.raycaster) : null;
      if (camHit) candidates.push({ selection: { kind: 'camera', id: camHit.id }, distance: camHit.distance });
      const probeHit = this.probeGizmos.pickHit(this.raycaster);
      if (probeHit) candidates.push({ selection: { kind: 'probe', id: probeHit.id }, distance: probeHit.distance });
      const volumeHit = this.volumeGizmos.pickHit(this.raycaster);
      if (volumeHit) candidates.push({ selection: { kind: 'volume', id: volumeHit.id }, distance: volumeHit.distance });
      const hit = nearestHit(candidates);
      const next = selectionAfterClick(this.prev?.selection ?? null, hit, this.down, { x: ev.clientX, y: ev.clientY });
      this.selectHandler?.(next);
    };
    this.onObjectChange = () => this.emitTransform();

    viewport.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    viewport.renderer.domElement.addEventListener('click', this.onClick);
    viewport.transformControls.addEventListener('objectChange', this.onObjectChange);
  }

  /** Build the viewport (async `WebGPURenderer.init`) and wire up the scene objects. */
  static async create(container: HTMLElement): Promise<SceneView> {
    const viewport = await createViewport(container);
    return new SceneView(viewport);
  }

  /** Which backend `WebGPURenderer` selected (spec §2.3). */
  get renderBackend(): RenderBackend {
    return this.viewport.renderBackend;
  }

  /** Register the callback for a resolved viewport selection change (spec §5.2). */
  onSelect(handler: (selection: Selection) => void): void {
    this.selectHandler = handler;
  }

  /** Register the callback for a resolved TransformControls drag (spec §12.4, §13.8). */
  onTransform(handler: (change: TransformChange) => void): void {
    this.transformHandler = handler;
  }

  /** Clear the coverage overlay's retained chunks before a new run (spec §9, §14.4). */
  resetCoverage(): void {
    this.overlay.reset();
  }

  /** Feed a streamed `ChunkResult` into the coverage overlay (spec §9). */
  addCoverageChunk(chunk: ChunkResult): void {
    this.overlay.addChunk(chunk);
  }

  /**
   * Push a snapshot into the scene. Each guarded block mirrors one of the old
   * App effects and fires only when its inputs changed by reference (the first
   * call, `prev === null`, applies everything).
   */
  sync(next: SceneViewState): void {
    const prev = this.prev;

    // --- geometry group swap (import/reset, spec §14.4): remove the outgoing
    // group and add the new one. App owns disposing the outgoing build. ---------
    if (!prev || prev.room !== next.room) {
      if (prev) this.viewport.scene.remove(prev.room.group);
      this.viewport.scene.add(next.room.group);
    }

    // --- clip cross-section (spec §13.9): re-apply when the band or the room
    // (which rebuilds the ClippingGroup) changed. -------------------------------
    if (!prev || prev.clipBand !== next.clipBand || prev.room !== next.room) {
      setGeometryClippingPlanes(next.room, next.clipBand ? clipBandPlanes(next.clipBand) : []);
    }

    // --- camera gizmos (spec §5.3): [cameras, selectedCameraId, flagged] --------
    if (!prev || prev.cameras !== next.cameras || camId(prev.selection) !== camId(next.selection) || prev.flaggedCameras !== next.flaggedCameras) {
      this.gizmos.update(next.cameras, camId(next.selection), next.flaggedCameras);
    }

    // --- probe gizmos (spec §12.4): [probes, selectedProbeId] -------------------
    if (!prev || prev.probes !== next.probes || probeId(prev.selection) !== probeId(next.selection)) {
      this.probeGizmos.update(next.probes, probeId(next.selection));
    }

    // --- section gizmos (spec §13.4): [sections, cellGrids, sectionsVisible, stale] ---
    if (!prev || prev.sections !== next.sections || prev.sectionCellGrids !== next.sectionCellGrids || prev.sectionsVisible !== next.sectionsVisible || prev.stale !== next.stale) {
      this.sectionGizmos.update(next.sections, next.sectionCellGrids, next.sectionsVisible, next.stale);
    }

    // --- volume gizmos (spec §5, §7.3): [volumes, selectedVolumeId, enabledZoneIds] ---
    if (!prev || prev.volumes !== next.volumes || volumeId(prev.selection) !== volumeId(next.selection) || prev.enabledZoneIds !== next.enabledZoneIds) {
      this.volumeGizmos.update(next.volumes, volumeId(next.selection), next.enabledZoneIds);
    }

    // --- overlay marked filter (spec §7.3): a pure client-side re-filter --------
    if (!prev || prev.markedFilter !== next.markedFilter) {
      this.overlay.setMarkedFilter(next.markedFilter);
    }

    // --- overlay options (spec §9) ---------------------------------------------
    if (!prev || prev.overlayOptions !== next.overlayOptions) {
      this.overlay.setOptions(next.overlayOptions);
    }

    // --- TransformControls attach per selection kind (spec §12.4, §13.8) --------
    if (!prev || prev.selection !== next.selection) {
      this.attachForSelection(next.selection);
    }

    // --- TransformControls mode (spec §12.4, §13.8): [transformMode, selection] -
    if (!prev || prev.transformMode !== next.transformMode || prev.selection !== next.selection) {
      this.viewport.transformControls.setMode(resolveMode(next.transformMode, next.selection));
    }

    // --- TransformControls space (spec §2.4) -----------------------------------
    if (!prev || prev.transformSpace !== next.transformSpace) {
      this.viewport.transformControls.setSpace(threeSpace(next.transformSpace));
    }

    // --- gizmo layer visibility (spec §2.4) ------------------------------------
    if (!prev || prev.gizmosVisible !== next.gizmosVisible) {
      this.gizmos.group.visible = next.gizmosVisible;
    }

    // --- zone (sampling-volume) layer visibility (spec §2.4) -------------------
    if (!prev || prev.zonesVisible !== next.zonesVisible) {
      this.volumeGizmos.group.visible = next.zonesVisible;
    }

    // --- active view (spec §2.4) -----------------------------------------------
    if (!prev || prev.activeView !== next.activeView) {
      this.viewport.setActiveView(next.activeView);
    }

    // --- selected-probe sightlines (spec §12.4) --------------------------------
    if (!prev || prev.sightlines !== next.sightlines) {
      if (next.sightlines) this.probeGizmos.setSightlines(next.sightlines.from, next.sightlines.targets);
      else this.probeGizmos.setSightlines(null);
    }

    this.prev = next;
  }

  dispose(): void {
    const dom = this.viewport.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('click', this.onClick);
    this.viewport.transformControls.removeEventListener('objectChange', this.onObjectChange);
    this.overlay.dispose();
    this.gizmos.dispose();
    this.probeGizmos.dispose();
    this.sectionGizmos.dispose();
    this.volumeGizmos.dispose();
    this.viewport.dispose();
  }

  /**
   * Read the dragged target back into an App-domain patch and emit it (spec
   * §12.4, §13.8). The non-trivial math is pure (`transformReadback.ts`); this
   * only reads the gizmo and assembles the change.
   */
  private emitTransform(): void {
    const sel = this.prev?.selection;
    if (!sel) return;
    if (sel.kind === 'camera') {
      const readback = this.gizmos.readTransform(sel.id);
      if (!readback) return;
      this.gizmos.syncHelper(sel.id);
      this.transformHandler?.({ kind: 'camera', id: sel.id, position: readback.position, rotation: readback.rotation });
    } else if (sel.kind === 'probe') {
      const position = this.probeGizmos.readPosition(sel.id);
      if (!position) return;
      this.transformHandler?.({ kind: 'probe', id: sel.id, position });
    } else if (sel.kind === 'volume') {
      const t = this.volumeGizmos.readTransform(sel.id);
      if (!t) return;
      const size = floorVolumeSize(t.size, this.prev?.voxelSize ?? t.size[0]);
      this.transformHandler?.({ kind: 'volume', id: sel.id, position: t.position, rotation: t.rotation, size });
    } else if (sel.kind === 'section') {
      const current = this.prev?.sections.find((s) => s.id === sel.id);
      if (!current) return;
      const { collapseAxis, axisA, axisB } = axisMapping(current.orientation);
      const mid = this.sectionGizmos.readAxisPosition(sel.id, collapseAxis);
      const centerA = this.sectionGizmos.readAxisPosition(sel.id, axisA);
      const centerB = this.sectionGizmos.readAxisPosition(sel.id, axisB);
      if (mid === undefined || centerA === undefined || centerB === undefined) return;
      const bounds = sectionBoundsFromCenters(current, { mid, centerA, centerB });
      this.transformHandler?.({ kind: 'section', id: sel.id, ...bounds });
    }
  }

  /**
   * Attach TransformControls to the selected entity's target, or detach (spec
   * §12.4, §13.8; `sampling_volumes.md` §5). A zone is a container with no
   * viewport body, so selecting one detaches.
   */
  private attachForSelection(selection: Selection): void {
    const target =
      selection?.kind === 'camera'
        ? this.gizmos.getAttachTarget(selection.id)
        : selection?.kind === 'probe'
          ? this.probeGizmos.getAttachTarget(selection.id)
          : selection?.kind === 'section'
            ? this.sectionGizmos.getAttachTarget(selection.id)
            : selection?.kind === 'volume'
              ? this.volumeGizmos.getAttachTarget(selection.id)
              : undefined;
    if (target) this.viewport.transformControls.attach(target);
    else this.viewport.transformControls.detach();
  }
}

/**
 * The active TransformControls mode for a selection (spec §12.4, §13.8): a probe
 * is a point and a section slides along one axis — both translate only; scale is
 * a volume-only mode and falls back to translate on any other selection.
 */
function resolveMode(mode: 'translate' | 'rotate' | 'scale', selection: Selection): 'translate' | 'rotate' | 'scale' {
  if (selection?.kind === 'probe' || selection?.kind === 'section') return 'translate';
  if (mode === 'scale' && selection?.kind !== 'volume') return 'translate';
  return mode;
}
