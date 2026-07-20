# ARCHITECTURE.md — `@linkervision/camera-coverage-sdk`

How the SDK is structured. For *why* these choices were made see
[DECISIONS.md](./DECISIONS.md); for the behavioral contract see
[`../specs/spec.md`](../specs/spec.md) and the spec-section → module table in
[`../README.md`](../README.md).

## The one pipeline

Everything is oriented around a single data flow:

```
scene (raw buffers)
  → preprocessing: mesh clean → occupancy + flood-fill → BVH build   (WASM or TS)
  → sampling setup: regions ∩ free space → validity mask
  → camera setup: quaternion → viewProj matrices (CPU)
  → per-chunk compute (one chunk resident at a time):
        Pass 1 frustum cull + compaction
        Pass 2 BVH ray occlusion  (Möller–Trumbore, any-hit)
        Pass 3 stats reduction                                        (WebGPU or CPU)
  → readback → SVO compression (dense fallback)
  → onChunkDone(ChunkResult) + CoverageSummary
```

Public entry: `createEngine()` / `CoverageEngine` implementing `VisibilityEngine`
(`init → loadScene → setSampling → setCameras → compute → dispose`).

## Module map

| Concern | Spec | Module(s) |
|---|---|---|
| Coordinate system, workspace + chunk partition | §2–3 | `src/grid.ts` |
| Mesh cleaning (degenerate/NaN culling) | §5.1 | `src/geometry/mesh.ts` |
| Occupancy (triangle–AABB SAT + flood-fill SOLID) | §6.2 | `src/occupancy.ts`, `src/geometry/triangle-aabb.ts` |
| Sampling policy → validity mask | §6.3 | `src/sampling.ts` |
| Camera model (viewProj, 96-byte GPU struct, CAM_WORDS, pre-cull) | §7 | `src/camera.ts` |
| Ray occlusion (Möller–Trumbore, any-hit) | §8/§10.3 | `src/kernel.ts` (CPU), `src/shaders.ts` (WGSL) |
| Binned-SAH BVH, threaded stackless node layout | §10 | `src/geometry/bvh.ts` |
| Per-chunk pipeline (Pass 1/2/3) | §11 | `src/compute/cpu.ts`, `src/compute/webgpu.ts`, `src/shaders.ts` |
| Dense result buffers | §9.1–9.3 | `src/compute/cpu.ts`, `src/results.ts` |
| SVO merged storage + `VoxelAccessor` | §9.5 | `src/svo.ts` |
| Engine API + orchestration | §16.1 | `src/engine.ts` |
| Web Worker host + main-thread client | §4/§16 | `src/worker/*` |
| Rust WASM kernels | §4/§6.2/§9.5/§10 | `crates/camera_coverage_wasm/` + `src/wasm/loader.ts` |
| Error handling | §17 | `src/types.ts` (`EngineError`/`EngineErrorCode`) |
| Kernel selection (TS vs WASM) | — | `src/kernels.ts` (`tsKernels`, `Kernels`) |
| Acceptance tests | §18 | `test/acceptance.test.ts` |

## The four axes of duplication

The design deliberately maintains several parallel implementations that must stay
in lockstep. Understanding these is essential to not breaking one while fixing the
other.

### 1. Two compute backends, one algorithm

- `src/compute/cpu.ts` (TypeScript) and `src/compute/webgpu.ts` + `src/shaders.ts`
  (WGSL) implement **bit-identical** logic: same camera/BVH struct layouts, same
  Möller–Trumbore ray-triangle test, same stackless traversal.
- **The CPU backend is the tested behavioral reference.** The WebGPU path has
  historically shipped with real bugs that only surface on a real WGSL compiler
  (see below). Fix a bug in one → check the other.
- WebGPU uploads the immutable BVH/triangle buffers once, then creates/destroys
  per-chunk buffers around each dispatch so only one chunk is GPU-resident (§9.4).

### 2. Two preprocessing implementations, one algorithm

Mesh clean / BVH build / occupancy / SVO exist as **Rust → WASM**
(`crates/camera_coverage_wasm/`, raw-pointer ABI, no wasm-bindgen) *and* as an
equivalent pure-TS fallback (`tsKernels`, the default). `test/wasm.test.ts` holds
them to byte-identical (occupancy cells, SVO node arrays) / occlusion-equivalent
(BVH) output. Select WASM via `new CoverageEngine({ kernels })` from
`createWasmKernels(...)`.

The four Rust kernels: `clean_mesh`, `build_bvh`, `compute_occupancy`,
`build_svo`. The ABI: JS allocates input buffers, calls a kernel, reads a small
`u32` header describing outputs, copies them out, frees everything
(`src/wasm/loader.ts`).

### 3. Dense during compute, SVO for storage/transfer

GPU passes need random-access writes to per-voxel buffers, so compute always
works on **dense arrays**; results are immediately compressed into a **sparse
voxel octree** (`src/svo.ts`, 256³ root, depth 8, 9-byte SoA nodes) for the
CPU-side store and worker→main transfer. Dense is a documented fallback encoding
when SVO offers no size benefit (recorded in `ChunkResult.encoding`). Downstream
code goes through `accessor(result)` / `VoxelAccessor` (`src/results.ts`) and
stays agnostic to which encoding it got.

### 4. Camera masks are word-parameterized

`CAM_WORDS = ceil(numCameras / 32)` (range 1–4, up to 128 cameras) is threaded
through buffer layouts, WGSL `override` constants, and the SVO merge key. Camera
`c` → `word = c >> 5`, `bit = c & 31`, stable across chunks. Never assume a single
`u32` mask.

## Off-thread execution

`src/worker/{host,client,entry,protocol}.ts` implement a `VisibilityEngine`-shaped
proxy over `postMessage`:

- `installHost(transport)` runs the engine worker-side; `WorkerClient` is the
  main-thread proxy exposing the same interface.
- Large typed arrays (input meshes, streamed chunk results) cross as
  **transferables**, never structured-clone copies. Callers must not reuse a
  mesh's typed arrays after `loadScene` hands them off.
- `messageTransport(self)` wraps a real `Worker`; `loopback()` runs both ends
  in-process for tests. **`loopback()` does NOT simulate buffer
  detachment/transfer semantics** — it won't catch transfer-ownership bugs.

## Chunking

Chunk count/size derive from workspace dimensions (`src/grid.ts`), not a constant
— default 10 m × 10 m on XZ, full workspace height, giving 100 chunks of 2 M
voxels each. Only one chunk's GPU buffers are ever resident at a time (§9.4), a
memory-budget constraint driven by WebGPU's default 128 MiB
`maxStorageBufferBindingSize`.

## WebGPU is a separate risk surface

`npm test` does **not** exercise the real WGSL path. `test/webgpu.test.ts` is the
only file that does, using the `webgpu` npm package (native Dawn) to get a real
`navigator.gpu` under `node --test` (skips cleanly with no GPU adapter). This is
the only headless way to validate WGSL here — Playwright/automated browsers on
this machine have `navigator.gpu` undefined regardless of flags.

Two real bugs were only catchable this way (both fixed):
- A WGSL **operator-precedence** bug in `src/shaders.ts` (`>>`/`&` mixed without
  parens — WGSL precedence differs from C/JS), which made Tint reject the compute
  pipeline and silently produced all-zero visibility.
- An **empty-scene BVH sentinel-root** bug in `src/geometry/bvh.ts` causing a real
  GPU infinite loop.

Treat any WebGPU/WGSL change as unverified until run through `test/webgpu.test.ts`
or real hardware. Passing `npm test` proves the CPU reference is correct, not the
GPU path.
