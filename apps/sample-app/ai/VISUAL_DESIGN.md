# VISUAL_DESIGN.md — sample-app

The app's visual language and UI guidelines. Values below are the ones actually
in `src/index.css` and the `scene/*` gizmo modules — treat this as the reference
when adding UI, and keep it in sync with the CSS. See
[CONVENTIONS.md](./CONVENTIONS.md) for the code side and
[DESIGN.md](./DESIGN.md) for product intent.

The app is a **dark, dense, desktop tool UI**: a neutral slate palette, one blue
accent, flat cards, and small semantic status colors — chrome that stays out of
the way of the 3D viewport.

## Color

Defined ad hoc in `index.css` (no CSS custom properties yet — if you find
yourself repeating a value, promote it to a `:root` variable).

### Surfaces & structure
| Role | Hex | Used for |
|---|---|---|
| App background | `#14161a` | `body`, number inputs |
| Sidebar / left panel | `#1b1e24` | side columns |
| Panel card | `#20242b` | `.panel` |
| Row hover / menu | `#262b33` | tree/probe row hover, popover menus |
| Border (subtle) | `#2a2e36` | panel/column borders, `.btn.secondary` |
| Border / control (raised) | `#384252` | scrollbar thumb, divider grip, disabled btn, menu border |
| Border hover | `#55606f` | scrollbar/divider hover |

### Text
| Role | Hex |
|---|---|
| Primary text | `#e6e8eb` |
| Secondary body | `#c4cad3` / `#b7bec9` |
| Muted label / hint | `#9aa3b0` / `#7c8592` |
| Faint (caret, counts) | `#7a828f` |

### Accent & semantic
| Role | Hex | Notes |
|---|---|---|
| Primary accent (blue) | `#2c66c9` → hover `#3574e0` | buttons, active toggles, selection border `#3a5ba0`, selected row bg `#24304a` |
| Accent text / numeric | `#7fb8e6` | tree-row rates, spinner, CPU / zone badge |
| Success / visible (green) | `#4de08a` on `#123a2b` | WebGPU badge, "seen" marks, sightlines |
| Warning / stale (amber) | `#ffb84d` on `#4a3410` | stale badge, warning hints |
| Error / flagged (red) | `#ff7d7d` / `#ff9d9d` on `#4a1414` / `#3a1414` | flagged-camera badge, error banner |

Semantic colors always pair a bright foreground with a dark, desaturated
background of the same hue (the badge pattern) — reuse that pattern for any new
status chip.

### 3D viewport (Three.js gizmos, not CSS)
| Element | Color | Source |
|---|---|---|
| Camera body (default) | `0x5da9e0` | `scene/cameraGizmos.ts` |
| Camera frustum helper (default) | `0x7fb8e6`, opacity 0.85 | |
| Camera selected (body + helper) | `0xffd23f` (yellow), body scaled ×1.4 | |
| Camera flagged "inside geometry" | `0xe0524f` (red) | |
| Camera disabled | body opacity 0.3 (frustum still follows selection) | |
| Probe marker | `0xff9d3f` (amber diamond) | `scene/probeGizmos.ts` |
| Probe selected | `0xffd23f` | |
| Sightline (probe → visible camera) | `0x4de08a` (green), opacity 0.9 | spec §12.4 |
| Sampling-volume box (edges + faint fill) | `0x8bd0c0` (teal) | `scene/samplingVolumeGizmos.ts` |
| Volume selected / disabled-zone volume | edges `0xffd23f` (yellow) / dimmed to opacity 0.25 | |
| Coverage overlay fog | user hue, default **red** (hue 0), `hsl(h,100%,50%)` | `scene/coverageOverlay.ts` |

The **frustum wireframe renders for the selected camera only** (spec §5.3); every
other camera shows just its body dot. So the default (blue `0x7fb8e6`) frustum
color above is effectively only a fallback — a visible frustum is always the
selected camera's (yellow, or red if that camera is also flagged).

The overlay is intensity-modulated volumetric fog (a single instanced-cube TSL
pass), not opaque voxels — see [DECISIONS.md](./DECISIONS.md). Hue is
user-controlled via a rainbow spectrum slider; intensity encodes coverage
fraction (Coverage mode) or is flat (Blind-spots mode).

## Typography

- **Font:** system stack — `-apple-system, BlinkMacSystemFont, 'Segoe UI',
  Roboto, sans-serif`. No web fonts.
- **Scale:** 11 px (chips, hints, badges, counts) · 12 px (default UI text,
  labels, rows, stats) · 13 px (buttons) · 15 px (add-menu "+"). The viewport is
  the focus, so body copy stays small and dense.
- **Weights:** 400 body, 500 group rows, 600 emphasis (buttons, badges, panel
  titles, `<b>` stat values).
- **Panel titles:** 12 px, 600, `text-transform: uppercase`, `letter-spacing:
  0.04em`, muted `#9aa3b0` — the standard section header.
- **Numerics:** always `font-variant-numeric: tabular-nums` for values, rates,
  and counts so digits don't jitter as they update.

