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

Defined ad hoc in `index.css`, with one exception: the subtle border recurred
sixteen times and is now `--border-subtle` on `:root`. That is the rule, not a
one-off — if you find yourself repeating a value, promote it to a `:root`
variable.

### Surfaces & structure
| Role | Hex | Used for |
|---|---|---|
| App background | `#14161a` | `body`, number inputs |
| Sidebar / left panel | `#1b1e24` | side columns |
| Panel card | `#20242b` | `.panel` |
| Row hover / menu | `#262b33` | tree/probe row hover, popover menus |
| Border (subtle) | `#2a2e36` (`var(--border-subtle)`) | panel/column borders, `.btn.secondary` |
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

### Aim-optimizer heatmap (`aim_optimization.md` §5.2)
| Role | Value | Notes |
|---|---|---|
| Score ramp | `rgb(20+235·t^0.8, 30+150·t^1.4, 70+40·(1−t))` | deep blue → amber |
| Panel type scale | 12 px, `#d5dae2` values on `#7c8592` labels | `.aim-stats`, `.aim-summary` |
| Gain figure | `#ffb84d` | the amber already used for "something changed" |

The ramp deliberately **does not** reuse the coverage legend's palette. The heatmap
answers a different question — *what would this camera be worth aimed here* — and two
images in the same colors invite reading one as the other. It shares only the
direction: cold is low, hot is high. It is normalized to its own panorama's maximum, so
it is readable within one camera and **not** comparable across cameras; the numeric
readout beside it is what carries absolute value.

### 3D viewport (Three.js gizmos, not CSS)
| Element | Color | Source |
|---|---|---|
| Camera body (default) | `0x5da9e0` | `scene/cameraGizmos.ts` |
| Camera frustum helper (default) | `0x7fb8e6`, opacity 0.85 | |
| Camera selected (body + helper) | `0xffd23f` (yellow), body scaled ×1.4 | |
| Camera flagged "inside geometry" | `0xe0524f` (red) | |
| Camera disabled | **not drawn** — except as the selection, where the body takes opacity 0.3 and the frustum still follows selection (spec §2.4.3) | |
| Section disabled | **not drawn** — except as the selection, where its box outlines draw at opacity 0.35 with no heatmap, so the drag has a visible target (spec §2.4.3, §13.8) | `scene/sectionGizmos.ts` |
| Probe marker | `0xff9d3f` (amber diamond) | `scene/probeGizmos.ts` |
| Probe selected | `0xffd23f` | |
| Sightline (probe → visible camera) | `0x4de08a` (green), opacity 0.9 | spec §12.4 |
| Sampling-volume box (edges + faint fill) | `0x8bd0c0` (teal) | `scene/samplingVolumeGizmos.ts` |
| Volume selected / hidden-zone volume | edges `0xffd23f` (yellow) / **not drawn**; as the selection, edges 0.4 and fill 0.06 — the selected-disabled tier (spec §2.4.3) | |
| Camera-constraint handles + bodies | `0xc08bd0` (violet); handles opaque, every fill 0.16 selected / 0.10 enabled / 0.06 selected-disabled. A disabled constraint — or any constraint of a disabled group — is **not drawn** (spec §2.4.3) | `scene/constraintGizmos.ts` |
| Constraint outside a group's mount zones | fill 0.06 selected / 0.03, edges at 0.35 — the disabled treatment, because for a placement run that is what it is. Never the only cue: the group panel spells out the overlap percentages (`camera_placement.md` §3.1.2, §4.1.1) | `scene/constraintGizmos.ts` |
| Constraint / vertex selected, selected-disabled constraint | `0xffd23f` (yellow) / handles and lines at opacity 0.35 | `camera_placement.md` §6.1 |
| Placement pool scatter | violet ramped 0.35→1.0 by the position's own reachable count; chosen positions `0xffd23f`. **4 px screen-space dots** (`sizeAttenuation: false`) drawn as an instanced **sprite**, not `THREE.Points` — WebGPU point primitives are fixed at 1 px, and a world-space size small enough for a 6 m room is sub-pixel on the 1120 m site | `camera_placement.md` §5.2 |
| Draft polyline (armed draw mode) | `0xffd23f`: a 7 px screen-space dot per clicked vertex plus a solid line between them, both `depthTest: false` at `RenderOrder.draftOverlay`. Solid rather than dashed because two dashed constructions rendered nothing under this WebGPU backend (`CONVENTIONS.md`) | `camera_placement.md` §6.2 |
| Coverage overlay fog | user hue, default **red** (hue 0), `hsl(h,100%,50%)` | `scene/coverageOverlay.ts` |

