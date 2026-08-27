# DECISIONS.md — sample-app

Notable technical decisions for the demo app and their trade-offs. Behavior is
defined in [`../specs/spec.md`](../specs/spec.md); this records *why* the code is
shaped the way it is. Newest at the top when you add to this file.

---

## Displayed coverage numbers come from one derivation, not per-call-site picks

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.5, §10 and
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §7.4.

**Why.** Two readouts show a camera's coverage rate: the stats panel's "Per
camera" list and the hierarchy row's badge (and its dot color). App built the
zone-aware summary inline for the stats panel but passed the raw SDK summary to
the hierarchy, so with zones active the same camera reported two different
percentages — the badge over the whole sampled volume, the panel over the marked
set. Nothing was wrong with either number; they just answered different
questions without saying so. **Decision:** `scene/statsDisplay.ts` owns the
choice, App derives once, and both consumers read that. A third readout gets
consistency by construction instead of by remembering.

**Trade-off.** A whole module for what was an inline ternary. It buys a unit
test on the rule (`test/statsDisplay.test.ts`) — App's JSX has none — and makes
the invariant structural rather than conventional.

**Related.** `hierarchyPerCamera` drops the badge when the marked set is empty:
`computeZoneCoverage` divides by `validVoxels`, so a zone marking nothing yields
`0` for every camera, and `0%` would read as "this camera sees nothing" instead
of "there is nothing to see". The stats panel still lists its `0.0%` rows, where
the adjacent `Valid voxels: 0` supplies that context.

## The coverage overlay decodes `maskWords`, and every mask consumer must

Behavior in [`../specs/spec.md`](../specs/spec.md) §9, §9.1, §16.

**Why.** `CoverageOverlay.addChunk` built each leaf's `camCount` from
`popcount32(mask)`, where `mask` is `forEachLeaf`'s **word 0** — cameras 0–31 only.
Above 32 enabled cameras that silently dropped every camera from index 32 up:
voxels seen only by those cameras got `camCount === 0`, so Coverage mode rendered
them at intensity 0 (invisible) and Blind spots mode drew them as **false blind
spots**. The overall coverage rate looked correct throughout, because that number
comes from `CoverageSummary` (engine Pass 3, which reads all words) — which is what
made the bug hard to spot. **Decision:** the overlay reads the SDK's `maskWords`
argument through a new `popcountWords()` helper, and reduces it to a scalar
`camCount` at traversal time since `maskWords` is accessor-owned scratch.

**Rule for new code:** anything decoding a camera mask iterates `camWords`. The
other consumers already did (`probeVisibility.ts`, `sectionHeatmap.ts`,
`samplingVolumes.ts` all loop via `getMaskWord`); the overlay was the one holdout
because it is the only `forEachLeaf` caller in the app. `popcount32` remains
exported for callers that genuinely hold a single word.

## Hierarchy reordering is a hand-rolled pointer drag over the existing arrays — no order field, no DnD library

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.5.1.

**Why no `order` field, and no format bump.** The tree is *derived* from the canonical
arrays (`buildSceneTree`) and `serializeScene` writes those arrays in order, so display
order already round-trips through `scene.json`. Adding an explicit `order` per entity
would introduce a second source of truth that has to be kept consistent with the array on
every add/delete/duplicate/import — for zero gain. Reordering a row is therefore just a
splice, and `formatVersion` stays `2`. The cost is that §14.3 now *guarantees* the
`volumes` array's zone-interleaving is preserved, which was previously only an accident of
`addVolume` appending.

**Why hand-rolled pointer events over `@dnd-kit`.** dnd-kit's real value-add is keyboard
reordering, screen-reader announcements, auto-scroll, and collision detection. We
deliberately declined the keyboard path (the tree has no keyboard navigation to hang it
on — see below), and every remaining decision is custom: within-group-only validity, a
zone dragging as a subtree, no-indicator-means-no-op, and a fixed insertion line rather
than live reflow. That left the library supplying ~40 KB and a sortable model built for
flat or explicitly-nested lists, most of which we'd be overriding. ~200 lines of
`pointerdown → threshold → pointermove → pointerup` is the smaller total.

**Why the action carries `beforeId`, not `toIndex`.** For cameras/probes/sections/zones
the two are equivalent. For volumes they are not: a zone's rows are a *filtered* view of a
zone-interleaved global array, so an index is ambiguous about which basis it's in — and
that's precisely where the bug would live. `{ kind, id, beforeId | null }` is declarative
and the reducer resolves the position itself.

**Why reordering marks nothing stale.** Coverage results are keyed by entity id, not array
position, and the camera/volume *sets* are unchanged — so array order cannot affect any
computed output. It sits in the same class as `renameEntity`.

