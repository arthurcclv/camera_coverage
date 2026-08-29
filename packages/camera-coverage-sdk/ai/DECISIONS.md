# DECISIONS.md — `@linkervision/camera-coverage-sdk`

Notable technical decisions and their trade-offs. These record *why* the code and
[`../specs/spec.md`](../specs/spec.md) are shaped the way they are. Newest
decisions at the top when you add to this file.

---

## An `AggregateResult` is not gated on having read the masks back

Behavior in [`../specs/spec.md`](../specs/spec.md) §19.4, §19.5.

**Why.** `WebGpuBackend.computeChunk` decided whether to decode the §19 accumulators
with `aggBufs && visOut` — that is, only if the visibility segment had been read back.
But `visOut` exists only when `emitVoxels` is set or the descriptor asks for probes,
because probes are the *one* §19 primitive resolved from the masks on the CPU (§19.3).

So a run with regions, columns and `leafCounts` but **no probes and no `onChunkDone`**
ran Passes 4–6, copied every accumulator into the staging buffer, mapped it — and
returned `undefined`. `onAggregate` never fired, while the CPU backend returned the
result: a §19.5 parity break in the one direction nothing asserted. The app never saw
it because `retainChunks` forces `emitVoxels` on.

**Decision.** The decode is gated on `aggBufs` alone; `visibility` is passed as
`visOut ?? null`, which `readAggregate` already handles (it reads the masks only when
`probeCount > 0`). `test/webgpu.test.ts` covers the stats-only shape against the CPU
reference, and fails against the old condition.

**The general lesson.** A guard built from "what did we happen to read?" rather than
"what did the caller ask for?" is a guard that will drift the first time the readback
becomes more conditional than it was.

---

## `suggestChunkSizeXZ` clamps on readback, not only on the dispatch limit

Behavior in [`../specs/spec.md`](../specs/spec.md) §3, §11.1.

**Why.** §3 requires the suggestion be clamped so *both* `voxelCount / WG` stays inside
`maxComputeWorkgroupsPerDimension` **and** the planned readback stays inside
`maxChunkReadbackBytes`. Only the first was implemented. That left the suggestion free
to propose a chunk `computeChunk` would then reject — the helper whose whole purpose is
to land on a workable operating point handing the backend an unworkable one.

**Decision.** The function takes optional `numCameras` and `maxReadbackBytes` and
clamps on `CAM_WORDS × 4 + 1 + 1/8` bytes per voxel (masks, plus §19's `leafCounts`
byte and validity bit). Both default to the permissive end — 1 camera, the same 256 MiB
`EngineOptions` uses — so an existing caller's answer never silently tightens.

**Trade-off.** The camera count is not known at `init` time in every app, and a caller
that omits it gets the 1-word clamp, which is weaker than reality at 96 cameras. That
is the honest default: a suggestion that guessed high would tighten chunks nobody asked
to tighten. `sample-app` passes `cameras.length`.

---

## The readback budget is part of `ComputeBackend`, not a cast target

Behavior in [`../specs/spec.md`](../specs/spec.md) §11.1.

**Why.** `init` set the backend's `maxChunkReadbackBytes` through
`this.backend as { maxChunkReadbackBytes?: number }` plus an `in` check — a cast that
compiles against any backend and silently does nothing if the property is ever renamed.

**Decision.** `ComputeBackend` declares `maxChunkReadbackBytes?: number`. It is
**optional rather than `Infinity`** because "not applicable" is the honest state for
the CPU reference: it builds its arrays directly and has no staging step to bound, and
a numeric sentinel would invite code that compares against it.

---

## Per-chunk GPU buffers are pooled, and a worker failure keeps its stack

Behavior in [`../specs/spec.md`](../specs/spec.md) §11.1, §17, §3, §18 (6x–6z).

