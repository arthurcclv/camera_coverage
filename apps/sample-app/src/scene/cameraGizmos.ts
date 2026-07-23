/**
 * Per-camera frustum gizmos (spec §5.3): a THREE.CameraHelper wireframe
 * reflecting fov/aspect/far, plus a small clickable body for selection and as
 * the TransformControls attach target.
 */
import * as THREE from 'three';
import type { SceneCamera } from '../cameras/camera.ts';

interface GizmoEntry {
  camObj: THREE.PerspectiveCamera; // attach target: position/quaternion == CameraConfig
  body: THREE.Mesh;
  helper: THREE.CameraHelper;
}

const DEFAULT_BODY_COLOR = 0x5da9e0;
const SELECTED_BODY_COLOR = 0xffd23f;
const FLAGGED_BODY_COLOR = 0xe0524f;
const DEFAULT_HELPER_COLOR = 0x7fb8e6;
const SELECTED_HELPER_COLOR = 0xffd23f;
const FLAGGED_HELPER_COLOR = 0xe0524f;

export class CameraGizmoSet {
  readonly group = new THREE.Group();
  private entries = new Map<string, GizmoEntry>();

  update(
    cameras: SceneCamera[],
    selectedId: string | null,
    flaggedIds: ReadonlySet<string> = new Set(),
  ): void {
    const seen = new Set<string>();
    for (const cam of cameras) {
      seen.add(cam.id);
      let entry = this.entries.get(cam.id);
      if (!entry) {
        entry = this.createEntry(cam.id);
        this.entries.set(cam.id, entry);
      }
      const { camObj, body, helper } = entry;
      camObj.fov = cam.fov;
      camObj.aspect = cam.aspect ?? 16 / 9;
      camObj.near = cam.near ?? 0.1;
      camObj.far = cam.far ?? 50;
      camObj.updateProjectionMatrix();
      camObj.position.set(...cam.position);
      camObj.quaternion.set(cam.rotation[0], cam.rotation[1], cam.rotation[2], cam.rotation[3]);
      camObj.updateMatrixWorld(true);
      helper.update();

      const flagged = flaggedIds.has(cam.id);
      const selected = cam.id === selectedId;
      const disabled = !cam.enabled;
      const bodyColor = flagged ? FLAGGED_BODY_COLOR : selected ? SELECTED_BODY_COLOR : DEFAULT_BODY_COLOR;
      const helperColor = flagged ? FLAGGED_HELPER_COLOR : selected ? SELECTED_HELPER_COLOR : DEFAULT_HELPER_COLOR;
      (body.material as THREE.MeshBasicMaterial).color.setHex(bodyColor);
      body.scale.setScalar(selected ? 1.4 : 1);
      (helper.material as THREE.LineBasicMaterial).color.setHex(helperColor);
      // Frustum wireframe follows selection alone (spec §5.3): only the selected
      // camera draws one — including a selected *disabled* camera — while every
      // other camera shows just its (state-colored) body.
      helper.visible = selected;
      (body.material as THREE.MeshBasicMaterial).opacity = disabled ? 0.3 : 1;
      (body.material as THREE.MeshBasicMaterial).transparent = disabled;
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
  }

  /** Nearest hit camera id, or null. */
  pick(raycaster: THREE.Raycaster): string | null {
    return this.pickHit(raycaster)?.id ?? null;
  }

  /**
   * Nearest hit camera id + its ray distance, or null. The distance lets a caller
   * pick the nearest hit across cameras and probes (spec §5.2, §12.4).
   */
  pickHit(raycaster: THREE.Raycaster): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null;
    for (const [id, entry] of this.entries) {
      const hits = raycaster.intersectObject(entry.body, false);
      if (hits.length > 0 && (!best || hits[0].distance < best.distance)) {
        best = { id, distance: hits[0].distance };
      }
    }
    return best;
  }

  getAttachTarget(id: string): THREE.Object3D | undefined {
    return this.entries.get(id)?.camObj;
  }

  /** Read back position/quaternion after a TransformControls drag. */
  readTransform(id: string): { position: [number, number, number]; rotation: [number, number, number, number] } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const p = entry.camObj.position;
    const q = entry.camObj.quaternion;
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
  }

  /** Immediately refresh a single helper's wireframe (e.g. during a live drag). */
  syncHelper(id: string): void {
    this.entries.get(id)?.helper.update();
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
  }

  private createEntry(id: string): GizmoEntry {
    const camObj = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50);
    camObj.name = id;

    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshBasicMaterial({ color: DEFAULT_BODY_COLOR }),
    );
    body.name = id;
    camObj.add(body);

    const helper = new THREE.CameraHelper(camObj);
    (helper.material as THREE.LineBasicMaterial).color.setHex(DEFAULT_HELPER_COLOR);
    (helper.material as THREE.LineBasicMaterial).transparent = true;
    (helper.material as THREE.LineBasicMaterial).opacity = 0.85;

    this.group.add(camObj);
    this.group.add(helper);
    return { camObj, body, helper };
  }

  private disposeEntry(entry: GizmoEntry): void {
    this.group.remove(entry.camObj);
    this.group.remove(entry.helper);
    entry.body.geometry.dispose();
    (entry.body.material as THREE.Material).dispose();
    entry.helper.dispose();
  }
}
