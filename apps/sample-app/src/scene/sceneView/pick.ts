/**
 * Nearest-hit pick arbitration (spec §5.2, §12.4; `sampling_volumes.md` §5).
 *
 * A viewport click raycasts every pickable gizmo set (cameras, probes, volumes);
 * this pure step reduces those hits to the single nearest entity, which the
 * click-vs-drag decision (`viewportSelection.ts`) then applies. Kept pure so the
 * arbitration is unit-tested without a raycaster (`test/sceneView/pick.test.ts`),
 * rather than living inline in the viewport click handler.
 */
import type { Selection } from '../viewportSelection.ts';

/** One gizmo-set ray hit: the entity it would select and its ray distance. */
export interface PickCandidate {
  selection: Exclude<Selection, null>;
  distance: number;
}

/**
 * The nearest candidate's selection, or `null` when nothing was hit. Ties keep
 * the earlier candidate (callers push in camera → probe → volume order).
 */
export function nearestHit(candidates: PickCandidate[]): Selection {
  let best: PickCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best ? best.selection : null;
}