**Why.** `computeChunk` created ~18 `GPUBuffer`s per chunk — chunk info, cameras,
validity, candidates, candidate masks, candidate count, visibility, coverage, stats, §19's
eight accumulators, and a staging buffer — and destroyed them in a `finally`. That honours
§9.4's one-chunk-resident rule, but poorly: a driver releases a destroyed buffer's mappable
shared memory *asynchronously*, and a loop that outruns reclamation exhausts the host's
mappable address space. On a real 440 × 201 × 1120 m site that meant **~88,700 buffer
create/destroy cycles and 4,928 mappings in one run**, failing partway with
`Array buffer allocation failed` inside the readback.

**Decision:** one pooled set, grown to the largest chunk and reused. Chunk dimensions are
uniform except at the workspace edge, where they are *smaller*, so the first chunk sizes
the pool and nothing reallocates after it. Residency becomes bounded and constant, which is
strictly stronger than §9.4 asks. Buffers created per run: **O(chunks) → O(1)**, asserted
by §18 6y.

**The correctness condition, and why it needs its own test.** WebGPU zero-initializes a
buffer at **creation**, not at reuse. Every pooled buffer the passes accumulate into rather
than fully overwrite — `candidateCount`, `stats`, `visibility`, `regionAccum`, `cellAccum`,
`cellSeen`, `leafCounts`, `leafValid` — must be cleared per chunk, in the same encoder so
the one-submit/one-map contract holds. `candidates` and `candMasks` are exempt: Pass 1
writes them at compacted slots and Pass 2 reads only slots below `candidateCount`. Omitting
a clear yields a plausible wrong number, never an error, so §18 6x proves it by asserting a
multi-chunk run equals running each chunk against a *fresh engine*, whose pool starts empty.

**Second half: the error stopped naming itself.** `installHost`'s `replyError` sent only
`{ code, message }`, so every non-`EngineError` throw in the worker arrived as an anonymous
`INVALID_STATE` — no allocation, no size, no chunk. Finding the site above took the user
reading `webgpu.ts` themselves. The reply now carries the worker `stack` and the
`EngineError`'s `detail`, and a failed readback allocation is rethrown as `SCENE_TOO_LARGE`
naming the requested bytes, chunk dims, `CAM_WORDS`, the staging plan's segment sizes, and
the run's counters. A diagnostic that costs two fields should not have been optional.

**Third: `chunkSizeXZ` was pinned at 10 m.** That constant describes the §3 default room.
On the site above it gave **4,928 chunks of 20,100 voxels** — 50× the intended count, each
100× smaller — multiplying every per-chunk fixed cost by 50 for no per-voxel benefit.
`suggestChunkSizeXZ` derives it from a 2M-voxel target: `vpc = floor(sqrt(target/gridY))`,
since chunks partition XZ only and the height is a fixed multiplier. It reproduces 10 m
exactly on the §3 defaults and gives 99 m — **60 chunks of 1.97M voxels** — on the real site.

**Trade-off.** The pool holds one chunk's buffers between `compute()` calls instead of
releasing them, so an idle engine retains a chunk's worth of device memory until `dispose()`.
That is the same peak a run already needs, moved from transient to resident, and it is what
buys the bounded behaviour. A pooled buffer also hands back the previous chunk's bytes,
which is a live hazard for anything added later: the rule in `ARCHITECTURE.md` is that a
reused buffer must be fully written or explicitly cleared, and it now covers GPU buffers as
well as host scratch.

**What this cost to find.** Four measured fixes preceded it — the leaf-merge cube, the
`denseOf` churn, occupancy retention, and a retention hypothesis that measurement
disproved — and none was the reported failure. Two things would have collapsed that: an
error carrying its own context, and a note that the chunk-count assumption in
`ARCHITECTURE.md` ("100 chunks of 2M voxels") was an assumption rather than a fact.

---

## Occupancy is materialized per chunk and retained nowhere

Behavior in [`../specs/spec.md`](../specs/spec.md) §6.2, §6.4, §16.1, §18 (6u–6w).

