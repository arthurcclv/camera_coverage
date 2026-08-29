# CONVENTIONS.md — sample-app

Coding standards and organization for the demo app. Match the existing code. See
[WORKFLOWS.md](./WORKFLOWS.md) for the spec-first process and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the module map.

## The spec is the source of truth

The app is built from `specs/spec.md` (+ `specs/volumetric_rendering.md` and
`specs/sampling_volumes.md`). Every
source file opens with a doc comment citing the spec section it implements.
Behavior changes update the spec first — see WORKFLOWS.md.

## File organization

Grouped by layer:

| Folder | Contents |
|---|---|
| `engine/` | The SDK bridge (`useEngine.ts`). |
| `scene/` | Imperative Three.js objects **and** the pure math they rely on. `scene/sceneView/` is the `SceneView` bridge cluster (the imperative class + its pure `pick`/`transformReadback` helpers). |
| `cameras/` | Camera config + Euler/quaternion math. |
| `ui/` | Presentational React components. |
| `test/` | Unit tests, mirroring the pure modules. |
| `specs/` | Source-of-truth specs. |

## TypeScript & React

- **`strict`**, `tsc --noEmit` clean. `verbatimModuleSyntax`, `isolatedModules`,
  Bundler module resolution (Vite/esbuild).
- **`.tsx`** for React components (PascalCase, one per file); **`.ts`** for logic.
- Internal imports use explicit `.ts` extensions (Vite resolves them).
- **Plain React 19 with hooks** — no component library, no CSS framework. A single
  shared `Slider` primitive; panels are `.panel` / `.panel-title` / `.hint` div
  structures styled by class in `index.css`. Inline SVG icons live in `App.tsx`.
- **Accessibility:** semantic roles are used — `tree`/`treeitem`/`group`, `menu`,
  `radiogroup`, `separator`, and `aria-expanded`/`aria-selected`.
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

## Testing

- Runner is `node:test` (`node --test --experimental-strip-types
  "test/**/*.test.ts"`) with `node:assert/strict`. No framework, no bundler.
- **Tests target pure functions and CPU-side Three.js objects — never the React
  render tree or the GPU** (no `WebGPURenderer`, no `viewport.ts`, no render loop).
  Most suites are pure: `sceneTree`, `coverageOverlay`, `transformSpace`,
  `volumetric`, `leftPanelSplit`, `probeVisibility`, `viewportSelection`,
  `sectionHeatmap`, `sceneReducer`, `coverageRun` (the run coordinator: generation
  guard + reset/addChunk/clear fan-out), `sceneView/pick`, `sceneView/transformReadback`.
  A few drive real (renderer-free) Three.js gizmo objects and assert on their
  state — `cameraGizmos`, `samplingVolumeGizmos`, and `gizmoSet` (the shared spine,
  via a minimal subclass: reconcile/dispose/getAttachTarget/pickHit) — which is how
  the reconcile loop is covered for every entry shape. The imperative `SceneView`
  class itself stays untested (like `viewport.ts`); its decision logic is tested
  through the two pure `sceneView/*` helpers. `sceneReducer.test.ts` covers the stale/samplingDirty rules and
  selection-follows-CRUD — the orchestration that used to be untestable in App.
- **Every change ships with a test.** When adding behavior, extract the decision
  logic into a pure function in `scene/`/`ui/` and test that, rather than testing
  through React.

## Rendering specifics

- Import the renderer and TSL nodes from `three/webgpu` and `three/tsl`; scene
  geometry uses bare `three` (aliased to `three/webgpu` — see
  [DECISIONS.md](./DECISIONS.md)). Do not add a second `three` import path.
- `createViewport` is **async** (`await renderer.init()` before the first frame);
  the App setup effect runs an async IIFE with deferred teardown.
