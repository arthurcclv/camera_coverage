/**
 * Viewport view cameras (spec §2.4, §2.4.1): the pure geometry behind the
 * top-middle **View selector**. The viewport renders through one of five cameras —
 * `perspective` (the default 3/4 orbit view), three world-axis-aligned
 * orthographic elevations (`top` / `front` / `right`), and `camera`, the
 * **Selected** view that renders from the currently selected scene camera
 * (§2.4.1). This module is kept free of the renderer/DOM/controls so it can be
 * unit-tested (test/viewCameras.test.ts); `scene/viewport.ts` owns the camera
 * *objects*, the OrbitControls/TransformControls re-pointing, and the render loop.
 *
 * Axis convention (Y-up, glTF): Top looks straight down −Y with −Z as screen-up;
 * Front looks along −Z from +Z; Right looks along −X from +X. Both ortho views
 * keep +Y as up. See spec §2.4.
 */
import * as THREE from 'three';

export type ViewId = 'perspective' | 'top' | 'front' | 'right' | 'camera';

/**
 * The three axis-aligned elevations. Spelled out rather than derived as
 * `Exclude<ViewId, 'perspective'>` — that exclusion stopped meaning "ortho" once
 * the perspective `camera` view joined `ViewId`.
 */
export type OrthoViewId = 'top' | 'front' | 'right';

/** Selector order (Perspective first, Selected last — spec §2.4). */
export const VIEW_IDS: readonly ViewId[] = ['perspective', 'top', 'front', 'right', 'camera'];

/**
 * Human labels shown in the View dropdown. The `camera` view is labeled
 * **Selected** — not "Selected camera" and never the camera's own name — so the
 * word "Camera" stays reserved for the §5 coverage cameras and the Cameras layer
 * toggle (spec §2.4).
 */
export const VIEW_LABELS: Record<ViewId, string> = {
  perspective: 'Perspective',
  top: 'Top',
  front: 'Front',
  right: 'Right',
  camera: 'Selected',
};

/** The view selected on load; never persisted to the scene file (spec §2.4). */
export const DEFAULT_VIEW: ViewId = 'perspective';

/**
 * Near/far clip planes for the perspective view. Unlike the ortho elevations —
 * whose planes are derived per scene by `fitOrtho` — the perspective camera is
 * never auto-fit, so these are its permanent values. `FAR` is deliberately far
 * beyond the demo room so a zoomed-out or imported large scene never clips.
 */
export const PERSPECTIVE_NEAR = 0.1;
export const PERSPECTIVE_FAR = 10000;

/**
 * Ortho views are the three axis-aligned elevations. An explicit whitelist, not
 * `!== 'perspective'` — the `camera` view (§2.4.1) is perspective too.
 */
export function isOrthographic(view: ViewId): boolean {
  return view === 'top' || view === 'front' || view === 'right';
}

/**
 * Orbit/rotation is available only in the perspective view; the ortho elevations
 * are locked axis-aligned and offer pan + zoom only (spec §2.4), and the
 * `camera` view is locked outright — a drag there aims the camera instead
 * (§2.4.1, §5.2).
 */
export function orbitEnabled(view: ViewId): boolean {
  return view === 'perspective';
}

/**
 * Whether the view offers *any* orbit-control navigation. The ortho elevations
 * still pan + zoom; the `camera` view is the one view with the controls fully
 * disabled, because the viewport *is* the selected camera's image and an orbit
 * would show coverage that camera does not have (spec §2.4.1).
 */
export function navigationEnabled(view: ViewId): boolean {
  return view !== 'camera';
}

/**
 * Per-ortho-view screen mapping: the unit direction from the look-at target
 * toward the camera, the screen-up vector, and which world axes fall on the
 * screen's width/height (used to size the frustum to the scene).
 */
interface OrthoAxes {
  /** Unit vector target→camera (camera sits at `center + dir * distance`). */
  dir: [number, number, number];
  /** Screen-up vector. */
  up: [number, number, number];
  /** World axis (0=x,1=y,2=z) that maps to screen horizontal. */
  widthAxis: 0 | 1 | 2;
  /** World axis that maps to screen vertical. */
  heightAxis: 0 | 1 | 2;
}

const ORTHO_AXES: Record<OrthoViewId, OrthoAxes> = {
  top: { dir: [0, 1, 0], up: [0, 0, -1], widthAxis: 0, heightAxis: 2 },
  front: { dir: [0, 0, 1], up: [0, 1, 0], widthAxis: 0, heightAxis: 1 },
  right: { dir: [1, 0, 0], up: [0, 1, 0], widthAxis: 2, heightAxis: 1 },
};

/** Padding factor applied around the scene bounds when auto-fitting (spec §2.4). */
export const FIT_PADDING = 1.12;

/** A fallback box (~the 24-unit grid, 6-high room) used when scene bounds are empty. */
export function fallbackBounds(): { min: THREE.Vector3; max: THREE.Vector3 } {
  return { min: new THREE.Vector3(-12, 0, -12), max: new THREE.Vector3(12, 6, 12) };
}

/** A box is usable for fitting only if it is non-empty and fully finite. */
export function isUsableBounds(box: THREE.Box3): boolean {
  if (box.isEmpty()) return false;
  return (
    Number.isFinite(box.min.x) &&
    Number.isFinite(box.min.y) &&
    Number.isFinite(box.min.z) &&
    Number.isFinite(box.max.x) &&
    Number.isFinite(box.max.y) &&
    Number.isFinite(box.max.z)
  );
}

