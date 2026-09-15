# WORKFLOWS.md — sample-app

Common development workflows for the demo app. Repo-wide rules are in the root
[`../../CLAUDE.md`](../../CLAUDE.md); the SDK it consumes has its own
[workflows](../../packages/camera-coverage-sdk/ai/WORKFLOWS.md).

## Commands

```bash
npm run dev         # vite dev server
npm run build       # tsc -b && vite build
npm run preview     # preview the production build
npm test            # node --test --experimental-strip-types "test/**/*.test.ts"
npm run typecheck   # tsc --noEmit
```

The app consumes the SDK by package name through the npm-workspace symlink, so
`npm install` at the repo root wires them together. Node ≥ 22.6 (native TS
type-stripping) is required for the tests.

## The spec-first loop (mandatory for behavior changes)

Same discipline as the rest of the repo — do not implement ahead of an approved
spec change:

1. **Read** the relevant section of `specs/spec.md` (or the feature docs beside it:
   `specs/volumetric_rendering.md` for the overlay, `specs/sampling_volumes.md` for
   zones, `specs/aim_optimization.md` for the aim optimizer,
   `specs/camera_placement.md` for constraint-driven placement, and
   `specs/gaussian_splats.md` for splat captures) first.
2. **Write the spec edit** describing the new/changed behavior and **get approval**
   before coding.
3. **Implement** against the approved spec.
4. **Update the affected `ai/` doc(s) in the same change** — module/layer
   changes go in [ARCHITECTURE.md](./ARCHITECTURE.md), a new or reversed
   trade-off goes in [DECISIONS.md](./DECISIONS.md) (newest at top), a new
   coding pattern goes in [CONVENTIONS.md](./CONVENTIONS.md), a dependency/tooling
   change goes in [STACK.md](./STACK.md), a color/typography/spacing/component/
   accessibility change goes in [VISUAL_DESIGN.md](./VISUAL_DESIGN.md). Don't let
   these go stale.
5. **Add a test** — see below.
6. **Verify** spec and code haven't drifted.

## Adding a feature (the app's grain)

Because React owns state and the Three.js side is one imperative sink (`SceneView`,
see [ARCHITECTURE.md](./ARCHITECTURE.md)), a typical feature touches three places:

1. **State** — if it is part of the editable scene document (an entity field, a
   selection/collapse/dirtiness rule), add a case (and, if needed, an action) to
   `scene/sceneReducer.ts` and `dispatch` it from a thin `App.tsx` handler; put
   any new stale/samplingDirty rule there. Otherwise (viewport UI, run output,
   geometry build) add `useState` in `App.tsx`. The only `useRef`s are the async
   run/handler path (the `stateRef` mirror + `roomRef`/`runGenerationRef`/`bvhRef`).
2. **Pure logic** — put the actual decision/derivation in a pure function under
   `scene/` or `ui/` (e.g. how selection resolves, how a chunk maps to voxels),
   so it can be unit-tested without React or a GPU.
3. **Sink + UI** — if the scene must reflect it, add a field to `SceneViewState`
   (`scene/sceneView/`), include it in the `sceneViewState` snapshot, and consume
   it in a guarded block of `SceneView.sync()`; render a presentational `ui/*`
   component driven by props/callbacks. A drag that edits state comes back through
   `onTransform` → `dispatch`.

Then add a test — for the reducer transition and/or the pure function.

## Testing

- `node:test` over `test/**/*.test.ts`; **pure functions only** — never the React
  tree or live Three.js/WebGPU.
- Extract the logic you want to cover into a pure helper first, then test it.
  Existing pattern to follow: `coverageOverlay.test.ts`, `viewportSelection.test.ts`,
  `volumetric.test.ts`.
- Every change ships with a test.
- **Engine-driven features:** `test/optimizeAcceptance.test.ts` is the pattern where a
  derivation must be checked against the *real* engine — it drives `CoverageEngine`
  under `backend: 'cpu'` directly (no worker, no React) and brute-forces a ground truth
  the implementation shares no code with. It runs in well under a second; reach for it
  when a feature's correctness is a claim about what the SDK would have computed.
