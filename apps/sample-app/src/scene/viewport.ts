/**
 * Viewport (spec §2.2, §2.3, §2.4): Three.js `WebGLRenderer` (WebGL2), orbit /
 * transform controls, and the render loop. **One canvas, one scene, one depth
 * buffer** — the 3D Gaussian Splat captures draw into this renderer too, as a
 * `Group` in this scene (`scene/splatLayer.ts`, `gaussian_splats.md` §4), so a
 * capture is occluded by the geometry in front of it like any other content.
 * `WebGLRenderer` constructs synchronously, so `createViewport` is synchronous.
 * Driven imperatively; React only owns the container ref.
 *
 * The viewport renders through one of five **view cameras** chosen by the
 * top-middle View selector (spec §2.4): a `perspective` camera (full orbit),
 * three world-axis orthographic elevations (`top`/`front`/`right`, locked to
 * pan + zoom), and `camera` — the **Selected** view, which renders from the
 * currently selected scene camera (§2.4.1). `setActiveView` re-points the orbit
 * controls, TransformControls, and — via `activeCamera` — the picking raycaster at
 * the chosen camera; the first four keep their own remembered framing (auto-fit
 * once, then their own pan/zoom).
 *
 * The Selected view is the exception throughout: it has no remembered framing
 * (its pose comes from `setCameraViewSource`, its FOV from `fitCameraView`), the
 * orbit controls are disabled outright, and it publishes a **frame guide** rect
 * through `onCameraGuide` for App to outline — the guide and the rendered FOV
 * coming from one `fitCameraView` call so they cannot disagree. The drag that
 * aims the camera lives in `scene/sceneView/`, not here.
 *
 * The pure fitting geometry lives in `scene/viewCameras.ts`. A passive
 * orientation gizmo (`OrientationGizmo`, aliased from Three.js's `ViewHelper`
 * addon; labeled X/Y/Z axis balls) is pinned
 * to the bottom-left, mirroring the active camera; it is read-only (click-to-snap
 * is never wired).
 *
 * The render backend here (WebGPU or its WebGL2 fallback) is independent of the
 * SDK's WebGPU *compute* backend (spec §3.2); the two are selected and reported
 * separately.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
// Aliased to OrientationGizmo — the bare name collides with the app's notion of
// coverage "cameras"/views and reads ambiguously here.
import { ViewHelper as OrientationGizmo } from 'three/addons/helpers/ViewHelper.js';
import {
  DEFAULT_VIEW,
  PERSPECTIVE_FAR,
  PERSPECTIVE_NEAR,
  fallbackBounds,
  fitCameraView,
  fitOrtho,
  fitPerspective,
  flyNavigation,
  isOrthographic,
  navigationEnabled,
  orbitEnabled,
  orthoFrustumForAspect,
  unionFiniteBounds,
  type CameraViewFit,
  type OrthoViewId,
  type ViewId,
} from './viewCameras.ts';
import {
  dampStep,
  groundRefDistance,
  middleDragStep,
  pivotAlongView,
  sceneDiagonal,
  speedModifierOf,
  viewportNdc,
  wheelAxisDelta,
  wheelNotches,
  wheelStep,
} from './navigation.ts';
import { createSceneLights } from './sceneLighting.ts';
import { VIEWPORT_CLEAR_COLOR, SplatLayer } from './splatLayer.ts';
import { FogCompositor } from './fogCompositor.ts';
import type { LabelOverlay } from './cameraLabels.ts';

/**
 * The selected camera's pose + lens, as the **Selected** view needs it (spec
 * §2.4.1). Deliberately not `SceneCamera` — the viewport has no business knowing
 * about names, enabled flags, or ids.
 */
export interface CameraViewSource {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
  fov: number;
  aspect: number;
}

export interface ViewportOptions {
  /**
   * Called whenever the **Selected** view's frame guide changes — on entering or
   * leaving the view, a camera/lens change, or a resize; `null` when the view is
   * not active (spec §2.4.1). The rect comes from the same `fitCameraView` call
   * that sets the rendered FOV, so the DOM outline and the render always agree.
   */
  onCameraGuide?(guide: CameraViewFit['guide'] | null): void;
}