/**
 * Union the usable boxes from `candidates` into `target`, skipping degenerate
 * contributors — empty or non-finite — so a bad object (e.g. the coverage
 * overlay's InstancedMesh reporting a non-finite box while it holds no instances)
 * can't poison the auto-fit frustum (spec §2.4). Returns whether any contributed.
 */
export function unionFiniteBounds(target: THREE.Box3, candidates: Iterable<THREE.Box3>): boolean {
  target.makeEmpty();
  let any = false;
  for (const box of candidates) {
    if (!isUsableBounds(box)) continue;
    target.union(box);
    any = true;
  }
  return any;
}

export interface OrthoFit {
  /** World position for the camera. */
  position: THREE.Vector3;
  /** Look-at / orbit target (scene-bounds center). */
  target: THREE.Vector3;
  /** Screen-up vector for the camera. */
  up: THREE.Vector3;
  /** Symmetric frustum half-height in world units (top = +halfHeight). */
  halfHeight: number;
  /** Frustum half-width for the given aspect (= halfHeight * aspect). */
  halfWidth: number;
  near: number;
  far: number;
}

/**
 * Fit an ortho view's frustum + placement to the scene bounds for a viewport
 * `aspect` (w/h). The frustum is sized so the padded bounds fit on both axes,
 * then widened to the aspect; the camera is pulled back along the view axis far
 * enough that the whole depth range clips cleanly. Called once per view on first
 * activation (spec §2.4); afterward the view keeps its own pan/zoom.
 */
export function fitOrtho(
  view: OrthoViewId,
  min: THREE.Vector3,
  max: THREE.Vector3,
  aspect: number,
): OrthoFit {
  const axes = ORTHO_AXES[view];
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const comp = (v: THREE.Vector3, axis: 0 | 1 | 2) => (axis === 0 ? v.x : axis === 1 ? v.y : v.z);

  const dataHalfW = (comp(size, axes.widthAxis) * FIT_PADDING) / 2;
  const dataHalfH = (comp(size, axes.heightAxis) * FIT_PADDING) / 2;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;

  // Fit both axes: grow whichever dimension the aspect ratio under-covers.
  let halfHeight = dataHalfH;
  if (dataHalfW / halfHeight > safeAspect) halfHeight = dataHalfW / safeAspect;
  const halfWidth = halfHeight * safeAspect;

  // Distance only affects clipping for an ortho camera; span the full diagonal.
  const distance = size.length() + 1;
  const dir = new THREE.Vector3(...axes.dir);
  const position = center.clone().addScaledVector(dir, distance);

  return {
    position,
    target: center.clone(),
    up: new THREE.Vector3(...axes.up),
    halfHeight,
    halfWidth,
    near: 0.01,
    far: distance * 2 + size.length(),
  };
}

/**
 * Padding factor around the selected camera's image in the **Selected** view
 * (spec §2.4.1) — the counterpart of `FIT_PADDING` for the camera view. Kept as
 * its own constant because it serves a different purpose: not breathing room
 * around auto-fit scene bounds, but a deliberate band of context outside the
 * frame guide showing what a small pan or a wider FOV would gain.
 */
export const CAMERA_VIEW_PADDING = 1.15;

export interface CameraViewFit {
  /** Vertical FOV (degrees) the viewport actually renders at — always ≥ the camera's. */
  renderFov: number;
  /**
   * The frame guide (spec §2.4.1) as fractions of the viewport's width/height,
   * centered. Expressed as fractions rather than pixels so the DOM overlay is
   * pure percentages and survives a resize untouched whenever the aspects hold.
   */
  guide: { widthFrac: number; heightFrac: number };
}

/**
 * Fit the selected camera's image inside the viewport for the **Selected** view
 * (spec §2.4.1). The camera's own `aspect` rarely matches the viewport's, so
 * rendering at its exact FOV would either crop the image or fill the viewport
 * with scene the camera cannot see. Instead the rendered vertical FOV is expanded
 * until the camera's true image fits with `CAMERA_VIEW_PADDING` on the binding
 * axis, and the guide rect reports where that true image lands.
 *
 * Both outputs come from this one call so the outline and the render can never
 * disagree (spec §2.4.1). Note the binding axis always lands at exactly
 * `1 / CAMERA_VIEW_PADDING` of the viewport, whichever axis it is.
 */
export function fitCameraView(camFov: number, camAspect: number, viewportAspect: number): CameraViewFit {
  const safeAspect = viewportAspect > 0 && Number.isFinite(viewportAspect) ? viewportAspect : 1;
  const safeCamAspect = camAspect > 0 && Number.isFinite(camAspect) ? camAspect : 1;

  // Work in tangent space: the camera's half-extents at unit distance.
  const camHalfH = Math.tan((camFov * Math.PI) / 360);
  const camHalfW = camHalfH * safeCamAspect;

  // Grow the rendered vertical half-extent until *both* padded axes fit.
  const renderHalfH = Math.max(camHalfH * CAMERA_VIEW_PADDING, (camHalfW * CAMERA_VIEW_PADDING) / safeAspect);
  const renderHalfW = renderHalfH * safeAspect;

  return {
    renderFov: (Math.atan(renderHalfH) * 360) / Math.PI,
    guide: { widthFrac: camHalfW / renderHalfW, heightFrac: camHalfH / renderHalfH },
  };
}

/**
 * Recompute a symmetric ortho frustum's horizontal extent for a new viewport
 * aspect while preserving the vertical world-extent (`halfHeight`). Used on
 * resize so a remembered ortho framing keeps its scale (spec §2.4); camera
 * `zoom` (set by wheel-dolly) is applied separately by the projection matrix.
 */
export function orthoFrustumForAspect(halfHeight: number, aspect: number): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const halfWidth = halfHeight * safeAspect;
  return { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight };
}
