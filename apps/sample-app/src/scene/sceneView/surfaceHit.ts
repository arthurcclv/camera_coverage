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
 * surface normal (spec §2.4.2). The **normal** rides along with it because the
 * polyline draw mode seeds its hover plane from the surface a click landed on
 * (`camera_placement.md` §6.2, `hoverPlane.ts`); "Place on surface" itself reads
 * only the point.
 */
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import type { ClipBand } from '../sectionHeatmap.ts';

/**
 * The fields of a `THREE.Intersection` this step reads.
 *
 * `face.normal` is the **geometric** face normal — not `Intersection.normal`,
 * which is the interpolated *shading* normal. `meshFromTris` runs
 * `computeVertexNormals()` over indexed geometry, so at a box corner the shading
 * normal is the average of three faces and is the plane of none of them. It is
 * also in the hit object's **local** space, which only equals world space for the
 * room/box primitives (built world-space with identity transforms); a `gltf`
 * object carries its own transform, so the normal has to be pushed through it.
 */
export interface SurfaceIntersection {
  point: { x: number; y: number; z: number };
  face?: { normal: { x: number; y: number; z: number } } | null;
  object?: { matrixWorld: THREE.Matrix4 };
}

/** A resolved click: where it landed, and the surface it landed on (§2.4.2, §6.2). */
export interface SurfaceHit {
  point: Vec3;
  /** Unit world-space geometric face normal, or null when the hit carried no face. */
  normal: Vec3 | null;
}

const _normalMatrix = new THREE.Matrix3();
const _normal = new THREE.Vector3();

/** The face normal of one intersection, in world space (§6.2). */
function worldNormal(hit: SurfaceIntersection): Vec3 | null {
  const local = hit.face?.normal;
  if (!local) return null;
  _normal.set(local.x, local.y, local.z);
  if (hit.object) _normal.applyMatrix3(_normalMatrix.getNormalMatrix(hit.object.matrixWorld));
  if (_normal.lengthSq() === 0) return null;
  _normal.normalize();
  return [_normal.x, _normal.y, _normal.z];
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
): SurfaceHit | null {
  for (const hit of intersections) {
    const { point } = hit;
    const p: Vec3 = [point.x, point.y, point.z];
    if (!clipBand) return { point: p, normal: worldNormal(hit) };
    const along = p[clipBand.axis];
    if (along >= clipBand.min && along <= clipBand.max) return { point: p, normal: worldNormal(hit) };
  }
  return null;
}
