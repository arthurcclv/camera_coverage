import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { SceneCamera } from '../src/cameras/camera.ts';
import { CameraGizmoSet } from '../src/scene/cameraGizmos.ts';

function cam(far: number): SceneCamera {
  return { id: 'cam-1', name: '', enabled: true, position: [0, 2, 0], rotation: [0, 0, 0, 1], fov: 60, far };
}

test('editing far live-resizes the frustum gizmo (spec §5.2, §5.3)', () => {
  const gizmos = new CameraGizmoSet();
  gizmos.update([cam(30)], null);
  const attach = gizmos.getAttachTarget('cam-1') as THREE.PerspectiveCamera;
  assert.equal(attach.far, 30);

  const helper = gizmos.group.children.find(
    (c): c is THREE.CameraHelper => c instanceof THREE.CameraHelper,
  )!;
  const before = (helper.geometry.getAttribute('position').array as Float32Array).slice();

  gizmos.update([cam(80)], null);
  assert.equal(attach.far, 80);
  const after = helper.geometry.getAttribute('position').array as Float32Array;

  assert.notDeepEqual(Array.from(before), Array.from(after));
  gizmos.dispose();
});

test('far defaults to 50 when omitted from CameraConfig', () => {
  const gizmos = new CameraGizmoSet();
  gizmos.update([{ id: 'cam-2', name: '', enabled: true, position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 }], null);
  const attach = gizmos.getAttachTarget('cam-2') as THREE.PerspectiveCamera;
  assert.equal(attach.far, 50);
  gizmos.dispose();
});

/** The frustum wireframe for the camera whose id matches (via CameraHelper.camera.name). */
function helperFor(gizmos: CameraGizmoSet, id: string): THREE.CameraHelper {
  return gizmos.group.children.find(
    (c): c is THREE.CameraHelper => c instanceof THREE.CameraHelper && (c.camera as THREE.Camera).name === id,
  )!;
}

function bodyFor(gizmos: CameraGizmoSet, id: string): THREE.Mesh {
  return gizmos.getAttachTarget(id)!.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
}

test('only the selected camera renders a frustum wireframe (spec §5.3)', () => {
  const gizmos = new CameraGizmoSet();
  const a: SceneCamera = { ...cam(30), id: 'cam-a' };
  const b: SceneCamera = { ...cam(30), id: 'cam-b' };

  // Nothing selected → no frustums anywhere, just the body dots.
  gizmos.update([a, b], null);
  assert.equal(helperFor(gizmos, 'cam-a').visible, false);
  assert.equal(helperFor(gizmos, 'cam-b').visible, false);

  // Selecting cam-a reveals only its frustum.
  gizmos.update([a, b], 'cam-a');
  assert.equal(helperFor(gizmos, 'cam-a').visible, true);
  assert.equal(helperFor(gizmos, 'cam-b').visible, false);
  gizmos.dispose();
});

test('frustum follows selection, not enabled: a selected disabled camera still shows its frustum (spec §5.3, §5.4)', () => {
  const gizmos = new CameraGizmoSet();
  const disabled: SceneCamera = { ...cam(30), enabled: false };

  // Disabled + not selected: no frustum, body dimmed.
  gizmos.update([disabled], null);
  assert.equal(helperFor(gizmos, 'cam-1').visible, false);
  assert.equal((bodyFor(gizmos, 'cam-1').material as THREE.MeshBasicMaterial).opacity, 0.3);

  // Disabled + selected: frustum revealed, body stays dimmed to signal disabled.
  gizmos.update([disabled], 'cam-1');
  assert.equal(helperFor(gizmos, 'cam-1').visible, true);
  assert.equal((bodyFor(gizmos, 'cam-1').material as THREE.MeshBasicMaterial).opacity, 0.3);
  gizmos.dispose();
});

test('a flagged but non-selected camera shows no frustum (spec §5.3)', () => {
  const gizmos = new CameraGizmoSet();
  gizmos.update([cam(30)], null, new Set(['cam-1']));
  const helper = helperFor(gizmos, 'cam-1');
  assert.equal(helper.visible, false);
  // The red body carries the "inside geometry" warning.
  assert.equal((bodyFor(gizmos, 'cam-1').material as THREE.MeshBasicMaterial).color.getHex(), 0xe0524f);
  gizmos.dispose();
});

