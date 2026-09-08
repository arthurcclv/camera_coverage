# CONVENTIONS.md — sample-app

Coding standards and organization for the demo app. Match the existing code. See
[WORKFLOWS.md](./WORKFLOWS.md) for the spec-first process and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the module map.

## The spec is the source of truth

The app is built from `specs/spec.md` (+ `specs/volumetric_rendering.md`,
`specs/sampling_volumes.md`, and `specs/aim_optimization.md`). Every
source file opens with a doc comment citing the spec section it implements.
Behavior changes update the spec first — see WORKFLOWS.md.

## File organization

Grouped by layer:

| Folder | Contents |
|---|---|
| `engine/` | The SDK bridge (`useEngine.ts`). |
| `scene/` | Imperative Three.js objects **and** the pure math they rely on. `scene/sceneView/` is the `SceneView` bridge cluster (the imperative class + its pure `pick`/`transformReadback` helpers). |
| `cameras/` | Camera config + Euler/quaternion math. |
| `optimize/` | Aim optimization (`aim_optimization.md`): the search, the cube rig, and the `useAimOptimizer` session hook. |
| `placement/` | Camera placement (`camera_placement.md`): the constraint region math, the Halton draw and pool, the analysis and the Apply plan, the mode reducer, the curve plot geometry, and the `usePlacement` session hook. |
| `ui/` | Presentational React components. |
| `test/` | Unit tests, mirroring the pure modules. |
| `specs/` | Source-of-truth specs. |

`src/` root holds only the entry points (`main.tsx`, `App.tsx`, `worker.ts`) and
`errorText.ts` — one `describeError` shared by every session hook's status-area
message, belonging to no single layer.

## TypeScript & React

- **`strict`**, `tsc --noEmit` clean. `verbatimModuleSyntax`, `isolatedModules`,
  Bundler module resolution (Vite/esbuild).
- **`.tsx`** for React components (PascalCase, one per file); **`.ts`** for logic.
- Internal imports use explicit `.ts` extensions (Vite resolves them).
- **Plain React 19 with hooks** — no component library, no CSS framework. A single
  shared `Slider` primitive; panels are `.panel` / `.panel-title` / `.hint` div
  structures styled by class in `index.css`. Inline SVG icons live in `App.tsx`.
- **Accessibility:** semantic roles are used — `tree`/`treeitem`/`group`, `menu`,
  `radiogroup`, `separator`, `dialog`/`aria-modal`, `listbox`/`option`, and
  `aria-expanded`/`aria-selected`/`aria-disabled`.
- **A dialog may own its own I/O; a commit may not.** The scene-file dialogs
  (`LoadSceneDialog`, `SaveSceneAsDialog`) are the one exception to the
  presentational-components rule: each runs its own folder reads (`listSceneFiles`,
  `fileNamesIn`, `findExistingAssets`) for state that exists only while it is open,
  guarded by a `live` flag so a folder change mid-read is discarded. What they never
  own is the **commit** — the all-or-nothing import and the asset-copy-then-write both
  stay in `App.tsx`, so a failure leaves the scene untouched and the dialog open. Nor
  do they own **decisions**: the name rules, summaries and replace warnings are pure
  functions in `scene/saveTarget.ts`, and the file list's order, rows and
  selection — including where an arrow key moves it — in `scene/sceneFileList.ts`,
  both unit-tested without a handle in sight. A keyboard shortcut inside a dialog is
  still `(rows, selected) → selected`, and belongs in the pure module like any other.
- **Pointer gestures** (the panel divider, hierarchy drag-reorder): the geometry goes
  in a pure module that takes plain numbers; the component keeps only the plumbing.
  Window `pointermove`/`pointerup` listeners are attached **imperatively inside
  `pointerdown`** and removed on up/cancel — not declared as an effect — so an
  unstarted gesture costs nothing and one that leaves the element still tracks. Those
  listeners close over pointerdown-time values, so anything they need that can change
  mid-gesture (the current rows, the latest callback) is mirrored into a ref.

## Naming

- Scene classes: `XxxSet` / `XxxRenderer` / `Coverage*`
  (`CameraGizmoSet`, `VoxelVolumetricRenderer`, `CoverageOverlay`).
- Node ids are namespaced: `cam:`, `probe:`, `group:cameras`.
- Constants are `UPPER_SNAKE` (`BOX_OBSTACLES`, `DEFAULT_COMPOSITE_MODE`).
- **Placement says *build*; the aim optimizer says *capture*.** In `placement/`, one GPU
  measurement of one position is a **build step** (`buildStep`, `buildStepSpec`,
  `buildStepCameras`, `classifyBuildStep`, `BuildStepOutcome`) and the loop over a pool is
  `buildPool()`; the UI says `Build` / `building n/N` / `Rebuild` to match. `optimize/`
  keeps `capture`, and so does the machinery both features share (`captureRig`,
  `CAPTURE_SLOTS`, the `opt-cap-` slot ids) — see DECISIONS.md.

## The state pattern

