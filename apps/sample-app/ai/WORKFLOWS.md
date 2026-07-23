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

1. **Read** the relevant section of `specs/spec.md` (or
   `specs/volumetric_rendering.md` for the overlay) first.
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

1. **State** — add `useState` in `App.tsx`. If the scene needs to reflect it, add
   a field to `SceneViewState` (`scene/sceneView/`) and include it in the
   `sceneViewState` snapshot — App builds the snapshot; it no longer mirrors state
   into imperative callbacks. A `useRef` mirror is now only for the run/handler
   path (values `handleRun`/`applyScene` read imperatively), not for the scene.
2. **Pure logic** — put the actual decision/derivation in a pure function under
   `scene/` or `ui/` (e.g. how selection resolves, how a chunk maps to voxels),
   so it can be unit-tested without React or a GPU.
3. **Sink + UI** — consume the new snapshot field in a guarded block of
   `SceneView.sync()` (drive the relevant `scene/*` object's `update()`/
   `setOptions()`), and render a presentational `ui/*` component driven by
   props/callbacks. A drag that edits state comes back through `onTransform`.

Then add a test for the pure function.

## Testing

- `node:test` over `test/**/*.test.ts`; **pure functions only** — never the React
  tree or live Three.js/WebGPU.
- Extract the logic you want to cover into a pure helper first, then test it.
  Existing pattern to follow: `coverageOverlay.test.ts`, `viewportSelection.test.ts`,
  `volumetric.test.ts`.
- Every change ships with a test.

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