**Why.** `computeOccupancy` allocated one dense `Uint8Array` over the whole
workspace grid — one byte per voxel — and the engine held it for the session. At a
real site's scale (1000 × 100 × 1000 = 100M voxels, `chunkSizeXZ: 10`) that is
**95.4 MiB in a single allocation**, and it was **89% of the worker's live
`ArrayBuffer` bytes before a single chunk ran**: measured 95.4 MiB after
`loadScene`, 107.3 MiB after `setSampling`, of which the validity cache is 11.9.
It was the largest allocation left in the SDK and the last workspace-scale one.

Two things about it were mis-stated in its own header, and both were why it went
unrevisited: it claimed the dense grid was "appropriate for the CPU reference
backend" and that "the GPU path is the production route" for large workspaces.
**Occupancy is not part of either backend** — `loadScene` calls it before
`backend.setScene(...)`, and neither `compute/cpu.ts` nor `compute/webgpu.ts`
mentions it. There is no GPU occupancy path; `MAX_CPU_VOXELS` was never a
CPU-backend cap.

The shape of the fix comes from what the array is *for*. Its only per-voxel
consumer is §6.4's validity build, which compresses it 8× to one bit per voxel and
caches **that**. The 95.4 MiB is an intermediate outliving its own output by the
entire session.

**Decision:** two `OccupancySource` implementations. `ChunkOccupancy` (the
default) voxelizes one chunk on demand into a reused scratch and retains nothing
per voxel; a CSR triangle→chunk index built once at `loadScene` keeps a chunk's
build proportional to the geometry near it instead of rescanning the mesh.
`DenseOccupancy` survives only for `solidDetection: true`, because deciding
whether an EMPTY cell is enclosed is a *global* reachability question — a sealed
interior can span chunks, so no chunk-local pass can answer it. That path also
lost its `Int32Array(total)` flood-fill worklist (381.6 MiB at 100M voxels) in
favour of one grown to the frontier, and its ceiling now throws `SCENE_TOO_LARGE`
naming `voxelSize` rather than a bare `Error` — which crossed the Worker boundary
as `INVALID_STATE` naming nothing.

Measured at 100M voxels, 78k triangles:

| | before | after |
|---|---|---|
| live `ArrayBuffer` after `loadScene` | 95.4 MiB | 17.0 MiB (mesh + BVH + index) |
| `loadScene` | 486 ms | 110 ms |
| `setSampling` (full) | 341 ms | 483 ms |
| `setSampling` (a volume edit) | 257 ms | 415 ms |
| `setCameras` + `compute` | — | unchanged, **0** voxelizations |

**Trade-off — this is a memory-for-time trade, and it lands on one path.**
`setSampling` rebuilds every chunk's validity mask (§6.4), and each now
re-derives that chunk's occupancy rather than reading a standing array, so
sampling-volume edits get ~1.6× slower. Nothing else does: `setCameras` does not
invalidate the validity cache, `compute()` reads the cached mask, and §19.4
aggregation never touches occupancy. `loadScene` gets faster by more than the
first `setSampling` loses. The alternatives considered were packing the grid to
2 bits/voxel (4×, no time cost) and a 1-bit "not empty" plane (8×, no time cost);
per-chunk was chosen for removing the ceiling outright rather than moving it.

**The trap, and it is not hypothetical.** The first cut computed voxel centers and
AABB ranges off the *chunk* origin. `worldMin + (i0 + i + 0.5) * vs` is not
bit-identical to `(worldMin + i0 * vs) + (i + 0.5) * vs`, and that drift
reclassified **~48k of 97M voxels at chunk seams** — `validVoxels` came back
97,135,802 instead of 97,183,592. A small-grid parity test passed the whole time.
Both are computed in global index space now, so the two sources agree by
construction; only the storage is chunk-local. §18 6u's seam test (unaligned
origin, 0.1 m voxels, 400 chunks, geometry lying *on* the boundaries) is the one
that catches it.

