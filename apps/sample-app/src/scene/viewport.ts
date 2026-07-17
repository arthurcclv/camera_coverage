/**
 * Three.js renderer, orbit camera, transform-controls gizmo, and render loop
 * (spec §2.2). Driven imperatively; React only owns the container ref.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export interface Viewport {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  orbitControls: OrbitControls;
  transformControls: TransformControls;
  dispose(): void;
}

export function createViewport(container: HTMLElement): Viewport {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d22);

  // A steep-ish elevation keeps the optical path through the full-volume
  // coverage overlay short, so it reads as a translucent haze rather than a
  // near-opaque wall at a grazing viewing angle (see coverageOverlay.ts).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(13, 24, 15);
  camera.lookAt(0, 1, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
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
    container.removeChild(renderer.domElement);
  }

  return { scene, camera, renderer, orbitControls, transformControls, dispose };
}
