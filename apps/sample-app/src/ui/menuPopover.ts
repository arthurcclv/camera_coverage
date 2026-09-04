/**
 * Placement for the hierarchy's popover menus (`VISUAL_DESIGN.md` → Menu).
 *
 * Both the "+" add menu and its Constraint submenu open **outward** — rightward,
 * away from the panel — and both are `position: fixed`, placed from their anchor's
 * measured rect. Fixed rather than absolute because the hierarchy is the app's left
 * column: an outward popover overhangs `.left-panel`, whose `overflow: hidden`
 * clips an absolutely positioned child to a sliver at the panel edge.
 *
 * The width is **fixed**, not content-driven, so the two popovers line up as one
 * assembly instead of each sizing to its own longest label — and so the side below
 * can be decided before the popover has rendered.
 */

/**
 * The hierarchy popovers' width in CSS px.
 *
 * Mirrors the `width` on `.add-menu-anchor .menu`, `.menu.context-menu`, and
 * `.menu.submenu` in `index.css`, which is the authority; `test/menuPopover.test.ts`
 * reads the stylesheet and fails if the two drift, since this constant is what
 * decides whether a popover fits before it exists to measure.
 */
export const MENU_WIDTH_PX = 160;

/**
 * Which way a popover opens, given where its outward edge would land.
 *
 * `'right'` — the ordinary case — puts the popover's left edge at `anchorEdge` and
 * lets it extend rightward. `'left'` is the flip for when that would run past the
 * window: the popover's right edge is pinned instead. The check is a measurement
 * rather than a constant because the left panel is resizable
 * (`leftPanelSplit.ts`), so how much room lies to the right varies.
 *
 * @param anchorEdge   where the popover's left edge would sit, in CSS px from the
 *                     window's left — the "+" button's left edge for the add menu,
 *                     the parent row's right edge for a submenu
 * @param menuWidth    the popover's width in CSS px
 * @param viewportWidth the window's inner width in CSS px
 */
export function popoverSide(
  anchorEdge: number,
  menuWidth: number,
  viewportWidth: number,
): 'right' | 'left' {
  return anchorEdge + menuWidth <= viewportWidth ? 'right' : 'left';
}
