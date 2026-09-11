/**
 * Perspective-view navigation math (`navigation.md` §2–§4) — pure, and the
 * reason `viewport.ts` stays a wiring module.
 *
 * Stock `OrbitControls` measures every distance against a fixed orbit pivot: the
 * wheel multiplies the camera-to-pivot distance by a constant, and pan is scaled
 * by that same distance. Both of the defects this replaces fall out of that one
 * choice — zoom converges on the pivot and appears to stop, and pan shrinks as
 * the factor it is derived from collapses (`navigation.md` §1).
 *
 * So the yardstick is the **ground plane at world y = 0** instead: the distance
 * under a screen point is a closed-form ray-plane intersection, the way Google
 * Maps gets it. That is what keeps this module free of the scene graph, the
 * depth buffer, and any raycast index — every function below is camera pose +
 * cursor + viewport size + scene diagonal in, a scalar or vector out, so the
 * whole model is assertable in `node --test` without a GPU (`test/navigation.test.ts`).
 * Why not the depth buffer or the splats: `ai/DECISIONS.md`.
 *
 * These functions take plain `{x, y, z}` vectors rather than `THREE.Vector3` so
 * the tests need no Three.js scene; `viewport.ts` passes the real ones, which
 * are structurally compatible.
 */

/** A world-space point/direction. Structurally compatible with `THREE.Vector3`. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The ground plane's world height (`navigation.md` §2) — where the grid is drawn. */
export const GROUND_Y = 0;

/**
 * Cap on the ground-hit distance, as a multiple of the scene diagonal
 * (`navigation.md` §2). As the view approaches the horizon the intersection
 * distance runs to infinity; without this a one-pixel drag would fling the
 * camera across the workspace. Maps avoids the case by forbidding the camera to
 * look at the horizon at all — a free 3D camera cannot, so it clamps instead.
 */
export const MAX_REF_DIAGONALS = 3;

/**
 * Reference distance used when the ray never usefully meets the ground — it is
 * parallel to the plane, or the intersection lies behind the camera (looking
 * away from the ground, or below it looking down). A fraction of the scene
 * diagonal (`navigation.md` §2).
 */
export const FALLBACK_REF_FRACTION = 0.1;

/** A wheel notch's travel, as a fraction of the reference distance (`navigation.md` §4.1). */
export const STEP_FRACTION = 0.1;

/**
 * Floor on a wheel notch's travel, in meters (`navigation.md` §4.1). Without it,
 * descending toward the floor shrinks the step without bound and the camera can
 * never pass through it — which is the stall this design exists to remove, just
 * relocated from the pivot to the ground. With it, scrolling always makes
 * progress and the camera can travel below the ground and inside geometry.
 */
export const MIN_STEP_METERS = 0.05;

/** Wheel speed multipliers (`navigation.md` §4.1). Ctrl is unavailable — see `wheelNotches`. */
export const FAST_MODIFIER = 5;
export const SLOW_MODIFIER = 1 / 5;

/**
 * Middle-drag travel per full viewport height of vertical drag, in reference
 * distances (`navigation.md` §4.2) — a full-height drag flies `2 × dRef`.
 */
export const MIDDLE_DRAG_GAIN = 2;

/** A ray whose direction is at most this far from horizontal cannot meet the ground. */
const PARALLEL_EPS = 1e-9;

/** The scene bounding box's diagonal length — the scale everything else is expressed in. */
export function sceneDiagonal(min: Vec3Like, max: Vec3Like): number {
  const dx = max.x - min.x;
  const dy = max.y - min.y;
  const dz = max.z - min.z;
  return Math.hypot(dx, dy, dz);
}

/**
 * Distance from `origin` along `direction` to the ground plane, or `null` when
 * the ray is parallel to it or meets it behind the camera (`navigation.md` §2).
 * `direction` need not be normalized; the returned distance is in units of
 * `direction`'s length, so callers pass a unit vector.
 */
export function groundHitDistance(origin: Vec3Like, direction: Vec3Like): number | null {
  if (Math.abs(direction.y) < PARALLEL_EPS) return null;
  const t = (GROUND_Y - origin.y) / direction.y;
  return t > 0 ? t : null;
}

/**
 * The reference distance `dRef` (`navigation.md` §2): the ground hit under a
 * screen point, clamped to `MAX_REF_DIAGONALS × diagonal`, falling back to
 * `FALLBACK_REF_FRACTION × diagonal` when there is no usable hit.
 *
 * Derived per gesture and never stored — nothing in the scene file records it.
 */
export function groundRefDistance(
  origin: Vec3Like,
  direction: Vec3Like,
  diagonal: number,
): number {
  const fallback = FALLBACK_REF_FRACTION * diagonal;
  const hit = groundHitDistance(origin, direction);
  if (hit === null) return fallback;
  return Math.min(hit, MAX_REF_DIAGONALS * diagonal);
}

/**
 * Where to seat the orbit pivot: `distance` along `direction` from the camera
 * (`navigation.md` §3). `direction` is always the **viewport centre** ray, so the
 * pivot lands on the camera's own view axis; `distance` is `dRef` under the
 * centre for an orbit and under the cursor for a pan.
 *
 * Being on the view axis is not incidental. `OrbitControls` ends every update by
 * looking at the pivot, so a pivot off the axis silently re-aims the camera — and
 * since the Perspective view's remembered framing is its camera pose alone (§3),
 * re-entering the view has to seat the pivot through here rather than restore a
 * saved point, or the orientation the user left is thrown away.
 */
