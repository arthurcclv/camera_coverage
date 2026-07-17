# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

npm workspaces monorepo, two packages:

- `packages/camera-coverage-sdk` — `@linkervision/camera-coverage-sdk`, the actual engine. Implemented from `packages/camera-coverage-sdk/specs/spec.md` — that spec is the source of truth for behavior; the README maps spec sections to modules.
- `apps/sample-app` — Vite/React/Three.js browser demo of the SDK, implemented from `apps/sample-app/specs/spec.md`. Consumes the SDK by package name (`"@linkervision/camera-coverage-sdk": "*"`) via workspace symlink.

`npm install` at the repo root wires both up.

## Workflow rules

- **Read the relevant spec before changing anything.** `packages/camera-coverage-sdk/specs/spec.md` and `apps/sample-app/specs/spec.md` are the source of truth for intended behavior, not just background reading — check the applicable section(s) before touching engine or app code.
- **Update the spec first, and get approval before implementing.** For any behavior change, write the spec edit describing the new/changed behavior and present it to the user for approval before writing implementation code. Don't code ahead of an approved spec change.
- **Keep the spec consistent with the implementation.** The spec and code must never drift — a diff that changes behavior without a corresponding (approved) spec update is incomplete.
- **Add tests for every new change.** New functionality or bug fixes need a corresponding test (unit, acceptance, WASM-parity, or WebGPU as applicable — see below); don't rely on manual verification alone.

## Commands

SDK (`packages/camera-coverage-sdk`):
```bash
npm test                      # node --test --experimental-strip-types "test/**/*.test.ts"
npm test -- --test-name-pattern "<name>"   # run a single test
npm run typecheck              # tsc --noEmit
npm run build:wasm             # compiles crates/camera_coverage_wasm → src/wasm/*.wasm; needs rustup + wasm32 target
```
Node ≥ 22.6 is required (native TS type-stripping, no build step for the SDK itself).

Sample app (`apps/sample-app`):
```bash
npm run dev         # vite dev server
npm run build        # tsc -b && vite build
npm run typecheck
```

## SDK architecture

Everything is oriented around one pipeline: **scene → occupancy/BVH preprocessing → per-chunk GPU (or CPU) visibility compute → merged result → accessor**. Read `packages/camera-coverage-sdk/README.md` before making non-trivial changes — it has a spec-section-to-module table and documents the exact interpretations/edge cases chosen where the spec was ambiguous (validity semantics, `CAMERA_INSIDE_GEOMETRY`, pre-cull losslessness, etc.).

Key structural points:

- **Two compute backends, one algorithm.** `src/compute/cpu.ts` (TypeScript) and `src/compute/webgpu.ts` + `src/shaders.ts` (WGSL) are meant to implement bit-identical logic — same camera/BVH struct layouts, same Möller–Trumbore ray-triangle test, same traversal. When fixing a bug in one, check whether the same bug exists in the other. **The CPU backend is the tested behavioral reference**; the WebGPU path historically shipped with real bugs that only surfaced at runtime on real WGSL compilers (see "WebGPU is a separate risk surface" below) — don't assume "matches the CPU logic on inspection" means it's correct until it's actually been run.
- **Two preprocessing implementations, one algorithm.** Mesh cleaning / BVH build / occupancy / SVO construction exist both as a Rust→WASM crate (`crates/camera_coverage_wasm/`, raw-pointer ABI, no wasm-bindgen) and as an equivalent pure-TS fallback. `test/wasm.test.ts` checks them for byte-identical/equivalent output — keep both in sync when changing either.
- **Dense buffers during compute, SVO for storage/transfer.** GPU passes need random-access writes to per-voxel buffers (§9.1–9.3 of the spec), so compute always works on dense arrays; results are immediately compressed into a sparse voxel octree (`src/svo.ts`) for the CPU-side store and for worker↔main-thread transfer, with dense as a documented fallback encoding when SVO offers no size benefit. Downstream code must go through `VoxelAccessor`/`accessor()` (`src/results.ts`) and stay agnostic to which encoding it got.
- **Camera masks are word-parameterized, not hardcoded to 32.** `CAM_WORDS = ceil(numCameras / 32)` is threaded through buffer layouts, WGSL `override` constants, and the SVO merge key. Never assume a single `u32` mask — support for >32 cameras (up to 128) depends on this.
- **Everything expensive runs off the main thread.** `src/worker/{host,client,entry,protocol}.ts` implement a `VisibilityEngine`-shaped proxy over postMessage; large typed arrays cross that boundary as transferables, never structured-clone copies. `loopback()` (used in tests) does NOT simulate buffer detachment/transfer semantics — don't rely on it to catch transfer-ownership bugs.
- **Chunking is a memory-budget mechanism, not a fixed constant.** Chunk count/size derive from workspace dimensions (`src/grid.ts`); only one chunk's GPU buffers are ever resident at a time by design (§9.4 of the spec).

## WebGPU is a separate risk surface from everything else

`npm test` alone does **not** exercise the real WebGPU/WGSL path — `test/webgpu.test.ts` is the one file that does, using the `webgpu` npm package (`dawn-gpu/node-webgpu`, native Dawn bindings) to get a real `navigator.gpu` under `node --test` (skips cleanly if no GPU adapter is available). This is the only way to validate WGSL changes without a real browser: Playwright/automated browsers on this machine have `navigator.gpu` undefined regardless of flags tried, so browser-automation testing of the WebGPU path isn't viable here.

Two real bugs were only catchable this way, both fixed:
- WGSL operator-precedence bug in `src/shaders.ts` (`>>`/`&` mixed without parens — WGSL doesn't share C/JS precedence here), which made Tint reject the compute pipelines and silently produced all-zero visibility with no thrown error.
- An empty-scene BVH sentinel-root bug in `src/geometry/bvh.ts` causing a real GPU infinite loop, from an "always-false AABB" trick that this codebase's slab-test actually evaluates as always-true, combined with `prim == 0` ambiguously meaning both "interior node" and "empty leaf."

Implication for future work: treat any WebGPU/WGSL change as unverified until run through `test/webgpu.test.ts` (or real hardware) — passing `npm test` proves the CPU reference is correct, not that the GPU path is.
