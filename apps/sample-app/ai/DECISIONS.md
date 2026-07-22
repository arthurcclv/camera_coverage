# DECISIONS.md — sample-app

Notable technical decisions for the demo app and their trade-offs. Behavior is
defined in [`../specs/spec.md`](../specs/spec.md); this records *why* the code is
shaped the way it is. Newest at the top when you add to this file.

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
skipped (not aggregated, not blacking); the cell aggregates only its in-zone valid voxels
and is black only when it has none or an in-zone voxel is invalid (an ROI obstacle
silhouette). **Why the order:** with zones active the SDK samples only the enabled
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

## Section legend floats over the viewport, gated on layer + section presence

Behavior in [`../specs/spec.md`](../specs/spec.md) §2.2/§13.6. `SectionHeatmapControls`
renders as a floating `.viewport-legend` overlay at the viewport bottom-right (a third
overlay beside the two top toolbars, §2.4) rather than as a right-sidebar panel, and is
shown only when `sectionsVisible && sections.length > 0`. **Why:** the legend describes
the on-scene heatmaps, so it reads better docked to the viewport than buried in the
sidebar's scroll; gating on the master toggle keeps the legend and the heatmap layer
appearing/disappearing together, and the extra `sections.length > 0` guard stops a
meaningless `0..1` fallback legend from floating over the **default empty scene**
(which starts with `sectionsVisible = true` but no sections). It stays an opaque
`.panel` card (plus a drop shadow to lift it off the 3D scene) rather than a translucent
HUD, for consistency with every other panel and guaranteed readability over bright cells.

## Section legend labels track the selected section's aggregation

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.5/§13.6. The section colorbar
is a fixed Turbo gradient (value→color is always the linear `0..1` mapping), but its
tick labels and caption are derived at render time from the *selected* section:
`sectionLegendScale(aggregation, cameraCount)` in `sectionHeatmap.ts` returns
`{caption, ticks:[{label, pos}]}` — a **camera count** `0..N` for `mean`/`max`/`min`
(N = the retained run's enabled-camera count, i.e. the coverage-fraction denominator;
count `k` sits at position `k/N` because the mapping is linear), a **percentage** for
`blind`, or the plain coverage **fraction** as a fallback when no section is selected
or no run has completed. Camera-count ticks use an adaptive "nice" step (1/2/5/10/…)
targeting ~5–9 labels, always including 0 and N. **Why:** users read the heatmap as
"how many cameras see this," not an abstract 0..1 — but only the coverage aggregations
map to a count, so the scale is aggregation-aware rather than a single global relabel.
The tick math is a pure function (no React) so it is unit-tested directly
(`test/sectionHeatmap.test.ts`); the component only positions the returned ticks.
Labels are positioned absolutely along the bar (not flex `space-between`) since an
adaptive step can leave the final gap uneven.

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

## Sampling volumes & zones with zero SDK changes

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

**Decision:** `turboColormap` (`sectionHeatmap.ts`) is a piecewise-linear
interpolation over 8 hand-picked RGB control points (dark blue → cyan → green →
yellow → orange → dark red), not Google's published degree-5 polynomial
approximation of the real Turbo colormap. **Why:** the polynomial's exact
coefficients weren't reliably reproducible from memory, and shipping wrong
constants under the "Turbo" name risked a colormap that silently didn't match
its own description (dark blue at 0, red at 1) at the endpoints. The control-point
version is exact-by-construction and cheap to verify (`test/sectionHeatmap.test.ts`
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
between React state and scene objects, accepted for a reference demo.

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
