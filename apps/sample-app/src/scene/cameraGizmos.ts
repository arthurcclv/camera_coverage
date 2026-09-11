/**
 * Per-camera frustum gizmos (spec §5.3): a THREE.CameraHelper wireframe
 * reflecting fov/aspect/far, plus a small clickable body for selection and as
 * the TransformControls attach target.
 *
 * The keyed entry map, reconcile loop, pickHit, getAttachTarget, and dispose are
 * the shared `PickableGizmoSet` spine; this file owns the camera entry shape and
 * its per-frame update.
 */
import * as THREE from 'three';
import type { SceneCamera } from '../cameras/camera.ts';
import { PickableGizmoSet } from './gizmoSet.ts';

interface GizmoEntry {
  camObj: THREE.PerspectiveCamera; // attach target: position/quaternion == CameraConfig
  body: THREE.Mesh;
  helper: THREE.CameraHelper;
}

/**
 * The two ids every camera-visibility decision needs: which camera is selected, and
 * which is being rendered *through* (the Selected view, spec §2.4.1).
 *
 * One object rather than two adjacent `string | null` parameters — they travel
 * together through the gizmo set, the label layer, and `cameraBodyVisible`, and as
 * positional arguments they swap silently with no type error.
 */
export interface CameraFocus {
  selectedId: string | null;
  suppressedId: string | null;
}

/**
 * Whether a camera draws in the viewport at all (spec §5.3, §2.4.3): a disabled
 * camera draws nothing unless it is the selection — the one moment it is on screen —
 * and the camera being rendered *through* draws nothing at all (§2.4.1).
 *
 * Exported because the **name label** layer (`cameraLabels.ts`) must appear and
 * disappear with the body it names, and it lives in a different scene. One predicate
 * rather than two copies of the condition, for the same reason `statsDisplay.ts`
 * derives the coverage numbers once.
 */
export function cameraBodyVisible(camera: { id: string; enabled: boolean }, focus: CameraFocus): boolean {
  if (camera.id === focus.suppressedId) return false;
  return camera.enabled || camera.id === focus.selectedId;
}

/**
 * The camera body's world radius in metres, and the factor the **selected** body is
 * scaled by. Exported because the name labels sit beside that body and have to clear
 * its *projected* size to do it (spec §5.3, `cameraLabels.ts`) — the gap is 4 screen
 * pixels from the body, not from its centre, and a body a metre from the eye covers a
 * lot more than 4 px.
 */
export const CAMERA_BODY_RADIUS = 0.22;
export const SELECTED_BODY_SCALE = 1.4;

/** The body radius `focus` implies for one camera, in metres (the selected one is bigger). */
export function cameraBodyRadius(id: string, focus: CameraFocus): number {
  return id === focus.selectedId ? CAMERA_BODY_RADIUS * SELECTED_BODY_SCALE : CAMERA_BODY_RADIUS;
}

const DEFAULT_BODY_COLOR = 0x5da9e0;
const SELECTED_BODY_COLOR = 0xffd23f;
const FLAGGED_BODY_COLOR = 0xe0524f;
const DEFAULT_HELPER_COLOR = 0x7fb8e6;
const SELECTED_HELPER_COLOR = 0xffd23f;
const FLAGGED_HELPER_COLOR = 0xe0524f;

export class CameraGizmoSet extends PickableGizmoSet<GizmoEntry> {
  /**
   * @param suppressedId A camera to draw **nothing** for — neither body nor
   *   frustum. Set while the viewport renders *through* that camera in the
   *   Selected view (spec §2.4.1, §5.3): both are degenerate at the eye point,
   *   the frustum's edges projecting onto the image borders. Every other camera
   *   still draws normally.
   */
  update(
    cameras: SceneCamera[],
    selectedId: string | null,
    flaggedIds: ReadonlySet<string> = new Set(),
    suppressedId: string | null = null,
  ): void {
    const focus: CameraFocus = { selectedId, suppressedId };
    this.reconcile(cameras, (entry, cam) => {
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
      // Rendering through this camera: hide its body (a child of camObj) and its
      // frustum outright (spec §2.4.1, §5.3). Still coloured/scaled below so the
      // state is already correct when the view is left.
      const suppressed = cam.id === suppressedId;
      // Shared with the name-label layer, which must hide with the body it names
      // (spec §5.3). Colour/scale below still run for a hidden camera, so its state
      // is already correct when it is shown again.
      camObj.visible = cameraBodyVisible(cam, focus);
      const bodyColor = flagged ? FLAGGED_BODY_COLOR : selected ? SELECTED_BODY_COLOR : DEFAULT_BODY_COLOR;
      const helperColor = flagged ? FLAGGED_HELPER_COLOR : selected ? SELECTED_HELPER_COLOR : DEFAULT_HELPER_COLOR;
      (body.material as THREE.MeshBasicMaterial).color.setHex(bodyColor);
      body.scale.setScalar(selected ? SELECTED_BODY_SCALE : 1);
      (helper.material as THREE.LineBasicMaterial).color.setHex(helperColor);
      // Frustum wireframe follows selection alone (spec §5.3): only the selected
      // camera draws one — including a selected *disabled* camera — while every
      // other camera shows just its (state-colored) body. The one exception is
      // the camera being rendered through (spec §2.4.1).
      helper.visible = selected && !suppressed;
      (body.material as THREE.MeshBasicMaterial).opacity = disabled ? 0.3 : 1;
      (body.material as THREE.MeshBasicMaterial).transparent = disabled;
    });
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

  protected attachTargetOf(entry: GizmoEntry): THREE.Object3D {
    return entry.camObj;
  }

  protected pickTargetOf(entry: GizmoEntry): THREE.Object3D {
    return entry.body;
  }

  protected createEntry(id: string): GizmoEntry {
    const camObj = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50);
    camObj.name = id;

    const body = new THREE.Mesh(
      new THREE.SphereGeometry(CAMERA_BODY_RADIUS, 16, 12),
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

  protected disposeEntry(entry: GizmoEntry): void {
    this.group.remove(entry.camObj);
    this.group.remove(entry.helper);
    entry.body.geometry.dispose();
    (entry.body.material as THREE.Material).dispose();
    entry.helper.dispose();
  }
}