**Why no keyboard equivalent.** A genuine keyboard reorder needs a focusable tree with
roving tabindex and arrow-key navigation; that is the whole keyboard-navigation project,
not a bolt-on. A shortcut that works only when something happens to be selected would fire
from anywhere in the app (including the 3D viewport) and read as half-built. Documented as
an explicit limitation in §5.5 instead.

**Why the insertion line rather than live reflow.** Reflowing the list under the cursor
means the row rects being hit-tested move while you're hit-testing against them — the
classic jitter source in hand-rolled sortables. The dragged row dims in place and the list
holds still until the drop commits.

---

## "Place on surface" tests only the geometry, places the raw hit point, and names its supported kinds in one list

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.4.2. A one-shot toolbar tool: arm it,
click the scene geometry, and the selected entity's position becomes the point clicked.

**Why a geometry-only ray.** The existing pick raycasts the gizmo sets, and reusing it
would have been less code — but a camera body parked in front of a wall would then
occlude the wall the user is trying to place on, and the tool's whole value is naming a
*surface* directly. So it raycasts `room.group` alone; gizmos and the coverage overlay
are transparent to it. The corollary is that hits are filtered against the active clip
band (§13.9) in `surfaceHit.ts`: `Raycaster` knows nothing about clipping planes, so
without that filter the ray would land on geometry the clip has hidden and the resulting
position would appear to come from nowhere.

**Why the raw hit point, with no normal offset.** A small step along the surface normal
was the safer engineering choice and was rejected deliberately. A position lying exactly
on a surface can float-error into the geometry's interior, self-occluding a camera's rays
(≈0% coverage for it) or dropping a probe into an obstacle voxel (reads as invalid,
§12.2). Offsetting would hide that — but it also makes the tool's contract fuzzy: the
position you get is no longer the point you clicked, and the offset distance becomes
another number to explain and tune. The tool does the literal thing, and the panel's
numeric fields are one nudge away. Recorded as accepted behavior in the spec, not a bug.

**Why the supported kinds are a list, not a condition.** `PLACEABLE_KINDS` in
`scene/placement.ts` is the single place camera+probe is stated; `canPlace` is a type
predicate over it, and App's handler switches exhaustively with a `never` default. Adding
a kind to the list therefore *fails to compile* until it has an action of its own. The
alternative — an `if (kind === 'camera' || kind === 'probe')` at each use site — drifts
silently, and the excluded kinds each have a real reason to stay out (a section is bounds
not a point; a zone has no transform; a volume's `position` is its box centre, so a
surface hit buries half the box).

**Also decided here:**

- **The gizmo detaches while armed** rather than staying interactive. Leaving it up means
  the region around the selected entity can't be clicked — exactly the region you want
  when nudging a camera onto a nearby wall — and makes "does this drag move it or aim the
  ray?" ambiguous.
- **A miss is a no-op that stays armed.** Clipping the edge of the mesh is a mis-aim, not
  a cancel, and it must not deselect either. Mechanically this falls out of SceneView
  emitting nothing on a miss: App disarms only on a *delivered* point.
