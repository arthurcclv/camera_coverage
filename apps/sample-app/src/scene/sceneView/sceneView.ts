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
 * the click-vs-drag rule (`../viewportSelection.ts`), and the aim-drag mapping
 * (`../../cameras/aim.ts`).
 *
 * In the **Selected** view (spec §2.4.1) the pointer handling inverts: clicks are
 * inert (no pick, no deselect) and a drag aims the selected camera instead,
 * emitting the same `TransformChange` a gizmo drag would.
 */
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

import { createViewport, type RenderBackend, type Viewport } from '../viewport.ts';
import { aimDelta } from '../../cameras/aim.ts';
import { eulerToQuat, quatToEuler, type EulerAngles } from '../../cameras/math.ts';
import type { CameraViewFit } from '../viewCameras.ts';
import { CameraGizmoSet } from '../cameraGizmos.ts';
import { ProbeGizmoSet } from '../probeGizmos.ts';
import { SectionGizmoSet } from '../sectionGizmos.ts';
import { SamplingVolumeGizmoSet } from '../samplingVolumeGizmos.ts';
import { CoverageOverlay, type OverlayOptions } from '../coverageOverlay.ts';
import { threeSpace, type TransformSpace } from '../transformSpace.ts';
import { axisMapping, type ClipBand, type Section, type SectionCellGrid } from '../sectionHeatmap.ts';
import { clipBandPlanes, setGeometryClippingPlanes, type GeometryBuild } from '../sceneGeometryBuild.ts';
import { isClick, selectionAfterClick, type PointerPos, type Selection } from '../viewportSelection.ts';
import type { SamplingVolume } from '../samplingVolumes.ts';
import type { SceneCamera } from '../../cameras/camera.ts';
import type { Probe } from '../probeVisibility.ts';
import type { AggregateResult } from '@linkervision/camera-coverage-sdk';
import type { ViewId } from '../viewCameras.ts';

import { nearestHit, type PickCandidate } from './pick.ts';
import { surfaceHit } from './surfaceHit.ts';
import { floorVolumeSize, sectionBoundsFromCenters } from './transformReadback.ts';
import type { GizmoAttachable, GizmoPicker } from '../gizmoSet.ts';
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
  /**
   * Whether the "Place on surface" tool is armed (spec §2.4.2). While armed a
   * click places instead of selecting, and the TransformControls gizmo detaches.
   */
  placing: boolean;
}

