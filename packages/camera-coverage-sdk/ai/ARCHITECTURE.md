# ARCHITECTURE.md — `@linkervision/camera-coverage-sdk`

How the SDK is structured. For *why* these choices were made see
[DECISIONS.md](./DECISIONS.md); for the behavioral contract see
[`../specs/spec.md`](../specs/spec.md) and the spec-section → module table in
[`../README.md`](../README.md).

## The one pipeline

Everything is oriented around a single data flow:

```
scene (raw buffers)
  → preprocessing: mesh clean → BVH build → triangle→chunk index    (WASM or TS)
  → sampling setup: per chunk — voxelize occupancy → regions ∩ free space
                    → validity mask (occupancy dropped, mask cached)
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
| Occupancy (`OccupancySource`: per-chunk by default, dense only for the flood fill) | §6.2 | `src/occupancy.ts`, `src/geometry/triangle-aabb.ts` |
| Sampling policy → validity mask, and its per-chunk cache | §6.3/§6.4 | `src/sampling.ts` |
| Camera model (viewProj, 96-byte GPU struct, CAM_WORDS, pre-cull) | §7 | `src/camera.ts` |
| Ray occlusion (Möller–Trumbore, any-hit) | §8/§10.3 | `src/kernel.ts` (CPU), `src/shaders.ts` (WGSL) |
| Binned-SAH BVH, threaded stackless node layout | §10 | `src/geometry/bvh.ts` |
| Per-chunk pipeline (Pass 1/2/3), submission & readback | §11/§11.1 | `src/compute/cpu.ts`, `src/compute/webgpu.ts`, `src/shaders.ts` |
| Dense result buffers | §9.1–9.3 | `src/compute/cpu.ts`, `src/results.ts` |
| SVO merged storage + `VoxelAccessor` | §9.5 | `src/svo.ts` |
| Incremental recompute baseline + dirty-set diff | §13.1 | `src/incremental.ts` |
| Aggregation: descriptor, packing, CPU reduction, merge helpers | §19 | `src/aggregate.ts` |
| Per-chunk readback budget (host heap, not `maxBufferSize`) | §11.1 | `src/compute/webgpu.ts` (`maxChunkReadbackBytes`) |
| Aggregation passes (region / column / leaf-count reduce) | §19.3 | `src/shaders.ts` (Pass 4–6), `src/compute/webgpu.ts` |
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

- `src/aggregate.ts` (`aggregateChunkCPU`, `regionMask`) and `src/shaders.ts`
  (Pass 4–6, `AGG_COMMON`'s `regionMask`) are a **fifth** axis of the same
  duplication: the §19 reduction exists twice, once in JavaScript and once in
  WGSL, and §18 6l asserts they agree bit-for-bit. The sharp edge is `regionMask`
  — the OBB test — where a divergence produces a plausible wrong count rather
  than a crash. Both sides read the *same* packed `Float32Array` (`packAggregate`)
  so they at least start from identical f32 values.
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
  segments out and reports that size; `computeChunk` compares it to *both*
  `maxChunkReadbackBytes` (§11.1's host-heap budget) and
  `device.limits.maxBufferSize`, and throws `SCENE_TOO_LARGE` *before* creating the
  buffer, since an over-large `createBuffer` otherwise fails as an uncaptured
  `GPUValidationError` and only surfaces as a rejected `mapAsync`. `aggregateChunk`
  (§19.4) plans and checks the same two — it copies the accumulators out of the
  mapped range exactly as `computeChunk` does. The per-chunk buffers are released in
  a `finally`, so a rejection here — or a device loss mid-chunk — leaves nothing
  stranded.

  **The plan is keyed, not positional.** A segment's index is a function of which
  *other* segments were requested — a stats-only run plans one, a Mode 2 run with
  every §19 primitive plans eight — so `planStaging` takes `{key, bytes}` requests
  and answers `offsetOf(key)` / `sizeOf(key)` / `has(key)`. Reading a segment back
  by position is a bug waiting for the first descriptor that omits an earlier
  primitive. `ChunkBufferPool` slots are a union type for the same reason: a
  mistyped slot name would not fail, it would quietly open a second residency.

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

Chunk count/size derive from workspace dimensions (`src/grid.ts`), not a constant.
The **10 m × 10 m** figure quoted in §3 is the default *for the default workspace*
(100 × 20 × 100 m at 0.1 m), where it gives ~100 chunks of 2M voxels. Treat that
as an example, not a fact about every scene — a caller that pins it gets a
partition scaled to its own site:

| Workspace | `chunkSizeXZ` | Chunks | Voxels/chunk |
|---|---|---|---|
| 100 × 20 × 100 m @ 0.1 m | 10 m (pinned) | 100 | 2,000,000 |
| 440 × 201 × 1120 m @ 1.0 m | 10 m (pinned) | **4,928** | **20,100** |
| 440 × 201 × 1120 m @ 1.0 m | 99 m (`suggestChunkSizeXZ`) | 60 | 1,970,001 |

Nothing in the middle row is a per-voxel cost: it multiplies every **per-chunk
fixed** cost — a GPU buffer set, a submission, a mapping, a result message, a
§19.3 leaf merge — by 50. `suggestChunkSizeXZ` (`src/grid.ts`) derives the
footprint from a 2M-voxel target instead; because chunks partition XZ only, the
height is a fixed multiplier and `vpc = floor(sqrt(target / gridY))`. It returns
exactly 10 m on the §3 defaults.

Only one chunk's GPU buffers are ever resident at a time (§9.4), a memory-budget
constraint driven by WebGPU's default 128 MiB `maxStorageBufferBindingSize`. That
residency is now held by a **pool** rather than by create-and-destroy — see below.

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

## Occupancy is preprocessing, and it is materialized per chunk

Two things about `src/occupancy.ts` are easy to get wrong from the outside, and
both were wrong in its own header comment until measured:

**It is not part of either backend.** `loadScene` calls it unconditionally,
before `backend.setScene(...)`, and `grep occupancy src/compute/*.ts` returns
nothing. There is no GPU occupancy path — "use the GPU backend for large
workspaces" was never an escape hatch, and `MAX_CPU_VOXELS` is not a CPU-backend
cap. Backends see occupancy only through the 1-bit-per-voxel validity mask
`sampling.ts` derives from it.

**It is materialized per chunk, not per workspace** (§6.2). The classification's
only per-voxel consumer is the validity build, which compresses it 8× and caches
*that* — so a workspace-wide array is an intermediate that would outlive its own
output by the whole session. Two sources implement `OccupancySource`:

| Source | When | Retains |
|---|---|---|
| `ChunkOccupancy` | the default (`solidDetection: false`) | nothing per voxel — one reused chunk scratch, plus a CSR triangle→chunk index |
| `DenseOccupancy` | `solidDetection: true` only | the workspace grid; the flood fill is a *global* reachability question no chunk can answer |

Both drive **one** voxelizer, `voxelizeWindow`, parameterized by the window it
writes and the triangle set it tests: the dense source passes the whole grid and
every triangle, the per-chunk source passes one chunk's extent and that chunk's
index slice. Two copies of this arithmetic would agree only by luck, and §18 6u
asserts they agree exactly.

The trap when touching it: **voxel centers and AABB ranges must be
computed in global index space off `worldMin`, never off the chunk origin.**
`worldMin + (i0 + i + 0.5) * vs` is not bit-identical to
`(worldMin + i0 * vs) + (i + 0.5) * vs`, and at 0.1 m over 100 m that drift
reclassified ~48k of 97M voxels at chunk seams — a plausible-looking coverage
percentage, not a crash. Only the *storage* is chunk-local. `§18 6u`'s seam test
(unaligned origin, 0.1 m voxels, 400 chunks, walls *on* the boundaries) is what
catches it; the small-grid parity test does not.

## Reused scratch buffers, and the rule they all share

Three hot paths hand out a **reused** typed array rather than a fresh one, because
each ran once per chunk on a path that repeats over every chunk of a scene:

| Scratch | Where | Handed to |
|---|---|---|
| Zero masks for a pre-culled chunk (§19.4) | `engine.ts`, per `compute()` | `assembleChunkResult` / `buildSvo` |
| Dense expansion of a retained SVO chunk (§19.4) | `results.ts` (`DenseScratch`), per `aggregate()` | `ComputeBackend.aggregateChunk` |
| Leaf-merge levels + the growing leaf list (§19.3) | `aggregate.ts`, per `mergeLeafCounts` | nothing — internal |
| One chunk's occupancy cells (§6.2) | `occupancy.ts`, per source | `sampling.ts`'s validity build |
| The per-chunk **GPU** buffers (§11.1) | `compute/webgpu.ts` (`ChunkBufferPool`), per backend | the compute and §19 passes |

The shared rule: **a reused buffer must not escape into a returned value.** The
consumers above satisfy it — the CPU reduction reads and reduces, the WebGPU one
copies into a device buffer before returning, `resolveProbes` copies the words it
needs. The one place it is *violated by design* is `buildSvo` declining to
compress: `results.ts`'s dense fallback keeps the array it was handed, so
`compute()` surrenders that scratch and allocates the next one.

Two subtleties that a reader will otherwise rediscover the hard way:

- **A reused buffer must be fully written, not sparsely written.** `denseOf` writes
  zeros at invalid voxels instead of skipping them; skipping would inherit the
  previous chunk's masks. `DenseScratch` zero-fills `validity` on hand-out because
  `denseOf` only ORs bits into it.
- **Hand out an exact `subarray`, not the whole high-water buffer**, so a
  consumer's `length` still describes the chunk. `queue.writeBuffer` honours a
  view's `byteOffset`/`byteLength`, so this is also what keeps GPU uploads sized
  to the chunk.

The GPU pool is the same rule one level down, and the sharpest instance of it.
`computeChunk` used to create ~18 `GPUBuffer`s per chunk and destroy them in a
`finally`; at the 4,928-chunk partition above that is ~88,700 create/destroy
cycles in one run, and a driver reclaims a destroyed buffer's mappable memory
*asynchronously* — so the loop outran reclamation and died inside the readback.
Reuse is not an optimization here, it is what makes residency bounded.

**WebGPU zero-initializes a buffer at creation, not at reuse.** Every pooled
buffer the passes accumulate into (`candidateCount`, `stats`, `visibility`, and
§19's `regionAccum` / `cellAccum` / `cellSeen` / `leafCounts` / `leafValid`) is
cleared per chunk, in the same encoder so §11.1's one-submit contract holds.
`candidates` and `candMasks` are deliberately exempt: Pass 1 writes them at
compacted slots and Pass 2 reads only slots below `candidateCount`. If you add a
buffer to the pool, decide which of those two it is — getting it wrong produces a
wrong number, not a crash, which is why §18 6x compares a multi-chunk run against
one chunk per fresh engine.

Allocation bounds are acceptance criteria, not comments: §18 6s/6t and the
allocation-tracing tests in `test/aggregate.test.ts` (they patch the global
`Uint32Array` / `Int16Array` constructor and count), plus §18 6y over
`gpuCounters.buffersCreated`. If you add a per-chunk allocation, expect one of
them to fail.

## Failures must name themselves across the Worker boundary

`installHost`'s `replyError` maps any non-`EngineError` throw to `INVALID_STATE`.
It now also carries the worker's `stack` and the error's `detail` (§17), and
`WorkerClient` appends the worker frames to the client's own. Before that, an
allocation failure anywhere in the worker reached the app as a bare
`INVALID_STATE: Array buffer allocation failed` naming nothing — no size, no
chunk, no frame — and diagnosing one took four rounds of measuring the wrong
things. When you add a throw on a per-chunk path, attach what a caller could act
on: `readbackFailure` in `compute/webgpu.ts` is the shape to copy.

One thing that misled the search and is worth stating: **the worker and the main
thread share one renderer address space.** A failed `ArrayBuffer` allocation
reported by the worker does not prove the worker is what exhausted memory.

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
