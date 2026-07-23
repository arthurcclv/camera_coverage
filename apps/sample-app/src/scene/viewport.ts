/**
 * Viewport (spec §2.2, §2.3, §2.4): Three.js `WebGPURenderer` (`three/webgpu`)
 * with automatic WebGL2 fallback, orbit/transform controls, and render loop.
 * `WebGPURenderer` initializes asynchronously, so `createViewport` is async and
 * awaits `renderer.init()` before the first frame. Driven imperatively; React
 * only owns the container ref.
 *
 * The viewport renders through one of four **view cameras** chosen by the
 * top-middle View selector (spec §2.4): a `perspective` camera (full orbit) plus
 * three world-axis orthographic elevations (`top`/`front`/`right`, locked to
 * pan + zoom). `setActiveView` re-points the orbit controls, TransformControls,
 * and — via `activeCamera` — the picking raycaster at the chosen camera; each
 * view keeps its own remembered framing (auto-fit once, then its own pan/zoom).
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
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
// Aliased to OrientationGizmo — the bare name collides with the app's notion of
// coverage "cameras"/views and reads ambiguously here.
import { ViewHelper as OrientationGizmo } from 'three/addons/helpers/ViewHelper.js';
import {
  DEFAULT_VIEW,
  fallbackBounds,
  fitOrtho,
  isOrthographic,
  orbitEnabled,
  orthoFrustumForAspect,
  unionFiniteBounds,
  type ViewId,
} from './viewCameras.ts';

export type RenderBackend = 'webgpu' | 'webgl2';

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
  renderer: THREE.WebGPURenderer;
  /** Which backend `WebGPURenderer` actually selected (spec §2.3). */
  renderBackend: RenderBackend;
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

export async function createViewport(container: HTMLElement): Promise<Viewport> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d22);

  // A steep-ish elevation keeps the optical path through the full-volume
  // coverage overlay short, so it reads as a translucent haze rather than a
  // near-opaque wall at a grazing viewing angle (see coverageOverlay.ts).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(13, 24, 15);
  camera.lookAt(0, 1, 0);

  // The three ortho elevations. Frustum/placement are placeholders until each
  // view is first activated and auto-fit to the scene bounds (spec §2.4).
  const makeOrtho = () => new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 500);
  const cameras: Record<ViewId, THREE.Camera> = {
    perspective: camera,
    top: makeOrtho(),
    front: makeOrtho(),
    right: makeOrtho(),
  };

  // Per-view remembered state (spec §2.4): orbit target, whether the one-time
  // auto-fit has run, and each ortho view's base frustum half-height (kept so a
  // resize can re-derive left/right for the new aspect without losing scale).
  const viewTargets: Record<ViewId, THREE.Vector3> = {
    perspective: new THREE.Vector3(0, 1, 0),
    top: new THREE.Vector3(),
    front: new THREE.Vector3(),
    right: new THREE.Vector3(),
  };
  const orthoHalfHeight: Record<ViewId, number> = { perspective: 0, top: 0, front: 0, right: 0 };
  const fitted = new Set<ViewId>();
  let activeView: ViewId = DEFAULT_VIEW;

  // Prefers WebGPU; falls back to its own WebGL2 backend when navigator.gpu is
  // unavailable, so the demo always renders through one code path (spec §2.3).
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  await renderer.init();
  // `backend` is typed as the abstract base; the WebGPU backend tags itself.
  const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined;
  const renderBackend: RenderBackend = backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  container.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x30323a, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(15, 25, 10);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

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
    render(renderer: THREE.WebGPURenderer): void;
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
    orbitControls.enabled = !(e as unknown as { value: boolean }).value;
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
  function fitOrthoView(view: Exclude<ViewId, 'perspective'>): void {
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

  function setActiveView(view: ViewId): void {
    if (view === activeView && (view === 'perspective' || fitted.has(view))) return;
    // Save the framing of the view we're leaving so returning restores it.
    viewTargets[activeView].copy(orbitControls.target);

    if (view !== 'perspective' && !fitted.has(view)) {
      fitOrthoView(view);
      fitted.add(view);
    }

    const cam = cameras[view];
    activeView = view;

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
    renderer.setSize(w, h);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    orbitControls.update();
    renderer.render(scene, cameras[activeView]);
    // Mirror the live view, then draw the gizmo over the corner (it manages its
    // own viewport + depth clear, and handles the WebGPU y-origin, spec §2.4).
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
    renderer,
    renderBackend,
    orbitControls,
    transformControls,
    dispose,
  };
}
