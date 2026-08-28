# DECISIONS.md — `@linkervision/camera-coverage-sdk`

Notable technical decisions and their trade-offs. These record *why* the code and
[`../specs/spec.md`](../specs/spec.md) are shaped the way they are. Newest
decisions at the top when you add to this file.

---

## Cancellation is cooperative, chunk-granular, and needs a macrotask yield to work

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.2, §16.1, §17.

**Why.** A superseded run — the caller changed resolution, sampling, or the scene — used
to run to completion because the engine exposed no way to stop it; callers could only
discard the result. **Decision:** `compute()` takes an `AbortSignal` and checks it
between chunks. Chunk granularity is forced, not chosen: Passes 1–3 are a single GPU
submission (§11.1) with no interruption point inside them, so the floor on cancel latency
is one chunk either way.

**The non-obvious part** is that checking the signal is not enough. On the CPU backend
`computeChunk` is synchronous, so `await`ing it drains microtasks only — and a cancel
crossing the Worker boundary is a *message*, a macrotask. Without an explicit
`setTimeout(0)` between chunks the flag could never flip mid-run, and cancellation would
appear to work in an in-process test while doing nothing in the real worker. The WebGPU
backend already yields at `mapAsync`, but the yield is unconditional so both backends
behave the same, and it is skipped entirely when no signal was supplied so an
uncancellable run pays nothing. `test/worker.test.ts` covers this end-to-end over
`loopback()`, which is the only place the macrotask requirement is actually visible.

**Trade-off.** Rejecting with `COMPUTE_CANCELED` rather than resolving with a partial
summary means every caller has to classify the error; the alternative — a "was cancelled"
flag on the summary — would let a caller silently treat a partial scan as a whole-scene
one. A cancelled run also drops the incremental baseline (§13.1): it stopped part-way,
so its retained statistics straddle two camera generations, which is the same condition
a thrown `compute()` already discards for. That makes the run *after* a cancellation a
full one — the cost of stopping early, and §18.6k pins it so nobody 'optimizes' it away.

**Related.** An `AbortSignal` cannot be cloned into a Worker any more than a callback
can. The client keeps the signal and relays a firing as a `cancel` message naming the
request; the host holds one `AbortController` per in-flight compute. A cancel for an id
that already settled is a deliberate no-op — a late cancel racing a finishing run is
normal, not an error.

## Incremental recompute keys off camera *identity*, and `enabled` exists to protect it

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.1, §5.2, §16.1.

**Why.** §13 always listed "recompute only the chunks touched by the moving camera's
old and new frusta" as step 3, and it was never implemented: `compute()` defaulted
`chunkIds` to every chunk, so a gizmo drag at 10 runs/sec re-ran the whole workspace to
move one camera a few centimetres. The blocker was never the frustum math — the
conservative pre-cull test in §7.2 already answers "can this camera touch this chunk"
with no false negatives. It was that a mask bit is a camera's *array index*, so a
retained result is only meaningful while the camera list is positionally identical.
**Decision:** an incremental run is gated on the ordered camera **id** list being
unchanged, and on `mode`/`threshold`/`emitVoxels` matching, before any dirty-set math
runs. Everything else falls back to a full run. **Trade-off:** add, delete, and reorder
pay full price. Reorder never marks the app stale anyway, and add/delete are one-off
clicks rather than a continuous stream, so the case that actually needed this — dragging
— is fully covered.

**Related.** `CameraConfig.enabled` was added *for* this rule, not for convenience.
`sample-app` used to filter its list to enabled cameras before `setCameras()`, which
made switching a camera off a positional edit: every later camera's bit shifted, and
every retained mask in the app became garbage. Toggling is a common interaction, so it
would have fallen back to a full recompute on every click. Carrying the flag instead
keeps indices stable and makes a toggle just another eligible pose-class edit. The price
is that disabled cameras consume the 128-camera budget and can widen `CAM_WORDS`, and
that every "of N cameras" denominator in a consumer must now count enabled entries
rather than take the list's length — §5.4 of the app spec enumerates the call sites.