- **Placement is routed through `changeCamera`/`changeProbe`, not a new action or a
  `TransformChange`.** The existing actions already carry the right recompute coupling
  (a camera edit latches `stale`, a probe edit deliberately doesn't, §12.5), so the tool
  inherits it instead of restating it. `TransformChange`'s camera variant demands a
  `rotation` the tool never changes, which would have meant reading the current rotation
  back just to echo it.
- **It works in the Selected view**, the one exception to §2.4.1's inert clicks. Safe
  because placement never changes the selection, so it can't eject the view. Note what
  that view constrains: an active Selected view always implies a selected *camera*, so
  the only thing placeable there is the camera being rendered through — aim it at a wall,
  click, and it mounts there while the viewport jumps to the new vantage point. It does
  reinstate the click-vs-drag threshold in a view that otherwise has no use for one, so
  an aim drag places nothing.
- **Escape is scoped, not global.** The listener mounts only while armed and ignores
  events targeting a form field, because Escape is already the numeric fields' revert key
  (§5.2.1) and those keydowns bubble to `window`.

---

## Save writes back to the folder the scene was opened from, and the target is session-only

Behavior in [`../specs/spec.md`](../specs/spec.md) §14.5, §14.7. The app now tracks a
**save target** — the folder a successful import (or Save As…) established — and plain
**Save** writes `scene.json` into it with no picker. `Save As…` picks a folder and
retargets; both pickers pass `startIn: <target>` and a stable `id`.

**Why:** neither picker used to pass `startIn` or `id`, so both fell back to Chrome's
per-origin "last directory used by any picker". Saving to a scratch folder once made it
the default destination for every later save, and the round-trip a user actually wants —
open a scene, edit, save it back — was two dialogs and a chance to misfile the file.
The target makes "where does Save write?" answerable without opening a dialog to find
out.

**Trade-off:** the target is deliberately **not** persisted, even though directory
handles are structured-cloneable and could live in IndexedDB. A reload restores the
*boot* scene (§14.1) but would restore a target pointing at a real scene folder — one
click of Save would then overwrite that scene with the default room. Persisting the
target is only coherent alongside persisting the scene, which reverses §14.1's
"no folder is opened at boot". So a reload costs one re-pick; that beats a data-loss
footgun.

**Also decided here:**

- **Write permission is requested lazily, on the first save** — import keeps
  `mode: 'read'`, so opening a scene to look at it never asks for permission to edit
  files. `ensureWritePermission` runs as the first `await` in the Save handler, inside
  the click's user activation.
- **Overwrite confirmation keys off the picker, not the button.** Any write to a folder
  chosen from a picker in that same interaction confirms if `scene.json` exists;
  an established target never does. Keying it off the *button* would have left the
  boot-state Save fallback (Save with no target → picker) unguarded — the one path most
  likely to drop the default room on top of someone's real scene. The directory picker,
  unlike `showSaveFilePicker`, warns about nothing itself. `window.confirm` is used
  deliberately: the app has no modal component, and building one for a single string
  isn't proportionate.
- **A failed save keeps the target** (§14.8) rather than clearing it or immediately
  reopening the picker: a re-mounted drive or a re-granted permission then just works on
  retry, and one accidental "don't allow" doesn't discard a good target.
- **A silent Save needs a visible acknowledgement.** Removing the dialog removed the
  only success signal, so the Scene panel's status line names the target and flashes
  "Saved to <folder>". Full dirty-state tracking ("unsaved changes") was rejected as
  much larger than this change — it needs every edit path to mark the scene modified.
  Only the handle's leaf `name` is available, so the line can never show a full path.

## Save As… copies the scene's referenced assets, so the destination is self-contained

Behavior in [`../specs/spec.md`](../specs/spec.md) §14.5. A save into a folder that
isn't the current target copies every `gltf` asset the scene references from the target
folder to the same relative path in the destination, before `scene.json` is written.

**Why:** export used to write `scene.json` alone, so a Save As… into a fresh folder
produced a scene file that could not be reopened — every `gltf` `src` was a dangling
reference (§14.5) to a file still sitting in the original folder. "Save this scene
somewhere else" only means something if the somewhere-else is loadable.

**Why the target is the asset source:** nothing retains the GLB bytes — `buildGltfPieces`
hands each `ArrayBuffer` to `GLTFLoader` and drops it — so a copy has to re-read from
disk. The save target is exactly the folder the current scene's assets live in (import
sets it; Save As… retargets only *after* a successful write), so no second handle is
needed. A scene with no target provably has no assets to copy: `gltf` objects can only
arrive via import (§14.9 forbids in-app geometry authoring), and import always sets a
target.

**Trade-offs:**

- **Referenced paths only, deduplicated** — not the whole `assets/` folder. Follows the
  request ("files being referenced"), and makes a Save As… prune assets the scene no
  longer uses. The cost is that a file the user *thinks* of as part of the scene but
  that nothing references is left behind.
- **Assets copy before `scene.json`, and any failure aborts the save.** A destination
  with no `scene.json` is visibly incomplete; one holding a `scene.json` whose assets
  are missing looks complete and fails only on the next import. Already-copied bytes are
  deliberately *not* rolled back — deleting them could remove a file the copy had
  legitimately overwritten.
- **Existing assets in the destination are overwritten, but disclosed first.** The
  single overwrite confirmation now reports the `scene.json` and/or the count of
  referenced assets it would replace. Skipping clashes instead would have been
  non-destructive but silently wrong — the saved scene would reopen with whatever
  same-named mesh already lived there. Faithfulness beats preserving a file the user
  never asked to keep, provided it's stated before the write.
- **Picking the current target in Save As… is an in-place save** (`isSameEntry`): no
  copy, no confirmation. Copying a folder onto itself has nothing to do, and confirming
  the replacement of the scene you already have open is noise.
- Streaming (`file.stream().pipeTo(writable)`) rather than buffering each GLB, since
  scene assets are routinely tens of megabytes. The existing spinner covers the wait;
  per-file progress was not worth new UI.

## Rotation and FOV fields display 2 decimals, like every other pose field

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.2.1. The camera and volume
rotation `Vec3Field`s and the camera FOV slider were the only numeric fields left at
`digits={0}`; they now read 2 decimals, matching position, size, and range.

**Why:** the fields already *accepted* fractional degrees (text entry commits the
exact typed value, and a gizmo drag or an Euler⇄quat round-trip routinely produces
one), but the readout truncated them — a 45.25° pitch and a 45° pitch were
indistinguishable in the panel, and re-reading a rotation you had just typed showed a
different number than you entered. Uniform precision across every pose field also
removes the "which fields round?" question from the panel.