**Also here:** `installHost`'s `init` now disposes the engine it replaces and
clears the retained chunks (§16.1). It did neither, so a re-init — which the
sample app does on every debounced `voxelSize` change, and twice per attempt on
the WebGPU→CPU fallback — allocated the new workspace while the old one was still
live. Measured a **2× peak** at re-init (26.8 → 53.7 MiB at a 25M-voxel scale).
Retained chunk ids also describe a different partition after a re-init, so
keeping them was wrong independently of the memory.

---

## Leaf merging collapses on ceiling-halved levels, not on a padded power-of-two cube

Behavior in [`../specs/spec.md`](../specs/spec.md) §19.3, §18 (6s).

**Why.** §19.3's bottom-up count collapse was first written the textbook way: pad the
chunk to `side³` where `side` is the next power of two ≥ every dimension, then halve
uniformly. That is the shape §9.5's SVO uses, and there it is harmless — the SVO's cube is
*virtual*, a traversal convention, and nothing allocates it. The collapse is not a
traversal; it materializes one cell per level, so the padding became real memory.

Chunks partition XZ only (§9.1), so a chunk's Y extent is the **whole workspace height**.
That makes `side` the height while the voxel count stays bounded by §11's 1D dispatch
limit — the two decouple, and the cube's cost is `maxDim³` against an input of `voxels`.
Measured: a 100 × 400 × 100 chunk (4.0M voxels, within the dispatch cap) pads to 512³ and
allocates **292.5 MiB of `Int16Array` scratch, 268 MiB of it in a single array**, in the
Worker. That is `Array buffer allocation failed`, reported to the client as
`INVALID_STATE` because `installHost` maps any non-`EngineError` to it.

**Decision:** levels are the chunk's own dimensions, halved with a ceiling, and a child
past the level's edge reads as empty — which is what padding meant in the first place, so
the two agree leaf-for-leaf (verified over ~4,000 randomized shapes and count fields
against the previous implementation). Cost drops from `maxDim³` to `Σ voxels/8ⁱ ≈ 1.14 ×
voxels`: **292.5 MiB → 8.7 MiB (33.6×)** on that chunk, with an identical leaf list. The
collapse now stops when any axis reaches a single cell rather than at a cube root, which
loses no merge — a cube of that edge would have to reach past the short axis, and what it
would cover past `dims` is empty, so it could never have been uniform.

The merged list is also accumulated into doubling typed arrays instead of `number[]`
triples. A chunk whose coverage field barely merges emits a leaf per voxel, and boxed
doubles plus the conversion copy were ~7× the 7-bytes-per-leaf output.

**Trade-off.** The inner loop gained a bounds test per child (eight per block) that the
padded cube did not need, because an out-of-range child now has to be recognized rather
than read from padding. That is a predictable branch on a pass that is already
memory-bound, and it buys a working set that no longer depends on the chunk's aspect
ratio. It also means the level dimensions are no longer equal, so the code carries three
of them instead of one `curSide`.

**Where the previous two rounds were wrong.** The obvious suspect was `denseOf` (below),
the only place that inflates compressed data, and it *was* churning — but its peak is one
chunk and it never failed. The allocation that actually failed was in code whose comment
called its own cost "negligible", copied from a place where it was. Both earlier fixes
were found by tracing the global `Uint32Array` constructor; this one was invisible to that
trace because it allocates `Int16Array`.

---

## Re-aggregating retained chunks reuses one expansion buffer and skips uncovered chunks

Behavior in [`../specs/spec.md`](../specs/spec.md) §19.4, §18 (6t).

**Why.** A retained chunk is normally SVO-encoded (§9.5), and the §19 reduction needs a
flat mask array, so `aggregate()` expands it back to dense — undoing the compression that
made retention affordable. It runs on **every descriptor edit** (a zone moved, a section
dragged, a filter toggled) over **every retained chunk**, and the first cut allocated a
fresh `Uint32Array` pair per chunk. Measured on a 40 × 20 × 40 m workspace at 0.1 m, 16
chunks: **122.1 MiB of expansion buffers per edit**, one 7.6 MiB array per chunk.

