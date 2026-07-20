import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import { CameraGizmoSet } from '../src/scene/cameraGizmos.ts';

function cam(far: number): CameraConfig {
  return { id: 'cam-1', position: [0, 2, 0], rotation: [0, 0, 0, 1], fov: 60, far };
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
  gizmos.update([{ id: 'cam-2', position: [0, 0, 0], rotation: [0, 0, 0, 1], fov: 60 }], null);
  const attach = gizmos.getAttachTarget('cam-2') as THREE.PerspectiveCamera;
  assert.equal(attach.far, 50);
  gizmos.dispose();
});
