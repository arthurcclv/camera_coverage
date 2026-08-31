# @linkervision/camera-coverage-sdk

GPU-accelerated **3D camera coverage / visibility analysis engine**, implemented
from [`specs/spec.md`](./specs/spec.md).

Given scene geometry, a set of perspective cameras, and a spatial sampling
resolution, the engine computes — for every sampled point in space — whether it
is directly visible (line-of-sight) to each camera, and produces a coverage map,
a visibility mask, coverage statistics, and a compact octree result suitable for
visualization.

The core visibility kernel is a **WebGPU compute** pipeline (BVH ray occlusion);
a **CPU reference backend** implements the identical algorithm for headless use,
testing, and environments without WebGPU. Scene preprocessing (mesh cleaning,
BVH build, voxelization, flood fill, SVO) is provided both as a **Rust crate
compiled to WASM** (`crates/`) and as an equivalent pure-TypeScript fallback,
and the engine can run inside a **Web Worker** to keep the main thread
unblocked.

---

## Install / run

```bash
npm install
npm test          # unit, acceptance §18, WASM parity, WebGPU parity, worker E2E
npm run typecheck
npm run build:wasm # compile the Rust kernels → src/wasm/*.wasm (needs rustup + wasm32 target)
```

The WASM tests skip cleanly if the artifact hasn't been built. To build it:

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm
```

The package ships as TypeScript (`type: module`). Node ≥ 22.6 runs the sources
directly via native type-stripping; in a browser/bundler, import from
`@linkervision/camera-coverage-sdk`.

## Quick start

```ts
import { createEngine, accessor } from '@linkervision/camera-coverage-sdk';

const engine = createEngine();

await engine.init({
  worldMin: [0, 0, 0],
  worldMax: [100, 20, 100],   // Y is height (glTF Y-up)
  voxelSize: 0.1,
  chunkSizeXZ: 10,
  backend: 'auto',            // WebGPU if available, else throws WEBGPU_UNAVAILABLE
  // backend: 'cpu',          // headless reference (Node / tests)
});

await engine.loadScene({ positions, indices });          // raw buffers, world-space
await engine.setSampling({ regions: [{ type: 'heightBand', yMin: 0.5, yMax: 2.0 }] });
engine.setCameras([
  { id: 'cam-1', position: [10, 3, 10], rotation: [0, 0, 0, 1], fov: 70, far: 50 },
]);

const summary = await engine.compute({
  mode: 1,
  onChunkDone: (chunkId, result) => {
    const acc = accessor(result);                        // encoding-agnostic
    const visible = acc.getMask(0, 5, 0) & 1;            // camera 0 visibility bit
    // getMask / forEachLeaf's `mask` are word 0 (cameras 0-31); above 32 cameras
    // use acc.getMaskWord(i, j, k, c >> 5) or forEachLeaf's `maskWords` (§7.1)
    // acc.forEachLeaf(...) → merged cubes for instanced rendering / LOD
  },
});

