/**
 * Surface-hit resolution for the "Place on surface" tool (spec §2.4.2).
 *
 * An armed click raycasts the scene geometry; this pure step reduces the raw
 * intersections to the single world point the entity should move to. Kept pure so
 * the clip-band rule is unit-tested without a raycaster
 * (`test/sceneView/surfaceHit.test.ts`), rather than living inline in the viewport
 * click handler — the same split as the selection pick (`pick.ts`).
 *
 * The point returned is the **raw** intersection, with no offset along the
 * surface normal (spec §2.4.2).
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ClipBand } from '../sectionHeatmap.ts';

/** The one field of a `THREE.Intersection` this step reads: the world hit point. */
export interface SurfaceIntersection {
  point: { x: number; y: number; z: number };
}

/**
 * The point an armed click places at, or `null` for a miss (spec §2.4.2).
 *
 * `intersections` must arrive in the raycaster's own near→far order, so the first
 * eligible entry is the nearest. When a section is clipping (`clipBand` non-null)
 * hits outside the band are **discarded** — they are invisible, and placing on
 * geometry the clip has hidden would look like the position came from nowhere.
 * A ray whose every hit is clipped away is a miss.
 */
export function surfaceHit(
  intersections: readonly SurfaceIntersection[],
  clipBand: ClipBand | null,
): Vec3 | null {
  for (const { point } of intersections) {
    const p: Vec3 = [point.x, point.y, point.z];
    if (!clipBand) return p;
    const along = p[clipBand.axis];
    if (along >= clipBand.min && along <= clipBand.max) return p;
  }
  return null;
}
