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
