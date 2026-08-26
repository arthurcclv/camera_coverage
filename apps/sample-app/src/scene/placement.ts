/**
 * "Place on surface" tool logic for the viewport toolbar (spec §2.4.2).
 *
 * The tool sets a selected entity's position from a click on the scene geometry.
 * This module is the single source of truth for **which selection kinds it
 * supports** and for the button's tooltip, kept pure so it can be unit-tested
 * without a React/DOM harness (test/placement.test.ts) — the same split the
 * transform-space toggle uses (`transformSpace.ts`).
 *
 * The geometry side of the tool (resolving a ray's intersections to one world
 * point) lives in `sceneView/surfaceHit.ts`.
 */
import type { Selection } from './viewportSelection.ts';

/**
 * A selection kind the tool can place — i.e. one whose entity carries a
 * `position: Vec3` (spec §2.4.2). Derived from {@link Selection} rather than
 * spelled out independently, so renaming a kind fails the build here instead of
 * silently narrowing the supported set.
 */
export type PlaceableKind = Extract<NonNullable<Selection>['kind'], 'camera' | 'probe'>;

/**
 * The supported kinds, in one place (spec §2.4.2). A section is a set of bounds
 * rather than a point, a zone has no transform, and a volume's `position` is its
 * box *centre* — placing one on a surface would bury half the box — so none of
 * the three is here.
 *
 * Widening this list is deliberate: every consumer switches exhaustively over
 * {@link PlaceableKind}, so adding a kind fails to compile until it is handled.
 */
export const PLACEABLE_KINDS: readonly PlaceableKind[] = ['camera', 'probe'];

/** A selection the tool can act on — narrowed, so callers get exhaustiveness. */
export type PlaceableSelection = { kind: PlaceableKind; id: string };

/**
 * Whether the tool is available for `selection` (spec §2.4.2) — the button's
 * enablement rule. Narrows on success so the caller can switch over the
 * supported kinds without re-testing.
 */
export function canPlace(selection: Selection): selection is PlaceableSelection {
  return selection !== null && PLACEABLE_KINDS.some((kind) => kind === selection.kind);
}

/** Tooltip/`aria-label` for the button, naming why it is disabled when it is. */
export function placeTooltip(selection: Selection, armed: boolean): string {
  if (!canPlace(selection)) return 'Place on surface — select a camera or probe';
  return armed ? 'Place on surface — click the geometry' : 'Place on surface';
}