**Trade-off:** rotations now read `0.00` / `-0.00` rather than `0`, which is noisier
for the common case of an axis-aligned camera. Accepted — legibility of a value that
*is* fractional beats tidiness of one that isn't, and `-0.00` is the same sign artifact
the position fields have always shown. The no-op guard needed no change: it compares
against `value.toFixed(digits)`, so it simply tightens with the digits.

## The thickness slider's cap (30 m) is decoupled from a new section's default (5 m)

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.2. `MAX_SECTION_THICKNESS`
rose from 5 m to 30 m so a slab can aggregate across a whole room, and
`defaultRangeForOrientation` now clamps to a separate
`DEFAULT_SECTION_THICKNESS = 5` instead of to the slider's max.

**Why the split:** the two numbers had been one constant, which read as economical
until the cap moved. `min(axisExtent, cap)` with a 30 m cap makes every new section
in the default room (~20.6 × 6.6 × 20.6 m workspace) span its full collapse-axis
extent — a horizontal section would open as the entire floor-to-ceiling volume
rather than a slab, so the slab reading of a section, and the two outline planes
that convey it, would be lost on creation. Keeping the default at 5 m preserves
what a new section looks like today; the cap is now purely a ceiling on what the
user can widen it to. This also supersedes the "capped at 5 m" trade-off recorded
in *Section range control: a single thickness slider* below.

**Trade-off:** two constants where a reader might expect one, so a future change to
"how thick can a section be" has to decide which of the two it means. The doc
comments on both constants name the distinction to keep that decision explicit.

## The Selected view renders through the selected camera, and its drag aims it

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.4.1 (+ §5.2 for the gesture,
§5.3 for the hidden gizmo). A fifth View-selector entry renders the viewport from
the currently selected camera, answering "what does this camera see?" directly
rather than via the frustum wireframe and the overlay.

Decisions worth recording:

- **Live-bound to the selection, with no empty state.** The view derives entirely
  from `selection` + `cameras`, so there is nothing to remember and nothing to
  invalidate; walking the camera list walks the rig. The cost is one invalid
  combination — `activeView === 'camera'` with a non-camera selection — closed on
  both sides: the menu row is disabled when no camera is selected, and App reverts
  to Perspective if the selection stops being a camera. Neither the renderer nor
  the gizmo code ever sees a "camera view with no camera".
- **`'camera'` is a `ViewId`, not a parallel boolean.** A separate flag would allow
  `activeView: 'top'` + `cameraViewActive: true`. The cost was that
  `Exclude<ViewId, 'perspective'>` silently stopped meaning "the ortho elevations" —
  hence the explicit `OrthoViewId`, and `isOrthographic` becoming a whitelist rather
  than `!== 'perspective'`, which would have misreported this perspective view as
  orthographic.
- **A dedicated `PerspectiveCamera`, not the gizmo set's mirror object.**
  `CameraGizmoSet` already keeps a `PerspectiveCamera` per camera with the exact
  pose and lens, which is tempting to just render through. But this view needs the
  *fit* FOV (see below), and mutating the gizmo's FOV would corrupt the
  `CameraHelper` wireframe the other views draw from it.
- **The rendered FOV is derived, and the frame guide comes from the same call.** A
  camera's 16:9 rarely matches the viewport, so rendering at its exact FOV either
  crops the image or fills the viewport with scene it cannot see. `fitCameraView`
  expands the FOV until the true image fits with `CAMERA_VIEW_PADDING` on the
  binding axis and returns the guide rect alongside it — one computation feeding
  both, so the outline can never drift from the render. The guide is returned as
  *fractions*, so the DOM overlay is pure percentages and survives resizes.
  `CAMERA_VIEW_PADDING` is its own constant rather than a reuse of `FIT_PADDING`:
  same shape, different job (a deliberate band of context, not breathing room).
- **Clip planes are the viewport's, not the camera's.** Rendering at the camera's
  `far` would be defensible — it *is* the detection range — but it makes a large
  scene unreadable, and the overlay already conveys range.
- **Navigation is replaced by aiming, so clicks go inert.** With orbit off, a drag
  has no other job, so it aims the camera (yaw/pitch, ±89° clamp, roll preserved —
  the invariants `CameraPanel` already enforces). Making clicks inert then costs
  nothing and closes a trap: deselect-on-miss would eject the view to Perspective
  mid-task. It also means no click-vs-drag threshold applies in this view.
- **The drag is mouselook, not grab-the-world.** Both directions were built; the
  aim following the pointer won. The sensitivity is FOV-derived either way, but the
  *reason* differs and only one survives the flip: grab-the-world justified it by
  pinning the scene point under the cursor (true only for that direction, and only
  exactly at the image center, since the projection is nonlinear across the frame),
  whereas mouselook justifies it as "a drag spanning the image sweeps one field of
  view" — an angular claim that holds everywhere. The consequence to keep in mind is
  that the ±89° pitch clamp is now hit routinely rather than exceptionally: the
  default rig sits at −28° and downward is the natural drag, so the clamp is a
  working part of the gesture, not an edge guard.