The **frustum wireframe renders for the selected camera only** (spec §5.3); every
other camera shows just its body dot. So the default (blue `0x7fb8e6`) frustum
color above is effectively only a fallback — a visible frustum is always the
selected camera's (yellow, or red if that camera is also flagged).

The overlay is intensity-modulated volumetric fog (a single instanced-cube TSL
pass), not opaque voxels — see [DECISIONS.md](./DECISIONS.md). Hue is
user-controlled via a rainbow spectrum slider; intensity encodes coverage
fraction (Coverage mode) or is flat (Blind-spots mode).

### 3D viewport lighting (spec §2.3.1)

A fixed four-light rig, no shadow maps and no environment map. Legibility beats
realism here: the user orbits freely to judge coverage, and a face that renders
black cannot be judged at all.

The four roles: a `HemisphereLight` for sky/ground bounce, a key
`DirectionalLight` that establishes form, an opposing fill `DirectionalLight`
that keeps the shaded side shaped, and an `AmbientLight` setting the brightness
floor.

**The colors, intensities and positions live in one place only — spec §2.3.1's
table** (implemented in `scene/sceneLighting.ts`, pinned exactly by
`test/sceneLighting.test.ts`). They are deliberately not restated here: three
copies of a number table is three places for it to drift. What follows is the
design reasoning those numbers serve.

**The hemisphere ground color deliberately diverges from the panel palette.**
`#6a6f7a` is a mid grey, not the near-black `#30323a` used for UI surfaces —
because this value is *light*, not chrome. Reusing the dark surface token here is
what makes downward-facing faces read as unlit holes. The same reasoning applies
to any future viewport light: pick it for what it does to geometry, not for
palette consistency.

Two lights rather than one, plus a modest ambient rather than a large one: a bare
ambient lift raises the black areas but flattens the geometry into paper. The
opposite-side fill is what preserves shape while removing the black.

**Known limitation.** Loaded glTF materials render as authored (only `side` is
overridden, spec §14.6), so a fully metallic material (`metalness: 1.0`) still
renders black under this rig — a metal surface shows only reflections and there
is no environment map to reflect. If parts of a loaded scene are black *after*
this rig, check the asset's metalness before touching the lights.

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
- **Button row** (`.row.button-row`): the primary button takes the row's width
  (`flex: 1`) while a secondary beside it keeps its own — the placement mode's
  Build and Analyze, each with a Cancel that appears only while it runs, so the
  primary is the same width whether or not it is running. Separated from the
  fields above it by a `#2a2e36` rule with `10px` either side, the same divider
  the pinned action footer uses: the fields are what the button spends, so the
  line marks where reading settings ends and pressing begins. `.btn.block`
  remains the full-width form for a button that is alone in its column.
- **Radius:** `4px` (inputs, menu items, small chips) · `6px` (buttons, rows,
  banners, menus) · `8px` (panel cards) · `999px` (pill badges).
- **Layout:** three columns in a full-viewport flex row — left inspector `340px`
  (hierarchy tree grows, object-detail panel below with a draggable `8px`
  `row-resize` divider), center viewport (`flex: 1`, `min-width: 0`) with absolute
  top-left and top-right icon toolbars, right sidebar `340px`. Side columns
  scroll; the app shell never scrolls (`overflow: hidden`).
- **Target-zone list** (`ConstraintGroupPanel`, `camera_placement.md` §3.1.2): a
  `subhead` title, the two `.checkbox-row` flags, then a `.row` holding a `.select`
  that lists only the **unlisted** zones — so it reads as an *action* ("add a
  zone…"), never as a field, and a duplicate is impossible by construction — and
  one `.row` per listed zone with its label and an `.icon-btn` `×`. No chip or tag
  component: the app has none, and a list showing only what was picked stays short
  on a site whose BVH cut produced dozens of zones. An empty list carries a `.hint`
  saying the group scores against the whole marked set, so "no zones" reads as a
  state rather than as an unfinished control. With `restrictMounts` on, a second
  `.hint` carries the per-constraint overlap percentages
  (`Dock rail 100% · North wall 4%`) — the same line the placement mode's Build
  card shows, and the text cue that keeps the dimmed gizmos from being the only
  signal.
- **Placement mode** (`camera_placement.md` §5): the same three columns, with both
  side columns' *contents* replaced — nothing about the shell changes, because
  the mode's claim is exclusion, not screen space. The left column
  (`.left-panel.placement-inputs`) drops the hierarchy/detail divider and simply
  stacks two cards. **Neither column scrolls at the column level**: a scrolling
  column reserves a stable gutter, and reserving one on a single side would leave
  the two columns' content boxes disagreeing by its width. Both put the scroll
  one level in, in a card's `.panel-body` (`scrollbar-gutter: stable`,
  `padding-right: 6px`), which is the object-detail panel's idiom. The right (`.sidebar.placement-review-col`) holds one card
  that fills the column: a fixed title, a scrolling `.panel-body`, and a
  `.placement-actions` footer above a `#2a2e36` rule, so **Close** is on screen
  however far the review has been scrolled. `.placement-confirm` — the close
  guard, the app's only dialog — is a `.panel`-surfaced card anchored over that
  footer with a `0 8px 24px rgb(0 0 0 / 45%)` lift, dimming nothing: the viewport
  behind it is live and is what the user is judging. A stale result is dimmed
  (`.placement-curve.stale`, `opacity: 0.55`) rather than withdrawn.
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
  it (8 px top). `.hint.readout` is a result stated directly under a card's title,
  above the controls that produced it (the placement mode's pool and analysis
  readouts) — set off by a `#2a2e36` rule *below* it, since the title already
  separates it from above. No inline spacing styles — spacing lives in `index.css`.
