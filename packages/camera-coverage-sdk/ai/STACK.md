# STACK.md — `@linkervision/camera-coverage-sdk`

Technologies used by the SDK and the role each plays. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for how they fit and
[DECISIONS.md](./DECISIONS.md) for why they were chosen.

## Language & runtime

| Tech | Version | Role |
|---|---|---|
| **TypeScript** | ^5.5 | Every SDK source file. `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. |
| **Node.js** | ≥ 22.6 | Runs the sources **directly** via native TS type-stripping — no build step, no bundler for the library. Also the test runner. |
| **Rust** | stable + `wasm32-unknown-unknown` | Compiles the preprocessing kernels to a `cdylib` WASM module. |

The package ships as raw `.ts` (`"exports": "./src/index.ts"`, `"type":
"module"`). Node type-strips at runtime; browsers/bundlers import it by package
name. Hence `.ts` import extensions and `allowImportingTsExtensions`.

## GPU compute

| Tech | Role |
|---|---|
| **WebGPU** (`@webgpu/types`) | Production compute API — the `webgpu` backend (`src/compute/webgpu.ts`). |
| **WGSL** | Shader language for the visibility kernel — passes 1/2/3 in `src/shaders.ts`. |
| **`webgpu` npm package** (`dawn-gpu/node-webgpu`, native Dawn) | Provides a real `navigator.gpu` under `node --test` so WGSL can be exercised headlessly (`test/webgpu.test.ts`); skips cleanly with no GPU adapter. |

A **pure-TypeScript CPU backend** (`src/compute/cpu.ts` + `src/kernel.ts`)
implements the identical algorithm and is the behavioral reference.

## Preprocessing (dual implementation)

Mesh clean, BVH build, occupancy/flood-fill, SVO build exist twice and are held
byte-identical / occlusion-equivalent by `test/wasm.test.ts`:

- **Rust → WASM** (`crates/camera_coverage_wasm`): `cdylib`, **raw-pointer ABI, no
  `wasm-bindgen`**. Single-threaded (no rayon/wasm-bindgen-rayon, so no
  SharedArrayBuffer / COOP-COEP requirement). Loaded by `src/wasm/loader.ts`;
  opt-in via `createWasmKernels`.
- **Pure TypeScript** (`tsKernels`): the default (`src/kernels.ts`, `src/svo.ts`,
  `src/occupancy.ts`, `src/geometry/*`).

## Off-thread execution

| Tech | Role |
|---|---|
| **Web Worker + `postMessage`** | `src/worker/*` — a `VisibilityEngine`-shaped proxy so all heavy work runs off the main thread. |
| **Transferables** | Large typed arrays cross the worker boundary as transferables, never structured-clone copies. `loopback()` is an in-process transport for tests (does not simulate detachment). |

## Testing & tooling

| Tech | Role |
|---|---|
| **`node:test`** (`node --test --experimental-strip-types`) | The only test runner. Suites: `unit`, `acceptance` (§18), `wasm` (parity), `worker` (E2E), `webgpu` (real WGSL). |
| **`tsc --noEmit`** | Typecheck (`npm run typecheck`). |
| **bash** (`scripts/build-wasm.sh`) | Compiles the Rust crate → `src/wasm/*.wasm`. |

## Not in the stack (deliberately)

- No bundler/build step for the library — Node runs the TS directly.
- No test framework beyond `node:test`.
- No `wasm-bindgen`; no WASM multithreading; no cross-origin-isolation
  requirement.