React owns canonical state; the **editable scene document** is a pure
`useReducer(sceneReducer)` (`scene/sceneReducer.ts`), so every entity edit is a
`dispatch(action)` and the stale-marking rules live in one tested transition, not
in effects. The Three.js side is a single imperative sink, `SceneView`
(`scene/sceneView/`), fed one immutable snapshot per change through `sync()` and
answering with resolved `onSelect`/`onTransform` events (which App turns back into
dispatches). SceneView diffs the snapshot by reference internally, so each
`scene/*` object's `update()`/`setOptions()` still fires only on its own inputs;
App no longer mirrors live state into imperative callbacks (that lives inside
SceneView). **Keep engine/renderer mutation out of component render bodies, and
keep scene-document transitions pure in the reducer** — impure work (geometry
build/dispose, the `CoverageRun` coordinator, engine, BVH) stays in App around the
dispatch. Factor pure decision logic out of React/Three so it can be unit-tested
(see below) — this is why `viewportSelection`, `transformSpace`, `leftPanelSplit`,
`sceneTree`, the slab/chord math, `buildAggregateSpec`, the `sceneReducer`, and
SceneView's own `pick` / `transformReadback` are standalone pure functions. A run's
merged aggregation results + generation guard are a single imperative sink,
`CoverageRun` (`scene/coverageRun.ts`), that App drives and reads through.

**Dispatch on an entity kind through an exhaustive `Record<Kind, …>`, never an
if/else chain ending in a bare `else`.** A trailing `else` silently claims every
kind added to the union afterwards, and the failure is invisible: the hierarchy's
context menu routed `constraint` and `constraintGroup` into `onDeleteVolume`, which
filtered the volume array for an id no volume had and returned it unchanged — no
error, nothing deleted. A `Record` keyed on the union makes the next added kind a
compile error instead (`ui/entityMenu.ts`). The same reasoning covers the reducer's
`switch` over `EntityKind`, which is exhaustive per case rather than defaulted.

## Testing

- Runner is `node:test` (`node --test --experimental-strip-types
  "test/**/*.test.ts"`) with `node:assert/strict`. No framework, no bundler.
- **Tests target pure functions and CPU-side Three.js objects — never the React
  render tree or the GPU** (no `WebGPURenderer`, no `viewport.ts`, no render loop).
  Most suites are pure: `sceneTree`, `coverageOverlay`, `transformSpace`,
  `volumetric`, `leftPanelSplit`, `probeVisibility`, `viewportSelection`,
  `sectionHeatmap`, `sceneReducer`, `coverageRun` (the run coordinator: generation
  guard + reset/addChunk/clear fan-out), `sceneView/pick`, `sceneView/transformReadback`,
  `sceneLighting` (the viewport's light rig, extracted from `viewport.ts` precisely
  so it is reachable here).
  A few drive real (renderer-free) Three.js gizmo objects and assert on their
  state — `cameraGizmos`, `samplingVolumeGizmos`, and `gizmoSet` (the shared spine,
  via a minimal subclass: reconcile/dispose/getAttachTarget/pickHit) — which is how
  the reconcile loop is covered for every entry shape. The imperative `SceneView`
  class itself stays untested (like `viewport.ts`); its decision logic is tested
  through the two pure `sceneView/*` helpers. `sceneReducer.test.ts` covers the stale/samplingDirty rules and
  selection-follows-CRUD — the orchestration that used to be untestable in App.
- **Every change ships with a test.** When adding behavior, extract the decision
  logic into a pure function in `scene/`/`placement/`/`optimize/` and test that,
  rather than testing through React. Two rules follow from cases that got through:
  logic left inline in a component ships untested by default (§5.2's plot geometry
  did, until `placement/curvePlot.ts`); and **a worked example in a spec is a test
  case** — assert it exactly, because a test that checks only a sum and an ordering
  passes for many wrong answers (`poolSplit`, `camera_placement.md` §4.1).
- **Decision logic reachable only through a hook is decision logic without a test.**
  There is no React renderer in the suite, so anything a `use*` hook decides inline
  cannot be reached. `usePlacement`'s Reposition is the pattern: the pick and the
  blocker moved to `pool.ts` as `bestSample`/`repositionBlocker`, and the hook keeps
  the build step loop and the state writes.
- **A few suites drive the real engine on the CPU backend** — `coverageRun`,
  `optimizeAcceptance`, `optimizeObjective`, `placementParity` — because some contracts
  are only meaningful against the engine's own answer. `placementParity` is the model:
  the CPU union of cached reachable sets must **exactly** equal a `compute()` carrying
  every rig at once, which is testable as equality (not a tolerance) precisely because
  SDK §19.5 makes both reductions integral.

## Placement idioms

- **A cached voxel set is the SDK's merged cubes**, never an expanded bitset:
  `LeafChunk` keeps `leafCounts`' `index`/`size` arrays plus the chunk's `base`/`dims`,
  and `VoxelBitset.add()` rasterizes them into a reused scratch buffer, returning the
  **marginal** count. Do not expand a set to compare or store it — the union is what
  callers want, and the marginal is what makes a prefix curve exact.