- **Row** (`.row`): label left, control right, space-between, 12 px label.
  `Slider.tsx` is the reusable control for bounded scalars (plain range, plus a
  `.spectrum` rainbow variant with a white thumb for hue) — e.g. FOV, Range,
  resolution. Its value readout is a `.slider-value` **editable text input** (same
  dark boxed chrome as the vector fields — 56 px, `#14161a` field, `#2a2e36` border,
  right-aligned tabular-nums, blue `#3a5ba0` focus border), replacing the old
  read-only `.value-chip`. A `NumberInput` standing **alone** as a row's only
  control (a constraint group's Aspect and Near, the placement mode's Size and
  strategy fields) takes `.number-field`, which shares that rule — the component
  renders a `type="text"` input, so one with neither class matches no rule and
  falls back to the browser's default white box. When the row is too narrow for the label + slider + value,
  the **slider shrinks** (the range carries `min-width: 0`); the label and value box
  keep their size, so the row never overflows the panel horizontally. A label carrying a
  **unit most users will not know** (`Knee (pp)`) takes `Slider`'s `title`, which becomes
  both the hover text and the field's `aria-label` — the explanation reaches a pointer and a
  screen reader by one string rather than two.
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
  changes cursor — `.viewport.placing canvas` for "Place on surface",
  `.viewport.drawing canvas` for the polyline draw mode and **Extend**
  (`../specs/camera_placement.md` §6.2), both `cursor: crosshair`. Two signals, one
  in the toolbar and one under the pointer, because the toolbar is not where the
  user is looking when the mode matters. Two exceptions, both in
  `camera_placement.md` §6.2: **Extend**'s button lives in the *panel* of the
  polyline it grows (same `.active` + `aria-pressed` pair, just not in the
  toolbar), and the **draw mode** has no button at all — armed from the hierarchy's
  "+" menu, it is the one armed tool whose only signal is the crosshair.
- **Selected polyline vertex** (`.vertex-head`, `.vertex-row`,
  `../specs/camera_placement.md` §6.2): a subhead naming the vertex
  (`Vertex 3` with a muted `of 8` in `.vertex-count`) with **Extend** opposite it,
  then the coordinate row with `+` / `−` `.icon-btn`s. One vertex, never a list:
  the panel shows what the viewport gizmo is attached to, so there is no
  selected-row state to mark and no scrolling to find the vertex being held.
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
  "Restrict coverage to zones" toggle and the constraint group's two
  "Restrict … to zones" flags. Both group flags render **disabled** while the
  target-zone list is empty, carrying `Add a target zone to use these.` as their
  `title` — the flags are genuinely inert then (`camera_placement.md` §3.1.2), and
  a live checkbox that changed nothing would be the worse lie.
- **Menu** (`.menu`): popover for the add-entity menu and the right-click
  Duplicate/Delete context menu — dark surface, shadow `0 6px 20px rgba(0,0,0,.45)`,
  blue hover. The three hierarchy popovers (add menu, its submenu, the context menu)
  are **`position: fixed` at a fixed `width: 160px`**, placed from their anchor's
  measured rect (`ui/menuPopover.ts`). Fixed width, not content-driven: the add menu
  and its submenu then line up as one assembly instead of each sizing to its own
  longest label, and the open direction can be resolved before the popover renders.
  Fixed position because all three open **outward**, away from the panel, and
  `.left-panel`'s `overflow: hidden` clips an absolutely positioned child at the panel
  edge. The viewport's own `.layer-menu` / `.view-menu` keep their content-driven
  widths — they are not part of this assembly.
  - **Submenu** (`.menu li.has-submenu` + a nested `.menu.submenu`): a parent row
    carries a right-aligned `▸` caret in the faint text colour (`#7a828f`, going white
    on hover / while open) and opens its child popover on hover or click, to the row's
    **right** and 4 px above its top — flush with the parent popover's padding, so the
    two read as one surface. It flips to the row's left only when the right side would
    leave the **window** (the panel is resizable, so the room to the right varies).
    Placement and width are the shared hierarchy-popover rules above. The parent row
    stays highlighted while its submenu is open, so the trail from "+" to the chosen
    entry is visible at a glance. The child otherwise reuses `.menu` chrome unchanged,
    so nesting adds a position, not a new surface.
