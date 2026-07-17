/**
 * Viewport (spec §2.2, §2.3): Three.js `WebGPURenderer` (`three/webgpu`) with
 * automatic WebGL2 fallback, orbit camera, transform-controls gizmo, and render
 * loop. `WebGPURenderer` initializes asynchronously, so `createViewport` is async
 * and awaits `renderer.init()` before the first frame. Driven imperatively; React
 * only owns the container ref.
 *
 * The render backend here (WebGPU or its WebGL2 fallback) is independent of the
 * SDK's WebGPU *compute* backend (spec §3.2); the two are selected and reported
 * separately.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export type RenderBackend = 'webgpu' | 'webgl2';

export interface Viewport {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  /** Which backend `WebGPURenderer` actually selected (spec §2.3). */
  renderBackend: RenderBackend;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  dispose(): void;
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

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(0, 1, 0);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.update();

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !(e as unknown as { value: boolean }).value;
  });
  scene.add(transformControls.getHelper());

  function resize(): void {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    orbitControls.update();
    renderer.render(scene, camera);
  });

  function dispose(): void {
    renderer.setAnimationLoop(null);
    resizeObserver.disconnect();
    transformControls.dispose();
    orbitControls.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  }

  return { scene, camera, renderer, renderBackend, orbitControls, transformControls, dispose };
}
