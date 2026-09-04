/**
 * The polyline draw mode's **hover plane** (`camera_placement.md` §6.2).
 *
 * A draw-mode *click* raycasts the scene geometry (`surfaceHit.ts`, `spec.md`
 * §2.4.2). A draw-mode *hover* does not: it intersects the pointer ray with a
 * single plane and nothing else. The geometry raycast is `O(triangles)` with no
 * acceleration structure, and on an imported site glTF it is the most expensive
 * thing in the frame — far too much to pay on every pointer move, at pointer
 * rate, for a rubber band. The next vertex is nearly always on the same surface
 * as the last one (a rail along a wall, a line across a floor), so the plane
 * *through that surface* is where the band belongs anyway, and the arithmetic is
 * a dot product.
 *
 * The click stays exact, so no vertex is ever placed on the approximation — it
 * shows only when turning a corner, where the band tracks the wall being left
 * until the click re-seeds it onto the wall being entered.
 *
 * Pure, so the guards are unit-tested without a raycaster — the same split as
 * `surfaceHit.ts` and `pick.ts`.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

/** A point on the plane and its unit normal, both world space (§6.2). */
export interface HoverPlane {
  point: Vec3;
  normal: Vec3;
}

/** Extend's pre-click seed normal (§6.2). */
export const WORLD_UP: Vec3 = [0, 1, 0];

/**
 * How square to the plane a ray must be for its intersection to mean anything
 * (§6.2).
 *
 * This is `|cos θ|` between the (unit) ray direction and the plane normal, so
 * the guard rejects rays within ~0.06° of parallel. It is deliberately a *cosine*
 * threshold and not a cap on the hit distance: the workspace runs to over a
 * kilometre across, so there is no distance that is "too far" everywhere, but a
 * ray skimming along the plane produces an intersection that races off to the
 * horizon at any scale.
 */
export const MIN_RAY_COS = 1e-3;

/**
 * The plane a committed draw click leaves behind (§6.2): through its hit point,
 * along the surface it hit.
 *
 * A hit with no face normal falls back to **world up**, the same seed Extend uses
 * before its first click. Every mesh hit carries a face, so this is the defensive
 * path rather than a case the user reaches.
 */
export function planeFromHit(hit: { point: Vec3; normal: Vec3 | null }): HoverPlane {
  return { point: [...hit.point] as Vec3, normal: [...(hit.normal ?? WORLD_UP)] as Vec3 };
}

/**
 * Extend's plane before its first click (§6.2): through the vertex being grown
 * from, world up.
 *
 * Extend wants a band immediately — its whole point is "keep drawing from here" —
 * and has no click of its own to take a surface from yet. Drawing needs no such
 * seed: there is no band until a first vertex exists, and that click seeds the
 * plane.
 */
export function seedPlane(anchor: Vec3): HoverPlane {
  return { point: [...anchor] as Vec3, normal: [...WORLD_UP] as Vec3 };
}

/**
 * Where the pointer ray meets the hover plane, or `null` for no band (§6.2).
 *
 * `direction` must be a unit vector (a `THREE.Raycaster`'s ray always is), since
 * {@link MIN_RAY_COS} reads the dot product as a cosine.
 *
 * Two rays draw nothing rather than something wrong: one **near-parallel** to the
 * plane, whose intersection sits at effectively infinite distance, and one that
 * meets the plane **behind the camera**, which the algebra would otherwise report
 * as a perfectly good point at negative `t`. A missing plane is a miss too — that
 * is the state a freshly armed draw mode is in, before its first click.
 */
export function planeHit(origin: Vec3, direction: Vec3, plane: HoverPlane | null): Vec3 | null {
  if (!plane) return null;
  const n = plane.normal;
  const denom = direction[0] * n[0] + direction[1] * n[1] + direction[2] * n[2];
  if (Math.abs(denom) < MIN_RAY_COS) return null;
  const t =
    ((plane.point[0] - origin[0]) * n[0] +
      (plane.point[1] - origin[1]) * n[1] +
      (plane.point[2] - origin[2]) * n[2]) /
    denom;
  if (t <= 0) return null;
  return [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
}
