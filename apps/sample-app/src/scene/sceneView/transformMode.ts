/**
 * Which TransformControls mode a selection actually gets (spec §2.4, §12.4,
 * §13.8; `geometry_assets.md` §7).
 *
 * Pure and its own module so the rule is testable without a WebGL context — it
 * is a decision, and the imperative bridge below it should not be the only place
 * it is stated (`ai/CONVENTIONS.md`).
 */
import type { Selection } from '../viewportSelection.ts';

/**
 * The active TransformControls mode for a selection (spec §12.4, §13.8): a probe
 * is a point and a section slides along one axis — both translate only; scale
 * applies to a **sampling volume and a geometry object**
 * (`geometry_assets.md` §7) and falls back to translate on any other selection.
 * A splat is the deliberate exclusion: its scale is one uniform number edited in
 * its panel, because a per-axis drag would shear its Gaussians.
 *
 * A **splat** therefore keeps Move/Rotate and never Scale, which is deliberate
 * rather than incidental: `TransformControls`'s scale mode is per-axis, and
 * dragging one handle would write the non-uniform scale that shears a capture's
 * Gaussians. Its scale is a single number in its panel instead
 * (`gaussian_splats.md` §2.1, §7).
 */
export function resolveMode(mode: 'translate' | 'rotate' | 'scale', selection: Selection): 'translate' | 'rotate' | 'scale' {
  if (selection?.kind === 'probe' || selection?.kind === 'section') return 'translate';
  if (mode === 'scale' && !isScaleCapable(selection)) return 'translate';
  return mode;
}

/**
 * Whether Scale applies to this selection at all — a **sampling volume**
 * (`sampling_volumes.md` §5) or a **geometry object** (`geometry_assets.md` §7).
 *
 * Exported because the toolbar's Scale button has to agree with
 * {@link resolveMode}: it used to hard-code `kind !== 'volume'` for its `disabled`
 * state, so adding a second scale-capable kind left a button the mode would have
 * honoured but the user could not press.
 */
export function isScaleCapable(selection: Selection): boolean {
  return selection?.kind === 'volume' || selection?.kind === 'geometry';
}