console.log(summary.overallRate, summary.perCamera);
engine.dispose();
```

---

## Architecture / spec mapping

| Spec | Module |
|---|---|
| §2–3 coordinate system, workspace + chunk partition | `src/grid.ts` |
| §5.1 mesh cleaning (degenerate / NaN culling) | `src/geometry/mesh.ts` |
| §6.2 occupancy (triangle–AABB SAT + flood-fill SOLID) | `src/occupancy.ts`, `src/geometry/triangle-aabb.ts` |
| §6.3/§6.4 sampling policy → validity mask + per-chunk cache | `src/sampling.ts` |
| §7 camera model (viewProj, 96-byte GPU struct, CAM_WORDS, pre-cull) | `src/camera.ts` |
| §8/§10.3 ray occlusion (Möller–Trumbore, any-hit) | `src/kernel.ts` (CPU) / `src/shaders.ts` (WGSL) |
| §10 binned-SAH BVH, threaded stackless node layout | `src/geometry/bvh.ts` |
| §11/§11.1 per-chunk pipeline (Pass 1/2/3), submission & readback | `src/compute/cpu.ts`, `src/compute/webgpu.ts`, `src/shaders.ts` |
| §9.1–9.3 dense result buffers | `src/compute/cpu.ts`, `src/results.ts` |
| §9.5 SVO merged storage + VoxelAccessor | `src/svo.ts` |
| §13.1 incremental recompute (baseline + dirty-set diff) | `src/incremental.ts` |
| §16.1 engine API + orchestration | `src/engine.ts` |
| §4/§16 Web Worker host + main-thread client | `src/worker/*` |
| §4/§6.2/§9.5/§10 Rust WASM kernels | `crates/camera_coverage_wasm/` + `src/wasm/loader.ts` |
| §17 error handling | `src/types.ts` (`EngineError` / `EngineErrorCode`) |
| §18 acceptance tests | `test/acceptance.test.ts`, `test/aggregate.test.ts` |
| §19 aggregation (descriptor, camera mask, packing, CPU reduction, merge) | `src/aggregate.ts` |
| §19.3 aggregation passes (region / column / leaf-count / projection reduce) | `src/shaders.ts`, `src/compute/webgpu.ts` |

### Rust WASM kernels

`crates/camera_coverage_wasm` is a `cdylib` for `wasm32-unknown-unknown` using a
**raw pointer ABI** (no `wasm-bindgen`): JS allocates input buffers, calls a
kernel, reads a small u32 header describing the outputs, copies them out, and
frees everything (`src/wasm/loader.ts`). It implements the four preprocessing
kernels the spec assigns to Rust WASM: `clean_mesh`, `build_bvh`,
`compute_occupancy`, `build_svo`.

`test/wasm.test.ts` verifies the Rust against the TS reference: occupancy cells
and SVO node arrays are **byte-identical**, BVH results are occlusion-equivalent,
and the engine driven through the WASM kernels reproduces the acceptance
outcomes. Select the kernels via the engine option:

```ts
import { CoverageEngine, createWasmKernels } from '@linkervision/camera-coverage-sdk';
const kernels = await createWasmKernels(await fetch('camera_coverage_wasm.wasm').then(r => r.arrayBuffer()));
const engine = new CoverageEngine({ kernels });      // else defaults to tsKernels
```

Multithreading (rayon / wasm-bindgen-rayon, §10.1) is **not** wired up; the crate
is single-threaded and requires no cross-origin isolation.

### Web Worker

The engine can run inside a Worker (§16) so the main thread stays unblocked.
`installHost` runs the engine worker-side; `WorkerClient` is a main-thread
`VisibilityEngine` proxy. Input meshes and streamed chunk results cross the
boundary as **transferables** (§16.1). A `loopback()` transport runs both ends
in-process for tests.

```ts
// worker.ts  — bundle src/worker/entry.ts, or:
import { installHost, messageTransport } from '@linkervision/camera-coverage-sdk';
installHost(messageTransport(self as any));

// main.ts
import { WorkerClient } from '@linkervision/camera-coverage-sdk';
const engine = WorkerClient.fromWorker(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
await engine.init({ /* … */ });   // same VisibilityEngine API, now off-thread
```

### Backends

- **`cpu`** — the behavioral reference for the *compute* pipeline. Note that
  occupancy and flood-fill are **not** part of either backend: they are scene
  preprocessing (§6.2) that runs identically under `cpu` and `webgpu`, and
  neither backend ever sees the cell array. There is no GPU occupancy path, so
  the `solidDetection` voxel ceiling applies on both.
- **`webgpu`** — the production compute path (`src/compute/webgpu.ts` +
  `src/shaders.ts`). It uploads the immutable BVH/triangle buffers once and
  creates/destroys per-chunk buffers around each dispatch so only one chunk is
  ever GPU-resident (§9.4). The WGSL mirrors the CPU kernel exactly so both
  backends are intended to produce bit-identical visibility buffers.
  It is imported lazily and only runs where `navigator.gpu` exists, so it is not
  exercised by the Node test suite.

---

## Notes & spec interpretations

- **Validity = free space.** A voxel is a valid sampling point iff it is
  `EMPTY_SPACE`. `MIXED` voxels lie on geometry surfaces and `SOLID` voxels are
  enclosed interiors — neither is a meaningful free-space sample. This reconciles
  §6.2/§6.3/§9.2 with acceptance tests §18.2 (voxels *inside the wall* invalid)
  and §18.4 (closed-box interior invalid).
- **`CAMERA_INSIDE_GEOMETRY`** is raised only when a camera sits in a `SOLID`
  interior; a camera merely adjacent to a wall (in a `MIXED` voxel) stays active,
  as required by the t_max regression test §18.3.
- **Pre-cull is lossless** (§7.2 / §18.5a) — toggle via `compute({ precull })`.
- **Omitting `onChunkDone` means stats-only** (§11.1 / §18.6c). It is not merely
  optional: with no callback the engine skips per-voxel readback entirely and
  returns the same `CoverageSummary`. Pass a callback only if you consume the
  chunks — the difference is up to 62 MB of allocation per `compute()`.
- **The validity mask is cached** per chunk per (scene, sampling) generation
  (§6.4 / §18.6a), so repeated `compute()` with only the cameras changed costs no
  grid walk. The cached array is engine-owned; a `dense` `ChunkResult` receives a
  copy, because the worker transfers (and thus detaches) what it hands out
  (§18.6b).
- **Mode 2 coverage** raw counts are carried on `ChunkResult.coverage` (dense
  encoding); the SVO always stores the threshold-derived visibility mask so the
  `VoxelAccessor` interface is identical across modes.

## Caveats & known gaps

Where this implementation stops short of the full spec:

- **WebGPU path is not runtime-validated.** `src/compute/webgpu.ts` and the WGSL
  in `src/shaders.ts` are written to spec and mirror the CPU kernel, but there is
  no headless WebGPU in the test environment, so they are only typechecked — not
  executed. The **CPU backend is the behaviorally tested reference**; treat the
  WebGPU path as unverified until run in a real browser/Deno target.
- **Rust multithreading is not wired up.** The crate is single-threaded; the
  `rayon` + `wasm-bindgen-rayon` parallel build (§10.1) — and therefore the
  COOP/COEP cross-origin-isolation requirement — is not implemented. The
  single-threaded binned-SAH build will not hit the spec's ~1M tris/s target.
- **Loopback transport doesn't simulate buffer detachment.** `loopback()`
  structured-clones messages but ignores transfer lists, so the worker tests
  exercise the message/streaming logic but not transfer-ownership semantics
  (a real `Worker` detaches the sender's buffers). `WorkerClient.loadScene`
  does pass the buffers as transferables, so callers must not reuse a mesh's
  typed arrays after handing them off.
- **Occupancy is computed at voxel resolution, not the hierarchical L0/L1/L2
  sparse grid** (§6.2). This is exact and simple. It is also **materialized per
  chunk and retained nowhere** (§6.2), so voxel resolution no longer implies a
  workspace-scale allocation — a 100M-voxel grid costs one chunk of transient
  instead of 95.4 MiB for the session. The dense workspace grid survives only for
  `solidDetection: true`, whose flood fill is a global reachability question, and
  only that path has a voxel ceiling (`SCENE_TOO_LARGE`).
- **The coverage rate is not exactly partition-invariant.** §11 computes a voxel
  centre from the chunk origin, so `worldMin + i0·vs + (i+0.5)·vs` drifts against
  a different `chunkSizeXZ` and voxels sitting on an occlusion boundary flip —
  measured at ~4e-4 of the rate on a 30 m room, on both backends. §6.2's
  per-chunk occupancy avoids this by computing in global index space; the compute
  path has not been changed to match.
- **No CPU fallback for the compute pipeline in production** (§16.4): `backend:
  'auto'`/`'webgpu'` reject with `WEBGPU_UNAVAILABLE` when WebGPU is missing. The
  `'cpu'` backend exists for headless/reference use and does not scale to the
  full 200M-voxel workspace.

## Public API surface

`createEngine()` / `CoverageEngine`, the `VisibilityEngine` interface, and
`accessor(result)` for encoding-agnostic voxel queries. Lower-level building
blocks (`buildBvh`, `computeOccupancy`, `buildSvo`, `prepareCamera`, the WGSL
shader sources, …) are also exported for custom pipelines and visualization.
