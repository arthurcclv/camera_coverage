# STACK.md — sample-app

Technologies used by the demo app and the role each plays. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for how they fit and
[DECISIONS.md](./DECISIONS.md) for why.

## Core

| Tech | Version | Role |
|---|---|---|
| **TypeScript** | ^5.5 | All source. `strict`, Bundler module resolution, `isolatedModules`. |
| **React** | ^19.1 | UI layer — panels, controls, hierarchy tree. Plain React + hooks; no component library, no CSS framework. |
| **Three.js** | ^0.185 | 3D viewport. Uses the **classic** build (`WebGLRenderer`, WebGL2) throughout — one build, no alias, no `three/webgpu`. |
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
| **`three`** (`WebGLRenderer`) | The main-thread render backend: **WebGL2**, one canvas, one scene, one depth buffer. Fixed by Spark's `WebGLRenderer` requirement and confirmed by measurement against `WebGPURenderer` (see DECISIONS.md). Entirely independent of the SDK's compute backend, which is still WebGPU in the worker. |
| **GLSL `ShaderMaterial`** | Shader authoring for the volumetric coverage overlay (`volumetric_rendering.md` §2–3). WebGL2 is the only target, so there is one shader language; the pure-TS slab/chord reference stays the tested truth the shader mirrors. |
| **`GLTFLoader`** (`three/addons/loaders/GLTFLoader.js`) | Parses imported `gltf` geometry objects (spec §14.6) from bytes via `parseAsync` — no new npm dependency, same `three/addons` convention as `OrbitControls`/`TransformControls`. |
| **`@sparkjsdev/spark`** | `SparkRenderer` + `SplatMesh` + `SplatEdit`, living in a `Group` inside the viewport's own scene. Pulled in with `await import('@sparkjsdev/spark')` on the **first splat load** and emitted as its own ~5 MB chunk (inlined sort workers and base64 wasm), so a scene with no capture pays nothing for it. |

## Scene file (spec §14)

- **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`) —
  folder-based scene import/export. Chromium-only; hidden in the UI where
  absent. `Window.showDirectoryPicker` isn't in TypeScript's bundled DOM lib, so
  a minimal ambient declaration lives in `src/types/file-system-access.d.ts`
  (`FileSystemDirectoryHandle`/`FileSystemFileHandle` themselves — including
  `getFileHandle`/`getDirectoryHandle`/`createWritable` — are already declared).

The coverage overlay is a single `InstancedMesh` of unit cubes (one instance per
voxel) with per-instance attributes and a GLSL slab/chord fragment shader — one
draw call, order-independent. It renders in a **pass of its own** and is composited
over the scene (`scene/fogCompositor.ts`, `volumetric_rendering.md` §4), so it is
not part of the scene's transparent-layer stack.

**One renderer, one depth buffer.** Splats draw into the viewport's own
`WebGLRenderer` and its own scene, so geometry occludes captures
(`gaussian_splats.md` §4.1) — and that one depth buffer, shared with the fog pass as
a `DepthTexture`, is also what makes geometry occlude the fog.
There is a single `three` build in the bundle, so the app carries no alias, no
`optimizeDeps` carve-out, and no two-copies-of-`three.core.js` hazard. Spark itself
stays out of the main chunk, dynamically imported on the first capture load.

## Internationalization (spec §18)

| Tech | Version | Role |
|---|---|---|
| **`i18next`** | ^25 | Translation core: namespaced dictionaries, interpolation, pluralization (`_one`/`_other`). |
| **`react-i18next`** | ^15 | `useTranslation()` hook, `initReactI18next`. |
| **`i18next-browser-languagedetector`** | ^8 | First-load locale detection (`navigator.language`) + `localStorage` persistence for an override. |

Config lives in `src/i18n/index.ts`: seven namespaced dictionaries per locale
(`common`, `camera`, `scene`, `optimize`, `placement`, `sections`, `volumes`),
imported eagerly from `src/locales/{en,zh-TW}/*.json` — small, closed locale set
(two), so no lazy-loading/backend plugin. `supportedLngs: ['en', 'zh-TW']` with
`nonExplicitSupportedLngs: false` and `load: 'currentOnly'` keeps a generic `zh`
or `zh-CN` from being coerced to `zh-TW` (spec §18.2) rather than falling back
to English.

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