## Spacing, radius, layout

- **Rhythm:** multiples of ~4/6 px. Column & panel padding `12px`; panel card
  padding `10px 12px`; standard gap `12px` between panels, `6–8px` within rows.
- **Toolbar grouping:** the viewport's top-left toolbar is a flex row of
  `.toolbar-group` children — `12px` between groups, `6px` within one, reusing the
  between/within pair above. The gap *is* the grouping: no divider rule, so nothing
  extra is painted over the 3D scene. Add a tool by putting it in the group it
  belongs to, or opening a new group — never by hanging a margin off one button.
- **Radius:** `4px` (inputs, menu items, small chips) · `6px` (buttons, rows,
  banners, menus) · `8px` (panel cards) · `999px` (pill badges).
- **Layout:** three columns in a full-viewport flex row — left inspector `340px`
  (hierarchy tree grows, object-detail panel below with a draggable `8px`
  `row-resize` divider), center viewport (`flex: 1`, `min-width: 0`) with absolute
  top-left and top-right icon toolbars, right sidebar `340px`. Side columns
  scroll; the app shell never scrolls (`overflow: hidden`).
- **Scrollbars:** custom 8 px thin thumbs (`#384252`, hover `#55606f`), WebKit via
  `::-webkit-scrollbar` and Firefox via a `@supports` block — kept apart
  deliberately (see the comment in `index.css`). Scroll containers reserve space
  with `scrollbar-gutter: stable`.

## Component patterns

- **Panel** (`.panel`): the base card — dark surface, subtle border, 8 px radius,
  an uppercase `.panel-title`, then rows. Scrolling panels keep the title fixed
  and scroll only `.panel-body`. `.panel-title.subhead` is a subsection heading
  inside a body (12 px top margin); `.panel-title .badge` trails the title text
  (8 px left). A `.stat-line.spaced` sets a stat row off from the controls above
  it (8 px top). No inline spacing styles — spacing lives in `index.css`.
- **Row** (`.row`): label left, control right, space-between, 12 px label.
  `Slider.tsx` is the reusable control for bounded scalars (plain range, plus a
  `.spectrum` rainbow variant with a white thumb for hue) — e.g. FOV, Range,
  resolution. Its value readout is a `.slider-value` **editable text input** (same
  dark boxed chrome as the vector fields — 56 px, `#14161a` field, `#2a2e36` border,
  right-aligned tabular-nums, blue `#3a5ba0` focus border), replacing the old
  read-only `.value-chip`. When the row is too narrow for the label + slider + value,
  the **slider shrinks** (the range carries `min-width: 0`); the label and value box
  keep their size, so the row never overflows the panel horizontally.
- **Vector field** (`.vec-row`, `Vec3Field.tsx`): the editor for X/Y/Z and
  yaw/pitch/roll triplets (position, rotation, size) — a **fixed 58 px group label**
  (`.vec-group-label`, keeps the field grids aligned across Position / Rotation /
  Size) then a `.vec-fields` grid of three equal columns. Each `.vec-field` is a dim
  10 px axis letter (`.vec-axis`, `#7c8592`) + a dark text input (`#14161a` field,
  `#2a2e36` border, 4 px radius, tabular-nums; blue `#3a5ba0` focus border). Fields
  commit on blur/Enter and revert on Escape; no `.value-chip` (the input shows the
  value). Rotation columns are axis-correct: X = pitch, Y = yaw, Z = roll.
- **Button** (`.btn`): blue primary; `.secondary` neutral; `.active` = blue
  (toggle "on"); disabled goes flat grey. `.block` makes a full-width stacked
  action button (8 px top margin, e.g. "Generate from geometry"). `.icon-btn` for
  the square viewport toolbar buttons (inline SVG icons live in `App.tsx`; the
  layer-menu glyphs live in `ViewportLayerMenu.tsx`).
  `.segmented` groups buttons into an equal-width segmented control.
- **Armed viewport tool:** a toolbar button that puts the viewport into a
  click-to-act mode carries `.active` + `aria-pressed`, and the viewport itself
  changes cursor — `.viewport.placing canvas { cursor: crosshair }` for "Place on
  surface". Two signals, one in the toolbar and one under the pointer, because the
  toolbar is not where the user is looking when the mode matters.
- **Layer menu** (`.layer-menu`, a `.menu` popover): the top-right eye button
  (`.icon-btn`) opens a checklist of layer-visibility rows (`.layer-menu-row`:
  checkbox + glyph + label). Toggling keeps the menu open; it closes on
  outside-click / Escape / re-click. Reuses the `.menu` popover chrome shared with
  the hierarchy add/context menus.
- **View selector** (`.view-menu`, a `.menu` popover): the top-middle button opens
  the five view rows (`.view-menu-row`: a 12 px blue `#4d9dff` checkmark column +
  label; `.selected` brightens the label to `#fff`). A row that cannot be chosen
  takes `.view-menu-row.disabled` — opacity 0.4, no hover background, and a `title`
  carrying the reason, matching how the toolbar disables Scale rather than hiding it.
  Currently only the **Selected** row uses it (no camera selected, spec §2.4.1).
