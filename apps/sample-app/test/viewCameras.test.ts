import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DEFAULT_VIEW,
  FIT_PADDING,
  VIEW_IDS,
  VIEW_LABELS,
  fallbackBounds,
  fitOrtho,
  isOrthographic,
  isUsableBounds,
  orbitEnabled,
  orthoFrustumForAspect,
  unionFiniteBounds,
  type ViewId,
} from '../src/scene/viewCameras.ts';

test('view metadata: perspective first, four labeled views, perspective default', () => {
  assert.deepEqual([...VIEW_IDS], ['perspective', 'top', 'front', 'right']);
  assert.equal(DEFAULT_VIEW, 'perspective');
  for (const v of VIEW_IDS) assert.equal(typeof VIEW_LABELS[v], 'string');
});

test('only ortho views are orthographic; only perspective allows orbit (spec §2.4)', () => {
  assert.equal(isOrthographic('perspective'), false);
  assert.equal(orbitEnabled('perspective'), true);
  for (const v of ['top', 'front', 'right'] as const) {
    assert.equal(isOrthographic(v), true);
    assert.equal(orbitEnabled(v), false, `${v} must be locked (pan+zoom only)`);
  }
});

// Bounds: a 20×6×20 room-ish box centered above the floor.
const MIN = new THREE.Vector3(-10, 0, -10);
const MAX = new THREE.Vector3(10, 6, 10);
const CENTER = new THREE.Vector3(0, 3, 0);

test('fitOrtho targets the bounds center and orients per the axis convention', () => {
  const expected: Record<Exclude<ViewId, 'perspective'>, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
    top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
    front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
    right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  };
  for (const view of ['top', 'front', 'right'] as const) {
    const fit = fitOrtho(view, MIN, MAX, 1.5);
    assert.ok(fit.target.distanceTo(CENTER) < 1e-9, `${view} target = center`);
    assert.deepEqual([fit.up.x, fit.up.y, fit.up.z], [expected[view].up.x, expected[view].up.y, expected[view].up.z]);
    // Camera sits along +dir from the center.
    const offset = fit.position.clone().sub(CENTER).normalize();
    assert.ok(offset.distanceTo(expected[view].dir) < 1e-9, `${view} camera along view axis`);
    assert.ok(fit.far > fit.near && fit.near > 0, 'valid near/far');
  }
});

test('fitOrtho frustum covers the padded bounds on both screen axes and matches aspect', () => {
  // Top view maps world X→width, Z→height; both extents are 20.
  const aspect = 2;
  const fit = fitOrtho('top', MIN, MAX, aspect);
  const dataHalf = (20 * FIT_PADDING) / 2;
  assert.ok(fit.halfWidth >= dataHalf - 1e-9, 'width covers padded X extent');
  assert.ok(fit.halfHeight >= dataHalf - 1e-9, 'height covers padded Z extent');
  assert.ok(Math.abs(fit.halfWidth / fit.halfHeight - aspect) < 1e-9, 'frustum matches aspect');
});

test('fitOrtho grows the limiting axis for a tall/narrow view (front, aspect<1)', () => {
  // Front maps X(20)→width, Y(6)→height. A narrow viewport (aspect 0.5) is
  // width-limited, so height must grow past the data extent to keep aspect.
  const aspect = 0.5;
  const fit = fitOrtho('front', MIN, MAX, aspect);
  const dataHalfW = (20 * FIT_PADDING) / 2;
  const dataHalfH = (6 * FIT_PADDING) / 2;
  assert.ok(fit.halfWidth >= dataHalfW - 1e-9, 'covers X');
  assert.ok(fit.halfHeight >= dataHalfH - 1e-9, 'covers Y');
  assert.ok(Math.abs(fit.halfWidth / fit.halfHeight - aspect) < 1e-9, 'matches aspect');
});

test('orthoFrustumForAspect preserves half-height and derives width from aspect', () => {
  const f = orthoFrustumForAspect(11.2, 1.6);
  assert.equal(f.top, 11.2);
  assert.equal(f.bottom, -11.2);
  assert.ok(Math.abs(f.right - 11.2 * 1.6) < 1e-9);
  assert.equal(f.left, -f.right);
});

test('degenerate aspect falls back to 1 rather than producing NaN/inf', () => {
  const f = orthoFrustumForAspect(10, 0);
  assert.ok(Number.isFinite(f.right) && f.right > 0);
  const fit = fitOrtho('top', MIN, MAX, Number.NaN);
  assert.ok(Number.isFinite(fit.halfWidth) && Number.isFinite(fit.halfHeight));
});

test('fallbackBounds is a finite non-empty box around the grid/room', () => {
  const { min, max } = fallbackBounds();
  assert.ok(max.x > min.x && max.y > min.y && max.z > min.z);
});

test('isUsableBounds rejects empty and non-finite boxes', () => {
  assert.equal(isUsableBounds(new THREE.Box3()), false, 'default box is empty');
  const finite = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  assert.equal(isUsableBounds(finite), true);
  // Non-finite (an InstancedMesh with no instances yields ±Infinity extents).
  const inf = new THREE.Box3(new THREE.Vector3(Infinity, Infinity, Infinity), new THREE.Vector3(-Infinity, -Infinity, -Infinity));
  assert.equal(isUsableBounds(inf), false);
  const nan = new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1));
  assert.equal(isUsableBounds(nan), false);
});

test('unionFiniteBounds unions only the usable boxes, ignoring degenerate ones', () => {
  const room = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 6, 10));
  const emptyOverlay = new THREE.Box3(); // e.g. InstancedMesh, no instances
  const gizmo = new THREE.Box3(new THREE.Vector3(-11, 0, -11), new THREE.Vector3(12, 3, 8));
  const target = new THREE.Box3();
  const any = unionFiniteBounds(target, [emptyOverlay, room, gizmo]);
  assert.equal(any, true);
  // Union of only room + gizmo (empty box skipped, not expanding to origin).
  assert.deepEqual([target.min.x, target.min.y, target.min.z], [-11, 0, -11]);
  assert.deepEqual([target.max.x, target.max.y, target.max.z], [12, 6, 10]);
});

test('unionFiniteBounds reports no contribution when every box is degenerate', () => {
  const target = new THREE.Box3();
  const inf = new THREE.Box3(new THREE.Vector3(Infinity, Infinity, Infinity), new THREE.Vector3(-Infinity, -Infinity, -Infinity));
  assert.equal(unionFiniteBounds(target, [new THREE.Box3(), inf]), false);
});