**Decision:** one buffer pair per `aggregate()` call, grown to the largest chunk it is
asked for and handed out as an exact `subarray` so a backend still sees the chunk's own
length. This is safe because neither backend keeps what it is given — the CPU reduction
reads it, the WebGPU one copies it into a device buffer before returning, and
`resolveProbes` copies the words it needs. The expansion loop had to change to *write*
zeros at invalid voxels rather than skipping them, or a reused buffer would leak the
previous chunk's masks. A chunk retained in dense form is still passed through untouched.

Separately, a chunk whose `stats.coveredCount` is 0 is not expanded at all: Pass 3 only
increments `coveredCount` for a valid voxel with a set mask bit, and masks are only written
for valid voxels, so 0 means every mask word is zero — which is exactly §19.4's absent-
buffer case, decided in `O(1)` on data the retained result already carries. After pre-cull
that is most chunks of a large site. Together: **122.1 MiB → 7.6 MiB per edit**, and the
edit itself got ~30% faster.

**Trade-off.** The scratch is held for the duration of the call and sized to the largest
chunk, so peak residency is one chunk's dense form either way — the churn is what goes,
not the peak. It is deliberately per-call rather than per-engine: holding it between edits
would keep several MiB alive for a user who edits once.

---

## A pre-culled chunk aggregates without materializing its zeros, and readback is budgeted against the *host*

Behavior in [`../specs/spec.md`](../specs/spec.md) §19.4, §11.1, §17.

**Why.** Chunk-level pre-cull (§7.2) leaves whole chunks with an all-zero active mask, and
on a large site those are the *majority* — the cameras cover part of it. Those chunks are
not absent from the aggregation: their voxels are valid and fully blind, and dropping them
would make a region read as empty and a column read as no-data (§19.2). The first cut fed
them a dense array of zeros to say so, and a second one to emit the chunk. Measured on a
60 × 20 × 60 m workspace at 0.1 m — 36 chunks, 35 pre-culled — that was **534 MiB of
transient allocation per run**, and it surfaced in the sample app as
`Array buffer allocation failed`.

**Decision:** `AggregateChunkInput.visibility` is nullable, meaning "every mask word is
zero". The CPU reference reads 0; the WebGPU backend binds a zero-cleared storage buffer
it never uploads to. Separately, the array needed to *emit* such a chunk is a single
reused scratch — the bytes are identical every time and `buildSvo` only reads them. The
subtle part is that the SVO builder may decline to compress, and the dense fallback
**retains** the buffer it was handed (`results.ts`), so an escaped scratch is surrendered
rather than handed to the next chunk as well. Same workspace: **534 MiB → 77 MiB**.

**The second half is that the failure was undiagnosable.** §11.1 validated the staging
buffer against the device's `maxBufferSize`, which says nothing about whether the JS heap
can copy the mapped range out — and those limits are unrelated, so a device advertising
2 GiB will accept a readback the heap cannot take. `maxChunkReadbackBytes` (default
256 MiB) now bounds the host side and throws `SCENE_TOO_LARGE` naming `chunkSizeXZ` and
`voxelSize`, the knobs that actually change it.

**Trade-off.** On most hardware the 1D dispatch limit (§11 Pass 1) caps a chunk near 4M
voxels, so the host budget rarely binds — it exists for devices reporting a permissive
`maxComputeWorkgroupsPerDimension`, where nothing else would catch it. A guard that
usually does not fire is still worth its cost when the alternative failure names nothing.

---

## Reductions run where the masks are, behind a domain-neutral descriptor

Behavior in [`../specs/spec.md`](../specs/spec.md) §19, §16.1, §11.1.

**Why.** Every consumer of a run reduces per-voxel masks to a few kilobytes — counts in a
box, a per-column summary, a popcount per voxel, a mask at a point. Done downstream that
is paid three times: the readback, the transfer to wherever the consumer lives, and a
scalar scan over millions of voxels. The sample app's zone aggregation was 257 ms of
blocked main thread per run at 0.1 m voxels. **Decision:** the caller hands the engine a
descriptor and gets the reduction back.

