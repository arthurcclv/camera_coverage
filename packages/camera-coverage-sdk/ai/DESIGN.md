# DESIGN.md — `@linkervision/camera-coverage-sdk`

Product vision, goals, and design principles for the SDK. What it does and why.
The authoritative behavioral definition is [`../specs/spec.md`](../specs/spec.md);
this file is the plain-language orientation to it.

## Vision

A GPU-accelerated **3D camera coverage / visibility analysis engine**. Given
scene geometry, a set of perspective cameras, and a spatial sampling resolution,
it computes — for every sampled point in space — whether that point has a direct,
unobstructed **line of sight** to each camera, and produces a coverage map, a
visibility mask, coverage statistics, and a compact octree result for
visualization.

This is a purely **geometric** line-of-sight test: "can this camera physically
see this point, unobstructed by geometry." Lens optical quality, resolution, and
pixels-per-meter are explicitly out of scope.

## Who it's for

- **BIM / digital-twin** analysis
- **CCTV / security camera** placement planning
- **Industrial safety** monitoring coverage
- General **sensor placement** optimization

## Inputs & outputs

**In:**
- Scene geometry as **raw buffers only** — `positions: Float32Array` (xyz
  interleaved, world-space meters) and `indices: Uint32Array`. Format parsing
  (glTF, IFC, …), materials, normals, and UVs live *outside* the engine.
- Cameras — id, position, quaternion rotation, vertical FOV, aspect, near, and
  `far` (**effective detection range**, not a render clip plane).
- A workspace box, a voxel size, sampling regions, and a precision mode.

**Out:**
- Per-chunk `ChunkResult` (SVO or dense encoding) streamed via `onChunkDone`.
- A `CoverageSummary`: per-camera coverage rate, overall rate (fraction of valid
  points visible to ≥ 1 camera), valid-voxel count, elapsed time.

## Performance targets

Baseline is an RTX 3060-class GPU:
- Passes 1–3 combined: 500k candidate points × 8 cameras × 500k triangles in
  **< 500 ms**.
- Full default workspace (100 chunks, a Y = 0.5–2.0 m height band, 8 cameras) in
  **< 30 s**.

The default workspace is a 100 × 20 × 100 m box at 0.1 m voxels — a 1000 × 200 ×
1000 = **200 M** logical-voxel index space, partitioned into 100 chunks of 2 M
voxels. Up to **128 cameras** are supported.

## Design principles

These are the load-bearing invariants. Violating any of them is a correctness
bug, not a style issue. See [DECISIONS.md](./DECISIONS.md) for the reasoning.

1. **Occupancy never implies visibility.** Voxel occupancy (empty / mixed /
   solid) only decides *whether a point needs analysis* and *lets ray traversal
   skip empty BVH regions*. An empty voxel can still have a wall between it and a
   camera — so visibility is *always* decided by a full BVH ray-occlusion
   traversal, never inferred from occupancy. This is the single most emphasized
   rule in the spec.
2. **Validity is separate from visibility.** A dedicated validity mask lets
   "not visible to any camera" be distinguished from "not an analysis point at
   all," so statistics and visualization aren't polluted. **Validity = free
   space** — a voxel is valid iff it is `EMPTY_SPACE` (not `MIXED`, not `SOLID`).
3. **Coordinate pass-through, zero conversion.** Right-handed, Y-up (glTF /
   Three.js). glTF feeds straight in. Z-up sources (IFC/BIM) must be converted by
   the loading layer *before* entering the engine.
4. **Nothing hard-coded.** Chunk count/size derive from workspace dimensions.
   Shaders/structs never assume 32 cameras — everything is parameterized by
   `CAM_WORDS = ceil(numCameras / 32)`.
5. **Stable global camera indices.** Camera `c` maps to `word = c >> 5`,
   `bit = c & 31`, stable across all chunks; pre-cull never renumbers cameras.
6. **Pre-cull is lossless.** Chunk-level camera pre-cull is a conservative
   speed-up; toggling it on/off must produce bit-exact identical output (an
   acceptance test enforces this).
7. **Determinism.** Two runs on identical input yield bit-exact identical
   visibility/validity buffers.
8. **Dense during compute, SVO for storage/transfer.** GPU passes need random-
   access writes, so compute uses dense arrays; results compress to a sparse
   voxel octree immediately after readback, with a dense fallback when SVO offers
   no size win. Downstream code stays encoding-agnostic (`VoxelAccessor`).
9. **One chunk GPU-resident at a time**, by memory budget.
10. **Everything expensive runs off the main thread**, with large typed arrays
    crossing the worker boundary as transferables — never structured-clone
    copies.

## Non-goals

- Lens resolution / pixels-per-meter (may get distance weighting beyond `far`
  later).
- Transparent/translucent materials — every triangle is an opaque occluder.
- Dynamic geometry — the BVH is immutable after `loadScene` (cameras *can* move
  cheaply; geometry cannot).
- Reflection / refraction.
- Orthographic cameras — perspective only.
- A production CPU fallback for the browser end-user path. When WebGPU is absent,
  the product surfaces an error and a supported-browser list. (The engine *does*
  keep a CPU backend, but as the **tested reference / headless** path — see
  [ARCHITECTURE.md](./ARCHITECTURE.md), not as a full-scale production route.)