type SelectionKind = NonNullable<Selection>['kind'];

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

  /** The viewport-pickable sets, arbitrated together on a click (spec §5.2, §12.4). */
  private readonly pickableSets: ReadonlyArray<{ kind: 'camera' | 'probe' | 'volume'; set: GizmoPicker }>;
  /**
   * Every set that carries a TransformControls attach target, keyed by selection
   * kind. A zone is a container with no viewport body, so it has no entry here and
   * selecting one detaches (spec §12.4, §13.8; `sampling_volumes.md` §5).
   */
  private readonly attachableSets: Partial<Record<SelectionKind, GizmoAttachable>>;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly down: PointerPos = { x: 0, y: 0 };

  private prev: SceneViewState | null = null;
  private selectHandler: ((selection: Selection) => void) | null = null;
  private transformHandler: ((change: TransformChange) => void) | null = null;
  private placeHandler: ((point: Vec3) => void) | null = null;

  /**
   * In-flight aim drag in the Selected view (spec §2.4.1, §5.2). The orientation
   * is accumulated **locally** rather than re-read from state each move: React
   * state lands a render behind the pointer, so reading it back would drop the
   * deltas of any moves that arrive within one batch. The absolute rotation is
   * still emitted on every move, so the panel and gizmos stay live (§5.2).
   */
  private aim: { pointerId: number; x: number; y: number; id: string; euler: EulerAngles } | null = null;

  private readonly onPointerDown: (ev: PointerEvent) => void;
  private readonly onPointerMove: (ev: PointerEvent) => void;
  private readonly onPointerUp: (ev: PointerEvent) => void;
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

    // A viewport click raycasts each pickable set and the nearest hit wins
    // (`pick.ts`); attach maps a selection kind straight to the set that owns its
    // TransformControls target. Sections attach but are not viewport-pickable
    // (spec §13.8), so they appear only in the attach registry.
    this.pickableSets = [
      { kind: 'camera', set: this.gizmos },
      { kind: 'probe', set: this.probeGizmos },
      { kind: 'volume', set: this.volumeGizmos },
    ];
    this.attachableSets = {
      camera: this.gizmos,
      probe: this.probeGizmos,
      section: this.sectionGizmos,
      volume: this.volumeGizmos,
    };

    // A genuine click selects the picked gizmo (or deselects on a miss); the click
    // that fires at the end of an orbit/TransformControls drag leaves the selection
    // unchanged (spec §5.2, see ../viewportSelection.ts).
    this.onPointerDown = (ev) => {
      this.down.x = ev.clientX;
      this.down.y = ev.clientY;
      this.beginAim(ev);
    };
    this.onPointerMove = (ev) => this.moveAim(ev);
    this.onPointerUp = (ev) => this.endAim(ev);
    this.onClick = (ev) => {
      // An armed "Place on surface" click is consumed for placement (spec §2.4.2).
      // This precedes the Selected-view return below because placement is live in
      // that view too, and precedes the pick because an armed click never selects
      // or deselects.
      if (this.prev?.placing) {
        this.placeFromClick(ev);
        return;
      }
      // Viewport clicks change nothing in the Selected view: no picking, and no
      // deselect-on-miss — which would eject the view to Perspective (spec §2.4.1).
      if (this.prev?.activeView === 'camera') return;
      this.setRayFromEvent(ev);
      // Nearest hit across cameras, probes, and volumes (spec §5.2, §12.4;
      // `sampling_volumes.md` §5). Hidden camera gizmos are not clickable (spec
      // §2.4). Zones/sections have no viewport body.
      const candidates: PickCandidate[] = [];
      for (const { kind, set } of this.pickableSets) {
        if (kind === 'camera' && !this.prev?.gizmosVisible) continue;
        const hit = set.pickHit(this.raycaster);
        if (hit) candidates.push({ selection: { kind, id: hit.id }, distance: hit.distance });
      }
      const hit = nearestHit(candidates);
      const next = selectionAfterClick(this.prev?.selection ?? null, hit, this.down, { x: ev.clientX, y: ev.clientY });
      this.selectHandler?.(next);
    };
    this.onObjectChange = () => this.emitTransform();

    viewport.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    viewport.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    viewport.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    viewport.renderer.domElement.addEventListener('pointercancel', this.onPointerUp);
    viewport.renderer.domElement.addEventListener('click', this.onClick);
    viewport.transformControls.addEventListener('objectChange', this.onObjectChange);
  }

  /**
   * Build the viewport (async `WebGPURenderer.init`) and wire up the scene objects.
   * `onCameraGuide` forwards the Selected view's frame-guide rect straight from
   * the viewport to App, which renders the outline (spec §2.4.1).
   */
  static async create(
    container: HTMLElement,
    onCameraGuide?: (guide: CameraViewFit['guide'] | null) => void,
  ): Promise<SceneView> {
    const viewport = await createViewport(container, { onCameraGuide });
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

  /**
   * Register the callback for a resolved "Place on surface" hit (spec §2.4.2).
   * Only the world point is emitted — which entity it applies to is App's to
   * decide from its own selection, so SceneView stays out of the entity kinds.
   */
  onPlace(handler: (point: Vec3) => void): void {
    this.placeHandler = handler;
  }

  /** Empty the coverage overlay outright, with no run following (spec §14.4). */
  clearCoverage(): void {
    this.overlay.clear();
  }

  /**
   * Begin streaming a coverage run at the run grid's `voxelSize` (spec §9). A full
   * run drops the retained chunks first; an incremental one (spec §8) keeps them,
   * so arriving chunks replace their predecessors and every other chunk stands.
   */
  beginCoverageRun(voxelSize: number, opts: { incremental: boolean }): void {
    this.overlay.beginRun(voxelSize, opts);
  }

  /**
   * Feed one chunk's `leafCounts` aggregation into the coverage overlay (spec
   * §3.3, §9). The chunk's placement comes from the caller's `WorkspaceGrid`,
   * since an `AggregateResult` carries a `chunkId` and accumulators, not a place.
   * The resolution does not: it is the whole run's, bound by
   * {@link beginCoverageRun}.
   */
  addCoverageCounts(result: AggregateResult, origin: Vec3, dims: [number, number, number]): void {
    this.overlay.addResult(result, origin, dims);
  }

  /** Rebuild the overlay once, after a run's last chunk (spec §9). */
  flushCoverage(): void {
    this.overlay.flush();
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

    // --- camera gizmos (spec §5.3): [cameras, selectedCameraId, flagged, activeView].
    // `activeView` joins the diff because the camera being rendered through draws
    // neither body nor frustum (spec §2.4.1). -----------------------------------
    if (!prev || prev.cameras !== next.cameras || camId(prev.selection) !== camId(next.selection) || prev.flaggedCameras !== next.flaggedCameras || prev.activeView !== next.activeView) {
      const suppressed = next.activeView === 'camera' ? camId(next.selection) : null;
      this.gizmos.update(next.cameras, camId(next.selection), next.flaggedCameras, suppressed);
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

    // --- overlay options (spec §9) ---------------------------------------------
    if (!prev || prev.overlayOptions !== next.overlayOptions) {
      this.overlay.setOptions(next.overlayOptions);
    }

    // --- TransformControls attach per selection kind (spec §12.4, §13.8), with
    // `activeView` in the diff because the Selected view detaches (§2.4.1) and
    // `placing` because an armed placement tool detaches too (§2.4.2) -----------
    if (!prev || prev.selection !== next.selection || prev.activeView !== next.activeView || prev.placing !== next.placing) {
      this.attachForSelection(next.selection, next.activeView, next.placing);
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

    // --- Selected view source (spec §2.4.1): the selected camera's pose + lens.
    // Pushed regardless of the active view so entering the view is immediate; the
    // viewport publishes the frame guide only while it *is* active. Must precede
    // the `activeView` block below, which re-fits from whatever source is stored.
    if (!prev || prev.cameras !== next.cameras || camId(prev.selection) !== camId(next.selection)) {
      const id = camId(next.selection);
      const cam = id ? next.cameras.find((c) => c.id === id) : undefined;
      this.viewport.setCameraViewSource(
        cam
          ? { position: cam.position, rotation: cam.rotation, fov: cam.fov, aspect: cam.aspect ?? 16 / 9 }
          : null,
      );
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
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('click', this.onClick);
    this.viewport.transformControls.removeEventListener('objectChange', this.onObjectChange);
    this.overlay.dispose();
    this.gizmos.dispose();
    this.probeGizmos.dispose();
    this.sectionGizmos.dispose();
    this.volumeGizmos.dispose();
    this.viewport.dispose();
  }

  /** Point the shared raycaster at an event's position in the viewport. */
  private setRayFromEvent(ev: MouseEvent): void {
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.viewport.activeCamera);
  }

  /**
   * Resolve an armed click to a point on the scene geometry and emit it (spec
   * §2.4.2). Only `room.group` is tested, so gizmos and the coverage overlay are
   * transparent to the ray; the clip band filters hidden hits (`surfaceHit.ts`).
   *
   * The click-vs-drag threshold applies here as it does to a pick — including in
   * the Selected view, whose aim drag (§2.4.1) must place nothing. A miss emits
   * nothing at all, which is what leaves the tool armed for another try: App only
   * disarms on a delivered point.
   */
  private placeFromClick(ev: MouseEvent): void {
    if (!isClick(this.down, { x: ev.clientX, y: ev.clientY })) return;
    const room = this.prev?.room;
    if (!room) return;
    this.setRayFromEvent(ev);
    const point = surfaceHit(this.raycaster.intersectObject(room.group, true), this.prev?.clipBand ?? null);
    if (point) this.placeHandler?.(point);
  }

  /** The camera the Selected view is rendering through, or null (spec §2.4.1). */
  private cameraViewTarget(state: SceneViewState | null): SceneCamera | null {
    if (state?.activeView !== 'camera') return null;
    const id = camId(state.selection);
    return (id && state.cameras.find((c) => c.id === id)) || null;
  }

  /**
   * Start an aim drag (spec §2.4.1, §5.2). Only in the Selected view, only the
   * primary button — the orbit controls are disabled there, so nothing else
   * competes for the gesture, and there is no click-vs-drag threshold to clear
   * because clicks are inert in that view.
   */
  private beginAim(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const target = this.cameraViewTarget(this.prev);
    if (!target) return;
    this.aim = {
      pointerId: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      id: target.id,
      euler: quatToEuler(target.rotation),
    };
    // Capture so a drag that leaves the canvas keeps aiming until release.
    this.viewport.renderer.domElement.setPointerCapture?.(ev.pointerId);
  }

  /**
   * Apply one increment of an aim drag: mouselook, rated over the *guide* rect
   * (the camera's true image), so a drag spanning it sweeps one field of view and
   * the aim follows the pointer (spec §5.2). Emits the absolute rotation through
   * the same transform path as a gizmo drag, so the panel ticks live and the
   * result marks stale.
   */
  private moveAim(ev: PointerEvent): void {
    const aim = this.aim;
    if (!aim || ev.pointerId !== aim.pointerId) return;
    const target = this.cameraViewTarget(this.prev);
    // Selection or view changed mid-drag (e.g. from the hierarchy): abandon it
    // rather than writing to a camera the user is no longer looking through.
    if (!target || target.id !== aim.id) {
      this.endAim(ev);
      return;
    }
    const image = this.viewport.cameraGuideSizePx();
    if (!image) return;

    const dx = ev.clientX - aim.x;
    const dy = ev.clientY - aim.y;
    if (dx === 0 && dy === 0) return;
    aim.x = ev.clientX;
    aim.y = ev.clientY;
    aim.euler = aimDelta(aim.euler, dx, dy, target.fov, target.aspect ?? 16 / 9, image);
    this.transformHandler?.({
      kind: 'camera',
      id: aim.id,
      position: target.position,
      rotation: eulerToQuat(aim.euler),
    });
  }

  private endAim(ev: PointerEvent): void {
    if (!this.aim || ev.pointerId !== this.aim.pointerId) return;
    const dom = this.viewport.renderer.domElement;
    if (dom.hasPointerCapture?.(ev.pointerId)) dom.releasePointerCapture(ev.pointerId);
    this.aim = null;
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
  private attachForSelection(selection: Selection, activeView: ViewId, placing: boolean): void {
    // The Selected view shows no gizmo: it would be attached to the very camera
    // being rendered through, so its handles would surround the viewer (§2.4.1).
    // An armed placement tool detaches too, so the whole viewport is clickable
    // surface with no dead zone around the selected entity (§2.4.2).
    if (activeView === 'camera' || placing) {
      this.viewport.transformControls.detach();
      return;
    }
    const target = selection ? this.attachableSets[selection.kind]?.getAttachTarget(selection.id) : undefined;
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
