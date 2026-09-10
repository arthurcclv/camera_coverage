# CONVENTIONS.md — sample-app

Coding standards and organization for the demo app. Match the existing code. See
[WORKFLOWS.md](./WORKFLOWS.md) for the spec-first process and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the module map.

## The spec is the source of truth

The app is built from `specs/spec.md` (+ `specs/volumetric_rendering.md`,
`specs/sampling_volumes.md`, `specs/aim_optimization.md`,
`specs/camera_placement.md`, and `specs/gaussian_splats.md`). Every
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
- **A dialog may own its own I/O; a commit may not.** The **file-referencing
  dialogs** (`LoadSceneDialog`, `SaveSceneAsDialog`, `AddSplatDialog`) are the
  exception to the presentational-components rule: each runs its own folder reads
  (`listSceneFiles`, `fileNamesIn`, `findExistingAssets`, `listSplatAssets`) for
  state that exists only while it is open, guarded by a `live` flag so a folder
  change mid-read is discarded. The exception is exactly this shape — *what is on
  disk right now, needed only while the dialog is up* — and does not extend to a
  dialog reading app state it could be handed. What they never
  own is the **commit** — the all-or-nothing import and the asset-copy-then-write both
  stay in `App.tsx`, so a failure leaves the scene untouched and the dialog open. Nor
  do they own **decisions**: the name rules, summaries and replace warnings are pure
  functions in `scene/saveTarget.ts`, and the file list's order, rows and
  selection — including where an arrow key moves it — in `scene/sceneFileList.ts`,
  both unit-tested without a handle in sight. A keyboard shortcut inside a dialog is
  still `(rows, selected) → selected`, and belongs in the pure module like any other —
  and where two dialogs walk a file list the same way they **share** that function
  rather than each keeping its own copy: `AddSplatDialog` moves its selection with
  `sceneFileList.moveListSelection`, the Load dialog's own.
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
`switch` over `EntityKind`, which is exhaustive per case rather than defaulted, and
three more sites that each replaced a chain: `sceneTree.nodeSelection` (row → what it
selects), `sceneTree.nodeEnabled` (row → whether it dims, via an `EnabledLookup` the
hierarchy builds from what it has indexed), and `SceneView.emitTransform` (selection →
how a gizmo drag reads back, with `zone`/`constraintGroup` as **explicit** no-ops).
The hierarchy's context menu no longer dispatches at all: it asks `nodeSelection` for
the kind and id, since the `DeletableKind`s *are* the selectable kinds. The
**group-header** menu is the newest instance (`ui/groupMenu.ts`): a
`Record<GroupKind, GroupMenuItem[]>` in which a group with nothing to offer declares
an **empty array** rather than being left out, so "no items here" is a stated
decision and the next group added is a compile error. That record is also why the
tree's `group` node carries a `groupKind` — its id is a plain string, and a `Record`
cannot be keyed on one.

## Testing

- Runner is `node:test` (`node --test --experimental-strip-types
  "test/**/*.test.ts"`) with `node:assert/strict`. No framework, no bundler.