test('the camera being rendered through draws neither body nor frustum (spec §2.4.1, §5.3)', () => {
  const gizmos = new CameraGizmoSet();
  const a: SceneCamera = { id: 'cam-1', name: '', enabled: true, position: [0, 2, 0], rotation: [0, 0, 0, 1], fov: 60 };
  const b: SceneCamera = { id: 'cam-2', name: '', enabled: true, position: [3, 2, 0], rotation: [0, 0, 0, 1], fov: 60 };

  // Selected but not rendered through: body + frustum both draw (§5.3).
  gizmos.update([a, b], 'cam-1');
  assert.equal(gizmos.getAttachTarget('cam-1')!.visible, true);
  assert.equal(helperFor(gizmos, 'cam-1').visible, true);

  // Entering the Selected view on cam-1 hides its own body and frustum...
  gizmos.update([a, b], 'cam-1', new Set(), 'cam-1');
  assert.equal(gizmos.getAttachTarget('cam-1')!.visible, false, 'own body hidden at the eye point');
  assert.equal(helperFor(gizmos, 'cam-1').visible, false, 'own frustum hidden at the eye point');
  // ...while every other camera keeps drawing normally.
  assert.equal(gizmos.getAttachTarget('cam-2')!.visible, true, 'other cameras stay visible');
  assert.equal(bodyFor(gizmos, 'cam-2').visible, true);

  // Leaving the view restores it, with its selected colour/scale intact.
  gizmos.update([a, b], 'cam-1');
  assert.equal(gizmos.getAttachTarget('cam-1')!.visible, true);
  assert.equal(helperFor(gizmos, 'cam-1').visible, true);
  assert.equal(gizmos.getAttachTarget('cam-1')!.children.find((c) => c instanceof THREE.Mesh)!.scale.x, 1.4);
  gizmos.dispose();
});

test('suppression is independent of selection and enabled state (spec §2.4.1)', () => {
  const gizmos = new CameraGizmoSet();
  const disabled: SceneCamera = { id: 'cam-9', name: '', enabled: false, position: [0, 2, 0], rotation: [0, 0, 0, 1], fov: 60 };
  // A *disabled* camera may be rendered through — it still has a pose and FOV.
  gizmos.update([disabled], 'cam-9', new Set(), 'cam-9');
  assert.equal(gizmos.getAttachTarget('cam-9')!.visible, false);
  assert.equal(helperFor(gizmos, 'cam-9').visible, false);

  // Suppressing a camera that isn't the selected one hides only that one.
  const other: SceneCamera = { ...disabled, id: 'cam-8', enabled: true };
  gizmos.update([disabled, other], 'cam-9', new Set(), 'cam-8');
  assert.equal(gizmos.getAttachTarget('cam-8')!.visible, false);
  assert.equal(gizmos.getAttachTarget('cam-9')!.visible, true);
  assert.equal(helperFor(gizmos, 'cam-9').visible, true, 'selected elsewhere still draws its frustum');
  gizmos.dispose();
});

// --- Disabled cameras are hidden (spec §2.4.3) ------------------------------

/** The `PerspectiveCamera` a camera's body hangs under, by id. */
function camObjFor(gizmos: CameraGizmoSet, id: string): THREE.PerspectiveCamera {
  return gizmos.getAttachTarget(id) as THREE.PerspectiveCamera;
}

test('a disabled camera draws nothing, and returns as the selection (spec §2.4.3)', () => {
  const gizmos = new CameraGizmoSet();
  const off: SceneCamera = { ...cam(30), enabled: false };

  gizmos.update([off], null);
  assert.equal(camObjFor(gizmos, 'cam-1').visible, false, 'disabled and unselected: gone');

  // Selection is the one exception — it is what keeps a disabled camera editable
  // without re-ticking its box first, so TransformControls has a visible target.
  gizmos.update([off], 'cam-1');
  const camObj = camObjFor(gizmos, 'cam-1');
  assert.equal(camObj.visible, true, 'disabled and selected: back');
  const body = camObj.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
  assert.equal((body.material as THREE.MeshBasicMaterial).opacity, 0.3, 'at the selected-disabled tier');
  assert.equal(helperFor(gizmos, 'cam-1').visible, true, 'frustum follows selection, disabled or not');

  // Deselecting puts it away again.
  gizmos.update([off], null);
  assert.equal(camObjFor(gizmos, 'cam-1').visible, false);

  gizmos.dispose();
});

test('an enabled camera draws opaque whether or not it is selected (spec §2.4.3)', () => {
  const gizmos = new CameraGizmoSet();

  gizmos.update([cam(30)], null);
  const camObj = camObjFor(gizmos, 'cam-1');
  const body = camObj.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
  assert.equal(camObj.visible, true);
  assert.equal((body.material as THREE.MeshBasicMaterial).opacity, 1);

  gizmos.update([cam(30)], 'cam-1');
  assert.equal(camObj.visible, true);
  assert.equal((body.material as THREE.MeshBasicMaterial).opacity, 1);

  gizmos.dispose();
});
