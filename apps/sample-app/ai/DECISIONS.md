# DECISIONS.md — sample-app

Notable technical decisions for the demo app and their trade-offs. Behavior is
defined in [`../specs/spec.md`](../specs/spec.md); this records *why* the code is
shaped the way it is. Newest at the top when you add to this file.

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