- **Frame guide** (`.camera-frame-guide`): in the Selected view, a **1 px
  `#ffd23f`** rectangle centered over the canvas marking the selected camera's true
  image (spec §2.4.1). It takes the *selected-camera yellow* from the gizmo table
  above deliberately — it is that camera's frustum seen head-on. Sized in
  percentages from the fit, `pointer-events: none` so a drag still reaches the
  canvas to aim. The area outside it is **not** dimmed: it is legible context
  showing what a small pan or a wider FOV would gain.
- **Badge** (`.badge`): pill, 11 px/600 — variants `stale`, `backend-webgpu`,
  `backend-cpu`, `flagged`, `zone` (neutral blue, the volume's zone reference).
- **Tree row** (`.tree-row`): caret + colored `.dot` + ellipsized `.label` +
  right-aligned rate/count; `.selected` (blue bg + border), `.disabled` (opacity
  0.45), `.group` (lighter, 500). Probe dots are rotated squares (`.probe-dot`),
  section dots are green squares (`.section-dot`), and zone/volume dots are teal
  (`.zone-dot` round, `.volume-dot` square). Zone rows carry a leading
  `.tree-row-toggle` **enabled checkbox** (checked = the zone contributes to the
  visualized marked set), reusing the camera enable-toggle control. Sections use the
  same checkbox for their per-heatmap enabled state.
- **Tree drag-reorder** (`.tree-row.dragging`, `.tree-insertion-line`): while a row
  is dragged to reorder it (§5.5.1) the source row **dims in place** (opacity 0.4)
  and the list does **not** reflow; a 2 px accent (`#2c66c9`) line, absolutely
  positioned in `.tree`'s scroll-content space and **inset to the target row's indent
  depth** (`8 + depth * 14` px, matching the row padding), marks where it will land.
  The line's absence is the "you can't drop here" cue — there is deliberately no
  separate rejection state. `.tree` therefore carries `position: relative`.
- **Select / text input** (`.select`, `.text-input`): match the numeric-input
  chrome (dark field, subtle border, 4 px radius) — the volume zone-reassign
  dropdown and the editable zone name.
- **Checkbox row** (`.checkbox-row`): inline checkbox + 12 px label, for the
  "Restrict coverage to zones" toggle.
- **Menu** (`.menu`): popover for the add-entity menu and the right-click
  Duplicate/Delete context menu — dark surface, shadow `0 6px 20px rgba(0,0,0,.45)`,
  blue hover.
- **Spinner** (`.spinner`): 12 px ring, blue top border, 0.7 s spin.
- **Error banner** (`.error-banner`): dark-red surface + border, for engine
  errors.
- **Warning banner** (`.warning-banner`): amber surface + border, same geometry
  as the error banner. For a condition that left something *out* of an otherwise
  valid result — a §3.3 descriptor cap dropping over-cap zones, volumes,
  sections, or probes. The colour is the load-bearing difference: red means the
  panel below it is empty, amber means it is populated but incomplete, so the two
  must never be styled alike.

## Accessibility

- **Semantic roles are expected on every interactive structure:** the hierarchy
  is `role="tree"` / `treeitem` / `group` with `aria-expanded` / `aria-selected`;
  menus use `role="menu"`; the overlay-mode control is a `radiogroup`; the panel
  divider is a `separator`. Preserve these when editing components.
- **Never encode state in color alone.** Camera state carries a text badge
  ("inside geometry"), coverage carries a numeric % and count next to the dot,
  probe visibility uses a ✓/– `.mark` glyph alongside color, and the compute/render
  backend is a labeled badge. Keep the redundant text/glyph cue when you add color.
- **Contrast:** primary text `#e6e8eb` on the dark surfaces is high-contrast;
  muted greys (`#7c8592`, `#7a828f`) are for secondary/hint text only, not primary
  reading content — don't push important text into them.
- **Pointer targets:** thin visual affordances get larger hit areas (the 8 px
  divider grip has a 3 px visible bar; the 5 px drag threshold in
  `viewportSelection` prevents accidental deselect, and the hierarchy's 4 px
  reorder threshold keeps a shaky click on a row a *selection*, not a drag).
  Maintain that split when adding thin controls.
- **Known gap:** hierarchy drag-reorder (§5.5.1) is **mouse/touch only** — the tree
  has no keyboard navigation to hang a keyboard reorder on, so there is no
  non-pointer equivalent. Documented in the spec rather than half-built; adding it
  means building roving-tabindex tree navigation first.
- **Motion:** the only animation is the spinner; keep new motion minimal and
  non-essential.

## When adding UI

Reuse the palette and the `.panel` / `.row` / `.btn` / `.badge` / `Slider`
primitives rather than introducing new colors, fonts, or bespoke controls. New
semantic status → follow the bright-on-dark-same-hue badge pattern. If a value
recurs, lift it into a `:root` custom property. There is no component library or
CSS framework, by design — keep it that way.