- **The drag accumulates locally, but emits every move.** It reuses the
  `TransformChange {kind:'camera'}` path so the panel ticks live and `stale` latches
  as usual — but re-reading the rotation from state each move would drop deltas that
  arrive within one React batch, so the in-flight orientation is held in the gesture
  and the absolute rotation is emitted from it.
- **Suppression is per-camera, not a layer flag.** Only the camera being rendered
  through hides (its body and frustum are degenerate at the eye point); the others
  keep drawing, which is what makes their placement in this camera's field of view
  visible. Hence a `suppressedId` argument to `CameraGizmoSet.update` rather than
  hiding the group.

---

## Slider value readouts are editable text fields (shared `NumberInput`)

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.2.1 (+ cross-refs in §5.2, §6,
§13.6, and [`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §3.4). Every
`Slider` kept its read-only value chip after the pose fields moved to `Vec3Field`;
that chip is now an editable text field so any slider-backed value (FOV, range, voxel
size, section thickness/footprint/reveal, octree levels) can be typed exactly.

Decisions worth recording:

- **One shared `NumberInput`, not a second copy of the commit/revert logic.** The
  focus-draft + blur/Enter-commit + Escape-revert behavior already lived (privately)
  inside `Vec3Field`. It was extracted to `NumberInput.tsx` and both `Vec3Field` and
  `Slider` consume it, so the subtle caret/no-op handling has a single home. The one
  axis the two field kinds differ on is a `seed: 'display' | 'full'` prop.
- **Slider fields seed the full stored value on focus; vector fields seed the rounded
  display.** A slider value can hold precision the readout hides (a typed FOV 42.375 in a
  2-decimal field). Re-focusing seeds that full value via `seedFieldValue`, trimmed to
  ≤6 decimals with trailing zeros stripped — lossless for real edits, and it also hides
  float noise from a viewport drag (`0.30000000000000004 → "0.3"`). Vector fields keep
  the rounded seed so their no-op guard (compare-against-displayed) is unchanged.
- **Exact value, clamp to range only — never snap to step.** Text entry is precisely the
  affordance the slider step denies, so the committed value is the parsed number clamped
  to `[min, max]` and nothing more. **Integer sliders are the exception:** an `integer`
  slider (zone/box octree levels) rounds after clamping, because a fractional level is
  meaningless downstream. FOV also has `step=1` but is *not* integer — step alone doesn't
  imply it, so the caller declares `integer` explicitly.
  The no-op re-check happens *after* rounding, so typing `2.4` at level 2 marks nothing
  stale.
- **`seedFieldValue` is a pure function in `numberField.ts`**, unit-tested at the same
  `node --test` seam as `commitNumberField`/`resolveFieldCommit` — no DOM harness, matching
  the existing "logic in a pure module" pattern. The React `NumberInput` stays thin glue.

## Position / rotation / size are numeric text fields, not sliders

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.1, §5.2, §5.2.1, §12.3 and
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §6.1. The camera,
probe, and volume editors used one `Slider` per axis for position, Euler rotation,
and (volume) size. Sliders can't express an exact value and were capped to arbitrary
UI ranges (camera Pos X ±12 m, etc.) that could be smaller than the scene needs.

**Resolution.** Every X/Y/Z and yaw/pitch/roll triplet is now a `Vec3Field` — a
group label (Position / Rotation / Size) plus three numeric text fields on one row.
FOV and Range stay sliders (single scalars that were always bounded).

Decisions worth recording:

- **Commit on blur/Enter, revert on Escape; a focused field holds the raw typed
  string.** Two forces drove this over live-per-keystroke commit: every edit marks the
  run stale and re-renders the scene (one commit per edit, not per keystroke), and the
  rotation Euler is re-derived from the quaternion on each render — committing mid-type
  would round-trip through `quatToEuler` and **overwrite the caret**. Holding the draft
  string while focused (and not overwriting it from props) sidesteps both; unfocused
  fields still track the live value, so gizmo drags update the numbers.
- **Rotation columns are axis-correct (X=pitch, Y=yaw, Z=roll), reordered for display
  only.** `eulerToQuat`/`quatToEuler` still speak `{yaw,pitch,roll}` in `YXZ` order
  (`cameras/math.ts` unchanged) — the label/order change is purely presentational.
- **Clamp meaningful, free the rest.** Pitch stays ±89° (gimbal) and volume size keeps
  its per-axis voxel floor; position/yaw/roll drop their former slider bounds and accept
  any finite value. Invalid/empty input reverts to the last committed value (never NaN).
- **Parse/clamp/revert *and the commit decision* extracted to a pure `numberField.ts`
  helper.** `commitNumberField` does parse+clamp+revert; `resolveFieldCommit` decides
  whether a focused field's raw string should write at all, returning `null` for a no-op.
  Crucially it compares the raw string against the field's **displayed** value
  (`value.toFixed(digits)`), not the higher-precision stored value — otherwise a
  focus-then-blur on a rotation field showing "45.00" (stored 45.001° from a quat
  round-trip) would spuriously commit 45 and mark the run stale on a zero-edit
  interaction. **Why a
  pure helper:** it makes the only interesting logic unit-testable under `node --test`
  (`test/numberField.test.ts`) without a DOM harness — the `Vec3Field` component and the
  three panels are thin glue, matching the existing "logic in a pure module" pattern
  (`leftPanelSplit.ts`). (The spurious-commit case above was caught in code review
  precisely because it originally lived in the untested React glue; moving it into
  `resolveFieldCommit` both fixed it and covered it with a regression test.)

## The section legend describes the clipping section and needs a retained run

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.5/§13.6. The bottom-right
section legend used to key its scale off the **currently-selected** section and fall
back to a plain Turbo "Coverage fraction" bar whenever `N` was unknown — including
before any run. So adding a section and enabling clip (no run yet) showed a Turbo
colorbar labeled "Coverage fraction" describing a plane that draws **nothing** (every
cell transparent until a run is retained), and selecting a different entity blanked or
changed the legend even though the *clipping* section's heatmap was what was on screen.

**Resolution.** Two changes, both in `heatmapLegend.ts` + `App.tsx`:
- The legend now describes the **clipping section** (`clipSectionId`), never the
  selection — its aggregation drives the caption, and its retained run's
  `cameraIds.length` drives `N`.
- It **requires a retained run**: no cell grid → the legend is hidden (`null`), not a
  placeholder. Since nothing is drawn pre-run, there is nothing to describe.

The legend-selection logic moved out of an inline IIFE in `App.tsx` into a pure
`chooseHeatmapLegend(clipSection, clipGrid, overlay)` builder in `heatmapLegend.ts`,
returning `LegendScale | null`. **Why:** it makes the "which legend, or none" decision
unit-testable (`test/heatmapLegend.test.ts`) instead of buried in JSX, and keeps the
precedence explicit — an enabled clipping section claims the slot (hiding the widget
when it has no run, rather than falling through to the overlay legend); only when no
section is clipping does a visible overlay show its legend. The one surviving fallback
is defensive: a run retained with **zero** enabled cameras (`N=0`) still uses the plain
fraction scale to avoid a `k/0` tick position. `heatmapLegend.ts` imports only *types*
from `sectionHeatmap.ts` (the builder takes already-resolved `Section`/`SectionCellGrid`
values), so the existing `turboColormap` import back the other way stays acyclic.

## A `CoverageRun` coordinator owns the retained-chunk consumers + the run guard

Behavior in [`../specs/spec.md`](../specs/spec.md) §9, §12–§13, §14.4;
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §7 — **unchanged**;
a pure structural extraction (no spec edit). A `compute()` streams `ChunkResult`s
that three pure stores retain in parallel — `ProbeVisibility`,
`SectionHeatmapStore`, `ZoneCoverageStore` — each reset per run and read on demand.
`App.tsx` used to `new` all three, wire the identical reset/addChunk/clear fan-out
across `handleRun`/`applyScene`, read each store from its own `useMemo`, and guard
a mid-run scene swap with a raw `runGenerationRef` checked at five points. That
run orchestration was, after the `sceneReducer` extraction, the last non-document
orchestration left in App.

**Resolution.** `scene/coverageRun.ts`. `CoverageRun` constructs and owns the
three stores, fans out `reset`/`addChunk`/`clear` over a shared `RetainedRun`
interface, fronts their reads (`sectionCells`/`probeQueries`/`zoneCoverage`), and
owns the generation guard: `generation` (the token `handleRun` snapshots before
its awaits) + `isCurrent(token)`, with `clear()` — the scene-replace path from
`applyScene` — both wiping the stores and bumping the generation so an in-flight
run's later chunks are dropped (spec §14.4). `reset()` (run start) deliberately
does **not** bump, since the run snapshotted its token first. App's three store
`useMemo`s collapse to one `new CoverageRun()`; `runGenerationRef` is gone.

**Scope.** The **overlay** — the fourth chunk consumer — stays in `SceneView`
(created async, `viewRef.current` may be null), driven inline by App
(`resetCoverage()`/`addCoverageChunk()`) right beside the coordinator calls. To
satisfy `RetainedRun`, `ZoneCoverageStore.reset` gained an unused `grid` param
(zone coverage decodes chunks by their own origin/dims). `masksVersion` stays in
App — bumping a version to re-run the derived `useMemo`s is a React concern the
coordinator can't own.

**Trade-off.** `CoverageRun` centralizes the guard *state*, but the *checking
discipline* — snapshot `generation` before the first `await`, re-check after each
engine `await` — stays in `handleRun`, because it interleaves with
`initAndLoad`/`setSampling`/`compute`, which aren't store operations. So the
extraction names the guard behind an API and removes the four scattered
store-wiring blocks, but doesn't make `handleRun` await-guard-free; engine
orchestration legitimately remains App's. Accepted. `test/coverageRun.test.ts`
covers the generation semantics (reset doesn't bump, clear does, `isCurrent`) and
the reset/addChunk/clear fan-out end-to-end against real stores.

## The four gizmo sets share a `GizmoSet` spine

Behavior in [`../specs/spec.md`](../specs/spec.md) §5.3, §12.4, §13;
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §5 — **unchanged**;
a pure structural extraction (no spec edit). The camera, probe, section, and
sampling-volume gizmo sets each reconciled a keyed collection of Three.js objects
against the scene with the *same* create/update/sweep loop, and three of them
repeated the *same* nearest-hit `pickHit` raycast — four copies of the map, the
group, `getAttachTarget`, and `dispose`, with no shared type. `SceneView`, their
sole consumer, hand-branched per kind twice: a pick dispatch that pushed one
candidate per set, and an `attachForSelection` four-way ternary.

**Resolution.** A shared spine in `scene/gizmoSet.ts`. `GizmoSet<E>` owns the
`entries` map, the group, the generic `reconcile` loop, `getAttachTarget`, and
`dispose`; each set supplies only `createEntry`/`disposeEntry`/`attachTargetOf`
and its own `update` signature (which closes over the per-set state — selection,
flags, enabled zones, cell grids — and calls `reconcile`). `PickableGizmoSet<E>`
extends it with the shared `pickHit` for the three viewport-pickable sets;
`SectionGizmoSet` extends the plain `GizmoSet`, since sections are selected from
the hierarchy row, never the viewport (spec §13.8). `SceneView` now holds the sets
behind two minimal interfaces — `GizmoPicker` (a three-set pickable registry, with
the camera's gizmos-hidden guard retained, spec §2.4) and `GizmoAttachable` (a
four-set attach registry keyed by selection kind) — collapsing both per-kind
branches. The dead `CameraGizmoSet.pick()` wrapper (no caller) was removed. A new
`test/gizmoSet.test.ts` covers the spine (reconcile/dispose/getAttachTarget/
pickHit) through a minimal subclass — the first direct coverage of the reconcile
loop for the probe/section shapes, which had none.

**Trade-offs.** A two-level hierarchy (`GizmoSet` → `PickableGizmoSet` → the sets)
plus a template-method `reconcile` is the most indirection of the SceneView-area
extractions — reading `CameraGizmoSet` now means looking one file up for the loop.
Accepted for the dedup, the two-interface SceneView registries (one edit site each
when a fifth gizmo kind lands, not two hand-branches), and the new spine coverage.
Two registries (three pickable, four attachable) encode the real
pickable-vs-attachable split rather than one list with exceptions. A free-function
reconcile helper was considered and rejected: the map/group/dispose state it
operates on is exactly what a base class already holds, so the class keeps it
co-located.

## The editable scene document lives in a pure `sceneReducer`

Behavior in [`../specs/spec.md`](../specs/spec.md) §5, §8.1, §12–§13;
[`../specs/sampling_volumes.md`](../specs/sampling_volumes.md) §4 — a pure
structural extraction (no spec edit) **except two spec-alignment fixes noted
below**. The scene document — cameras, probes, sections, `clipSectionId`, zones,
volumes, `useZones`, plus `selection`, `collapsedIds`, and the
`stale`/`hasRunOnce`/`samplingDirty` flags — used to be ~11 `useState` in
`App.tsx` mutated by ~34 scattered handlers, with the stale-marking rules hidden
in two `useEffect`s keyed on `[cameras, debouncedVoxelSize]` and `[volumes,
useZones]`. None of it was reachable by `node --test`.

**Resolution.** One pure `sceneReducer(state, action)` (`scene/sceneReducer.ts`)
owns that slice via `useReducer`; App destructures it for reading and every
handler is a thin `dispatch`. A fine-grained typed `SceneAction` union carries
each intent; the reducer allocates ids (`nextFreeId`) and calls the
`entityDuplication` helpers. The stale/samplingDirty machine and
selection-follows-CRUD now live in that one transition, unit-tested exhaustively
in `test/sceneReducer.test.ts`.

**Scope split.** The reducer is pure. `App.tsx` keeps the geometry build
(`room`/`geometryObjects`), `voxelSize`, run outputs, the engine, the
run-generation guard, and all impure orchestration (build disposal, retained-chunk
store resets, the Generate BVH, engine calls) — done around each dispatch.
`applyScene` resets the document in one `sceneReplaced` dispatch and does the
impure rest; the debounced `voxelSize` dispatches `markStale`; `handleRun`
dispatches `samplingApplied`/`runCompleted` and reads the live document across
awaits through **one `stateRef`** mirroring reducer state (it replaced the ~7
per-field mirror refs and `samplingDirtyRef`). Folding the run outputs or the
generation guard in was rejected — that is run orchestration (a separate future
step), not the document.

**Two spec-alignment fixes.** The old effects marked stale on any change to the
`[cameras]`/`[volumes]` array *reference*, which over-invalidated in two cases the
reducer now encodes to match the spec/comments (both are wasted-recompute-only, so
they bring code into spec compliance without a spec change): a **camera rename**
marks neither stale nor dirty (spec §5.6 — renames never mark stale — like every
other rename; the old `[cameras]` effect fired on it), and **deleting or
duplicating an *empty* zone** marks neither (only a zone that actually had volumes
is a sampled-set change; the old unconditional `setVolumes(filter)` fired on the
new array reference regardless — duplicate-zone was already guarded).

**Trade-off.** State reads now come from a destructured reducer value and the
async run path reads one `stateRef` snapshot instead of live per-field refs;
`samplingApplied` clears the dirty flag via dispatch rather than a synchronous
ref write (same one-render race the ref version already had). Accepted for a
single tested transition and ~140 fewer lines in `App.tsx`.

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
the thickness, which defaults to 5 m — so it looks identical to the old full-workspace slab until
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

**Stale-marking follows the same rules as add/delete** — a camera, a volume, or a non-empty
zone marks stale; a probe, section, or empty zone does not. (Originally this fell out of the
shared cameras/volumes `useEffect`s; it is now encoded per-action in the `sceneReducer` — see
the reducer entry at the top of this file — with the same outcome.)

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
  holds **and** the clipping section has a retained cell grid — the master toggle is on,
  `clipSectionId` references an existing, **enabled** section (§13.9), and a run exists.
  Turbo bar; scale keyed to the **clipping** section's aggregation, not the selection
  (§13.6). Before a run the plane draws nothing, so the widget is hidden.
- **Coverage-overlay legend** when **no** enabled section is clipping **and** the coverage
  overlay is visible (`overlayOptions.visible`, §9) — the overlay's hue-intensity ramp
  (coverage mode) or solid swatch (blind-spots mode) via `overlayLegendScale(hue, mode)`.
  A clipping-but-not-yet-run section keeps the slot (widget hidden), so it does not fall
  through to the overlay legend.

The three-way choice (section / overlay / none) is a pure `chooseHeatmapLegend` builder
in `heatmapLegend.ts`, not inline JSX — see the top-of-file decision.

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

## Section legend labels track the clipping section's aggregation

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.5/§13.6. The colorbar is a
fixed Turbo gradient (value→color is always the linear `0..1` mapping), but its tick
labels and caption are derived at render time in **one of two modes**, split into two
pure builders that both return `{caption, ticks:[{label, pos}]}`:
- `sectionLegendScale(aggregation, cameraCount)` — **section mode**: a **camera count**
  `0..N` for `mean`/`max`/`min` (N = the retained run's enabled-camera count, i.e. the
  coverage-fraction denominator; count `k` sits at position `k/N` because the mapping is
  linear), or a **percentage** for `blind`. It delegates to `coverageLegendScale()` only
  in the defensive `N=0` case (a run retained with no enabled cameras); the widget is
  hidden outright before any run rather than showing this fallback (§13.6).
- `coverageLegendScale()` — **coverage mode**: the plain coverage **fraction** `0..1`.

Both live in **`heatmapLegend.ts`** (not `sectionHeatmap.ts`); the `chooseHeatmapLegend`
builder there picks the mode — the section scale keyed to the **clipping** section (once
a run exists), the overlay scale when no section is clipping, or none.
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
(0.1–30 m; originally 0.1–5 m — see *The thickness slider's cap (30 m) is
decoupled from a new section's default (5 m)* at the top of this file). Changing
it keeps the slab's center (`(min+max)/2`) fixed and grows `[min, max]`
symmetrically; position is changed only by the viewport drag (§13.8), never by
this panel. `defaultRangeForOrientation` likewise caps a new section's (or
newly-reoriented section's) default extent to 5 m, centered on
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
**Trade-off:** thickness is capped — a slab that needs to be thicker isn't
reachable from this control, and position is moved only by the viewport drag. The
cap was 5 m when this was written and is now 30 m (see the entry at the top of
this file); the default remains 5 m.

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
