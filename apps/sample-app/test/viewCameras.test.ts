import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CAMERA_VIEW_PADDING,
  DEFAULT_VIEW,
  FIT_PADDING,
  PERSPECTIVE_FAR,
  PERSPECTIVE_NEAR,
  VIEW_IDS,
  VIEW_LABELS,
  fallbackBounds,
  fitCameraView,
  fitOrtho,
  fitPerspective,
  flyNavigation,
  isOrthographic,
  isUsableBounds,
  navigationEnabled,
  orbitEnabled,
  orthoFrustumForAspect,
  unionFiniteBounds,
  type OrthoViewId,
} from '../src/scene/viewCameras.ts';

test('view metadata: perspective first, Selected last, five labeled views (spec §2.4)', () => {
  assert.deepEqual([...VIEW_IDS], ['perspective', 'top', 'front', 'right', 'camera']);
  assert.equal(DEFAULT_VIEW, 'perspective');
  for (const v of VIEW_IDS) assert.equal(typeof VIEW_LABELS[v], 'string');
  // The camera view is labeled "Selected" — never the camera's name, and never a
  // label carrying the reserved word "Camera" (spec §2.4).
  assert.equal(VIEW_LABELS.camera, 'Selected');
  for (const v of VIEW_IDS) assert.ok(!/camera/i.test(VIEW_LABELS[v]), `${v} label must not say "Camera"`);
});

test('only ortho views are orthographic; only perspective allows orbit (spec §2.4)', () => {
  assert.equal(isOrthographic('perspective'), false);
  assert.equal(orbitEnabled('perspective'), true);
  for (const v of ['top', 'front', 'right'] as const) {
    assert.equal(isOrthographic(v), true);
    assert.equal(orbitEnabled(v), false, `${v} must be locked (pan+zoom only)`);
  }
});

test('the camera view is perspective, not ortho, and has no navigation (spec §2.4.1)', () => {
  // The regression this guards: `isOrthographic` was once `!== 'perspective'`,
  // which would misreport the camera view as an orthographic elevation.
  assert.equal(isOrthographic('camera'), false);
  assert.equal(orbitEnabled('camera'), false);
  // Orbit, pan, and zoom are all off — a drag aims the camera instead (§5.2).
  assert.equal(navigationEnabled('camera'), false);
  for (const v of ['perspective', 'top', 'front', 'right'] as const) {
    assert.equal(navigationEnabled(v), true, `${v} keeps orbit-control navigation`);
  }
});

test('only the perspective view flies (`navigation.md` §7)', () => {
  // The wheel and the middle drag are ours in Perspective only; the three
  // elevations keep OrbitControls' frustum zoom, and the Selected view neither.
  assert.equal(flyNavigation('perspective'), true);
  for (const v of ['top', 'front', 'right', 'camera'] as const) {
    assert.equal(flyNavigation(v), false, `${v} must keep OrbitControls' own zoom`);
  }
  // Not the same predicate as orbit, even though they agree on today's five
  // views: the elevations refuse rotation while keeping the wheel.
  for (const v of VIEW_IDS) assert.equal(flyNavigation(v), orbitEnabled(v));
});

test('perspective clip planes are a valid range reaching well past the room (spec §2.4)', () => {
  assert.ok(PERSPECTIVE_NEAR > 0, 'near must be positive');
  assert.ok(PERSPECTIVE_FAR > PERSPECTIVE_NEAR, 'far beyond near');
  // The default room is ~24 units across; the far plane must not be the limit.
  assert.ok(PERSPECTIVE_FAR >= 1000, 'far reaches past any plausible imported scene');
});

// Bounds: a 20×6×20 room-ish box centered above the floor.
const MIN = new THREE.Vector3(-10, 0, -10);
const MAX = new THREE.Vector3(10, 6, 10);
const CENTER = new THREE.Vector3(0, 3, 0);