export function pivotAlongView(
  origin: Vec3Like,
  direction: Vec3Like,
  distance: number,
): Vec3Like {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance,
  };
}

/** Which speed modifier a wheel/drag event carries (`navigation.md` §4.1). */
export type SpeedModifier = 'fast' | 'slow' | 'none';

/**
 * A `Record` keyed on the union rather than an if/else chain ending in a bare
 * `else` (`ai/CONVENTIONS.md`): a fourth modifier becomes a compile error here
 * instead of silently inheriting `none`'s 1.
 */
export const SPEED_MULTIPLIERS: Record<SpeedModifier, number> = {
  fast: FAST_MODIFIER,
  slow: SLOW_MODIFIER,
  none: 1,
};

export function speedMultiplier(modifier: SpeedModifier): number {
  return SPEED_MULTIPLIERS[modifier];
}

/**
 * Which modifier an input event's held keys select (`navigation.md` §4.1).
 * **Shift wins** over Alt when both are down — an arbitrary but fixed choice, so
 * the pair never cancels into `none`. Ctrl is deliberately absent: a trackpad
 * pinch arrives as a ctrl-wheel and is a gesture, not a modifier (§4.6).
 */
export function speedModifierOf(event: { shiftKey: boolean; altKey: boolean }): SpeedModifier {
  if (event.shiftKey) return 'fast';
  if (event.altKey) return 'slow';
  return 'none';
}

/**
 * One notch's travel along the cursor ray, in meters (`navigation.md` §4.1).
 * The floor is applied before the modifier, so Alt still slows an already-floored
 * step rather than being swallowed by it.
 */
export function wheelStep(refDistance: number, modifier: SpeedModifier = 'none'): number {
  const base = Math.max(STEP_FRACTION * refDistance, MIN_STEP_METERS);
  return base * speedMultiplier(modifier);
}

/**
 * Middle-drag travel for a vertical pointer delta (`navigation.md` §4.2).
 * Dragging **up** (negative `deltaYPx`, screen coordinates) flies forward, so the
 * gesture matches wheel-forward.
 */
export function middleDragStep(
  deltaYPx: number,
  refDistance: number,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx <= 0) return 0;
  return (-deltaYPx / viewportHeightPx) * MIDDLE_DRAG_GAIN * refDistance;
}

/** `WheelEvent.deltaMode` values, named (the DOM exposes them only as integers). */
const DELTA_MODE_PIXEL = 0;
const DELTA_MODE_LINE = 1;

/**
 * A wheel event's `deltaY` in **notch units** (`navigation.md` §4.6), so a mouse
 * notch and a trackpad flick move comparable distances across browsers: pixels ÷
 * 100 (Chrome's notch is ±100), lines × 1 (Firefox's is ±3 lines, so ×1 keeps a
 * notch ≈ 3 units — deliberately not renormalized, since Firefox's line deltas
 * are already the coarser unit), pages × 10.
 *
 * Positive is scroll-down, which flies **backward**.
 */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  if (deltaMode === DELTA_MODE_PIXEL) return deltaY / 100;
  if (deltaMode === DELTA_MODE_LINE) return deltaY;
  return deltaY * 10;
}

/**
 * Which of a wheel event's two axes carries the scroll (`navigation.md` §4.6).
 * Some browsers report a **shift-modified** wheel on `deltaX` rather than
 * `deltaY`, so the non-zero axis is used and the Shift modifier of §4.1 works
 * everywhere. `deltaY` wins when both move, since that is the intended axis.
 */
export function wheelAxisDelta(deltaY: number, deltaX: number): number {
  return deltaY !== 0 ? deltaY : deltaX;
}

/** A canvas's position and size in client space — the part of a `DOMRect` used here. */
export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A client-space point as **normalized device coordinates** (x and y in −1…1, y
 * up), which is what unprojecting a cursor ray needs. Passing `null` for either
 * coordinate gives the **viewport centre** — the sampling point for an orbit
 * (`navigation.md` §3) and for the middle drag (§4.2), neither of which has a
 * cursor position that means anything.
 *
 * A zero-size rect (a container measured before layout) degrades to the centre
 * rather than dividing by zero.
 */
export function viewportNdc(
  clientX: number | null,
  clientY: number | null,
  rect: ViewportRect,
): { x: number; y: number } {
  if (clientX === null || clientY === null) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) / (rect.width || 1)) * 2 - 1,
    y: -(((clientY - rect.top) / (rect.height || 1)) * 2 - 1),
  };
}

/**
 * Remainder below which a pending translation is applied outright rather than
 * eased, in meters (`navigation.md` §4.5) — what makes an ease *terminate*.
 */
export const SETTLE_EPS = 1e-4;

/**
 * Per-frame damping toward a pending translation, matching the factor
 * `OrbitControls` uses for rotate and pan (`navigation.md` §4.5) so the viewport
 * reads as one system rather than a smooth orbit bolted to a jumpy zoom.
 *
 * Returns how much of `pending` to apply this frame and what remains. Below
 * `SETTLE_EPS` the remainder is applied outright, so a translation terminates
 * instead of asymptotically approaching its target — the same failure mode, at a
 * smaller scale, that this whole design removes.
 */
export function dampStep(pending: number, factor: number): { apply: number; remaining: number } {
  if (Math.abs(pending) < SETTLE_EPS) return { apply: pending, remaining: 0 };
  const apply = pending * factor;
  return { apply, remaining: pending - apply };
}