**Four primitives, not an extension point.** The alternative considered was letting a
caller inject its own WGSL pass. That is strictly more general and much larger — a buffer
binding model, a readback budget inside §11.1's one-submission rule, and no CPU-backend
parity unless the caller also hand-writes a JavaScript twin, which would drift. Oriented
boxes, voxel columns, per-voxel popcounts, and point lookups cover every consumer we have
while keeping the SDK domain-free: it knows boxes and columns, not zones and sections.

**Groups are the non-obvious part.** A caller whose domain object owns several boxes — a
zone made of volumes — cannot total it by summing the per-region entries, because a voxel
in two of them counts twice. The alternative is inclusion–exclusion over region
intersections, which is exponential and needs geometry the caller no longer has. A group
accumulator counts each voxel once however many of that group's regions contain it, for
one OR and one popcount loop per voxel.

**No float atomics, and none needed.** WGSL has no float atomic, which normally forces a
fixed-point encoding for a mean/max/min. It does not here: every fraction the app wants is
`popcount / enabledCameras` over a denominator constant for the run, so the passes
accumulate integer popcounts and the caller divides once. That is exact, not an
approximation — which is what makes bit-identical CPU/GPU parity (§18 6l) an assertion
rather than a tolerance.

**Trade-off.** The reduction now exists twice, in WGSL and in JavaScript, and they must
agree. `regionMask` is the sharp edge — see ARCHITECTURE.md's duplication axes.

---

## Retention is the caller's, and that is what makes a descriptor edit free

Behavior in [`../specs/spec.md`](../specs/spec.md) §19.4, §16.1, §9.4.

**Why.** §9.4 keeps exactly one chunk GPU-resident, which is what holds a 200M-voxel
workspace inside a 128 MiB binding budget. So the §19 passes cannot be a downstream
stage — the masks are gone by then — and must run inside the per-chunk pipeline. But a
descriptor changes far more often than a scene does: moving a zone, dragging a section,
toggling a filter changes *what is counted*, never *what is seen*.

**Decision:** two entry points over one WGSL body. `compute({ aggregate })` rides the run;
`aggregate(chunks, spec)` re-runs Passes 4–6 alone over chunks **the caller retained**,
uploading one at a time so §9.4 holds unchanged. Nothing is raycast and no BVH is touched.

Retention is deliberately not the engine's: it holds one chunk at a time by design, and a
caller that keeps a run's `ChunkResult`s can hand them straight back. `installHost`'s
`retainChunks` makes the **Worker host** that caller, so `WorkerClient.aggregateRetained`
re-reduces without any per-voxel data crossing the boundary in either direction. That is
the whole loop: masks produced, reduced, and re-reduced, all in the worker.

**Trade-off.** `aggregateRetained` is on `WorkerClient`, not on `VisibilityEngine` — an
in-process engine retains nothing, so putting it on the shared interface would promise
something only one implementation can keep.

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
  sparse grid** — exact and simple. No longer a memory gap: it is materialized
  per chunk and retained nowhere (see the entry above), so only the
  `solidDetection` path still allocates over the logical grid. The remaining gap
  is that the Rust crate exports only the whole-workspace `compute_occupancy`, so
  the per-chunk voxelizer is TS on both kernel sets.
- **The coverage rate is not exactly partition-invariant** — §11 takes a voxel
  centre from the chunk origin, so a different `chunkSizeXZ` drifts the centre and
  flips voxels on an occlusion boundary (~4e-4 of the rate on a 30 m room, both
  backends). §6.2's per-chunk occupancy computes in global index space to avoid
  exactly this; the compute path has not been changed to match.
- **No production CPU compute fallback** (see "WebGPU compute is the production
  path" above) — the CPU backend does not scale to the full 200 M-voxel
  workspace.
