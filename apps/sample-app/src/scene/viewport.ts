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
  navigationEnabled,
  orbitEnabled,
  orthoFrustumForAspect,
  unionFiniteBounds,
  type CameraViewFit,
  type OrthoViewId,
  type ViewId,
} from './viewCameras.ts';
import { createSceneLights } from './sceneLighting.ts';
import { VIEWPORT_CLEAR_COLOR, SplatLayer } from './splatLayer.ts';

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
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  dispose(): void;
}

// Orientation gizmo corner inset, in CSS pixels (bottom-left, spec §2.4).
const GIZMO_INSET = 16;

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
  // The **WebGL splat layer owns the viewport background** (`gaussian_splats.md`
  // §4.2): this canvas is created `alpha: true` with a null scene background, so
  // it clears transparent and composites over the layer beneath. Measured on the
  // real `volumetric.ts` material, that composite differs from the old
  // opaque-background result by 0.07/255 in `max` mode and 0.12/255 in
  // `additive` — invisible in both (§4.5). When the splat layer has no WebGL2
  // context the background is restored here instead, so the viewport renders
  // exactly as it did before (§9).
  scene.background = null;

  // A steep-ish elevation keeps the optical path through the full-volume
  // coverage overlay short, so it reads as a translucent haze rather than a
  // near-opaque wall at a grazing viewing angle (see coverageOverlay.ts).
  const camera = new THREE.PerspectiveCamera(55, 1, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
  camera.position.set(13, 24, 15);
  camera.lookAt(0, 1, 0);

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

  // Per-view remembered state (spec §2.4): orbit target, whether the one-time
  // auto-fit has run, and each ortho view's base frustum half-height (kept so a
  // resize can re-derive left/right for the new aspect without losing scale).
  // The `camera` view has no remembered framing — it is derived wholly from the
  // selected camera (spec §2.4.1) — so its entries here stay unused.
  const viewTargets: Record<ViewId, THREE.Vector3> = {
    perspective: new THREE.Vector3(0, 1, 0),
    top: new THREE.Vector3(),
    front: new THREE.Vector3(),
    right: new THREE.Vector3(),
    camera: new THREE.Vector3(),
  };
  const orthoHalfHeight: Record<ViewId, number> = { perspective: 0, top: 0, front: 0, right: 0, camera: 0 };
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
  scene.background = new THREE.Color(VIEWPORT_CLEAR_COLOR);

  // The splat layer is built **unconditionally** — one code path whether or not a
  // scene has a capture (`gaussian_splats.md` §4.2). It owns no renderer; it holds
  // this one only so Spark can construct its `SparkRenderer` against it.
  const splats = new SplatLayer(renderer);
  scene.add(splats.group);

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
  orbitControls.target.copy(viewTargets.perspective);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
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
    // Save the framing of the view we're leaving so returning restores it — the
    // Selected view has none, and its orbit target is meaningless (spec §2.4.1).
    if (navigationEnabled(activeView)) viewTargets[activeView].copy(orbitControls.target);

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
    orbitControls.target.copy(viewTargets[view]);
    const canOrbit = orbitEnabled(view);
    orbitControls.enableRotate = canOrbit;
    // Ortho views: left-drag pans (the view stays axis-aligned); perspective
    // keeps left-drag orbit, right-drag pan.
    orbitControls.mouseButtons = {
      LEFT: canOrbit ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
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
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    orbitControls.update();
    // One render call. `SparkRenderer` is an `Object3D` in this scene, so the
    // captures draw as part of it, into the same depth buffer
    // (`gaussian_splats.md` §4.1, §4.2).
    renderer.render(scene, cameras[activeView]);
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
    setCameraViewSource,
    cameraGuideSizePx,
    renderer,
    splats,
    orbitControls,
    transformControls,
    dispose,
  };
}