## The engine retains per-chunk statistics, never per-chunk masks

Behavior in [`../specs/spec.md`](../specs/spec.md) §13.1.

**Why.** An incremental run skips chunks, but `CoverageSummary` must still describe the
whole scene — `overallRate` and `perCamera` are ratios over every valid voxel, not over
the ones this run happened to touch. Something has to remember the skipped chunks.
The obvious move is to retain the `ChunkResult`s, and it is the wrong one: that is the
per-voxel data §9.4 budgets in megabytes per chunk, and whoever consumed `onChunkDone`
is already holding it. **Decision:** the baseline retains only
`{ validCount, coveredCount, visibleCount[] }` per chunk — kilobytes total — and the
summary is re-summed across all of them. Voxel-level retention stays the caller's
problem, which is why `onRunStart` exists to tell the caller when it must replace rather
than rebuild. **Trade-off:** the engine cannot serve a "give me chunk 7 again" query, and
a caller that ignores `onRunStart` and clears its store on an incremental run silently
loses most of the scene. That failure is invisible at the type level, so §16.1 states the
replace-don't-reset contract explicitly and §18.6i pins the fallback reporting.

**Related.** The baseline advances only on a run that completed over everything it was
responsible for. A `compute()` with an explicit `chunks` list never advances it, and a
throw discards it. Both keep the invariant "the baseline describes one camera generation
uniformly" — the alternative, per-chunk baselines, would let a half-finished run leave
chunks straddling two camera sets with no cheap way to tell which.

## Narrowed validity-build loops clamp inward only; an unreached chunk is empty

**Why:** building the validity mask by testing every voxel center against every
region is the whole cost of `setSampling()`, so the builder narrows its `i/j/k`
loops to the region union's index range and — when that range is *exact*, which a
single region of any kind makes it — skips the per-voxel region test entirely.
Clamping the derived indices into `[0, n-1]` looks like the obvious way to keep
them in bounds, and it is wrong: a region that misses a chunk on some axis
collapses to a single edge index instead of an empty range, and with the per-voxel
test skipped, that chunk hands back a whole plane of "valid" voxels it never
contained. A single `box` volume — what `sample-app` emits for every sampling
volume — inflates `validVoxels`/`activeChunks` and deflates every coverage rate.
**Decision:** clamp only the *inward* side (`lo` up to 0, `hi` down to `n-1`) and
return early when any axis leaves `lo > hi`. The narrowing stays an optimization
that cannot change the answer, which is how §6.4 Build now states it.
**Trade-off:** one extra three-way comparison per chunk, and a bug class that is
invisible to any test whose region sits inside the workspace — so §18.6e pins a
corner `box` across a 3×3 chunk partition and a `heightBand` above *and* below the
workspace, and fails against the clamped version.

## A zero-valid-voxel chunk reports a zero-length mask on every call

**Why:** §6.4 caches a chunk with `validCount === 0` as a null entry that "caches
no words", so cache hits returned a shared zero-length `EMPTY`. The *building*
call, though, returned the full-length all-zero array it had just allocated — the
same chunk answered differently depending on whether you were first. Nothing broke
only because `compute()` skips on `validCount` before reading words.
**Decision:** `build()` returns `EMPTY` too, so there is exactly one answer for an
empty chunk, and the range check that precedes it means the words are never
allocated in the first place. The `ChunkValidity` contract now reads "ceil(voxelCount/32)
words, **or zero-length when validCount is 0**". **Trade-off:** consumers must gate
on `validCount`, never on `validity.length` — stated in §6.4 Build rather than left
to be discovered.

## The validity mask is cached per chunk; the cache owns its buffers