- **Pointer-interaction features:** extract the geometry into a pure function that
  takes plain numbers, and test *that*. `scene/reorder.ts` is the pattern —
  `insertionTargetAt` takes a pointer Y plus row extents as data, so the midpoint and
  adjacency rules (where the bugs are) test without a DOM. What stays manual is only
  the event wiring: **verify the drag threshold, Escape-cancel, and edge auto-scroll
  in `npm run dev`** — jsdom has no layout, so `getBoundingClientRect` would return
  zeros and any test of those would be testing its own stubs.

## Bringing a real site model in

1. **"+" → Import model…** (or right-click the **Geometry** group header). The OS
   picker opens on the scene folder when one is open, anywhere otherwise.
2. Pick the `.glb` / `.gltf` / `.ply` / `.obj`. A row appears, auto-selected, drawing
   from memory — no scene folder required, and nothing written yet.
3. Fix the obvious import errors in the `GeometryPanel`: up-axis and units, read off
   the world-size readout. A 1000× unit error is visible within a second.
4. **Save.** That is when the bytes are written, into `<scene folder>/assets/<name>/`
   — and when a file that was *already* in `assets/` is recognised by identity and
   referenced in place instead of copied (`asset_import.md` §8.3). A save with no
   target opens the Save-as dialog first, so a from-scratch scene gets a folder here.
   If a folder of that name is already there, the save asks before replacing it, and
   **refuses outright** if another row in the scene still reads from it.
5. **Run.**

The row carries a **`not saved`** marker until step 4, because until then the bytes
exist only in the tab. A capture follows the same five steps through **Import 3DGS
capture…**, minus step 3 and step 5 — it is a backdrop, not an occluder.

## Working on the splat layer

Nothing here is reachable from `node --test`: Spark needs a WebGL2 context,
workers and wasm. Two rules follow.

- **Put the decision in `scene/splats.ts` or `scene/assetImport.ts`, never in
  `scene/splatLayer.ts`.** The layer is canvas creation, the `SparkRenderer`, the
  stream load, `mesh.visible`, the `SplatEdit` lifecycle and disposal — and is
  deliberately untested. If a change to it needs a judgement (which files are
  accepted, what a badge says, where the clip box goes), that judgement belongs in
  one of the pure two, with a test (`gaussian_splats.md` §11).
- **What must be verified in `npm run dev`, against a real capture:** that the
  capture appears at all, that the WebGPU canvas still composites over it, that
  the clip cuts it, that the orthographic elevations project it correctly, and
  that hiding **Geometry** reveals it. Drop a `.spz`/`.sog`/`.ply` into a scene
  folder's `assets/`, Load that scene, then **+ → 3D Gaussian Splat…**.

Two traps worth knowing before you debug the layer:

- **`SplatMesh.initialized` resolves before anything renders.** Spark's sort runs
  in a worker and the mesh emits no geometry for its first several frames (measured:
  the first real draw call at frame 7–8). Never treat "loaded" as "on screen" — a
  first-frame screenshot or a pixel assertion right after the await reads an empty
  layer.
- **`SparkRenderer`'s own mesh draws one triangle every frame regardless of
  content**, so a non-zero draw-call or triangle count is not evidence a capture
  is visible.

There is one `three` build (the classic, WebGL2 one) and no alias, so a `three`
import cannot resolve to the wrong build. If you find yourself reaching for
`three/webgpu` or `three/tsl`, read the top entry in
[DECISIONS.md](./DECISIONS.md) first — that path was removed deliberately.

## Running against a local SDK change

The workspace symlink means edits in `packages/camera-coverage-sdk/src` are picked
up directly by `npm run dev` (Vite resolves the SDK's raw `.ts`). No rebuild step
— but if you change SDK behavior, follow the SDK's spec-first loop there too.

## Working on the viewport / volumetric overlay

- The renderer is the classic `WebGLRenderer` (WebGL2), one canvas, one scene;
  `createViewport` is synchronous. WebGPU is compute-only and lives in the worker,
  so render changes cannot affect coverage numbers and vice versa.
- Overlay math (slab/chord/composite) has a pure-TS reference in
  `scene/volumetric.ts` mirrored by the GLSL fragment shader. Change both together
  and update `test/volumetric.test.ts`, including its shader source-parity
  assertion — the shader cannot execute under `node --test`, so that assertion is
  the only automated link between the two.
