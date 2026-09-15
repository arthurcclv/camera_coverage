/**
 * Whether a run can happen at all (`geometry_assets.md` §5.3, §5.4).
 *
 * Geometry is authored in the app now, so two states are reachable that never
 * were before: a scene with **no geometry**, and — from stage 2 — a scene whose
 * geometry has not loaded. Both are legal scenes; neither is a measurable one,
 * and a coverage number produced against either would be wrong rather than
 * merely empty.
 *
 * One pure function rather than a condition spelled out at each use site: the
 * Run button, the auto-run poll and `handleRun` itself all have to agree, and
 * the reason has to be sayable to the user.
 */
import type { GeometryObject } from './geometryModel.ts';

/**
 * Why a run is refused, as an i18n key suffix (`ai/CONVENTIONS.md`: a pure
 * function that composes user-facing text returns a key, never a sentence).
 */
export type RunBlocker = 'noGeometry';

/**
 * The reason a run cannot happen, or `null` when it can.
 *
 * **`noGeometry`** — nothing enabled contributes triangles, so there is no
 * collision mesh and no workspace to voxelize (§5.3). A disabled object does not
 * count: unticking is how the user asks "what if this weren't here?", and
 * unticking *everything* is that question with no scene left.
 */
export function runBlocker(geometry: readonly GeometryObject[]): RunBlocker | null {
  return geometry.some((o) => o.enabled) ? null : 'noGeometry';
}
