# camera-coverage

GPU-accelerated **3D camera coverage / visibility analysis** — an engine plus a
browser demo, in one npm workspaces monorepo.

Given scene geometry, a set of perspective cameras, and a sampling resolution,
the engine determines for every sampled point in space which cameras have direct
line of sight to it, and returns a coverage map, per-camera visibility masks,
coverage statistics, and a compact octree result for visualization.

## Packages

| Path | Package | What it is |
|---|---|---|
| `packages/camera-coverage-sdk` | `@linkervision/camera-coverage-sdk` | The engine. WebGPU compute kernel (BVH ray occlusion) with a CPU reference backend; scene preprocessing in Rust→WASM with a pure-TS fallback; runs in a Web Worker. |
| `apps/sample-app` | `@linkervision/camera-coverage-sample-app` | Vite/React/Three.js demo: an enclosed room with movable CCTV cameras, a volumetric coverage overlay, probes, section heatmaps, and zones. |
| `apps/splat-camera-export` | `@linkervision/splat-camera-export` | Vite/React/PlayCanvas tool: loads a **3D Gaussian Splat** capture of a real site, imports a `scene.json` camera layout, and exports one rendered image per camera. |

The apps consume the SDK by package name via the workspace symlink —
`sample-app` uses the engine, while `splat-camera-export` only borrows its `Vec3`/`Quat`
types.

The two apps answer complementary questions: `sample-app` *how much of the volume is
covered*, `splat-camera-export` *what each camera actually sees*. A `scene.json` written by
the first is the input to the second.

## Getting started

```bash
npm install          # at the repo root — wires up all three workspaces
npm run dev -w @linkervision/camera-coverage-sample-app   # open the coverage demo
npm run dev -w @linkervision/splat-camera-export          # open the splat export tool
npm test -w @linkervision/camera-coverage-sdk             # engine test suite
```

Node ≥ 22.6 is required (the SDK ships as TypeScript and relies on native
type-stripping — no build step). A WebGPU-capable browser gets the GPU compute
and render paths; everything falls back to CPU / WebGL2 otherwise.

Optional — rebuild the Rust preprocessing kernels (WASM tests skip cleanly
without them):

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm -w @linkervision/camera-coverage-sdk
```

## Quick start (SDK)

```ts
import { createEngine, accessor } from '@linkervision/camera-coverage-sdk';

const engine = createEngine();
await engine.init({
  worldMin: [0, 0, 0],
  worldMax: [100, 20, 100],   // Y is height (glTF Y-up)
  voxelSize: 0.1,
  chunkSizeXZ: 10,
  backend: 'auto',            // 'cpu' for headless
});
await engine.loadScene({ positions, indices });
await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2.0 }] });
engine.setCameras([{ id: 'cam-1', position: [10, 3, 10], rotation: [0, 0, 0, 1], fov: 70, far: 50 }]);

const summary = await engine.compute({ mode: 1 });
console.log(summary.overallRate, summary.perCamera);
engine.dispose();
```

## Documentation

- Behavior is defined by each package's spec — `packages/camera-coverage-sdk/specs/spec.md`,
  `apps/sample-app/specs/spec.md`, and `apps/splat-camera-export/specs/spec.md`. These are
  the source of truth.
- `packages/camera-coverage-sdk/README.md` maps spec sections to modules and
  records the interpretations chosen where the spec was ambiguous.
- Deeper orientation lives in each package's `ai/` directory (`DESIGN.md`,
  `ARCHITECTURE.md`, `DECISIONS.md`, `CONVENTIONS.md`, `WORKFLOWS.md`,
  `STACK.md`, plus `VISUAL_DESIGN.md` for the app).
- Contributing conventions — including "update the spec before the code" — are in
  [`CLAUDE.md`](./CLAUDE.md).