- **A region test is a distance, not a box test.** `inRegion` is
  `distToPrimitive(p, c) ≤ c.distance + REGION_EPSILON`. The epsilon is arithmetic, not
  tolerance: `projectIntoRegion` reaches the surface by scaling a vector, and
  `0.4 / 30 * 30` is `0.4000000000000001`, so without it the clamp could emit a position
  failing the very test it was projected into.
- **Validators are shared between the file reader and the panels.**
  `constraintProblem`/`groupProblem` live beside the entities, so an imported constraint
  and a hand-edited one are rejected for the same reason, in the same words.
- **A mode's lifecycle is a pure reducer, not React state with rules in the handlers.**
  `mode.ts` takes `(state, event)` to `{ state, effect }`, and the App carries out the one
  effect (`closeSession`). The rules worth keeping out of a component — a running build step
  is not closeable, a built pool asks first, Apply must *not* close the session twice —
  are then unit-testable without a renderer, which is the only kind of UI test this app
  has.

## Rendering specifics

- Import the renderer and TSL nodes from `three/webgpu` and `three/tsl`; scene
  geometry uses bare `three` (aliased to `three/webgpu` — see
  [DECISIONS.md](./DECISIONS.md)). Do not add a second `three` import path.
- `createViewport` is **async** (`await renderer.init()` before the first frame);
  the App setup effect runs an async IIFE with deferred teardown.
- **Never draw a point cloud with `THREE.Points`.** WebGPU's point primitives are
  fixed at one pixel, so a `Points` cloud renders and cannot be seen — a failure
  with no error and no wrong number. Use an instanced `Sprite` with a
  `PointsNodeMaterial` whose `positionNode`/`colorNode` are
  `instancedBufferAttribute`s, set `count`, and set `frustumCulled = false` (the
  object's own transform stays at the origin). `scene/constraintGizmos.ts`'s pool
  scatter is the worked example — `ScreenDots` in that file is the shared
  implementation, used by both the pool and the draw mode's draft vertices.
- **Never let a geometry reach the scene without a `position` attribute.** An object
  whose points arrive later (the draw mode's draft, the placement move lines) is rendered
  at least once while empty, because the animation loop is already running; on that frame
  three's WebGPU path caches the render object's vertex buffers from `geometry.attributes`
  — an empty list, and an empty `attributesId` map with it — and `needsGeometryUpdate`
  afterwards re-checks only the attributes named in that map. A `position` attribute added
  later is therefore never noticed: the object keeps a pipeline with no vertex buffer and
  **draws nothing for the rest of its life**, with no error and nothing wrong with the
  data. This is what made the draft polyline invisible through three rewrites. Give the
  geometry a placeholder attribute at construction (`PlacementOverlay.emptyLineGeometry` —
  two zero vertices, plus `visible = false` until there is something to draw), or build the
  geometry attributes-first as `probeGizmos`/`sectionGizmos` do.
- **Draw a changing line as `LineSegments` over explicit endpoint pairs, with a fresh
  `BufferAttribute` sized to exactly those points, rebuilt on every update.** Fresh, not
  written in place: replacing the attribute is the change `needsGeometryUpdate` compares
  ids to detect, per the bullet above. Prefer the allocation — a line is a handful of
  points — over being invisible. Two other constructions were tried for the draft and
  neither could be seen, though the bare geometry above was the real cause: a
  `LineDashedMaterial` (it discards fragments by a `lineDistance` attribute) and a grown,
  over-allocated buffer trimmed by `setDrawRange`. Neither shape appears anywhere else in
  the app; `PlacementOverlay.setMoves`, `setDraft`, and the committed polyline all use the
  pattern above, and **do not reach for a dashed line here at all**: use colour, or a
  separate overlay, to distinguish one line from another.
- **An overlay drawn *on* the geometry needs `depthTest: false` and a render order.**
  A point placed by the surface hit test is exactly coplanar with the surface it was
  clicked on, so anything drawn through such points z-fights the geometry and disappears
  without an error. `RenderOrder.draftOverlay` is the layer for it (`scene/renderOrder.ts`
  explains the whole order); the draw mode's draft is the worked example.
- **No constructor parameter properties** (`constructor(private readonly x: number)`). The
  test runner strips types rather than compiling them (`node --test
  --experimental-strip-types`), and a parameter property is a *syntax* it refuses:
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. `tsc --noEmit` and Vite both accept it, so this
  surfaces only as a whole test file failing to load. Declare the field and assign it.
- **Never `setFromPoints` a geometry that already has a `position` attribute.**
  It writes into the existing buffer and refuses to grow it, dropping the overflow
  with a console warning — so a line whose vertex count *grows* (the draw mode's
  draft polyline, `../specs/camera_placement.md` §6.2) silently freezes at
  whatever length the first call had. Set a fresh `BufferAttribute` sized to the
  points instead, as `PlacementOverlay.setDraft` and `setMoves` do.