test('fitOrtho targets the bounds center and orients per the axis convention', () => {
  const expected: Record<OrthoViewId, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
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

// --- fitCameraView: the Selected view's framing (spec §2.4.1) ----------------

const CAM_FOV = 60;
const CAM_ASPECT = 16 / 9;

/** Half-extents at unit distance, the space fitCameraView reasons in. */
function halfExtents(fov: number, aspect: number): { w: number; h: number } {
  const h = Math.tan((fov * Math.PI) / 360);
  return { w: h * aspect, h };
}

test('fitCameraView always contains the camera image, whatever the viewport shape', () => {
  const cam = halfExtents(CAM_FOV, CAM_ASPECT);
  // Wide, square, and tall viewports — the guide must fit inside all three.
  for (const viewportAspect of [21 / 9, 16 / 9, 4 / 3, 1, 3 / 4]) {
    const fit = fitCameraView(CAM_FOV, CAM_ASPECT, viewportAspect);
    assert.ok(fit.renderFov >= CAM_FOV, `renderFov must never crop (aspect ${viewportAspect})`);
    assert.ok(fit.guide.widthFrac > 0 && fit.guide.widthFrac <= 1, `guide width in range (${viewportAspect})`);
    assert.ok(fit.guide.heightFrac > 0 && fit.guide.heightFrac <= 1, `guide height in range (${viewportAspect})`);

    // The guide's fractions must describe the camera's true image in the
    // rendered frustum: guideFrac * renderHalfExtent === camHalfExtent.
    const render = halfExtents(fit.renderFov, viewportAspect);
    assert.ok(Math.abs(fit.guide.heightFrac * render.h - cam.h) < 1e-12, `height maps to cam FOV (${viewportAspect})`);
    assert.ok(Math.abs(fit.guide.widthFrac * render.w - cam.w) < 1e-12, `width maps to cam FOV (${viewportAspect})`);
  }
});

test('fitCameraView leaves padding on all sides, binding axis at exactly 1/padding', () => {
  // Viewport wider than the camera → height binds; taller → width binds.
  const wide = fitCameraView(CAM_FOV, CAM_ASPECT, 21 / 9);
  assert.ok(Math.abs(wide.guide.heightFrac - 1 / CAMERA_VIEW_PADDING) < 1e-12, 'height binds on a wide viewport');
  assert.ok(wide.guide.widthFrac < wide.guide.heightFrac, 'wide viewport pads the sides more');

  const tall = fitCameraView(CAM_FOV, CAM_ASPECT, 3 / 4);
  assert.ok(Math.abs(tall.guide.widthFrac - 1 / CAMERA_VIEW_PADDING) < 1e-12, 'width binds on a tall viewport');
  assert.ok(tall.guide.heightFrac < tall.guide.widthFrac, 'tall viewport pads top/bottom more');

  // Padding is real on every axis: the guide never reaches the canvas edge.
  for (const fit of [wide, tall]) {
    assert.ok(fit.guide.widthFrac < 1, 'context band on the sides');
    assert.ok(fit.guide.heightFrac < 1, 'context band top/bottom');
  }
});

test('fitCameraView matches aspects exactly when viewport and camera agree', () => {
  const fit = fitCameraView(CAM_FOV, CAM_ASPECT, CAM_ASPECT);
  // Both axes bind at once; the guide is a uniform inset.
  assert.ok(Math.abs(fit.guide.widthFrac - 1 / CAMERA_VIEW_PADDING) < 1e-12);
  assert.ok(Math.abs(fit.guide.heightFrac - 1 / CAMERA_VIEW_PADDING) < 1e-12);
  // The rendered FOV is the camera's, widened by the padding — not equal to it.
  assert.ok(fit.renderFov > CAM_FOV);
});

test('fitCameraView survives a degenerate aspect (pre-layout container)', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const fit = fitCameraView(CAM_FOV, CAM_ASPECT, bad);
    assert.ok(Number.isFinite(fit.renderFov) && fit.renderFov > 0, `renderFov finite for aspect ${bad}`);
    assert.ok(Number.isFinite(fit.guide.widthFrac) && fit.guide.widthFrac > 0, `guide finite for aspect ${bad}`);
    assert.ok(Number.isFinite(fit.guide.heightFrac) && fit.guide.heightFrac > 0);
  }
  // A degenerate camera aspect falls back to square rather than producing NaN.
  const fit = fitCameraView(CAM_FOV, 0, 16 / 9);
  assert.ok(Number.isFinite(fit.renderFov) && fit.renderFov > 0);
});

