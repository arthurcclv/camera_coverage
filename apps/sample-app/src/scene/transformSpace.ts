/**
 * Transform-space toggle logic for the viewport toolbar (spec §2.4).
 *
 * The UI exposes two spaces, "local" and "global"; Three's TransformControls
 * calls the latter "world". This module is the single source of truth for the
 * UI↔Three mapping, the toggle, and the icon/tooltip selection, kept pure so it
 * can be unit-tested without a React/DOM harness (test/transformSpace.test.ts).
 */

/** UI-facing transform space. Maps to Three's `'local'` / `'world'`. */
export type TransformSpace = 'local' | 'global';

/** Three.js `TransformControls` space string. */
export type ThreeSpace = 'local' | 'world';

/** Default space on load (spec §2.4). */
export const DEFAULT_TRANSFORM_SPACE: TransformSpace = 'local';

/** Flip to the other space. */
export function toggleSpace(space: TransformSpace): TransformSpace {
  return space === 'local' ? 'global' : 'local';
}

/** Map the UI space to the string `TransformControls.setSpace` expects. */
export function threeSpace(space: TransformSpace): ThreeSpace {
  return space === 'global' ? 'world' : 'local';
}

/** Which glyph the single toggle button shows for the current space. */
export function spaceIconKind(space: TransformSpace): 'box' | 'globe' {
  return space === 'local' ? 'box' : 'globe';
}

/**
 * The i18n key (spec §18.4, `common` namespace) for the tooltip naming the
 * current space and the action a click performs. Returns a key rather than
 * formatted English so this stays testable without a React/i18next harness;
 * the caller runs it through `t()`.
 */
export function spaceTooltipKey(space: TransformSpace): string {
  return space === 'local' ? 'spaceTooltipLocal' : 'spaceTooltipGlobal';
}