**Why:** the validity mask depends only on the scene and `SamplingConfig` — never
on cameras — yet `compute()` rebuilt it from scratch on every call, walking every
voxel of every chunk in JS. Measured at 0.1 m voxels that was 25–40% of a whole
`compute()` and a *constant* floor: with one camera it was 73% of the total. Since
repeated `compute()` with fixed scene and sampling is the primary interactive
workload (dragging a camera) and the inner loop of any camera-placement search,
this was the single largest waste in the engine. **Decision:** memoize per chunk on
the `SamplingState` instance (§6.4); a fresh instance *is* a new cache generation,
so "at most one build per chunk per generation" falls out of construction rather
than needing invalidation logic. `loadScene()` deliberately builds **nothing** —
the app's re-init path calls `setSampling()` immediately afterwards, so an eager
build there would be discarded unused. **Trade-off:** the mask is now resident
(≤ 25 MB for a full 100-chunk workspace) instead of transient, and it is
**cache-owned**: `assembleChunkResult` must copy it into a `dense` `ChunkResult`,
because the worker transfers those buffers to the main thread and thereby detaches
them — without the copy the *next* `compute()` would hand a backend a detached
buffer, and only on the dense fallback path, which makes it an intermittent. The
`svo` encoding folds validity into `nodeValid` and carries no array, so the common
path copies nothing. Guarded by §18.6a (build counter) and §18.6b (transfer-then-
recompute).

## Per-voxel readback is conditional on `onChunkDone`, not a new option

**Why:** `compute()` always read the dense `visibility` buffer back — up to 62 MB
per call at 0.1 m voxels with 128 cameras — even when the caller supplied no
`onChunkDone` and `emitChunk` discarded it immediately. **Decision:** treat the
absence of `onChunkDone` as a declaration of stats-only intent (§11.1) rather than
adding a `ComputeOptions` flag: the callback is already the only thing that
consumes per-voxel data, so a second switch could only ever disagree with it.
Callbacks cannot cross a Worker boundary, so `WorkerClient.compute()` derives a
boolean `emitChunks` onto the wire and the host installs a chunk stream only when
it is set. **Trade-off:** the performance cliff is invisible at the call site —
adding a `console.log` in `onChunkDone` silently restores the full readback. That
is why §16.1 states the coupling explicitly instead of leaving it to the reader.
Note the honest size of the win: on unified memory the copy itself is only ~5–10%
of a `compute()`; the real gains are the allocation/GC churn and, on a discrete
GPU, a PCIe transfer.

## Pass 2 is bounded by `validCount`, not by a read-back candidate count

**Why:** the per-chunk pipeline made three `submit()`s and blocked on a 4-byte
`candidateCount` readback purely to size Pass 2's dispatch — ~1.1 ms of pure
latency per chunk, which at coarse resolutions was *the entire cost* of a compute
(10 of 12 ms at 0.5 m voxels). §11 offered either "a 1-thread pass or a CPU
readback" to fill an indirect-dispatch buffer. **Decision:** neither. A candidate
must be a valid voxel, so `candidateCount ≤ validCount`, and the validity cache
already hands the CPU a per-chunk `validCount` — so dispatch `ceil(validCount/64)`
statically and let the shader's existing `slot >= candidateCount` guard retire the
surplus threads. The count never leaves the GPU, all three passes plus the staging
copies go into one encoder and one `submit()`, and one `mapAsync` returns
everything. §11's indirect-dispatch wording was narrowed accordingly.
**Trade-off:** up to `validCount − candidateCount` threads launch and immediately
return (each costing one buffer read), where true indirect dispatch would launch
only what is needed — bought in exchange for no fourth pipeline, no `INDIRECT`
buffer, and no GPU→CPU round trip mid-chunk. This decision is only available
*because* of the validity cache; reverting that one re-opens the question.
Guarded by §18.6d.

## `forEachLeaf` carries the full mask via a scratch `maskWords` buffer

