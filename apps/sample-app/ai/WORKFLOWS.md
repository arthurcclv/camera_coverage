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
   zones, `specs/aim_optimization.md` for the aim optimizer) first.
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

## Running against a local SDK change

The workspace symlink means edits in `packages/camera-coverage-sdk/src` are picked
up directly by `npm run dev` (Vite resolves the SDK's raw `.ts`). No rebuild step
— but if you change SDK behavior, follow the SDK's spec-first loop there too.

## Working on the viewport / volumetric overlay

- The renderer is `WebGPURenderer` from `three/webgpu` with a WebGL2 fallback;
  `createViewport` is async. Verify both backends when touching render code — the
  stats panel reports which one is active.
- Overlay math (slab/chord/composite) has a pure-TS reference in
  `scene/volumetric.ts` mirrored by the TSL node graph. Change both together and
  update `test/volumetric.test.ts`.
