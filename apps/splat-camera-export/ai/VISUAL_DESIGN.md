# VISUAL_DESIGN.md — splat-camera-export

The UI's visual rules. Deliberately aligned with `apps/sample-app` so the two tools read
as one product family. All values live in `src/index.css`.

## Intent

A **dark, quiet instrument panel** beside a bright 3D viewport. The splat is the
content; the chrome should recede. Nothing in the UI competes with the render for
attention, and no control is larger than its importance.

## Palette

Custom properties on `:root`, with `color-scheme: dark`:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#14161a` | App background, sidebar. |
| `--surface` | `#1c1f25` | Panel background. |
| `--surface-2` | `#23272f` | Inputs, buttons, badges — one step up from panel. |
| `--border` | `#2f343d` | All borders and dividers. |
| `--text` | `#e6e8ec` | Primary text. |
| `--text-dim` | `#9aa1ad` | Hints, labels, metadata. |
| `--accent` | `#4ea1ff` | Focus rings, active state, progress fill. |
| `--accent-dim` | `#2b5f96` | Active/primary button fill (accent as a *background* is too loud). |
| `--warn` | `#ffb74d` | Size warnings. |
| `--error` | `#ff6b6b` | Error notice border. |
| viewport | `#0d0f12` | Darker than the panels, so the render reads as the focal plane. |

The **export background colour** is user state, not a design token — it is authored in
the render settings and defaults to `[0.08, 0.09, 0.11, 1]` (≈ `#14171c`), matching
`--bg` so previews and exports agree.

### Marker colours (3D, not CSS)

Camera gizmos use their own triple, chosen to stay legible against arbitrary splat
content: selected `#ffbf33`, enabled `#66ccff`, disabled `#737380`.

## Typography

One family: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.

| Role | Size | Weight | Notes |
|---|---|---|---|
| App title | 15px | 600 | `letter-spacing: -0.01em`. |
| Panel title | 11px | 600 | Uppercase, `letter-spacing: 0.06em`, `--text-dim`. |
| Body / controls | 13px / 12px | 400 | Base is 13px, controls 12px. |
| Field label | 10px | 400 | Uppercase, `letter-spacing: 0.05em`. |
| Hint | 11px | 400 | `line-height: 1.4`. |
| Metadata, badges | 10px | 400–500 | |

**Numeric fields and camera metadata use `font-variant-numeric: tabular-nums`** so
values don't jitter as they change.

## Spacing & layout

- Grid: `320px` sidebar + `1fr` viewport, full height.
- Sidebar padding `12px`; gap between panels `10px`.
- Panel padding `10px`; gap within a panel `8px`.
- Control rows gap `6px`; field label→input gap `3px`.
- `--radius: 5px` everywhere; `3px` for the progress bar.

Panels are a flat vertical stack — no accordions, no tabs. The order follows the task:
**Source → View → Alignment → Cameras → Render → Export → notices**. Alignment sits
above the camera list because it must be right before any export means anything.

## Components

- **`.panel`** — bordered surface with an uppercase title; the only container.
- **`.btn`** — 12px, `--surface-2`. `.btn-primary` and `.btn-active` both fill with
  `--accent-dim` and border `--accent`. `.btn-small` for list actions. Disabled is
  `opacity: 0.45` with a default cursor.
- **Radio groups** are rendered as adjacent buttons with `role="radio"` and
  `aria-checked`, not native radios — they read as a segmented control.
- **`NumberInput`** — a text field (not `number`), holding a draft string while focused
  and committing on blur/Enter, reverting on Escape or an unparseable value. Unfocused
  it shows a trimmed, fixed-digit value. `inputMode="decimal"`.
- **`.camera-row`** — checkbox, label (ellipsized), metadata, optional `off` badge.
  Selected fills `--accent-dim`; coverage-disabled dims the label only.
- **`.notice`** — 2px left border in `--accent` (or `--error`), with a dismiss button.
  Errors are never modal and never `alert()`.

## Accessibility

- Every interactive element is keyboard-reachable, with a visible
  `outline: 2px solid var(--accent); outline-offset: 1px` focus ring.
- Camera rows are `role="option"` inside `role="listbox"`, `tabIndex={0}`, and respond
  to Enter/Space; the row's checkbox stops propagation so toggling never changes
  selection.
- Progress is a `role="progressbar"` with `aria-valuemin/max/now`.
- Icon-only and ambiguous controls carry `aria-label` (the dismiss `×`, each
  include-in-run checkbox naming its camera).
- Toggle buttons expose `aria-pressed`; segmented controls expose `aria-checked`.
- State is never carried by colour alone: disabled cameras also show an `off` badge, and
  the active view mode is a pressed button, not just a tint.
