import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  FALLBACK_REF_FRACTION,
  MAX_REF_DIAGONALS,
  MIDDLE_DRAG_GAIN,
  MIN_STEP_METERS,
  SPEED_MULTIPLIERS,
  STEP_FRACTION,
  dampStep,
  groundHitDistance,
  groundRefDistance,
  middleDragStep,
  pivotAlongView,
  sceneDiagonal,
  speedModifierOf,
  speedMultiplier,
  viewportNdc,
  wheelAxisDelta,
  wheelNotches,
  wheelStep,
} from '../src/scene/navigation.ts';

/** The real workspace (`ai/` notes: 440 x 201 x 1120 m), as the scale that broke the old model. */
const SITE = { min: { x: 0, y: 0, z: 0 }, max: { x: 440, y: 201, z: 1120 } };
const SITE_DIAGONAL = sceneDiagonal(SITE.min, SITE.max);

const down = { x: 0, y: -1, z: 0 };
const up = { x: 0, y: 1, z: 0 };

test('sceneDiagonal is the bounding box diagonal', () => {
  assert.equal(sceneDiagonal({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.ok(Math.abs(SITE_DIAGONAL - Math.hypot(440, 201, 1120)) < 1e-9);
});

test('groundHitDistance measures to y = 0 along the ray', () => {
  assert.equal(groundHitDistance({ x: 0, y: 10, z: 0 }, down), 10);
  // 45 degrees down: the hypotenuse, not the height.
  const diag = { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 };
  assert.ok(Math.abs(groundHitDistance({ x: 0, y: 10, z: 0 }, diag)! - 10 * Math.SQRT2) < 1e-9);
});

test('groundHitDistance rejects rays that never usefully meet the ground', () => {
  // Parallel to the plane.
  assert.equal(groundHitDistance({ x: 0, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }), null);
  // Above the ground looking up — the intersection is behind the camera.
  assert.equal(groundHitDistance({ x: 0, y: 10, z: 0 }, up), null);
  // Below the ground looking down — likewise behind. Flying under the floor is
  // allowed (there is no travel limit), so this case is reachable.
  assert.equal(groundHitDistance({ x: 0, y: -5, z: 0 }, down), null);
});

test('groundRefDistance clamps a grazing ray to 3x the diagonal', () => {
  // A ray a hair off horizontal meets the ground enormously far away; unclamped,
  // a one-pixel drag would fling the camera across the workspace.
  const grazing = { x: 1, y: -1e-6, z: 0 };
  const raw = groundHitDistance({ x: 0, y: 10, z: 0 }, grazing)!;
  assert.ok(raw > MAX_REF_DIAGONALS * SITE_DIAGONAL);
  assert.equal(
    groundRefDistance({ x: 0, y: 10, z: 0 }, grazing, SITE_DIAGONAL),
    MAX_REF_DIAGONALS * SITE_DIAGONAL,
  );
});

test('groundRefDistance falls back to a fraction of the diagonal with no hit', () => {
  const expected = FALLBACK_REF_FRACTION * SITE_DIAGONAL;
  assert.equal(groundRefDistance({ x: 0, y: 10, z: 0 }, up, SITE_DIAGONAL), expected);
  assert.equal(
    groundRefDistance({ x: 0, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, SITE_DIAGONAL),
    expected,
  );
});

test('wheelStep is a fraction of the reference distance, floored', () => {
  assert.equal(wheelStep(100), STEP_FRACTION * 100);
  // Close to the ground the fraction underruns the floor.
  assert.equal(wheelStep(0.1), MIN_STEP_METERS);
});

test('wheelStep modifiers scale the floored step, so Alt still slows a floored one', () => {
  assert.equal(wheelStep(100, 'fast'), STEP_FRACTION * 100 * speedMultiplier('fast'));
  assert.equal(wheelStep(0.1, 'slow'), MIN_STEP_METERS * speedMultiplier('slow'));
  assert.ok(wheelStep(0.1, 'slow') < wheelStep(0.1));
});

test('forward travel never stalls: the camera reaches and passes the ground', () => {
  // The defect this replaces: OrbitControls multiplies the camera-to-pivot
  // distance by a constant, so the camera converges on the pivot and never
  // arrives. Here the floor guarantees progress through y = 0 in finite notches.
  let y = 10;
  let notches = 0;
  while (y > 0 && notches < 10_000) {
    y -= wheelStep(groundRefDistance({ x: 0, y, z: 0 }, down, SITE_DIAGONAL));
    notches += 1;
  }
  assert.ok(y <= 0, 'camera must pass through the ground plane');
  assert.ok(notches < 10_000, `expected finite notches, took ${notches}`);
});

test('travel is unbounded upward too', () => {
  let y = 10;
  for (let i = 0; i < 200; i += 1) {
    y += wheelStep(groundRefDistance({ x: 0, y, z: 0 }, down, SITE_DIAGONAL));
  }
  // Nothing clamps distance from the scene (`navigation.md` §5), so 200 notches
  // put the camera far outside a 1220 m site.
  assert.ok(y > 10 * SITE_DIAGONAL, `expected unbounded retreat, reached ${y}`);
});

test('the reference distance no longer collapses as the camera navigates', () => {
  // The second defect (§1): pan is scaled by the camera-to-pivot distance, and
  // the dolly was driving that to zero. The pivot's distance is now the ground
  // distance, which a camera at a fixed height does not change by orbiting or
  // panning at all — so OrbitControls' own 1:1 pan rate stops shrinking.
  const atStart = groundRefDistance({ x: 0, y: 30, z: 0 }, down, SITE_DIAGONAL);
  const afterPanning = groundRefDistance({ x: 500, y: 30, z: 900 }, down, SITE_DIAGONAL);
  assert.equal(atStart, afterPanning);
  // And unlike the old pivot distance, it does not shrink toward zero as the
  // camera flies forward over open ground — only as it descends.
  assert.ok(groundRefDistance({ x: 0, y: 3, z: 0 }, down, SITE_DIAGONAL) < atStart);
});

test('middleDragStep flies forward on an upward drag', () => {
  // Screen Y grows downward, so a negative delta is an upward drag.
  assert.ok(middleDragStep(-100, 50, 800) > 0);
  assert.ok(middleDragStep(100, 50, 800) < 0);
  assert.ok(Math.abs(middleDragStep(0, 50, 800)) === 0); // -0 is fine, sign is not
  // Proportional to the reference distance, like the wheel.
  assert.equal(middleDragStep(-100, 100, 800), 2 * middleDragStep(-100, 50, 800));
});

test('a full-height middle drag travels twice the reference distance', () => {
  // `navigation.md` §4.2 pins the gain: step = 2 x dRef x (pixels up / height).
  assert.equal(MIDDLE_DRAG_GAIN, 2);
  assert.equal(middleDragStep(-800, 120, 800), 2 * 120);
  assert.equal(middleDragStep(-400, 120, 800), 120);
});

test('middleDragStep tolerates a zero-height viewport', () => {
  assert.equal(middleDragStep(-100, 50, 0), 0);
});

test('wheelNotches normalises deltaMode', () => {
  assert.equal(wheelNotches(100, 0), 1); // Chrome: one notch is 100 px
  assert.equal(wheelNotches(-100, 0), -1);
  assert.equal(wheelNotches(3, 1), 3); // Firefox: lines
  assert.equal(wheelNotches(1, 2), 10); // pages
});

test('wheelAxisDelta falls back to the horizontal axis', () => {
  // Some browsers put a shift-modified wheel on deltaX, which is why Shift can
  // be a speed modifier at all (§4.6).
  assert.equal(wheelAxisDelta(0, -240), -240);
  assert.equal(wheelAxisDelta(100, 0), 100);
  // deltaY wins when both move: it is the intended axis.
  assert.equal(wheelAxisDelta(100, -240), 100);
  assert.equal(wheelAxisDelta(0, 0), 0);
});

test('speedModifierOf reads the held keys, and Shift beats Alt', () => {
  assert.equal(speedModifierOf({ shiftKey: false, altKey: false }), 'none');
  assert.equal(speedModifierOf({ shiftKey: true, altKey: false }), 'fast');
  assert.equal(speedModifierOf({ shiftKey: false, altKey: true }), 'slow');
  // Both down must resolve to one of them, never cancel back to 'none'.
  assert.equal(speedModifierOf({ shiftKey: true, altKey: true }), 'fast');
});

test('every speed modifier has a multiplier', () => {
  // The Record is the point (`ai/CONVENTIONS.md`): a modifier with no entry is a
  // compile error, where the old if/else chain silently gave it 1.
  for (const modifier of ['fast', 'slow', 'none'] as const) {
    assert.equal(typeof SPEED_MULTIPLIERS[modifier], 'number');
    assert.equal(speedMultiplier(modifier), SPEED_MULTIPLIERS[modifier]);
  }
  assert.equal(SPEED_MULTIPLIERS.none, 1);
  assert.ok(SPEED_MULTIPLIERS.fast > 1 && SPEED_MULTIPLIERS.slow < 1);
});

/** NDC pairs compare numerically: the y flip yields -0 at the exact centre. */
function assertNdc(actual: { x: number; y: number }, x: number, y: number): void {
  assert.equal(actual.x, x);
  assert.equal(actual.y + 0, y);
}

test('viewportNdc maps the canvas to -1..1 with y up', () => {
  const rect = { left: 40, top: 20, width: 800, height: 400 };
  assertNdc(viewportNdc(440, 220, rect), 0, 0); // centre
  assertNdc(viewportNdc(40, 20, rect), -1, 1); // top-left
  assertNdc(viewportNdc(840, 420, rect), 1, -1); // bottom-right
});

test('viewportNdc gives the centre for a null point or an unlaid-out canvas', () => {
  const rect = { left: 40, top: 20, width: 800, height: 400 };
  // An orbit and a middle drag have no cursor position that means anything (§3, §4.2).
  assertNdc(viewportNdc(null, null, rect), 0, 0);
  assertNdc(viewportNdc(440, null, rect), 0, 0);
  // A container measured before layout must not divide by zero.
  const ndc = viewportNdc(0, 0, { left: 0, top: 0, width: 0, height: 0 });
  assert.ok(Number.isFinite(ndc.x) && Number.isFinite(ndc.y));
});

test('dampStep eases toward the target and terminates', () => {
  const factor = 0.08;
  const first = dampStep(10, factor);
  assert.ok(Math.abs(first.apply - 0.8) < 1e-12);
  assert.ok(Math.abs(first.remaining - 9.2) < 1e-12);

  // It must actually finish rather than approach asymptotically — the same
  // failure this design removes, at a smaller scale.
  let pending = 10;
  let applied = 0;
  let frames = 0;
  while (pending !== 0 && frames < 10_000) {
    const step = dampStep(pending, factor);
    applied += step.apply;
    pending = step.remaining;
    frames += 1;
  }
  assert.equal(pending, 0);
  assert.ok(frames < 10_000, `expected settling, took ${frames} frames`);
  assert.ok(Math.abs(applied - 10) < 1e-9, `expected full travel, applied ${applied}`);
});

// --- The pivot (§3) ----------------------------------------------------------

test('pivotAlongView puts the pivot at the given distance along the ray', () => {
  const p = pivotAlongView({ x: 1, y: 2, z: 3 }, { x: 0, y: -1, z: 0 }, 10);
  assert.deepEqual(p, { x: 1, y: -8, z: 3 });
});

test('a pivot on the view axis leaves the camera orientation untouched', () => {
  // The regression: the Perspective view's remembered framing is its camera pose
  // alone (§3), so re-entering the view re-seats the pivot instead of restoring a
  // saved point. OrbitControls ends every update with lookAt(target), so the
  // pivot has to sit on the camera's own view axis or the orientation the user
  // left is thrown away — position kept, view yanked around to face the pivot.
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 10_000);
  // Flown far out over the site and tilted, the way §5 allows.
  camera.position.set(-380, 260, 1500);
  camera.lookAt(220, 0, 560);
  camera.updateMatrixWorld(true);
  const before = camera.quaternion.clone();

  const forward = camera.getWorldDirection(new THREE.Vector3());
  const pivot = pivotAlongView(camera.position, forward, 742);
  camera.lookAt(pivot.x, pivot.y, pivot.z);
  assert.ok(camera.quaternion.angleTo(before) < 1e-6, 'orientation must survive the re-seat');

  // Any distance along the axis does, which is why `dRef` is free to differ from
  // whatever the pivot was before.
  for (const distance of [0.5, 12, 5_000]) {
    const other = pivotAlongView(camera.position, forward, distance);
    camera.lookAt(other.x, other.y, other.z);
    assert.ok(camera.quaternion.angleTo(before) < 1e-6, `distance ${distance}`);
  }

  // And the stale point the bug restored does not: the startup look-at, once the
  // camera has been flown away from it, is a different orientation entirely.
  camera.lookAt(0, 1, 0);
  assert.ok(camera.quaternion.angleTo(before) > 0.1, 'a stale pivot re-aims the camera');
});