**Why:** the callback's `mask` parameter is a single `number`, so it could only
ever carry word 0 — cameras 0–31. Every consumer that popcounted a leaf or tested
"seen by no camera" silently dropped cameras at index ≥ 32 (the sample app's
coverage overlay rendered such voxels as blind spots while the engine's own
statistics, which read all words, stayed correct). `getMaskWord` was the only
correct path, but using it means per-voxel queries, throwing away the leaf merging
that `forEachLeaf` exists for. **Decision:** add a fifth callback argument
`maskWords: Uint32Array` of length `CAM_WORDS`, and compute the `maxDepth`
majority key over the full word tuple rather than word 0 (§9.5). `mask` keeps its
word-0 meaning so single-word callers are untouched. **Trade-off:** `maskWords` is
an accessor-owned buffer **reused across invocations** — retaining a leaf requires
copying it. Chosen over allocating per leaf because traversals run to millions of
leaves per chunk; the alternative (making `mask` a `Uint32Array`) would have been
the same hazard plus a breaking change for every existing caller.

## Spec is the source of truth; README records interpretations

Behavior is defined in `specs/spec.md`, and the README collects the concrete
interpretations chosen where the spec was ambiguous (validity semantics,
`CAMERA_INSIDE_GEOMETRY`, pre-cull losslessness, Mode 2 coverage encoding).
**Trade-off:** more process overhead (spec-first, see [WORKFLOWS.md](./WORKFLOWS.md)),
bought back as a single place to resolve "what should this do?" without reverse-
engineering code.

## WebGPU compute is the production path; CPU is the reference

**Why:** 200 M voxels × up to 128 cameras ≈ 25.6 B rays — no CPU can do this at
interactive scale. **Trade-off:** requires WebGPU (Chrome/Edge 113+); no
production CPU fallback for browser end-users (they get an error + supported-
browser list). A **CPU backend still exists**, but as the *behaviorally tested
reference* and headless/Node path — bit-identical to the WGSL, and what the
acceptance tests run against. It rejects very large workspaces with a clear error.

## Occupancy never implies visibility

The most-guarded invariant. Occupancy (empty/mixed/solid) only gates *whether a
point is analyzed* and *lets ray traversal skip empty BVH regions*. Visibility is
**always** decided by a full BVH ray-occlusion traversal — an empty voxel can
still be walled off from a camera. **Trade-off:** no shortcut from occupancy to
visibility (more rays), in exchange for correctness.

## Validity is a separate mask from visibility

**Why:** so "visible to 0 cameras" is distinguishable from "not an analysis point
at all," keeping statistics and visualization clean. **Decision:** validity =
free space = `EMPTY_SPACE` only. `MIXED` (on a surface) and `SOLID` (enclosed
interior) are not meaningful free-space samples, so both are invalid. This
reconciles §6.2/§6.3/§9.2 with acceptance tests §18.2 (inside-wall invalid) and
§18.4 (closed-box interior invalid).

## `CAMERA_INSIDE_GEOMETRY` only for SOLID interiors

A camera in a `SOLID` interior is flagged and recorded as 0 coverage. A camera
merely adjacent to a wall (in a `MIXED` voxel) stays active — required by the
t_max regression test §18.3.

## Binned-SAH BVH, immutable, stackless/threaded

**Why binned SAH (16 bins, ≤8 tris/leaf):** good build/quality trade-off for a
static scene built once at load; camera moves need no rebuild. **Why threaded
stackless layout:** GPUs have no dynamic stack — traversal uses an implicit
hit-link (`i+1`) plus an explicit miss-link. Empty-space skipping comes free
(empty regions have no BVH nodes), so no separate empty-space structure is needed.
**Trade-off:** single-threaded build ≈ 1 M tris/s (won't hit the spec's parallel
target; see gaps).

## SVO for merged storage, dense during compute