export interface Viewport {
  scene: THREE.Scene;
  /** The perspective camera (the default view). See `activeCamera` for the live one. */
  camera: THREE.PerspectiveCamera;
  /** The camera currently being rendered/picked through (spec §2.4). */
  readonly activeCamera: THREE.Camera;
  /** Which view is active (spec §2.4). */
  readonly activeView: ViewId;
  /** Switch the active view, re-pointing controls + raycaster (spec §2.4). */
  setActiveView(view: ViewId): void;
  /**
   * Re-frame the active view on the current scene bounds — the **Reset view**
   * button (spec §2.4). A no-op in the Selected view, which has no framing of
   * its own (§2.4.1). For the Perspective view this is the only way back from a
   * camera flown far from the scene (`navigation.md` §5).
   */
  resetActiveView(): void;
  /**
   * Point the **Selected** view at a camera, or `null` to clear it (spec §2.4.1).
   * Copies the pose and re-fits the rendered FOV + frame guide. A no-op on the
   * render while another view is active, but the source is retained so entering
   * the view is immediate.
   */
  setCameraViewSource(source: CameraViewSource | null): void;
  /** The frame guide's current size in CSS pixels, or null (spec §2.4.1, §5.2). */
  cameraGuideSizePx(): { width: number; height: number } | null;
  renderer: THREE.WebGLRenderer;
  /**
   * The 3D Gaussian Splat captures, as a `Group` in this viewport's scene
   * (`gaussian_splats.md` §4). Always present; a scene with no capture holds an
   * empty group and pays nothing for it.
   */
  splats: SplatLayer;
  /**
   * Hand the viewport the coverage fog's scene, so it can run the fog pass
   * (`fogCompositor.ts`). Until it is called the frame still runs the same three
   * steps — the fog target simply stays cleared, and composites to exactly the
   * scene.
   */
  setFogScene(fogScene: THREE.Scene): void;
  /**
   * Hand the viewport the overlay drawn **after** the fog composite
   * (`volumetric_rendering.md` §4.1) — the camera name labels (spec §5.3). Until it
   * is called the frame simply ends one pass earlier.
   */
  setLabelOverlay(overlay: LabelOverlay): void;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  dispose(): void;
}

// Damping applied to rotate, pan (by OrbitControls) and the Perspective view's
// wheel/middle-drag travel (by us, `navigation.md` §4.5) — one factor, so the
// viewport reads as one system rather than a smooth orbit beside a jumpy zoom.
const DAMPING_FACTOR = 0.08;

// Orientation gizmo corner inset, in CSS pixels (bottom-left, spec §2.4).
const GIZMO_INSET = 16;

// The Perspective camera's startup pose (spec §2.4): a steep-ish 3/4 elevation,
// and the point it first looks at — which is also where the orbit pivot starts,
// so the two cannot disagree and the first frame is not a re-aim.
const STARTUP_POSITION = new THREE.Vector3(13, 24, 15);
const STARTUP_LOOK_AT = new THREE.Vector3(0, 1, 0);

// Axis colors shared by the gizmo's positive balls and our negative rings.
const AXIS_COLORS: Record<'negX' | 'negY' | 'negZ', string> = {
  negX: '#ff4466',
  negY: '#88ff44',
  negZ: '#4488ff',
};

// A hollow-ring sprite for a negative-axis marker (Blender-style, spec §2.4):
// a stroked circle in the axis color over a transparent centre, replacing the
// the gizmo's default dim dot.
function ringSpriteMaterial(color: string): THREE.SpriteMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(32, 32, 11, 0, 2 * Math.PI);
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: texture, toneMapped: false, transparent: true });
}