- **Spinner** (`.spinner`): 12 px ring, blue top border, 0.7 s spin.
- **Error banner** (`.error-banner`): dark-red surface + border, for engine
  errors.
- **Warning banner** (`.warning-banner`): amber surface + border, same geometry
  as the error banner. For a condition that left something *out* of an otherwise
  valid result — a §3.3 descriptor cap dropping over-cap zones, volumes,
  sections, or probes. The colour is the load-bearing difference: red means the
  panel below it is empty, amber means it is populated but incomplete, so the two
  must never be styled alike.

- **Score heatmap** (`.aim-heatmap`): a 2:1 canvas of yaw × pitch, 2° per pixel,
  `image-rendering: pixelated` and a crosshair cursor. Pixelated on purpose — smoothing
  would imply an angular resolution the panorama does not have. Hovering it previews that
  orientation in the viewport and **clicking picks it** for Apply, so the canvas is a
  full *input*, not a legend — which is why it takes a crosshair rather than the default
  cursor.
- **Definition list** (`.aim-stats`) and **compact table** (`.aim-summary`): tabular
  numerals, one-line rows, no headers. Used where a panel reports a handful of
  before/after figures and a table header would outweigh the data.
- **Comparison table** (`.aim-summary.aim-compare`): the same table with a header row,
  for the measured per-zone before/after (`aim_optimization.md` §6.3). Deltas are colored
  by direction — `#4de08a` for an improvement, `#ffb84d` for a regression — reusing the
  app's existing success/warning hues rather than inventing a diverging scale, and a
  regression additionally raises the amber `.warning-banner`. The union row is bold. The
  colour is load-bearing: a zone that *lost* coverage is the one finding the user must act
  on, and it must not read like the rows around it.

## Accessibility

- **Semantic roles are expected on every interactive structure:** the hierarchy
  is `role="tree"` / `treeitem` / `group` with `aria-expanded` / `aria-selected`;
  menus use `role="menu"`; the overlay-mode control is a `radiogroup`; the panel
  divider is a `separator`. Preserve these when editing components.
- **Never encode state in color alone.** Camera state carries a text badge
  ("inside geometry"), coverage carries a numeric % and count next to the dot,
  probe visibility uses a ✓/– `.mark` glyph alongside color, and the compute/render
  backend is a labeled badge. Keep the redundant text/glyph cue when you add color.
  **The rule covers opacity too**: a constraint excluded by a group's mount filter
  dims to the *same* ramp as a selected-disabled one, so the group panel spells out
  its overlap percentage in words rather than leaving the viewport to be
  interpreted (`camera_placement.md` §5). It covers **absence** most of all — a
  disabled entity is not drawn at all (spec §2.4.3), so the scene hierarchy's
  dimmed row and unticked box are what say it is still there; never let the
  viewport be the only place an entity is accounted for.
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

**Violet is the constraint family's own hue**, chosen so a constraint is never mistaken
for a sampling volume (teal) in the hierarchy or the viewport. The two look alike — a
named container over child regions, both with enabled checkboxes — but a volume changes
*what is counted* while a constraint only *generates cameras* (`camera_placement.md`
§1.1), and the colour is the first place that distinction is legible.

The **reachable-vs-count curve** (`.placement-curve`) draws the curve in violet, the knee
dot in teal, the selected count in yellow, and the pool ceiling as a dim dashed
asymptote (`#5c6270`) — dimmer than the curve because it is a bound, not a result. It
carries a drawn **value axis** (`.curve-axis`, `#3a4150`) with three ticks labelled as
reachable percentages (`.curve-tick`, `#7c8592`, 8 px, tabular-nums) — the same percentage
the stats below quote, so a curve is never a shape without a scale — and dimmer still than
the ceiling, being the frame rather than the answer. The plot keeps **at least a tenth of its
height empty above the highest value** (`CURVE_HEADROOM = 0.1`, taken in value space so it
survives a height change): the ceiling sits at or near the top of the range, and flush
against the frame it would read as a border rather than as the bound the curve approaches.

Reuse the palette and the `.panel` / `.row` / `.btn` / `.badge` / `Slider`
primitives rather than introducing new colors, fonts, or bespoke controls. New
semantic status → follow the bright-on-dark-same-hue badge pattern. If a value
recurs, lift it into a `:root` custom property. There is no component library or
CSS framework, by design — keep it that way.