**Why dense during compute:** Pass 2 needs random writes to arbitrary voxels;
trees are unusable as GPU write targets. **Why SVO for storage/transfer:** regular-
grid hierarchy is implicit (coords derive from tree path — zero coordinate
redundancy), large homogeneous regions collapse to one node, and it gives
visualization LOD + hierarchical queries for free. **Trade-off:** compression
degrades with camera count, and a pathological checkerboard can exceed dense size
— so a **dense fallback** kicks in when `size(SVO) > size(dense)`, recorded in
`ChunkResult.encoding`. Mode 2 raw counts ride on `ChunkResult.coverage` (dense);
the SVO always stores the threshold-derived mask so `VoxelAccessor` is identical
across modes.

## Chunking as a memory-budget mechanism

**Why:** WebGPU's default `maxStorageBufferBindingSize` is only 128 MiB — can't
hold full-workspace results (~825 MB dense). **Decision:** partition into chunks
(default 10 × 10 m XZ, full height → 100 chunks of 2 M voxels), process one at a
time, free GPU buffers after readback so only one chunk is ever resident (§9.4).
Chunk size is **derived from workspace dims**, never hard-coded, and may drop to
5 × 5 m per GPU capability.

## `CAM_WORDS` mask parameterization instead of hard-coded 32

**Why:** support up to 128 cameras without assuming a 32-bit mask. `CAM_WORDS =
ceil(numCameras/32)` (1–4), specialized at pipeline creation via a WGSL `override`
constant; global camera index `c → word=c>>5, bit=c&31` stays stable across
chunks and pre-cull. At ≤32 cameras this collapses to the single-word layout for
free. **Trade-off:** >128 cameras would need batched compute + CPU-side mask
merge (not implemented).

## Chunk-level camera pre-cull (lossless)

CPU tests each camera's frustum against the chunk AABB (6 conservative planes)
before dispatch → `activeMask`, so GPU cost decouples from total camera count.
**Requirement:** toggling pre-cull must never change output (acceptance §18.5a);
`compute({ precull })` exposes the toggle purely for that test.

## Quaternions never uploaded to the GPU

The CPU precomputes `viewProj`; the GPU sees a fixed **96-byte** `Camera` struct
(viewProj 64 B + position vec4 + params vec4). `vec3` is forbidden in the struct
to avoid WGSL alignment ambiguity.

## Möller–Trumbore, any-hit, no backface culling

Occlusion rays only need *any* hit (not the closest), so traversal early-outs on
first hit. **No backface culling** because wall-normal orientation can't be
relied upon. Determinant epsilon 1e-7; `t_min = 1e-3`, `t_max = dist - 1e-3`;
`dist > far` → invisible.

## Raw-pointer WASM ABI, no wasm-bindgen, single-threaded

**Why raw pointers:** keeps the crate a plain `cdylib` with a tiny hand-written
JS loader — no bindgen toolchain coupling. **Trade-off / gap:** rayon +
wasm-bindgen-rayon multithreading (§10.1) is **not** wired up, so no
SharedArrayBuffer and no COOP/COEP cross-origin-isolation requirement — but the
single-threaded build won't hit the spec's ~1 M tris/s parallel target.

## Everything expensive runs off the main thread

The engine runs in a Web Worker via a `VisibilityEngine`-shaped `postMessage`
proxy; large arrays cross as transferables (structured-clone forbidden).
**Trade-off:** callers must not reuse a mesh's typed arrays after `loadScene`.

---

## Known gaps (where the implementation stops short of the spec)

- **WebGPU path is not runtime-validated by `npm test`.** Only
  `test/webgpu.test.ts` (native Dawn) exercises real WGSL; treat WGSL changes as
  unverified until run there or on real hardware.
- **No Rust multithreading** (single-threaded binned-SAH build).
- **`loopback()` doesn't simulate buffer detachment** — worker tests cover
  message/streaming logic, not transfer-ownership semantics.
- **Occupancy is computed at voxel resolution, not the hierarchical L0/L1/L2
  sparse grid** — exact and simple, but allocates over the logical grid, so
  CPU/WASM preprocessing rejects very large workspaces.
- **No production CPU compute fallback** (see "WebGPU compute is the production
  path" above) — the CPU backend does not scale to the full 200 M-voxel
  workspace.