export function createViewport(
  container: HTMLElement,
  options: ViewportOptions = {},
): Viewport {
  const scene = new THREE.Scene();

  // A steep-ish elevation keeps the optical path through the full-volume
  // coverage overlay short, so it reads as a translucent haze rather than a
  // near-opaque wall at a grazing viewing angle (see coverageOverlay.ts).
  const camera = new THREE.PerspectiveCamera(55, 1, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
  camera.position.copy(STARTUP_POSITION);
  camera.lookAt(STARTUP_LOOK_AT);

  // The three ortho elevations. Frustum/placement are placeholders until each
  // view is first activated and auto-fit to the scene bounds (spec §2.4).
  const makeOrtho = () => new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 500);
  // The Selected view's camera (spec §2.4.1). A camera of its own rather than the
  // gizmo set's mirror object: its FOV is the *fit* FOV, not the scene camera's,
  // and mutating the gizmo's would corrupt the frustum wireframe other views draw.
  // Clip planes are the viewport's generous pair, deliberately not the scene
  // camera's near/far — `far` is a detection range, not a drawing limit (§2.4.1).
  const cameraView = new THREE.PerspectiveCamera(55, 1, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
  const cameras: Record<ViewId, THREE.Camera> = {
    perspective: camera,
    top: makeOrtho(),
    front: makeOrtho(),
    right: makeOrtho(),
    camera: cameraView,
  };

  // Per-ortho-view remembered state (spec §2.4): the orbit target the view was
  // left at, and its base frustum half-height (kept so a resize can re-derive
  // left/right for the new aspect without losing scale). Keyed on `OrthoViewId`
  // rather than `ViewId` because the other two views genuinely have no entry to
  // keep: the `camera` view is derived wholly from the selected camera (spec
  // §2.4.1), and the Perspective view's remembered framing is its camera pose
  // alone, its pivot being per-gesture scratch (`navigation.md` §3) — a stale
  // target stored for it would be read back on the next switch and re-aim the
  // camera, which is exactly the bug this keying makes unrepresentable.
  const viewTargets: Record<OrthoViewId, THREE.Vector3> = {
    top: new THREE.Vector3(),
    front: new THREE.Vector3(),
    right: new THREE.Vector3(),
  };
  const orthoHalfHeight: Record<OrthoViewId, number> = { top: 0, front: 0, right: 0 };
  const fitted = new Set<ViewId>();
  let activeView: ViewId = DEFAULT_VIEW;

  // The Selected view's source camera and its last published guide (spec §2.4.1).
  let cameraViewSource: CameraViewSource | null = null;
  let cameraGuide: CameraViewFit['guide'] | null = null;

  // WebGL2 (spec §2.3). `antialias: false` on Spark's advice — MSAA does not
  // improve Gaussian splatting and costs real performance, and the captures now
  // share this framebuffer.
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  // Required for `Material.clippingPlanes`, which is how a section's clip
  // cross-sections the geometry (spec §13.9, `setGeometryClippingPlanes`).
  renderer.localClippingEnabled = true;
  renderer.domElement.classList.add('viewport-main');
  container.appendChild(renderer.domElement);
  // One canvas, one clear: splats draw into this scene rather than a layer beneath
  // it, so the background is `scene.background` as it was before splats existed
  // (`gaussian_splats.md` §4.2). It is painted into the compositor's offscreen
  // target along with everything else, and reaches the canvas through the composite.
  scene.background = new THREE.Color(VIEWPORT_CLEAR_COLOR);

  // The splat layer is built **unconditionally** — one code path whether or not a
  // scene has a capture (`gaussian_splats.md` §4.2). It owns no renderer; it holds
  // this one only so Spark can construct its `SparkRenderer` against it.
  const splats = new SplatLayer(renderer);
  scene.add(splats.group);

  // The coverage fog renders to its own target and is composited over the scene
  // (`volumetric_rendering.md` §4). Built unconditionally so there is one frame
  // path whether or not a run has produced fog.
  const fog = new FogCompositor();
  let fogScene: THREE.Scene | null = null;
  let labelOverlay: LabelOverlay | null = null;
  // Scratch for the label pass's drawing-buffer size, so the frame allocates nothing.
  const drawingBufferSize = new THREE.Vector2();

  // Fixed light rig (spec §2.3.1) — see `sceneLighting.ts` for the rationale.
  scene.add(...Object.values(createSceneLights()));

  const grid = new THREE.GridHelper(24, 24, 0x444a55, 0x2a2e36);
  scene.add(grid);

  // Passive orientation gizmo (spec §2.4): the Three.js `ViewHelper` addon
  // (aliased OrientationGizmo) — labeled X/Y/Z axis balls — pinned to the
  // bottom-left corner, mirroring the active camera. Read-only: `handleClick`
  // is intentionally never wired, so it never snaps the view (the top-middle
  // View selector is the only way to switch).
  // The bundled ViewHelper types lag the r16x runtime (which added a
  // reassignable `camera`, a `location` corner control, and WebGPU support in
  // `render`), so cast to the members we actually use.
  const orientationGizmo = new OrientationGizmo(camera, renderer.domElement) as unknown as THREE.Object3D & {
    camera: THREE.Camera;
    location: { top: number | null; right: number; bottom: number; left: number | null };
    setLabels(labelX: string, labelY: string, labelZ: string): void;
    render(renderer: THREE.WebGLRenderer): void;
    dispose(): void;
  };
  orientationGizmo.setLabels('X', 'Y', 'Z');
  orientationGizmo.location = { top: null, right: 0, bottom: GIZMO_INSET, left: GIZMO_INSET };
  // Restyle the axis sprites: give the negative axes hollow colored rings
  // (instead of the default faint dots), and enable alpha blending on the
  // positive balls so their canvas texture's transparent surround doesn't
  // render as an opaque black quad — the gizmo sits over the scene with a
  // fully transparent background (spec §2.4).
  for (const child of orientationGizmo.children) {
    const type = (child.userData as { type?: string }).type;
    if (!type) continue;
    const sprite = child as THREE.Sprite;
    if (type === 'negX' || type === 'negY' || type === 'negZ') {
      sprite.material.map?.dispose();
      sprite.material.dispose();
      sprite.material = ringSpriteMaterial(AXIS_COLORS[type]);
    } else {
      sprite.material.transparent = true;
      sprite.material.needsUpdate = true;
    }
  }

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.copy(STARTUP_LOOK_AT);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = DAMPING_FACTOR;
  // The wheel is ours (`navigation.md` §4.1): OrbitControls' dolly converges on
  // `target` and is the stall this design removes. Rotate and pan stay its job —
  // once `target` is re-seated per gesture (§3) they already do the right thing.
  // This also disables its middle-drag dolly, replaced below (§4.2).
  orbitControls.enableZoom = false;
  orbitControls.update();

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.addEventListener('dragging-changed', (e) => {
    // `navigationEnabled` keeps a drag-end from re-enabling the controls in the
    // Selected view, where they must stay off (spec §2.4.1).
    orbitControls.enabled = !(e as unknown as { value: boolean }).value && navigationEnabled(activeView);
  });
  const transformHelper = transformControls.getHelper();
  scene.add(transformHelper);

  function aspect(): number {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    return w / h;
  }

  // Scene bounds for the auto-fit (spec §2.4). Unions only the top-level objects
  // whose world box is finite and non-empty, so degenerate contributors — chiefly
  // the coverage overlay's InstancedMesh, which reports a non-finite box while it
  // holds no instances (before a run) — can't poison the frustum. The grid keeps
  // a sane frame even when no other geometry is present.
  const contentBounds = new THREE.Box3();
  function sceneContentBounds(): { min: THREE.Vector3; max: THREE.Vector3 } {
    const boxes: THREE.Box3[] = [];
    for (const child of scene.children) {
      // The TransformControls gizmo carries huge (finite) guide-line geometry
      // that would swamp the frame; it is UI, not scene content.
      if (child === transformHelper) continue;
      boxes.push(new THREE.Box3().setFromObject(child));
    }
    if (!unionFiniteBounds(contentBounds, boxes)) return fallbackBounds();
    return { min: contentBounds.min, max: contentBounds.max };
  }

  // --- Perspective navigation (`navigation.md`) ------------------------------
  //
  // Everything here is per-gesture scratch. `OrbitControls` keeps rotate and pan;
  // what this adds is (a) re-seating its pivot from the ground at each drag start,
  // which is what stops pan from shrinking, and (b) owning the wheel and the
  // middle drag, which translate camera *and* pivot together so the
  // camera-to-pivot distance never changes and forward travel cannot stall (§1).

  /** Un-damped remainder of wheel/middle-drag travel, in world space (§4.5). */
  const pendingTravel = new THREE.Vector3();
  const travelDirection = new THREE.Vector3();
  /** The in-flight middle drag, if any (§4.2). */
  let middleDrag: { pointerId: number; lastY: number } | null = null;

  const rayOrigin = new THREE.Vector3();
  const rayDirection = new THREE.Vector3();

  /**
   * Whether the Perspective view's fly gestures apply right now (§4.1, §4.2) —
   * the view's own capability (`viewCameras.flyNavigation`) and the live controls
   * state, which a `TransformControls` drag turns off mid-gesture.
   */
  function flyGesturesActive(): boolean {
    return flyNavigation(activeView) && orbitControls.enabled;
  }

  /**
   * Frames rendered, and the diagonal computed in the current one. `D` has to be
   * recomputed as the scene changes — loading a splat capture into a room-scale
   * scene grows it by ~1000x and navigation speed must follow immediately — but
   * `sceneContentBounds` walks every top-level object and boxes it, so §2 caps
   * that at **once per animation frame**: a trackpad emits wheel events far
   * faster than frames, and each one would otherwise re-walk the scene.
   */
  let frameIndex = 0;
  let diagonalFrame = -1;
  let diagonalValue = 0;

  /** Scene diagonal, at most once per frame (§2). */
  function currentDiagonal(): number {
    if (diagonalFrame !== frameIndex) {
      const { min, max } = sceneContentBounds();
      diagonalValue = sceneDiagonal(min, max);
      diagonalFrame = frameIndex;
    }
    return diagonalValue;
  }

  /**
   * World ray through a client-space point, or through the viewport centre when
   * `clientX` is null. Writes `rayOrigin`/`rayDirection` (normalized).
   */
  function rayThrough(clientX: number | null, clientY: number | null): void {
    const ndc = viewportNdc(clientX, clientY, renderer.domElement.getBoundingClientRect());
    // `unproject` reads `matrixWorld`, which is otherwise only refreshed at render
    // time — a stale one skews every ray taken between frames.
    camera.updateMatrixWorld();
    rayOrigin.copy(camera.position);
    rayDirection.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
  }

  /** `dRef` under a screen point, or under the viewport centre for null (§2). */
  function refDistanceAt(clientX: number | null, clientY: number | null): number {
    const diagonal = currentDiagonal();
    rayThrough(clientX, clientY);
    return groundRefDistance(rayOrigin, rayDirection, diagonal);
  }

  /**
   * Re-seat the orbit pivot before OrbitControls uses it (§3). The **direction**
   * is always the viewport centre, so the pivot stays in front of the camera; the
   * **distance** comes from the centre for an orbit and from the cursor for a pan,
   * since OrbitControls derives its pan rate from the camera-to-target distance
   * and §4.3 wants that to be the ground under the cursor.
   */
  function reseatPivot(clientX: number | null, clientY: number | null): void {
    const distance = refDistanceAt(clientX, clientY);
    rayThrough(null, null);
    orbitControls.target.copy(pivotAlongView(rayOrigin, rayDirection, distance));
  }

  /** Ease this frame's share of `pendingTravel` onto the camera and pivot (§4.5). */
  function applyPendingTravel(): void {
    const length = pendingTravel.length();
    if (length === 0) return;
    // Only the Perspective camera flies. `setActiveView` and `resetActiveView`
    // both clear the accumulator, so this is a backstop rather than the guard —
    // but an ease in flight must never write an ortho view's pan target, which
    // §7 leaves entirely to OrbitControls.
    if (!flyNavigation(activeView)) {
      pendingTravel.set(0, 0, 0);
      return;
    }
    const { apply, remaining } = dampStep(length, DAMPING_FACTOR);
    travelDirection.copy(pendingTravel).divideScalar(length);
    // Camera *and* pivot, by the same vector — the invariant the whole design
    // rests on: the distance between them never changes, so there is nothing for
    // forward travel to converge on.
    camera.position.addScaledVector(travelDirection, apply);
    orbitControls.target.addScaledVector(travelDirection, apply);
    if (remaining === 0) pendingTravel.set(0, 0, 0);
    else pendingTravel.copy(travelDirection).multiplyScalar(remaining);
  }

  function onWheel(e: WheelEvent): void {
    if (!flyGesturesActive()) return;
    // Claimed unconditionally, including the ctrl+wheel a trackpad pinch arrives
    // as, which the browser would otherwise turn into a page zoom (§4.6). This is
    // why the speed modifiers are Shift and Alt rather than Ctrl, and why the
    // listener is registered non-passive.
    e.preventDefault();
    const notches = wheelNotches(wheelAxisDelta(e.deltaY, e.deltaX), e.deltaMode);
    if (notches === 0) return;
    const diagonal = currentDiagonal();
    rayThrough(e.clientX, e.clientY);
    const step = wheelStep(groundRefDistance(rayOrigin, rayDirection, diagonal), speedModifierOf(e));
    // Along the cursor ray, not the view axis: translating a perspective camera
    // along a ray leaves every point on that ray on the same pixel, so what is
    // under the cursor stays under it at any depth — no depth match needed (§4.1).
    // Scroll-down is positive `deltaY` and flies backward.
    pendingTravel.addScaledVector(rayDirection, -notches * step);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!flyGesturesActive()) return;
    if (e.button === 0) {
      reseatPivot(null, null);
    } else if (e.button === 2) {
      reseatPivot(e.clientX, e.clientY);
    } else if (e.button === 1) {
      // preventDefault suppresses the compatibility mousedown, and with it
      // Chrome's middle-click autoscroll.
      e.preventDefault();
      middleDrag = { pointerId: e.pointerId, lastY: e.clientY };
      renderer.domElement.setPointerCapture(e.pointerId);
      // Attached here rather than for the element's whole life, so an unstarted
      // gesture costs nothing (`ai/CONVENTIONS.md`, pointer gestures). Removed on
      // up/cancel below, and by `dispose` if one is still in flight.
      addMiddleDragListeners();
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!middleDrag || e.pointerId !== middleDrag.pointerId) return;
    const deltaY = e.clientY - middleDrag.lastY;
    middleDrag.lastY = e.clientY;
    if (!flyGesturesActive()) return;
    const height = renderer.domElement.clientHeight || 1;
    const distance = refDistanceAt(null, null);
    rayThrough(null, null);
    pendingTravel.addScaledVector(rayDirection, middleDragStep(deltaY, distance, height));
  }

  function onPointerUp(e: PointerEvent): void {
    if (!middleDrag || e.pointerId !== middleDrag.pointerId) return;
    endMiddleDrag(e.pointerId);
  }

  function endMiddleDrag(pointerId: number): void {
    middleDrag = null;
    removeMiddleDragListeners();
    if (renderer.domElement.hasPointerCapture(pointerId)) {
      renderer.domElement.releasePointerCapture(pointerId);
    }
  }

  function addMiddleDragListeners(): void {
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
  }

  function removeMiddleDragListeners(): void {
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointercancel', onPointerUp);
  }

  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  // One-time auto-fit of an ortho view to the current scene bounds (spec §2.4).
  function fitOrthoView(view: OrthoViewId): void {
    const cam = cameras[view] as THREE.OrthographicCamera;
    const { min, max } = sceneContentBounds();
    const fit = fitOrtho(view, min, max, aspect());
    cam.position.copy(fit.position);
    cam.up.copy(fit.up);
    cam.left = -fit.halfWidth;
    cam.right = fit.halfWidth;
    cam.top = fit.halfHeight;
    cam.bottom = -fit.halfHeight;
    cam.near = fit.near;
    cam.far = fit.far;
    cam.zoom = 1;
    cam.lookAt(fit.target);
    cam.updateProjectionMatrix();
    viewTargets[view].copy(fit.target);
    orthoHalfHeight[view] = fit.halfHeight;
  }

  /**
   * Re-frame the active view on the bounds as they are *now* (spec §2.4). The
   * ortho views re-run exactly the auto-fit they got on first activation, which
   * is also the only thing that re-fits them after geometry changes; Perspective
   * keeps its viewing direction and is pulled back to frame the scene.
   */
  function resetActiveView(): void {
    // The Selected view is derived wholly from the selected camera (spec §2.4.1).
    if (activeView === 'camera') return;

    if (isOrthographic(activeView)) {
      fitOrthoView(activeView);
      fitted.add(activeView);
      orbitControls.target.copy(viewTargets[activeView]);
      orbitControls.update();
      return;
    }

    // Any travel still easing out would otherwise drift the camera off the fresh
    // framing over the next few frames (`navigation.md` §4.5).
    pendingTravel.set(0, 0, 0);
    const { min, max } = sceneContentBounds();
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const fit = fitPerspective(min, max, forward, camera.fov, aspect());
    camera.position.copy(fit.position);
    orbitControls.target.copy(fit.target);
    camera.lookAt(fit.target);
    orbitControls.update();
  }

  /**
   * Publish the frame guide, skipping no-op notifications so React doesn't
   * re-render on every resize tick that leaves the rect unchanged (spec §2.4.1).
   */
  function publishGuide(guide: CameraViewFit['guide'] | null): void {
    const unchanged =
      guide === cameraGuide ||
      (!!guide &&
        !!cameraGuide &&
        guide.widthFrac === cameraGuide.widthFrac &&
        guide.heightFrac === cameraGuide.heightFrac);
    if (unchanged) return;
    cameraGuide = guide;
    options.onCameraGuide?.(guide);
  }

  /**
   * Re-derive the Selected view's pose, rendered FOV, and frame guide from its
   * source camera (spec §2.4.1). Runs on a source change, a view switch, and a
   * resize; the guide is published only while the view is actually active.
   */
  function applyCameraView(): void {
    const source = cameraViewSource;
    if (!source) {
      publishGuide(null);
      return;
    }
    const a = aspect();
    const fit = fitCameraView(source.fov, source.aspect, a);
    cameraView.position.set(source.position[0], source.position[1], source.position[2]);
    cameraView.quaternion.set(source.rotation[0], source.rotation[1], source.rotation[2], source.rotation[3]);
    cameraView.fov = fit.renderFov;
    cameraView.aspect = a;
    cameraView.updateProjectionMatrix();
    cameraView.updateMatrixWorld(true);
    publishGuide(activeView === 'camera' ? fit.guide : null);
  }

  function setCameraViewSource(source: CameraViewSource | null): void {
    cameraViewSource = source;
    applyCameraView();
  }

  function cameraGuideSizePx(): { width: number; height: number } | null {
    if (!cameraGuide) return null;
    return {
      width: (container.clientWidth || 1) * cameraGuide.widthFrac,
      height: (container.clientHeight || 1) * cameraGuide.heightFrac,
    };
  }

  function setActiveView(view: ViewId): void {
    if (view === activeView && (view === 'perspective' || view === 'camera' || fitted.has(view))) return;
    // Save the framing of the view we're leaving so returning restores it. Only
    // the ortho elevations have one to save: the Selected view's orbit target is
    // meaningless (spec §2.4.1), and the Perspective view's pivot is per-gesture
    // scratch, re-seated from the ground at the next drag (`navigation.md` §3),
    // so its remembered framing is the camera pose alone — which lives on the
    // camera object and needs no saving here.
    if (isOrthographic(activeView)) {
      viewTargets[activeView].copy(orbitControls.target);
    }
    // Travel still easing out belongs to the view being left (`navigation.md`
    // §4.5). Left in place it would spend the next frames dragging whatever
    // `orbitControls.target` now points at — an ortho view's pan target — in a
    // direction the user asked for in a different camera.
    pendingTravel.set(0, 0, 0);

    // The Selected view is locked outright: no orbit, no pan, no zoom, since the
    // viewport *is* the camera's image. A drag aims the camera instead, which
    // SceneView owns (spec §2.4.1, §5.2). Nothing to fit or re-point.
    if (view === 'camera') {
      activeView = view;
      orbitControls.enabled = false;
      applyCameraView();
      return;
    }

    if (view !== 'perspective' && !fitted.has(view)) {
      fitOrthoView(view);
      fitted.add(view);
    }

    const cam = cameras[view];
    activeView = view;
    orbitControls.enabled = true;
    publishGuide(null);

    // Re-point the controls + gizmo at the new camera (spec §2.4).
    orbitControls.object = cam;
    if (isOrthographic(view)) {
      orbitControls.target.copy(viewTargets[view]);
    } else {
      // Perspective. Its remembered framing is the camera pose alone, so the
      // pivot is re-seated on the ground **along the camera's current view axis**
      // (`navigation.md` §3) instead of being restored from a saved point. This
      // is not cosmetic: `orbitControls.update()` below ends in `lookAt(target)`,
      // so a pivot anywhere off that axis re-aims the camera — flying out over
      // the site, glancing at Top and coming back used to yank the view around to
      // face the startup look-at point, keeping the position and losing the
      // orientation.
      reseatPivot(null, null);
    }
    const canOrbit = orbitEnabled(view);
    orbitControls.enableRotate = canOrbit;
    // Ortho views: left-drag pans (the view stays axis-aligned); perspective
    // keeps left-drag orbit, right-drag pan.
    // `navigation.md` applies to the Perspective view only (§7). The ortho views
    // keep OrbitControls' wheel/middle dolly, which scales their frustum and has
    // neither defect — there is no 'forward' under parallel projection, and their
    // pan is already 1:1 at every zoom. In Perspective both are ours instead:
    // the wheel and the middle drag fly the camera (§4.1, §4.2).
    const flies = flyNavigation(view);
    orbitControls.enableZoom = !flies;
    orbitControls.mouseButtons = {
      LEFT: canOrbit ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
      ...(flies ? {} : { MIDDLE: THREE.MOUSE.DOLLY }),
      RIGHT: THREE.MOUSE.PAN,
    };
    orbitControls.update();
    transformControls.camera = cam;
  }

  function resize(): void {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const a = w / h;
    camera.aspect = a;
    camera.updateProjectionMatrix();
    // Re-derive each fitted ortho frustum for the new aspect, preserving scale
    // (base half-height) and any wheel-dolly zoom (spec §2.4).
    for (const view of ['top', 'front', 'right'] as const) {
      if (!fitted.has(view)) continue;
      const cam = cameras[view] as THREE.OrthographicCamera;
      const f = orthoFrustumForAspect(orthoHalfHeight[view], a);
      cam.left = f.left;
      cam.right = f.right;
      cam.top = f.top;
      cam.bottom = f.bottom;
      cam.updateProjectionMatrix();
    }
    // The Selected view re-fits on every resize instead of remembering a framing
    // (spec §2.4.1), which also re-derives the frame guide for the new aspect.
    applyCameraView();
    renderer.setSize(w, h);
    // One observer sizes the compositor's targets too, off the renderer's own
    // drawing buffer, so they cannot drift from the canvas.
    fog.setSize(renderer);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    // Invalidates the cached scene diagonal, so navigation re-measures the scene
    // at most once a frame however many wheel events arrive (`navigation.md` §2).
    frameIndex += 1;
    applyPendingTravel();
    orbitControls.update();
    // The scene — geometry, gizmos, and the splat captures, which are an
    // `Object3D` in it and so share its depth buffer (`gaussian_splats.md` §4.1)
    // — draws into the compositor's offscreen target, then the coverage fog
    // accumulates against that target's depth and the two are composited to the
    // canvas (`volumetric_rendering.md` §4).
    fog.renderScene(renderer, scene, cameras[activeView], splats);
    fog.composite(renderer, fogScene, cameras[activeView]);
    // Passes 4a + 4 (`volumetric_rendering.md` §4.1): chrome that must read *over* the
    // fog rather than under it. The canvas has no scene depth left after the composite,
    // so the overlay is handed the compositor's `DepthTexture` and resolves its own
    // occlusion against it — `renderProbePass` runs its state pass (4a) and restores
    // the target it found. `autoClear` off so pass 4 composites onto the canvas.
    //
    // The frame timestamp goes with it: this loop is the clock, and the overlay's fade
    // is a function of elapsed time rather than of frames drawn (spec §5.3).
    if (labelOverlay) {
      renderer.getDrawingBufferSize(drawingBufferSize);
      labelOverlay.renderProbePass({
        renderer,
        depth: fog.sceneDepthTexture,
        width: drawingBufferSize.x,
        height: drawingBufferSize.y,
        camera: cameras[activeView],
        nowMs: performance.now(),
      });
      renderer.autoClear = false;
      renderer.render(labelOverlay.scene, cameras[activeView]);
      renderer.autoClear = true;
    }
    // Mirror the live view, then draw the gizmo over the corner (it manages its
    // own viewport + depth clear, spec §2.4).
    // autoClear is disabled so the gizmo's internal render composites over the
    // scene instead of clearing its viewport to the opaque black clear-color.
    orientationGizmo.camera = cameras[activeView];
    renderer.autoClear = false;
    orientationGizmo.render(renderer);
    renderer.autoClear = true;
  });

  function dispose(): void {
    renderer.setAnimationLoop(null);
    renderer.domElement.removeEventListener('wheel', onWheel);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    // A middle drag in flight when the viewport is torn down still has its
    // per-gesture listeners attached.
    removeMiddleDragListeners();
    fog.dispose();
    resizeObserver.disconnect();
    orientationGizmo.dispose();
    transformControls.dispose();
    orbitControls.dispose();
    // Tears down the second renderer, the splat scene, every `SplatMesh`, and
    // the decode cache (`gaussian_splats.md` §4.2).
    splats.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  return {
    scene,
    camera,
    get activeCamera() {
      return cameras[activeView];
    },
    get activeView() {
      return activeView;
    },
    setActiveView,
    resetActiveView,
    setCameraViewSource,
    cameraGuideSizePx,
    renderer,
    splats,
    setLabelOverlay(next: LabelOverlay): void {
      labelOverlay = next;
    },
    setFogScene(next: THREE.Scene): void {
      fogScene = next;
    },
    orbitControls,
    transformControls,
    dispose,
  };
}