- **Tests target pure functions and CPU-side Three.js objects — never the React
  render tree or the GPU** (no renderer, no `viewport.ts`, no render loop).
  Most suites are pure: `sceneTree`, `coverageOverlay`, `transformSpace`,
  `volumetric`, `leftPanelSplit`, `probeVisibility`, `viewportSelection`,
  `sectionHeatmap`, `sceneReducer`, `coverageRun` (the run coordinator: generation
  guard + reset/addChunk/clear fan-out), `sceneView/pick`, `sceneView/transformReadback`,
  `sceneLighting` (the viewport's light rig, extracted from `viewport.ts` precisely
  so it is reachable here), `splats`, `splatAssets`.
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
- **The pure/impure split extends to whole renderers, not just to functions.**
  Spark cannot run under `node --test` at all — it needs a WebGL2 context, workers
  and wasm — so the splat feature draws the boundary where `sceneFileList.ts` vs
  `sceneIO.ts` already draws it. `scene/splats.ts` (label, accepted extensions,
  row badge, the `Flip 180° Z` preset, `clipBandToSdfBox`, `needsSplatDepthPass`) and
  `scene/splatAssets.ts` (the Add-dialog list) hold **every judgement** and are
  tested; `scene/splatLayer.ts` holds only canvas creation, the `SparkRenderer`,
  the stream load, `mesh.visible`, the depth-only redraw (`writeDepth`), the
  `SplatEdit` lifecycle and disposal, and is verified by running the app. When a
  decision looks like it belongs in the layer, that is the signal it belongs in one
  of the other two — `clipBandToSdfBox` is the example: the layer could have built
  its SDF box inline, and then the band → box mapping would have had no test.
  `writeDepth` is the same split done deliberately: the layer owns the *draw* (bind
  the target, `autoClear` off, splat group only) and owns no decision, because
  **whether** there is anything to draw is `needsSplatDepthPass` over
  `{ sparkReady, meshCount, visible }` in `splats.ts`, where it is tested.
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

- **One `three` import path: bare `three`.** The app uses the classic build
  (`WebGLRenderer`, WebGL2) everywhere — no `three/webgpu`, no `three/tsl`, no Vite
  alias. Custom shaders are GLSL `ShaderMaterial`s. Do not reintroduce a second
  build; the two-copies-of-`three.core.js` hazard it used to carry is documented in
  [DECISIONS.md](./DECISIONS.md).
- `createViewport` is **synchronous** — `WebGLRenderer` needs no `init()`.
- **Screen-space point clouds are `THREE.Points` + `PointsMaterial`** with
  `sizeAttenuation: false` and `vertexColors: true`. World-space point sizing cannot
  work here: the same overlay must read on a 6 m demo room and on the 440 × 201 ×
  1120 m site, where a dot sized for the first is sub-pixel in the second. Check
  `gl.ALIASED_POINT_SIZE_RANGE` covers the size you ask for.
  `scene/constraintGizmos.ts`'s `ScreenDots` is the shared implementation, used by
  both the pool scatter and the draw mode's draft vertices.
- **Never let a geometry reach the scene without a `position` attribute.** An object
  whose points arrive later (the draw mode's draft, the placement move lines) is rendered
  at least once while empty, because the animation loop is already running. Give the
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
- **A pass that renders to a target owns two things Three.js will otherwise undo:
  `autoClear` and the colour space.** `render` clears whatever target is bound, so a
  pass that accumulates into one (the coverage fog max-blending into its own target,
  `splatLayer.writeDepth` adding depth to the scene target) must save `autoClear`,
  set it `false`, and restore it. And Three.js applies its output colour-space
  transform **only** when rendering to the canvas: a render target receives raw
  linear values, so the final full-screen pass that reaches the canvas has to do the
  conversion itself (`#include <colorspace_fragment>` in `fogCompositor.ts`). Both
  of these have already shipped as bugs, and neither raises an error — the first
  shows as a flickering or vanished layer, the second as a washed-out frame.
  `../specs/volumetric_rendering.md` §4 is the mechanism.
- **Depth for the fog comes from sharing a `DepthTexture`, not from re-traversing the
  scene.** The fog's colour target is constructed with the *scene* target's
  `depthTexture`, so geometry occludes voxels with no occluder list and no second
  scene pass. The cost is that anything which draws colour without writing depth is
  invisible to it: the 3DGS captures deliberately skip depth writes (a Gaussian has
  no surface), which is why they get a second, depth-only redraw between the scene
  pass and the fog pass. If a new layer starts being painted over by the fog, that is
  the reason to check first.
- **Never `setFromPoints` a geometry that already has a `position` attribute.**
  It writes into the existing buffer and refuses to grow it, dropping the overflow
  with a console warning — so a line whose vertex count *grows* (the draw mode's
  draft polyline, `../specs/camera_placement.md` §6.2) silently freezes at
  whatever length the first call had. Set a fresh `BufferAttribute` sized to the
  points instead, as `PlacementOverlay.setDraft` and `setMoves` do.
