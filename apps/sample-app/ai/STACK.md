# STACK.md — sample-app

Technologies used by the demo app and the role each plays. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for how they fit and
[DECISIONS.md](./DECISIONS.md) for why.

## Core

| Tech | Version | Role |
|---|---|---|
| **TypeScript** | ^5.5 | All source. `strict`, Bundler module resolution, `isolatedModules`. |
| **React** | ^19.1 | UI layer — panels, controls, hierarchy tree. Plain React + hooks; no component library, no CSS framework. |
| **Three.js** | ^0.185 | 3D viewport. Uses the **`three/webgpu`** build (`WebGPURenderer` + node/TSL system), plus the **classic** build for the splat layer's `WebGLRenderer` (below). |
| **`@sparkjsdev/spark`** | ^2.1.0 | 3D Gaussian Splat renderer (`gaussian_splats.md` §4). Peer `three >= 0.180`. **WebGL-only** and **dynamically imported** — see below. |
| **Vite** | ^6 | Dev server + production bundler; ES-module workers (`worker.format: 'es'`). |
| **Node.js** | ≥ 22.6 | Runs the tests via native TS type-stripping. |

## The SDK

- **`@linkervision/camera-coverage-sdk`** — consumed by package name (`"*"`) via
  the npm-workspace symlink; imported as raw `.ts`. Runs inside a **Web Worker**
  (`worker.ts` + `engine/useEngine.ts`) via `WorkerClient` / `installHost`.

## Rendering

| Tech | Role |
|---|---|
| **`three/webgpu`** (`WebGPURenderer`) | Main-thread render backend; prefers WebGPU, auto-falls-back to **WebGL2** (`renderer.backend.isWebGPUBackend` distinguishes them). Independent of the SDK's compute backend. |
| **TSL** (Three Shading Language, `three/tsl`) | Node-based shader authoring for the volumetric coverage overlay; one graph compiles to WGSL (WebGPU) or GLSL (WebGL2). |
| **Vite alias** `three → three/webgpu` | Forces a single Three.js build across the app and its addons (OrbitControls/TransformControls/GLTFLoader) — see DECISIONS.md. Two importers are the documented exception and get the **classic** build via the alias entry's `customResolver`: `scene/splatLayer.ts` (needs `WebGLRenderer`) and `@sparkjsdev/spark` (needs `WebGLRenderer` *and* writes its GLSL include into `THREE.ShaderChunk`) — neither is exported by `three/webgpu`. Safe because both builds import their core classes from the same `three.core.js`, so `Object3D`/`PerspectiveCamera`/`OrthographicCamera` identity — and therefore `instanceof` across the two — still holds. |
| **`optimizeDeps.exclude`** `['three', 'three/webgpu', 'three/tsl', '@sparkjsdev/spark']` | Keeps that rule true in dev. Pre-bundling `three` produces a chunk carrying its *own* copy of `three.core.js`, which would break the identity above and silently misrender the orthographic elevations (Spark branches on `camera instanceof THREE.OrthographicCamera`). Each excluded entry is a single ESM file, so serving them unbundled costs a request apiece. |
| **`GLTFLoader`** (`three/addons/loaders/GLTFLoader.js`) | Parses imported `gltf` geometry objects (spec §14.6) from bytes via `parseAsync` — no new npm dependency, same `three/addons` convention as `OrbitControls`/`TransformControls`. |
| **`three`** (classic, `WebGLRenderer`) | The **second canvas** behind the viewport, drawing 3D Gaussian Splat captures (`scene/splatLayer.ts`, `gaussian_splats.md` §4). Spark requires a `WebGLRenderer` and draws with GLSL `RawShaderMaterial`, which `WebGPURenderer` supports on neither backend. |
| **`@sparkjsdev/spark`** | `SparkRenderer` + `SplatMesh` + `SplatEdit` on that canvas. Pulled in with `await import('@sparkjsdev/spark')` on the **first splat load** and emitted as its own ~5 MB chunk (inlined sort workers and base64 wasm), so a scene with no capture pays nothing for it. |

## Scene file (spec §14)

- **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`) —
  folder-based scene import/export. Chromium-only; hidden in the UI where
  absent. `Window.showDirectoryPicker` isn't in TypeScript's bundled DOM lib, so
  a minimal ambient declaration lives in `src/types/file-system-access.d.ts`
  (`FileSystemDirectoryHandle`/`FileSystemFileHandle` themselves — including
  `getFileHandle`/`getDirectoryHandle`/`createWritable` — are already declared).

The coverage overlay is a single `InstancedMesh` of unit cubes (one instance per
voxel) with per-instance attributes and a TSL slab/chord fragment shader — one
draw call, order-independent.

**Two canvases, one camera.** The splat layer's `WebGLRenderer` canvas sits
behind the `WebGPURenderer` one and owns the viewport background (`0x1a1d22`);
the WebGPU canvas is `alpha: true` with `scene.background = null` and composites
over it. Both renderers are handed the *same* camera object each frame. Bringing
in the classic `three` build for that second renderer costs the main chunk about
350 kB raw (~85 kB gzipped) — the price of a real second renderer, paid whether
or not a scene has a capture, because the layer owns the background
unconditionally (`gaussian_splats.md` §4.2). Spark itself stays out of the main
chunk.

## Testing & tooling

| Tech | Role |
|---|---|
| **`node:test`** (`node --test --experimental-strip-types`) + `node:assert/strict` | Test runner; **pure functions only** (no React/Three/WebGPU — and no Spark, which needs a WebGL2 context, workers and wasm). |
| **`tsc`** | `tsc --noEmit` for typecheck; `tsc -b && vite build` for the production build. |

## Not in the stack (deliberately)

- No react-three-fiber — Three.js is driven imperatively, behind the `SceneView` bridge.
- No state library (Redux/Zustand/…) — state is React hooks, pushed to the scene as a `SceneView` snapshot.
- No component/CSS framework — styling is hand-written in `index.css`.
- No test framework beyond `node:test`.
- No numeric or optimization library. The aim optimizer's search is an exhaustive scan
  over a mip pyramid and placement's is a seeded Monte Carlo over cached voxel sets —
  both a few dozen lines of plain arithmetic, and both deliberately simple enough that
  the objective is readable in one function (see DECISIONS.md).
