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

The pipeline runs over **every** chunk by default. `compute({ incremental: true })`
(§13.1) narrows the per-chunk stage to the chunks a camera edit can have affected,
leaving the preprocessing and sampling stages untouched — they were already
camera-independent. Nothing else in the flow changes: a recomputed chunk is recomputed
whole, over all cameras, so no chunk ever mixes camera generations.

## Module map

| Concern | Spec | Module(s) |
|---|---|---|
| Coordinate system, workspace + chunk partition | §2–3 | `src/grid.ts` |
| Mesh cleaning (degenerate/NaN culling) | §5.1 | `src/geometry/mesh.ts` |
| Occupancy (triangle–AABB SAT + flood-fill SOLID) | §6.2 | `src/occupancy.ts`, `src/geometry/triangle-aabb.ts` |
| Sampling policy → validity mask, and its per-chunk cache | §6.3/§6.4 | `src/sampling.ts` |
| Camera model (viewProj, 96-byte GPU struct, CAM_WORDS, pre-cull) | §7 | `src/camera.ts` |
| Ray occlusion (Möller–Trumbore, any-hit) | §8/§10.3 | `src/kernel.ts` (CPU), `src/shaders.ts` (WGSL) |
| Binned-SAH BVH, threaded stackless node layout | §10 | `src/geometry/bvh.ts` |
| Per-chunk pipeline (Pass 1/2/3), submission & readback | §11/§11.1 | `src/compute/cpu.ts`, `src/compute/webgpu.ts`, `src/shaders.ts` |
| Dense result buffers | §9.1–9.3 | `src/compute/cpu.ts`, `src/results.ts` |
| SVO merged storage + `VoxelAccessor` | §9.5 | `src/svo.ts` |
| Incremental recompute baseline + dirty-set diff | §13.1 | `src/incremental.ts` |
| Cancellation (signal check + macrotask yield) | §13.2 | `src/engine.ts`, `src/worker/*` |
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
- **Submission contract (§11.1)**: per chunk, all three passes plus the staging
  copies go into **one** command encoder and **one** `submit()`, followed by
  **one** `mapAsync`. Nothing is read back to size a dispatch — Pass 2's bound is
  `ceil(validCount / 64)` from the §6.4 cache. Adding a mid-chunk readback, a
  second submit, or a per-buffer staging map breaks this and is caught by §18.6d
  (`gpuCounters`). The CPU backend has no equivalent structure, so this is the one
  axis where the two backends legitimately differ in shape while staying
  bit-identical in output.
- **One staging buffer means one *summed* allocation.** Because `stats`,
  `visibility`, and `coverage` are resident in it together, its peak is their
  **sum** — at Mode 2 / 0.1 m / 128 cameras, 160 MB against a default
  `maxBufferSize` of 128 MiB. `planStaging()` (pure, unit-tested by §18.6f) lays the
  segments out and reports that size; `computeChunk` compares it to
  `device.limits.maxBufferSize` and throws `SCENE_TOO_LARGE` *before* creating the
  buffer, since an over-large `createBuffer` otherwise fails as an uncaptured
  `GPUValidationError` and only surfaces as a rejected `mapAsync`. The per-chunk
  buffers are released in a `finally`, so a rejection here — or a device loss
  mid-chunk — leaves nothing stranded.

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

The `VoxelAccessor` surface has two shapes here, and picking the wrong one is a
silent correctness bug rather than a type error: `getMask()` and `forEachLeaf`'s
`mask` argument are **word 0 only**, while `getMaskWord(i, j, k, word)` and
`forEachLeaf`'s `maskWords` argument cover all `CAM_WORDS` words. Anything that
popcounts, tests "blind", or tests a specific camera bit must use the latter —
otherwise it works up to 32 cameras and quietly drops the rest. `maskWords` is
accessor-owned scratch reused per leaf; reduce it to a scalar or copy it.

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

## Retained state across calls, and what drops it

Two things now survive from one call to the next, and they invalidate differently:

| State | Owner | Keyed to | Dropped by |
|---|---|---|---|
| Per-chunk validity mask + `validCount` (§6.4) | `src/sampling.ts` | scene + `SamplingConfig` | `loadScene()`, `setSampling()` |
| Incremental baseline: camera set, run options, per-chunk stats (§13.1) | `src/incremental.ts` | scene + sampling + cameras + run options | the above, plus re-`init()`, a **cancelled** or thrown `compute()`, and any ineligible edit |

The baseline is strictly *narrower* than the validity cache: anything that drops the
cache must also drop the baseline, never the reverse. Reviewing a change that touches
lifecycle, check that direction explicitly — the failure mode is not a crash but a
coverage number computed against a stale chunk, which looks entirely plausible.

Two invariants carry the correctness of §13.1 and are worth stating as invariants
rather than leaving in the code:

- **The dirty set may over-approximate, never under-approximate.** It is built from the
  same conservative frustum–AABB test as pre-cull (`src/camera.ts`), which has false
  positives only. Any change that tightens that test to be more exact must be checked
  against *both* callers.
- **Cancellation needs the event loop to turn, not just a flag.** The CPU backend's
  `computeChunk` is synchronous, so a cancel crossing the Worker boundary (a macrotask)
  can only land if the engine explicitly yields between chunks. Anything that removes
  that yield makes cancellation silently inert in the worker while still passing an
  in-process test — `test/worker.test.ts` over `loopback()` is what catches it.
- **A chunk's mask never mixes camera generations.** A dirty chunk is recomputed over all
  cameras, not just the changed ones. Recomputing "only the moved camera's bit" would be
  faster and is wrong — the retained mask is the caller's, not the engine's, and the
  engine has nothing to merge into.

Both are covered by §18.6g–6i, which pair an equivalence assertion with a
dispatch-counter assertion: equivalence alone passes if the optimization silently stops
working, and the counter alone passes if it works but is unsound.

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

A third failure of the same shape is now designed out rather than tested for:
`upload()` in `src/compute/webgpu.ts` honours a view's `byteOffset`/`byteLength`
instead of uploading `.buffer` wholesale. Any pooled or `subarray()`-backed host
buffer — the validity cache and `bvh.triData` are both candidates — would
otherwise send the wrong bytes **only on the GPU path**, while the CPU reference
read through the view correctly and every determinism test still passed.

Treat any WebGPU/WGSL change as unverified until run through `test/webgpu.test.ts`
or real hardware. Passing `npm test` proves the CPU reference is correct, not the
GPU path.
