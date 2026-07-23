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

## Naming

- Scene classes: `XxxSet` / `XxxRenderer` / `Coverage*`
  (`CameraGizmoSet`, `VoxelVolumetricRenderer`, `CoverageOverlay`).
- Node ids are namespaced: `cam:`, `probe:`, `group:cameras`.
- Constants are `UPPER_SNAKE` (`BOX_OBSTACLES`, `DEFAULT_COMPOSITE_MODE`).

## The state pattern

React owns canonical state; the Three.js side is a single imperative sink,
`SceneView` (`scene/sceneView/`), fed one immutable snapshot per change through
`sync()` and answering with resolved `onSelect`/`onTransform` events. SceneView
diffs the snapshot by reference internally, so each `scene/*` object's
`update()`/`setOptions()` still fires only on its own inputs — but App no longer
mirrors live state into imperative callbacks (that now lives inside SceneView).
**Keep engine/renderer mutation out of component render bodies.** Factor pure
decision logic out of React/Three so it can be unit-tested (see below) — this is
why `viewportSelection`, `transformSpace`, `leftPanelSplit`, `sceneTree`, the
slab/chord math, probe `locateVoxel`, and SceneView's own `pick` /
`transformReadback` are standalone pure functions.

## Testing

- Runner is `node:test` (`node --test --experimental-strip-types
  "test/**/*.test.ts"`) with `node:assert/strict`. No framework, no bundler.
- **Tests target pure functions only** — never the React render tree or live
  Three.js/WebGPU. Existing suites: `sceneTree`, `coverageOverlay`,
  `transformSpace`, `volumetric`, `leftPanelSplit`, `probeVisibility`,
  `viewportSelection`, `sectionHeatmap`, `sceneView/pick`,
  `sceneView/transformReadback`. The imperative `SceneView` class itself stays
  untested (like `viewport.ts`); its decision logic is tested through those two
  pure helpers.
- **Every change ships with a test.** When adding behavior, extract the decision
  logic into a pure function in `scene/`/`ui/` and test that, rather than testing
  through React.

## Rendering specifics

- Import the renderer and TSL nodes from `three/webgpu` and `three/tsl`; scene
  geometry uses bare `three` (aliased to `three/webgpu` — see
  [DECISIONS.md](./DECISIONS.md)). Do not add a second `three` import path.
- `createViewport` is **async** (`await renderer.init()` before the first frame);
  the App setup effect runs an async IIFE with deferred teardown.