// --- fitPerspective: the Reset view button (spec §2.4) ------------------------

/** The real workspace, as the scale the room-sized startup pose fails at. */
const SITE_MIN = new THREE.Vector3(0, 0, 0);
const SITE_MAX = new THREE.Vector3(440, 201, 1120);

/** Every corner of a box, for checking it is really inside a frustum. */
function corners(min: THREE.Vector3, max: THREE.Vector3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    out.push(new THREE.Vector3(x, y, z));
  }
  return out;
}

test('fitPerspective targets the bounds center and preserves the viewing direction', () => {
  const dir = new THREE.Vector3(0.3, -0.8, 0.5).normalize();
  const fit = fitPerspective(SITE_MIN, SITE_MAX, dir, 55, 16 / 9);

  const center = new THREE.Vector3().addVectors(SITE_MIN, SITE_MAX).multiplyScalar(0.5);
  assert.ok(fit.target.distanceTo(center) < 1e-9);
  // The camera sits back along its own forward vector, so looking at the target
  // leaves the orientation exactly as it was — the button frames the scene, it
  // does not undo the user's orientation (spec §2.4).
  const forward = new THREE.Vector3().subVectors(fit.target, fit.position).normalize();
  assert.ok(forward.distanceTo(dir) < 1e-9);
});

test('fitPerspective frames the whole scene, at any scale and any aspect', () => {
  const dir = new THREE.Vector3(-0.4, -0.7, -0.6).normalize();
  for (const aspect of [0.5, 1, 16 / 9, 3]) {
    for (const [min, max] of [
      [SITE_MIN, SITE_MAX],
      [new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 6, 12)],
    ] as const) {
      const fit = fitPerspective(min, max, dir, 55, aspect);
      const cam = new THREE.PerspectiveCamera(55, aspect, PERSPECTIVE_NEAR, PERSPECTIVE_FAR);
      cam.position.copy(fit.position);
      cam.lookAt(fit.target);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      );
      for (const corner of corners(min, max)) {
        assert.ok(frustum.containsPoint(corner), `aspect ${aspect}: corner ${corner.toArray()} outside`);
      }
    }
  }
});

test('fitPerspective distance is independent of viewing direction', () => {
  // A bounding *sphere* is fitted, not the box: fitting the box would make the
  // same reset land at a different distance from every angle.
  const center = new THREE.Vector3().addVectors(SITE_MIN, SITE_MAX).multiplyScalar(0.5);
  const distances = [
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-0.5, -0.5, 0.7).normalize(),
  ].map((d) => fitPerspective(SITE_MIN, SITE_MAX, d, 55, 16 / 9).position.distanceTo(center));
  for (const d of distances) assert.ok(Math.abs(d - distances[0]) < 1e-9);
});

test('fitPerspective scales the padding with the bounds', () => {
  const dir = new THREE.Vector3(0, -1, 0);
  const center = new THREE.Vector3().addVectors(SITE_MIN, SITE_MAX).multiplyScalar(0.5);
  const near = fitPerspective(SITE_MIN, SITE_MAX, dir, 55, 1).position.distanceTo(center);
  const wide = fitPerspective(SITE_MIN, SITE_MAX, dir, 20, 1).position.distanceTo(center);
  // A narrower FOV must pull the camera further back to hold the same bounds.
  assert.ok(wide > near);
  assert.ok(near > (SITE_MAX.distanceTo(SITE_MIN) / 2) * FIT_PADDING);
});

test('fitPerspective survives a degenerate direction and a bad aspect', () => {
  const fit = fitPerspective(SITE_MIN, SITE_MAX, new THREE.Vector3(0, 0, 0), 55, Number.NaN);
  assert.ok(Number.isFinite(fit.position.x));
  assert.ok(Number.isFinite(fit.position.y));
  assert.ok(Number.isFinite(fit.position.z));
  assert.ok(fit.position.distanceTo(fit.target) > 0);
});
