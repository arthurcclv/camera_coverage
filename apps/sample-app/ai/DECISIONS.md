# DECISIONS.md — sample-app

Notable technical decisions for the demo app and their trade-offs. Behavior is
defined in [`../specs/spec.md`](../specs/spec.md); this records *why* the code is
shaped the way it is. Newest at the top when you add to this file.

---

## App's imperative Three.js bridge collapsed behind a `SceneView` module

Behavior in [`../specs/spec.md`](../specs/spec.md) §2–§13 — **unchanged**; this was
a pure structural extraction (no spec edit). `App.tsx` used to *be* the
React↔Three.js bridge: a 175-line "created once" mount effect (viewport + 5 scene
objects + pointer/click/`objectChange` listeners + teardown), ten single-value
"push state into a scene object" effects, inline pick arbitration, an inline
`attachForSelection`, and ~21 `useRef`s that existed only to smuggle live state
into those imperative callbacks. None of it had a seam, so none of it was testable
under `node --test` (the repo's convention), even though that wiring is exactly
where the bugs recorded below kept surfacing.

**Resolution.** A `scene/sceneView/` module presents one small interface —
`create` · `sync(SceneViewState)` · `onSelect` · `onTransform` ·
`resetCoverage`/`addCoverageChunk` · `dispose` — behind which the viewport, all
gizmo sets, the overlay, the pick raycaster, and the listeners now live. App holds
canonical state, bundles it into one immutable `sceneViewState` snapshot, and
pushes it through `sync()` in a single effect; selection and transform edits come
back as resolved events. `App.tsx` dropped from 1474 → 1246 lines and 23 → 9
effects; the ~21 mirror refs are gone (a handful of run/handler refs remain).

**Why `sync()` diffs by reference.** Re-applying every imperative op on every
snapshot would rebuild the overlay/sightlines on unrelated changes (e.g. a camera
drag) — a real perf regression, and perf is part of the interface. So `sync`
compares each field against the previous snapshot by reference and fires each op
only on its own change; App passes every field as stable React state or `useMemo`
output, so reference identity reproduces the old effect dependency arrays exactly.
The first `sync` (no previous snapshot) applies everything — that is the async-mount
catch-up, replacing the old hand-written pre-mount push.

**Why extract `pick`/`transformReadback` as pure helpers.** The two pieces of real
decision logic the bridge owns — nearest-hit arbitration and the volume-size-floor
/ section-bound-pair readback math — moved into pure, unit-tested modules
(`pick.ts`, `transformReadback.ts`); the section bound-pair algebra is precisely
the class of math that carried the "mirrored along its in-plane Z axis" sign bug
below, and now has a test surface. The `SceneView` class itself stays untested,
like `viewport.ts`. **Trade-off:** one large snapshot recomputed each render (cheap
— it's object-literal assembly) and a per-field diff inside `sync` instead of
React's effect scheduler; accepted for a single testable seam and a 230-line
lighter `App`. The overlay is owned by SceneView but still fed by the run path via
`resetCoverage`/`addCoverageChunk`; folding all four retained-chunk consumers
behind one coordinator was left as a separate future step.

## Sections are finite boxes, sized by sliders and moved by free 3-axis drag

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.1–13.3, §13.6, §13.8, §14.3.
A section used to be a slab that spanned the **whole workspace** in-plane; only its
thickness and along-normal position were adjustable. It is now a bounded axis-aligned
**box** with a finite in-plane footprint (`minA/maxA/minB/maxB` on `Section`, relative
to the orientation's in-plane axes), on top of the existing thickness/normal bounds.

**Interaction split.** Width/height are panel sliders (`SectionPanel`), matching the
existing thickness slider — each holds the footprint's center on its axis and grows
symmetrically. Position is the viewport `TransformControls`, now unlocked from the old
collapse-axis-only constraint to **free 3-axis translate**; the drag handler decomposes
the box center into all three axes and moves each bound-pair as a unit (`App.tsx`
`onObjectChange`). Sizing changes extent about a fixed center; dragging changes the
center — complementary, never overlapping. We rejected custom viewport resize handles:
`TransformControls` has no box-resize mode, and sliders reuse an established pattern.

**Cells snap to the grid.** `computeSectionCells` selects the voxel columns whose
in-plane position falls inside the footprint (via `axisIndexRange` on both in-plane
axes), so the texture dims are the *selected* column counts and the footprint snaps to
column boundaries. It returns the grid-aligned `extentA/extentB` so `sectionGizmos`
sizes the plane/outlines to exactly the drawn cells. The footprint params are **optional**
on `computeSectionCells`/`SectionHeatmapStore.computeCells` (absent → whole grid), which
keeps the aggregation callable with just the slab fields and matches the pre-footprint
behavior; real callers always pass a full `Section`.

**Defaults & back-compat.** A new section (and an orientation switch) defaults the
footprint to the **full** workspace-AABB extent on both in-plane axes — uncapped, unlike
the 5 m-capped thickness — so it looks identical to the old full-workspace slab until
shrunk. Scene files omit-tolerant: a section with no `minA/maxA/minB/maxB` parses to
`NaN` and `resolveSectionFootprints` fills the full extent once the imported geometry's
AABB is built (`sceneIO`), so pre-feature files load unchanged. No format-version bump.

**Clip unchanged.** The CAD cross-section (§13.9) stays a full-scene band along the
normal; the footprint bounds the heatmap only, not the clip.

## `solidDetection` is hard-coded off in the demo

Behavior in [`../specs/spec.md`](../specs/spec.md) §3.2 / §4.2. The app now inits
the SDK with `solidDetection: false` (via `initConfig()` in `engine/useEngine.ts`).

**Why.** The SDK's flood-fill SOLID detection seeds a BFS from the workspace
boundary and marks any empty voxel it can't reach as `SOLID_GEOMETRY` — it assumes
closed objects float in open space reachable from the boundary. A watertight room
*inverts* that assumption: its free space is enclosed by walls/floor/ceiling, so
the entire interior (cameras included) gets classified `SOLID_GEOMETRY`, every
in-room camera is flagged `CAMERA_INSIDE_GEOMETRY`, and coverage reads 0. The
built-in room is open-top so it happened to work, but imported closed rooms (§14)
broke. Turning solid detection off keeps enclosed interiors `EMPTY_SPACE`.

**Why it's safe.** Occupancy never determines visibility in the SDK — visible /
blocked always comes from BVH ray casting (SDK spec §6.2 invariant). The only thing
lost is culling of voxels truly buried inside a solid; those still report 0
coverage via ray casting, they just also count toward the valid denominator.

**Why not a UI toggle.** No user benefit — solid detection is a preprocessing
optimization, not a feature; the failure mode (silently zeroed coverage) is exactly
what a demo must never show. One hard-coded value, tested in `test/initConfig.test.ts`.

## Frustum wireframe renders for the selected camera only

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.3. Previously every enabled
camera drew its `CameraHelper` frustum wireframe; with more than a couple of
cameras the viewport became a thicket of overlapping frustums that obscured the
scene and the coverage overlay.

**Resolution:** a camera's frustum is visible **iff that camera is selected**. All
cameras still draw their clickable body sphere (unchanged selection target and
TransformControls attach point), so viewport click-selection is untouched. The
whole rule is one predicate — `helper.visible = selected` in
`scene/cameraGizmos.ts` — replacing the old `helper.visible = !disabled`.

**Why selection alone, not selection-plus-exceptions.** We considered keeping the
frustum for *disabled* cameras hidden even when selected (old §5.4) and keeping
*flagged* (`CAMERA_INSIDE_GEOMETRY`) cameras' red frustum always on as a warning.
Both were rejected in favor of a single rule: selecting a disabled camera *reveals*
its frustum (you select it precisely to inspect/re-aim it — its body stays dimmed
so you can still tell it's disabled), and a flagged camera's **red body** carries
the warning while its frustum, like every other camera's, appears only on
selection. Fewer exceptions, less clutter, one thing to reason about.

## Viewport View selector: four persistent cameras, ortho views locked, framing fit-once, state transient

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.4. The viewport gained a
top-middle **View selector** (Perspective / Top / Front / Right) alongside the
existing single perspective camera.

**Resolution:** the top/front/right views are **true `OrthographicCamera`s**
(parallel projection — the CAD/DCC convention), not the perspective camera
snapped to an axis. `viewport.ts` holds all four as **persistent camera
objects**; `setActiveView` re-points the OrbitControls (`.object`),
`TransformControls.camera`, and — via a new `activeCamera` getter — the picking
raycaster in `App.tsx`. Ortho views are **locked axis-aligned**: orbit disabled,
left-drag remapped to pan, wheel dollies `camera.zoom`. Each view **auto-fits the
scene bounds once** on first activation, then keeps its own pan/zoom (persistent
objects make this free); a resize re-derives each ortho frustum's left/right from
a stored base half-height so remembered framing keeps its scale. Editing stays
enabled in every view. The auto-fit unions only the **finite, non-empty**
top-level scene objects and skips the TransformControls helper — otherwise the
coverage overlay's InstancedMesh (a non-finite box while it holds no instances,
pre-run) or the gizmo's huge guide-line geometry would poison the ortho frustum
and render the scene as an invisible speck; the grid keeps a sane frame when no
other geometry is present. A passive **orientation gizmo** — the Three.js
`ViewHelper` (labeled X/Y/Z axis balls, with the negative-axis sprites swapped
for hollow colored rings) — is pinned bottom-left with `.camera` reassigned to
the active view each frame; its `handleClick` is intentionally never wired, so it
stays read-only (no click-to-snap that would fight the locked-ortho design).
`ViewHelper.render` handles the WebGPU viewport y-origin itself. The bundled
addon types lag the r16x runtime (reassignable `camera`, `location` corner,
WebGPU `render`), so the instance is cast to the members used.

**Why a pure `viewCameras.ts` split.** The fitting geometry (axis conventions,
frustum-from-bounds, aspect re-derivation) lives in `scene/viewCameras.ts`,
importing core `three` so it unit-tests under `node --test`
(`test/viewCameras.test.ts`), while `viewport.ts` keeps the `three/webgpu`
renderer/DOM/controls glue — mirroring the `transformSpace.ts` / `viewport.ts`
split. **Why transient.** The selected view is viewport UI state, like the layer
toggles — it is **not** written to `scene.json` and resets to Perspective on
load, so the scene-file schema stays focused on scene data (no format bump).
Keyboard shortcuts and an interactive view-cube were considered and deferred
(the dropdown + a passive triad cover the request without a keymap or a control
that fights the locked-ortho design).

---

## Camera enabled state moved onto the entity (from a side `disabledIds` set) so it persists

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.4, §14.1, §14.3. Camera
enable/disable previously lived in an app-level `disabledIds: Set<string>` in
`App.tsx` — separate from the camera entity — while sections and zones carried an
`enabled` flag on their own records. That split meant camera disabled state was
**not written to `scene.json`** and was lost on every save/load, unlike sections/zones.

**Resolution:** `SceneCamera` gains an `enabled: boolean` field (like `Section.enabled`
/ `Zone.enabled`); the `disabledIds` state, its ref, and all its plumbing are deleted.
Toggling, deleting, and duplicating a camera are now plain entity edits — duplication
inherits `enabled` for free via the verbatim copy, and the compute path filters
`cameras.filter(c => c.enabled)` before `setCameras()`. `toCameraConfig` strips
`enabled` alongside `name` at the SDK boundary. In `scene.json` the flag is **optional
on read (default `true`)** and **omitted on write when `true`** — only `enabled: false`
is written — matching the `name`/`clipRange`/`zone.enabled` omit-on-write precedent, so
**no format-version bump** (still `2`) and old files load with all cameras enabled.

**Why on-entity, not a persisted side array.** A single source of truth (the entity)
keeps cameras consistent with the other toggleable entities, lets the existing
serialize/parse and duplication paths carry the flag with no special-casing, and removes
the class of bug where the side set drifts from the camera list (stale ids on delete,
missed inheritance on duplicate). Scope was deliberately held to cameras: geometry
per-object disable was considered but deferred (it needs geometry identity + a hierarchy
surface + workspace-bounds handling); probes/volumes gained no flag (disabling neither
affects compute).

---

## Transparent-layer draw order pinned centrally; depth-writer first, depth test resolves the rest

Behavior in [`../specs/spec.md`](../specs/spec.md) §9, §13.5;
[`../specs/volumetric_rendering.md`](../specs/volumetric_rendering.md) §1, §4. The
scene has three overlapping `transparent:true` layers — the section heatmap plane, the
coverage voxel fog, and the sampling-volume fill. Left to Three.js's default, transparent
objects are sorted by bounding-sphere center distance to the camera, which **flips with
viewpoint**: in some views the section plane sorted *after* the fog and over-painted it.
There is no fixed render order that fixes this, because the correct order is
viewpoint-dependent.

**Resolution:** stop relying on the transparency sort and let the **depth buffer** decide.
Only the section plane writes depth (`depthWrite:true`); the fog and fill are
`depthWrite:false`/`depthTest:true`. So the plane must draw **first** to lay its depth
down, after which the fog and fill depth-test against it — correct per-viewpoint occlusion,
no `depthWrite`/`depthTest` changes needed. The only thing pinned is *order*, via explicit
`renderOrder` (plane 1 → fog 2 → fill 3), fog-before-fill so a fill tints over the fog.

**Why a dedicated `scene/renderOrder.ts`.** The three layers live in three unrelated
modules (`sectionGizmos.ts`, `volumetric.ts`/`coverageOverlay.ts`, `samplingVolumeGizmos.ts`);
their relative order is only correct when read together, so the constants live in one file
all three import. The generic `volumetric.ts` primitive stays visualization-agnostic — it
gains a `setRenderOrder(n)` that just forwards to its mesh (persisted so it survives the
mesh being rebuilt on buffer growth); the *value* comes from the caller. Objects not listed
(bound outlines, wireframe edges, camera/probe gizmos) keep the default order 0 — harmless
as they are thin or sit elsewhere.

---

## Section cells are three-way (colored / obstacle-black / no-data-transparent), valid data wins

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.3, §13.5, §13.7. A section cell
is no longer binary valid/black. `computeSectionCells` scans a column's in-zone voxels
and classifies it: **colored** if it holds ≥ 1 valid voxel (aggregating those, ignoring
any obstacle/no-data voxels sharing it — *valid data wins*), else **transparent** if any
voxel is no-data (no retained chunk) or the column is empty (all out-of-zone), else
**black** (entirely obstacle — a fully-solid column). No-data wins over obstacle in a
valueless column. The cell carries a `black` flag (only meaningful when `!valid`);
`sectionHeatmapTextureData` writes opaque black for obstacle, **alpha 0** for transparent.

**Why valid-wins over the old "any invalid → black".** The previous rule blacked a whole
column if *any* voxel was invalid, which framed heatmaps in black wherever a slab poked
past a shorter sampling volume or grazed geometry. Making coverage dominate shows data
wherever it exists; only genuinely dataless columns disappear (transparent) and only
wholly-solid columns read black. **Rendering:** the heatmap material gains
`alphaTest: 0.01` (`sectionGizmos.ts`) so alpha-0 texels write neither color nor depth
(true see-through, no occlusion of the overlay/other sections), while stale-dimmed colored
cells (opacity 0.35) survive the test. Needs manual **WebGPU** verification — the CPU
tests can't exercise the three.js WebGPU render path. **Stats:** the region-of-interest
total is colored + obstacle; transparent cells are excluded (like out-of-zone skips), so
`SectionStats` replaces `invalidCells` with `obstacleCells`.

## Duplicate: a pure copy module, deep-copying children, with app-level state left in App

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.5. The hierarchy row context menu gained a
**Duplicate** action (above Delete) for all five kinds. The copy logic lives in a pure
`scene/entityDuplication.ts` module (`duplicateCamera`/`Probe`/`Section`/`Volume`/`Zone` +
`nextFreeId`, moved out of `App.tsx`), so it is unit-testable under `node --test` without rendering
`App` — matching the repo's pure-module test convention. The `App.tsx` handlers are thin wrappers
that apply the returned entity via the existing setters.

**Copy is verbatim + coincident.** The copy carries every property as-is (including `name` — a
blank name stays blank and auto-derives its label from the new id) and the full
position/rotation/size, so it lands exactly on the original. Honors "exactly the same property"
literally; the user then drags it via the gizmo. No positional offset convention was introduced.

**State that lives outside the entity record is decided per case.** A section's clip status
(`clipSectionId`, single-valued scene-level) does **not** transfer — the copy is never the clip. A
camera's `enabled` flag rides **on the entity** (see the enabled-state decision above), so a
disabled camera duplicates to a disabled one automatically via the verbatim copy — no App-side
special-casing. A zone **deep-copies its child volumes** (fresh ids, pointing at the new zone) so
the copy is truly identical; a duplicated volume stays in the **same zone**.

**Stale-marking is not explicit.** Duplicating flows through the same `setCameras`/`setVolumes`
setters as add/delete, so the existing cameras/volumes `useEffect`s mark the result stale — a
camera, a volume, or a non-empty zone marks stale; a probe, section, or empty zone does not, with no
new stale plumbing.

---

## Viewport-layer visibility consolidated into an eye-button dropdown

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.4. The three separate top-right icon
buttons (Overlay / Section / Gizmos) were replaced by a single **eye icon button** that opens a
`ViewportLayerMenu.tsx` checklist: **Coverage / Sections / Cameras / Zones**. Toggling a checkbox
flips the layer immediately and leaves the menu open (closes on outside-click / Escape / re-click).

**Why.** Three always-visible buttons crowded the toolbar and had no room to grow; a dropdown
scales as layers are added. It also gave a natural home for the previously-missing **Zones** toggle
(sampling-volume gizmos), which had no viewport control at all. "Overlay"→"Coverage" and
"Gizmos"→"Cameras" were renamed so every row reads as the *thing* it hides, consistent with the new
"Zones" and "Sections" rows.

**Scope of "Zones".** Drives the `SamplingVolumeGizmoSet` `group.visible` only — purely visual,
independent of the `useZones` compute setting and per-zone enabled state, exactly as "Cameras" is
independent of per-camera enable/disable. `update()` never resets `group.visible`, so the toggle
survives re-renders (regression-tested in `test/samplingVolumeGizmos.test.ts`). Visibility state is
viewport-only React state, not persisted to the scene file. The menu reuses the existing `.menu`
popover chrome (add-entity / context menus); rows are always present and toggling an empty layer is
a no-op.

---

## All scene geometry rendered double-sided, glTF `side` overridden

Behavior in [`../specs/spec.md`](../specs/spec.md) §4.1, §14.6. Every renderable mesh in the
built geometry group — procedural floor/walls/boxes **and** loaded glTF meshes — has
`material.side` forced to `THREE.DoubleSide`. A single exported helper `forceDoubleSided(root)`
in `sceneGeometryBuild.ts` traverses the group once in `finishBuild` and flips `side` on every
mesh material (handling the material-**array** case). It is the **only** place `side` is set:
the previously hardcoded `side: THREE.DoubleSide` on `wallMat` was removed so there's no second
source of truth.

**Why override the glTF's own `side`.** §14.6 otherwise preserves glTF materials verbatim, and
this is the one deliberate exception. Single-sided back-face culling makes surfaces vanish when
viewed from behind — looking at the open-top room from inside, or a section clip cutaway (§13.9)
exposing a wall/box interior face. Forcing double-sided keeps every surface visible from both
sides. Only `side` is touched; all other authored material properties (color, roughness, maps)
are preserved. There is **no** capping of clipped solids, so a sliced box reads as hollow-but-
shaded rather than see-through — an accepted trade-off, not a bug.

**Not affected.** The coverage/collision path is untouched — `side` is purely a render property;
occlusion still uses the merged `SceneMesh` triangles. The volumetric coverage volume
(`volumetric.ts`, `BackSide`) and the section/sampling-volume gizmos are separate objects outside
the geometry group and keep their own `side`.

---

## Editable entity names: on-entity for the app, converted at the SDK boundary

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.6, §12.1, §13.1, §14.3. Cameras,
probes, and sections each carry an editable display `name` **on the entity** (like the
existing `Zone.name`), resolved for display by `cameraLabel`/`probeLabel`/`sectionLabel`
(trimmed, blank → default `Camera N`/`Probe N`/`Section N`). The tree, panel titles, and
every per-camera stat list (`StatsPanel`/`SectionStatsPanel`/`ZonePanel`, plus the probe
visibility list) resolve the id to the name via a `cameraNameById` map App builds from
`cameras`.

**Why on-entity and not a side map.** The camera is the tricky one: `CameraConfig` is the
**SDK** input type, and the headless engine keys cameras only by `id`. The first design
kept camera names in a `Scene.cameraNames` side map to leave `CameraConfig` untouched. We
rejected it: the scene-file `cameras` array need not match the SDK type, so instead the app
models a camera as its own `SceneCamera` (`cameras/camera.ts`) = `CameraConfig` + `name`
and **converts to a plain `CameraConfig` (dropping `name`) only at the `setCameras()`
boundary** (one `.map(toCameraConfig)` in `App.tsx`). This makes cameras symmetric with the
other entities, kills the sparse-map + orphan-prune special case (a name dies with its
entity), and every other camera consumer reads the superset unchanged. Renaming is a pure
label write — never a coverage input, never marks the result stale (like a zone rename).

**Scene file.** `name` is optional on read (blank/missing → default) and **omitted on
write when blank** (`stripBlankName` in `sceneFile.ts`), so unnamed entities add no noise.
Additive and back-compatible → **no format-version bump** (still v2), like
`clipRange`/`clipSectionId`. **Volumes are deliberately excluded** — auto-generated boxes
are low-value to name; volume rows keep their raw `volume-N` id.

## Section cells apply the zone filter before validity

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.3 and
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §7.3. In
`computeSectionCells` the zone filter runs **before** `isValid`: an out-of-zone voxel is
skipped (not aggregated, not classified); the cell aggregates only its in-zone valid
voxels. (Which non-colored outcome a valueless column gets — transparent vs black — is
the three-way rule in the newer entry above; this entry is only about the zone-vs-validity
*order*.) **Why the order:** with zones active the SDK samples only the enabled
volumes' neighborhood, so out-of-zone voxels are *unsampled* → `isValid === false`,
indistinguishable from obstacles. Checking validity first (the first attempt) blacked
every out-of-volume voxel — the all-black bug. Zone-membership must decide first.
Consequence: obstacles outside the ROI are skipped like any out-of-zone voxel; only
in-ROI obstacles stay black. A horizontal section over a shorter volume then shows the
ROI's coverage instead of going all-black. With no zones `marked` is null — unchanged.

## Section clip hides geometry via a ClippingGroup, chosen by a scene-level id

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.9. A section's clip hides scene
geometry outside a band along its normal. The renderable geometry group is a
**`three/webgpu` `ClippingGroup`** (`sceneGeometryBuild.ts`) whose two inward-facing world
planes clip every descendant mesh uniformly (`setGeometryClippingPlanes`); the band comes
from the pure helper `sectionClipBand()` (`sectionHeatmap.ts`, no THREE import), a width
centred on the cut plane so it follows the slab. **Why `ClippingGroup`, not
`Material.clippingPlanes`:** the WebGPU renderer (our only render path) **ignores**
`material.clippingPlanes`/`renderer.localClippingEnabled` (legacy WebGLRenderer API) —
WebGPU clipping is driven only by `ClippingGroup` scene nodes.

**Which** section clips is a single scene-level `clipSectionId` (`string | null`), toggled
by a Clip button in `SectionPanel` — not a per-section flag, not selection. The App effect
keys off `[clipSectionId, sections, room]`. **Why:** this replaced a per-section
`clipEnabled` + selection-gating that blinked the clip out when you selected a
camera/probe and let two sections clip at once; one id makes "at most one clips"
structural. A dangling id (deleted section / stale import) resolves to no clip
(`sceneFile.ts`/`handleDeleteSection` coerce to `null`). Independent of heatmap visibility;
never triggers `compute()`.

## Bottom-right legend is dual-purpose: section legend, else coverage-overlay legend

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.2/§13.6/§9. `HeatmapLegend`
renders as a floating `.viewport-legend` overlay at the viewport bottom-right (a third
overlay beside the two top toolbars, §2.4) rather than as a right-sidebar panel, and
shows **one of two legends, or nothing**:
- **Section legend** when `sectionLegendVisible(sectionsVisible, sections, clipSectionId)`
  holds — the master toggle is on **and** `clipSectionId` references an existing,
  **enabled** section (§13.9). Turbo bar; scale is selection-driven (§13.6).
- **Coverage-overlay legend** when the section legend is *not* shown **and** the coverage
  overlay is visible (`overlayOptions.visible`, §9) — the overlay's hue-intensity ramp
  (coverage mode) or solid swatch (blind-spots mode) via `overlayLegendScale(hue, mode)`.

**Why:** the widget always describes whatever coverage visualization is actually on
screen — the clipped section heatmap when you're inspecting a slice, otherwise the voxel
overlay — and docks to the viewport (not the sidebar scroll) since it annotates the 3D
scene. The section gate depends on the **global `clipSectionId` state, not on the clip
UI** (the `SectionPanel` need not be open — the state persists across selection), and its
**`enabled`** check aligns the section legend with what is drawn: a section's heatmap
plane renders only when the master toggle is on **and** that section is enabled
(`sectionGizmos.ts`), so a disabled clip section shows no section legend (the coverage
legend may still take over). Resolving the id to a **real** section (rather than merely
`clipSectionId != null`) guards a dangling clip id from a malformed scene import. The
coverage legend must reflect the overlay's **hue-intensity** appearance (§9.2), not the
Turbo colormap — which is why the gradient rides on `LegendScale` and `HeatmapLegend`
is a dumb renderer; in blind-spots mode intensity is fixed, so it shows a solid swatch
with no fraction scale rather than lying with a `0..1` ramp. Content is otherwise
presentational — the gates never touch `compute()`. It stays an opaque `.panel` card
(plus a drop shadow to lift it off the 3D scene) rather than a translucent HUD, for
consistency with every other panel and guaranteed readability over bright cells.

## Section legend labels track the selected section's aggregation

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.5/§13.6. The colorbar is a
fixed Turbo gradient (value→color is always the linear `0..1` mapping), but its tick
labels and caption are derived at render time in **one of two modes**, split into two
pure builders that both return `{caption, ticks:[{label, pos}]}`:
- `sectionLegendScale(aggregation, cameraCount)` — **section mode**: a **camera count**
  `0..N` for `mean`/`max`/`min` (N = the retained run's enabled-camera count, i.e. the
  coverage-fraction denominator; count `k` sits at position `k/N` because the mapping is
  linear), or a **percentage** for `blind`. It delegates to `coverageLegendScale()` when
  `N` is unknown (no aggregation / no run yet).
- `coverageLegendScale()` — **coverage mode**: the plain coverage **fraction** `0..1`.

Both live in **`heatmapLegend.ts`** (not `sectionHeatmap.ts`), and the caller (App)
picks the mode — section scale when a section is selected, coverage scale otherwise.
**Why the split & the module:** the widget serves two conceptually different scales
("how many cameras see this" vs. an abstract `0..1` coverage fraction); folding both
into a section-named function/module read as section-only and hid the coverage case, so
the generic colorbar (`turboColormap`, the scale builders, `LegendScale`) now lives in a
neutrally-named module and the component (`HeatmapLegend`) is a dumb renderer. Only the
coverage aggregations map to a count, so section mode is aggregation-aware rather than a
single global relabel. Camera-count ticks use an adaptive "nice" step (1/2/5/10/…)
targeting ~5–9 labels, always including 0 and N. The tick math is pure (no React) so it
is unit-tested directly (`test/heatmapLegend.test.ts`); the component only positions the
returned ticks. Labels are positioned absolutely along the bar (not flex
`space-between`) since an adaptive step can leave the final gap uneven.

## "% of full" denominator comes from full-volume sampling, not the run

Behavior in [`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §6.3/§7.4.
When zones are active the SDK samples only the boxes' neighborhood (§7.1), so the
retained `ChunkResult`s never cover the workspace — deriving the "% of full"
denominator from them would divide the marked count by the box union (≈100%,
inverting the tool's payoff). Instead `EngineState.fullValidVoxels` snapshots the
SDK's full-volume `SamplingStats.validVoxels` at init/re-init; the box-restricted
`setSampling` of a run updates `samplingStats` but deliberately leaves it untouched.
`computeZoneCoverage` therefore reports only what its chunks support (per-zone +
enabled-union summaries) and no longer a workspace-full count. **Why:** re-init is
exactly when the workspace valid count can change (`voxelSize` or geometry), so the
snapshot is always current, and no separate full-workspace pass is needed.

## Sampling zones with zero SDK changes

Behavior in [`../specs/sampling_volumes.md`](../specs/sampling_volumes.md). The
region-of-interest tool (editable oriented boxes grouped into zones, each with its
own coverage results) lives **entirely in the app** — the SDK was not touched.
Three choices make that possible:

**Narrow SDK to box AABBs; refine rotation client-side.** The run derives the SDK's
existing `{ type: 'box' }` sampling regions from the **world AABB** of every
volume's OBB (`regionsFromVolumes`), so the SDK computes only the boxes'
neighborhood. Rotation — the one thing the SDK's axis-aligned regions can't express
— is an app-side filter (`makeMarkedFilter` → `inVolume`) over the retained masks.
**Why:** no new OBB region type in the engine; a rotated box costs only a small
conservative over-compute that the client-side marked-set filter trims back. (An
OBB SDK region is explicitly out of scope, `sampling_volumes.md` §13.)

**Per-zone results are client-side aggregation, one compute pass.** Visibility is
per-voxel and grouping-independent, so a single `setSampling`/`compute` over the
union of all volumes suffices; `ZoneCoverageStore` (a 4th retained-chunk consumer
alongside the overlay, probe, and section stores) partitions the masks per zone in
one pass (`computeZoneCoverage`), producing per-zone summaries plus the
enabled-zones union. **Why:** zones never change *what* the SDK computes, only *how*
the app aggregates it — so adding/renaming zones or enabling/disabling a zone is
client-side only, no recompute.

**App-side BVH from public SDK building blocks.** "Generate from geometry" builds
its own BVH from the merged collision mesh via the already-exported `cleanMesh` +
`buildBvh` (identical to the worker's — both use the default TS kernels) and walks
the flattened node array (`extractZonesAndVolumes`) to cut zones/volumes at two
levels. **Why:** nothing new crosses the worker boundary; the walk is pure and
unit-testable against a hand-built node array. The built BVH is cached per `room`
and re-cut on level-slider changes without rebuilding.

**Enabled zones are a client-side re-filter, not a recompute.** Each zone has an
independent `enabled` flag (like cameras/sections), decoupled from selection; the
visualized marked set is the **union of the enabled zones**. The overlay
(`setMarkedFilter`) and section columns (a `marked` predicate → black outside the
union) filter the retained masks by that union; the main StatsPanel overrides its
coverage numbers from the enabled-union summary. Enabling/disabling or renaming a
zone never marks the result stale — only volume/zone-membership/`useZones` changes
set the sampling-dirty flag that triggers a re-run. (This replaced an earlier
single-"focus" model — All-zones-or-one — with the more consistent multi-enable
union.)

---

## Removed the "Reset to default" button

**Decision:** dropped the in-app Reset action from `SceneFileControls`/§14.7 —
Import and Export are the only scene-file controls now. `defaultScene()`
remains (it's still the boot-state source, spec §14.1), but nothing in the UI
calls it anymore; the only way back to the default scene is reloading the
page. **Why:** requested directly — Reset was the one action with no file-I/O
counterpart (Import/Export both round-trip a real folder), and duplicated
"just reload" for a scene that's already fully described by
`defaultGeometry()`/`defaultCameras()`. `applyScene` (the shared
replace-the-whole-Scene helper) is unaffected — Import still goes through it;
it just lost its second caller.

---

## Scene file (§14): `room` became state, geometry has no id, cancel is soft

Implementing import/export surfaced three scoping decisions (Reset also
existed at the time; it's since been removed — see above):

**`room` (the built geometry) is now `useState`, not a `useMemo` constant.**
Before §14, geometry never changed at runtime, so `buildRoom()` was memoized
with `[]` deps and several effects/callbacks listed `room` in their dependency
arrays purely to satisfy referencing it (one had a stale eslint-disable
comment). Making it real state meant the big Three.js setup effect — written as
"created once" but literally depending on `[room]` — would tear down and
recreate the entire `WebGPURenderer`/orbit camera/gizmo sets on every scene
replacement if left alone. Fix: that effect no longer depends on `room` at all
(reads it via `roomRef` for its one-time initial add); a new effect keyed on
`[room, viewportReady]` owns adding/removing `room.group` from the scene, so a
geometry swap only replaces geometry, never the viewport itself. Every other
effect/callback that already listed `room` in its deps needed no change — they
were already written correctly for a reactive `room`, just prematurely.

**Geometry objects carry no `id`; cameras/probes/sections do.** The spec's own
`scene.json` sketch (§14.3) omits `id` from every geometry entry. This matches
§14.9 (geometry isn't selectable/editable, has no hierarchy row) — there's
nothing to reference a geometry object *by*, so id uniqueness validation
(`sceneFile.ts`) only checks within `cameras`/`probes`/`sections`, independently
per category (the same id may repeat across categories).

**"Cancel any in-flight compute" (§14.4) is soft-cancel, not true abort.** The
SDK/worker (`engine/useEngine.ts`) exposes no cancellation primitive — the
worker has no message to stop a running `compute()`, and adding one is an
SDK-level change outside this feature's scope. Instead, `App.tsx` keeps a
`runGenerationRef` bumped by every `applyScene` call (import); `handleRun`
snapshots it and re-checks after every `await` and inside `onChunkDone`,
discarding a superseded run's results and — critically — refusing to feed its
streamed chunks into a newer run's (just-replaced) retained-data stores, which
would otherwise silently mix two scenes' data under colliding
chunk ids. The underlying worker computation still runs to completion; only its
observable effects are suppressed.

---

## Fixed bug: section heatmap mirrored along its in-plane Z axis

**Bug:** `horizontal` and `vertical-x` sections rendered their heatmap mirrored
along whichever in-plane axis was Z — the column holding the smallest world-Z
data drew at the largest-Z position and vice versa (`vertical-z` was unaffected,
since Z is its collapse axis, not in-plane). **Root cause:** `PlaneGeometry`'s
UV increases with local X/Y, `DataTexture` defaults to `flipY = false` (texture
row/column 0 = data index 0 = the smallest axisA/axisB index per
`computeSectionCells`), and the plane group's rotation (`rotation.x = -π/2` for
horizontal, `rotation.y = +π/2` for vertical-x) happened to map *increasing*
local coordinate to *decreasing* world Z. A single-axis rotation has only one
sign to get right, and it was wrong for two of the three orientations. **Fix:**
flipped both signs (horizontal → `+π/2`, vertical-x → `-π/2`); this also flips
which way the plane's normal points, so the min/max bound-outline offsets
(along local Z) needed a compensating sign per orientation too — see
`sectionPlaneRotation`/`collapseAxisNormalSign` (`sectionHeatmap.ts`). **Why it
lived here and not `sectionGizmos.ts`:** moved out of the Three.js layer into
the pure module specifically so it could get a real regression test
(`test/sectionHeatmap.test.ts`, using plain `three`'s actual `PlaneGeometry`/
rotation math, not hand-derived expected values) — the bug was caught by
running the app, not by type-checking or hand-checking the algebra, which is
exactly the class of mistake pure-function extraction + tests is meant to catch
next time.

## Section range control: a single thickness slider, not dual min/max handles

**Decision:** `SectionPanel`'s range control is one `Slider` for **thickness**
(0.1–5 m). Changing it keeps the slab's center (`(min+max)/2`) fixed and grows
`[min, max]` symmetrically; position is changed only by the viewport drag
(§13.8), never by this panel. `defaultRangeForOrientation` likewise caps a new
section's (or newly-reoriented section's) default extent to 5 m, centered on
the axis, instead of the raw workspace-AABB span. **Why:** an earlier iteration
used a dual-handle min/max slider (first over the raw workspace extent, then
over a fixed ±10 m window relative to the slab's own live-recomputed center) —
both were replaced. The absolute-workspace version had wildly different,
sometimes-asymmetric bounds per orientation (Horizontal's Y extent is roughly
-0.8..6.5, Vertical X/Z's is roughly ±10.8). The center-relative version
displayed each edge as an offset from `(min+max)/2`, which is a mathematical
tautology (the two offsets are always exact negatives of each other) — editing
one edge silently changed where the *other* edge's displayed offset read on the
next render, which is correct but easy to misread as a bug. A single thickness
value sidesteps both problems entirely: there's only one number, it can't
misrepresent position as a side effect, and its bounds are simple and constant.
**Trade-off:** thickness is capped at 5 m — a slab that needs to be thicker (or
positioned so its default would have exceeded that) isn't reachable from this
control; only the viewport drag moves it, and only within [0.1, 5] m thick.

## Sections read retained run results, via their own retained-chunk store

**Decision:** `sectionHeatmap.ts`'s `SectionHeatmapStore` retains the current
run's `ChunkResult`s and enabled-camera list independently of
`probeVisibility.ts`'s `ProbeVisibility`, rather than sharing one store — it's
fed in `handleRun`'s `onChunkDone` alongside the overlay and probe stores as a
third, parallel consumer. **Why:** probes need a single-point lookup; sections
need to walk whole voxel *columns*, including across chunk boundaries when the
collapse axis is X or Z (Y never crosses a chunk, since chunks span the SDK's
full Y extent). Sharing one class would conflate two different access patterns
for a small amount of duplicated retention bookkeeping. `VoxelAccessor`s are
cached per chunk id within a store (`chunkLocalForGlobalIndex`, shared with
`probeVisibility.ts`, factors out the global-index → chunk-local math both need).

## Turbo-style colormap: control points, not a fitted polynomial

**Decision:** `turboColormap` (`heatmapLegend.ts`) is a piecewise-linear
interpolation over 8 hand-picked RGB control points (dark blue → cyan → green →
yellow → orange → dark red), not Google's published degree-5 polynomial
approximation of the real Turbo colormap. **Why:** the polynomial's exact
coefficients weren't reliably reproducible from memory, and shipping wrong
constants under the "Turbo" name risked a colormap that silently didn't match
its own description (dark blue at 0, red at 1) at the endpoints. The control-point
version is exact-by-construction and cheap to verify (`test/heatmapLegend.test.ts`
checks the exact endpoint colors). **Trade-off:** not pixel-identical to Google's
Turbo, but satisfies the spec's requirement (a single global perceptual colormap,
dark blue → red, visually distinct from the black used for invalid cells).

## Section drag: axis-constrained TransformControls via showX/Y/Z

**Decision:** selecting a section sets `TransformControls.showX/showY/showZ` so
only the collapse-axis handle is visible/draggable (all three reset to `true`
for camera/probe selections); the attach target itself is never rotated, so
local and world space coincide and the space toggle has no visible effect while
a section is selected (matching spec §13.8's "space toggle ignored"). On
`objectChange`, the new slab midpoint is read directly off the target's position
on that axis and min/max are derived by keeping thickness (`max - min`) fixed,
rather than accumulating a drag delta — avoids drift across many small ticks.

## THREE.LineLoop is unsupported by this renderer

**Known limitation, not a decision:** this project's `WebGPURenderer` (via
`three/webgpu`, both its WebGPU and WebGL2-fallback paths) does not support the
`THREE.LineLoop` primitive — it logs `"Objects of type THREE.LineLoop are not
supported"` and draws nothing. Discovered by actually running the app (a
Playwright smoke pass) while building the section bound outlines. `sectionGizmos.ts`
draws each outline rectangle as 4 disjoint `THREE.LineSegments` pairs instead.
Keep this in mind before reaching for `LineLoop` anywhere else in `scene/`.

## Spec-first, like the rest of the repo

The app is implemented from `specs/spec.md` (+ `specs/volumetric_rendering.md`),
which is the source of truth. Behavior changes update the spec first and get
approval before implementation — see [WORKFLOWS.md](./WORKFLOWS.md) and the root
`CLAUDE.md`.

## React owns state; Three.js objects are dumb sinks (no react-three-fiber)

**Decision:** React `useState` in `App.tsx` holds the canonical data; `scene/*`
objects are plain Three.js classes updated imperatively via
`update()`/`setOptions()` inside effects, with `useRef` mirrors bridging live
state into imperative callbacks. **Why:** the SDK and Three.js are inherently
imperative and stream results through callbacks; wrapping them in a declarative
scene-graph library (r3f) would fight both. **Trade-off:** manual synchronization
between React state and scene objects, accepted for a reference demo. (That
synchronization — originally `useRef` mirrors + per-value push effects in
`App.tsx` — was later collapsed behind the `SceneView` bridge; see the
`SceneView` entry at the top of this file.)

## Two independent WebGPU surfaces, each with its own fallback

**Decision:** the Three.js **render** backend (`WebGPURenderer`, main thread) and
the SDK **compute** backend (worker) are chosen and fall back independently —
render → WebGL2, compute → CPU reference — and both are surfaced in the stats
panel. **Why:** they are genuinely different subsystems; forcing them to agree
would hide useful information and couple two unrelated fallbacks.

## Single Three.js instance via a Vite alias

**Decision:** `vite.config.ts` aliases bare `three` → `three/webgpu`
(regex matches the exact specifier only). **Why:** the renderer needs the
`three/webgpu` build (`WebGPURenderer` + node/TSL system); without the alias,
`buildRoom`, the gizmos, and addons (OrbitControls/TransformControls) would pull
in a *second* core `three` copy — breaking cross-build interop and doubling the
bundle. `three/webgpu`, `three/tsl`, and `three/addons/*` resolve normally.

## Volumetric overlay: instanced cubes + TSL, order-independent

**Decision:** one `InstancedMesh` of a unit cube, one instance per voxel, with
per-instance `center`/`half`/`intensity`/`color` as `InstancedBufferAttribute`s
(grown by doubling); a TSL node material slab-tests the view ray per fragment to
get a chord through each voxel. **Why:** a single draw call for the whole overlay,
compiling to WGSL or GLSL from one shader. Rendered `depthWrite:false`,
`side: BackSide`, `frustumCulled:false` so it needs no sorting/OIT and survives
the camera being inside the fog. **Two composite modes** exist — `additive`
(soft, uses chord) and `max` (hard cubes, chord dropped); **`max` is the default
and the app does not expose a UI toggle** for it. A pure-TS reference
(`slabChord`, `voxelContribution`, `compositeContributions`) is the tested truth
the TSL graph mirrors.

## Auto-run as a throttled poll

**Decision:** a 10 Hz `setInterval` fires a recompute when inputs are stale and
the engine is idle/error-free, rather than recomputing synchronously on every
slider tick; the voxel-size input is additionally debounced 250 ms. **Why:**
implements the spec §8.1 throttle and keeps dragging smooth without flooding the
worker.

## Probes read retained run results, not fresh raycasts

**Decision:** per-point visibility is decoded from the retained masks of the most
recent completed run, against a snapshot of that run's enabled-camera id list
(`probeVisibility.ts` decodes all mask words up to 128 cameras). **Why:** reuses
the authoritative engine result instead of a parallel, possibly-divergent client
raycast. **Trade-off:** results can go stale after inputs change — the UI shows a
stale hint and a "recompute" prompt.

## Buffers are cloned before load

`initAndLoad` clones the room mesh's typed arrays before `loadScene`, because the
SDK transfers them across the worker boundary and would otherwise detach the
app's copy.

---

## Known code/spec notes

- The stale badge reads "Recompute — inputs changed" (spec says just
  "Recompute").
- `CoverageOverlay.addChunk` assumes `camWords === 1` (≤ 32 cameras) for its
  popcount; probe visibility correctly decodes all words up to 128. The demo's 10
  cameras keep the overlay within that assumption.
- The volumetric composite mode `max` is the built-in default with no UI toggle;
  only overlay mode / color / intensity are user-facing.
