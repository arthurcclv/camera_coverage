# STACK.md — sample-app

Technologies used by the demo app and the role each plays. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for how they fit and
[DECISIONS.md](./DECISIONS.md) for why.

## Core

| Tech | Version | Role |
|---|---|---|
| **TypeScript** | ^5.5 | All source. `strict`, Bundler module resolution, `isolatedModules`. |
| **React** | ^19.1 | UI layer — panels, controls, hierarchy tree. Plain React + hooks; no component library, no CSS framework. |
| **Three.js** | ^0.185 | 3D viewport. Uses the **`three/webgpu`** build (`WebGPURenderer` + node/TSL system). |
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
| **Vite alias** `three → three/webgpu` | Forces a single Three.js core build across the app and its addons (OrbitControls/TransformControls) — see DECISIONS.md. |

The coverage overlay is a single `InstancedMesh` of unit cubes (one instance per
voxel) with per-instance attributes and a TSL slab/chord fragment shader — one
draw call, order-independent.

## Testing & tooling

| Tech | Role |
|---|---|
| **`node:test`** (`node --test --experimental-strip-types`) + `node:assert/strict` | Test runner; **pure functions only** (no React/Three/WebGPU). |
| **`tsc`** | `tsc --noEmit` for typecheck; `tsc -b && vite build` for the production build. |

## Not in the stack (deliberately)

- No react-three-fiber — Three.js is driven imperatively.
- No state library (Redux/Zustand/…) — state is React hooks + `useRef` mirrors.
- No component/CSS framework — styling is hand-written in `index.css`.
- No test framework beyond `node:test`.
