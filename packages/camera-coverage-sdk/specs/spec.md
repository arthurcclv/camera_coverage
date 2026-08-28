# 3D Camera Coverage Analysis Tool — Technical Specification

**WebGPU Visibility Analysis Engine**

---

## 1. Purpose and Scope

A GPU-accelerated 3D Visibility Analysis Engine based on WebGPU Compute Shaders.

Given 3D scene geometry, multiple camera configurations, and a spatial sampling resolution, compute whether each sampled position in space is directly visible (line-of-sight; lens optical quality excluded) to each camera.

**Outputs**: Camera Coverage Map, Visibility Mask, coverage statistics, coverage visualization.

**Applications**: BIM Digital Twin, CCTV planning, industrial safety monitoring, sensor placement.

**Explicitly out of scope**:
- Lens resolution / PPM (pixels-per-meter) evaluation — a future version may add distance weighting beyond `far`
- Transparent / translucent materials (every triangle is treated as an opaque occluder)
- Dynamic geometry (the BVH is immutable after scene load)
- Reflection / refraction
- Orthographic cameras (perspective only)

---

## 2. Terminology, Coordinate System, and Units

- **Coordinate system**: right-handed, **Y-up** (glTF convention: +Y up, +X right, +Z toward the viewer), consistent with glTF / Three.js — scene and camera data pass through with zero conversion. Z-up inputs (IFC / most BIM tool exports) must be axis-converted by the loading layer (`(x, y, z)ᵢfc → (x, z, -y)`) before entering the engine.
- **Units**: meters (m).
- **Workspace origin**: the minimum corner `worldMin` of the workspace AABB. Voxel index `(i,j,k)` maps to the center point:
  `center = worldMin + (vec3(i,j,k) + 0.5) * voxelSize`
- **Quaternion convention**: `[x, y, z, w]`, transforming camera-local coordinates to world. Camera local: `-Z` is the view direction, `+Y` is up (consistent with Three.js / glTF).
- **FOV**: `fov` is the **vertical** FOV in degrees. Horizontal FOV is derived from the aspect ratio.
- **Voxel / Sample / Chunk**:
  - *Logical voxel*: the full 0.1 m grid over the workspace (index space only; no memory is allocated)
  - *Sampling voxel*: a voxel included in the analysis
  - *Chunk*: the spatial sub-block the GPU processes at a time

---

## 3. Spatial Model and Parameters

All values are **configurable parameters**; defaults below:

```ts
interface WorkspaceConfig {
  worldMin: [number, number, number];   // default [0,0,0]
  worldMax: [number, number, number];   // default [100, 20, 100] (m), Y is height
  voxelSize: number;                    // default 0.1 (m)
  chunkSizeXZ: number;                  // default 10 (m), partitioned on the horizontal (XZ) plane;
                                        // chunk height (Y) = full workspace height
}
```

Derived defaults:

| Item | Value |
|---|---|
| Logical voxel grid | 1000 × 200 × 1000 (X × Y × Z) = 200M |
| Chunk partition (horizontal XZ plane) | 10 × 10 = 100 chunks |
| Voxels per chunk | 100 × 200 × 100 (X × Y × Z) = 2M |

Chunk count and size are derived from the workspace dimensions and **must not be hard-coded**.

---

## 4. System Architecture

```
                 3D Scene (glTF / raw buffers)
                    |
          Geometry Processing (Web Worker)
                    |
        +-----------+-----------+
        |                       |
   BVH Builder             Occupancy /
  (Rust WASM,             Sampling Generator
   binned SAH)            (WASM / GPU Pass 0)
        |                       |
        +-----------+-----------+
                    |
             Visibility Engine
          (WebGPU Compute, per-chunk)
                    |
      Pass 1: Frustum Cull + Compaction
      Pass 2: BVH Ray Visibility
      Pass 3: Stats Reduction
                    |
        Readback → CPU-side Result Store
                    |
          Visualization (Three.js)
```

---

## 5. Input Data Formats

### 5.1 Scene Geometry

The core engine API accepts raw buffers only (format parsing, e.g. a glTF loader, lives outside the engine):

```ts
interface SceneMesh {
  positions: Float32Array;  // xyz interleaved, world space, meters
  indices: Uint32Array;     // triangle indices, length a multiple of 3
}
```

glTF (Y-up) data requires no axis conversion and is fed straight into the engine. Materials, normals, and UVs are ignored. Degenerate triangles (area < 1e-10 m²) are culled at load time.

### 5.2 Camera Configuration

```ts
interface CameraConfig {
  id: string;
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion xyzw
  fov: number;      // vertical FOV, degrees, (0, 180)
  aspect: number;   // default 16/9
  near: number;     // default 0.1, used as the frustum near plane
  far: number;      // effective detection range (beyond it = invisible), default 50
  enabled: boolean; // default true; false = keeps its slot, contributes nothing
}
```

In this system, `far` means the **camera's effective detection range**, not a rendering clip plane; the default should reflect a realistic CCTV effective range (50 m) rather than 200 m.

`enabled` defaults to `true`. A camera with `enabled: false` stays in the list and
**keeps its global camera index** (§7.1) — it is simply never set in any chunk's
`activeMask` (§7.2), so its mask bit is 0 everywhere, its `visibleCount` is 0, and its
`coverageRate` is 0. It is not flagged `CAMERA_INSIDE_GEOMETRY` (§17): a camera the
caller switched off is not a misconfiguration to warn about.

Retaining the slot rather than dropping the camera from the list is deliberate. Mask
bits are positional, so removing a disabled camera would renumber every camera after it
and invalidate every retained result — which is exactly what disqualifies a camera-list
edit from an incremental run (§13.1). With `enabled`, toggling a camera is an
index-stable edit and stays incremental. The cost is that disabled cameras still count
against the 128 limit and can still widen `CAM_WORDS`.

---

## 6. Sampling Space Management

### 6.1 Hierarchical Sampling Grid

No full dense grid is built. Three levels:

| Level | Cell size | Default grid (100 × 20 × 100 m) | Subdivision factor |
|---|---|---|---|
| L0 | 2.0 m | 50 × 10 × 50 (X × Y × Z) = 25,000 | — |
| L1 | 0.4 m | each MIXED L0 cell expands 5×5×5 | 5 |
| L2 | 0.1 m | each MIXED L1 cell expands 4×4×4 | 4 |

Data structure: L0 is a dense array; L1 / L2 use indirection tables (an L0 cell stores the offset to its L1 block; unexpanded cells hold INVALID).

### 6.2 Occupancy Computation (Pass 0)

**Voxelization**: for each triangle, compute the L0 cells covered by its AABB, then run an exact triangle–AABB overlap test (Separating Axis Theorem) on each candidate cell; hits are marked `MIXED_SPACE`. This pass runs in WASM (CPU is sufficient for ≤ 2M triangles; the output is the L0 occupancy array).

**SOLID determination (flood fill)**: run a 6-connected BFS from all EMPTY L0 cells on the workspace boundary. Reachable EMPTY cells remain `EMPTY_SPACE`; unreachable EMPTY cells are marked `SOLID_GEOMETRY` (interior of closed objects).

**Watertight assumption and fallback**: flood fill assumes the shells of closed objects have no gaps at L0 resolution. Engine startup parameter `solidDetection: boolean` (default true); when the mesh is clearly non-watertight (e.g. an anomalous SOLID cell ratio) or the user disables it, all non-MIXED cells are treated as EMPTY — only the culling of some invalid sampling points is lost; correctness is unaffected.

L1 / L2 reuse the same voxelization logic level by level: only MIXED cells of the parent level are subdivided.

```rust
#[repr(u8)]
enum CellType { EmptySpace = 0, MixedSpace = 1, SolidGeometry = 2 }
```

| Type | Purpose |
|---|---|
| EMPTY_SPACE | Kept or density-reduced per sampling policy; **must not** be used to infer visibility |
| MIXED_SPACE | Subdivided further |
| SOLID_GEOMETRY | Voxels inside are marked invalid and excluded from analysis and statistics |

**Key invariant**: occupancy only decides "does this point need analysis" and "can ray traversal skip empty nodes"; it must **never** be used to directly derive visible / blocked. An empty voxel can still have a wall between it and the camera.

### 6.3 Sampling Policy (analysis-point filtering)

```ts
type SamplingRegion =
  | { type: 'full' }
  | { type: 'heightBand'; yMin: number; yMax: number }   // along the Y (height) axis; e.g. human height 0.5–2.0 m
  | { type: 'box'; min: Vec3; max: Vec3 };

interface SamplingConfig {
  regions: SamplingRegion[];   // union
  stride: 1 | 2 | 4;           // L2 voxel sampling stride, default 1
}
```

Final valid sampling points = (union of regions ∩ non-SOLID voxels), one validity bit per voxel.

### 6.4 Validity Cache

The validity mask (§9.2) is a pure function of the workspace grid, the occupancy
classification (§6.2), and `SamplingConfig` — **cameras never appear in it**. It is
therefore memoized per chunk and reused across `compute()` calls.

**Cached entry** — exactly what §9.2 defines, plus its population count: the packed
mask words for one chunk and its `validCount`. A chunk with `validCount === 0` caches
**no words** (a null entry); `compute()` skips such chunks without allocating. Cache
cost is thus 1 bit per voxel of the *active* chunks only — 0.25 MB per 2M-voxel chunk,
≤ 25 MB for a full 100-chunk workspace: the §9.4 validity-mask budget paid **once**
instead of once per `compute()`.

**Build** — the mask is derived from the region union, occupancy, and stride (§6.3).
The builder may narrow its voxel loops to the region union's index range rather than
testing every voxel center, and may skip the per-voxel region test when that range is
*exact* — which a single region of any kind is, the bounds being its own. Both are
optimizations and must not change the result: a chunk the region union does not reach
at all yields an **empty** index range, never a clamped edge index, and therefore
`validCount === 0`.

A chunk with `validCount === 0` carries a **zero-length** `validity` on *every* call —
the building call and each cached call alike. Consumers gate on `validCount`, never on
`validity.length`.

**Generation** — a (scene, `SamplingConfig`) pair. `loadScene()` and `setSampling()`
each begin a new generation and discard the previous cache; `setCameras()` and
`compute()` never do.

**Invariant** — within one generation, each chunk's mask is built **at most once**, by
whichever of `setSampling()` / `compute()` first needs it:

| Call | Effect on the cache |
|---|---|
| `loadScene()` | new generation, empty cache; **builds nothing** — a caller that reloads a scene normally replaces the sampling config immediately, so an eager build here would be discarded unused |
| `setSampling()` | new generation; builds **every** chunk, because `SamplingStats.activeChunks` / `validVoxels` require a whole-grid pass anyway. Those stats are derived from that same pass — never a second walk to summarize |
| `setCameras()` | **none** |
| `compute()` | builds only the chunks it touches (`opts.chunks`, §16.1), and only those not already cached; **never** rebuilds a cached entry |

**Ownership** — the cache owns its buffers, and any consumer that takes ownership gets
a **copy**. Concretely that is `ChunkResult.validity` on the `dense` encoding (§9.5),
which the worker transfers to the main thread (§16.1) and thereby *detaches*; without
the copy the next `compute()` would hand a backend a detached buffer. Backends receive
the cached array **read-only** and must not retain it beyond the chunk. The `svo`
encoding reads the mask to fill `nodeValid` and carries no `validity`, so the common
path copies nothing.

**Why this is normative** — repeated `compute()` over a fixed scene and sampling is the
primary interactive workload (moving a camera, §13) and the inner loop of any
camera-placement search. Rebuilding validity there costs O(chunk voxel count) of CPU
work per call, *independent of camera count* — measured at 25–40% of an entire
`compute()` at 0.1 m voxels, and the dominant cost when few cameras are active.

Non-normative build notes: derive the mask by restricting loop bounds to each region's
index range (a `heightBand` is a contiguous `j` slice) instead of testing every voxel
center, and allocate no per-voxel `Vec3`.

### 6.5 Camera-driven Candidate Generation

Candidate voxels are produced from the intersection of each camera frustum with the sampling space, implemented in GPU Pass 1 as frustum test + stream compaction (see §11).

---

## 7. Camera Model (GPU representation)

Quaternions are never uploaded to the GPU. The CPU precomputes:

- `view = inverse(translation(position) * rotationMatrix(quaternion))`
- `proj = perspectiveZO(fovRadians, aspect, near, far)` (WebGPU clip z ∈ [0,1])
- `viewProj = proj * view`

The GPU-side struct is a fixed 96 bytes with no alignment ambiguity:

```wgsl
struct Camera {
  viewProj : mat4x4<f32>,   // offset 0,  64 bytes
  position : vec4<f32>,     // offset 64, xyz = world pos, w unused
  params   : vec4<f32>,     // offset 80, x = near, y = far, zw unused
};
// Camera buffer: array<Camera> (storage, read), up to 128 entries (NUM_CAMERAS)
```

### 7.1 Camera Count Parameterization (CAM_WORDS)

The camera limit is **128**. All mask-related data is parameterized by

```
CAM_WORDS = ceil(numCameras / 32)     // 1..4
```

specialized at pipeline creation time via a WGSL `override` constant. With `numCameras ≤ 32`, `CAM_WORDS = 1` and all buffer layouts and behavior are identical to the single-word design. **Implementations must not hard-code 32 in shaders or structs.**

Camera *c* maps to `word = c >> 5`, `bit = c & 31` (**global camera index**, consistent across all chunks; never renumbered by pre-cull).

### 7.2 Chunk-level Camera Pre-cull (CPU)

Before dispatching each chunk, the CPU runs a frustum–chunk-AABB intersection test for every camera (6 planes vs AABB, conservative), producing that chunk's `activeMask: u32[CAM_WORDS]`, written into chunkInfo.

- Pass 1 / Pass 2 run frustum and ray tests only for the set bits of `activeMask`; actual GPU workload is determined by "how many cameras touch this chunk" (typically far fewer than numCameras in large scenes).
- Pre-cull is conservative (it only excludes cameras that definitely do not intersect); **toggling pre-cull must not change the output** (bit-exact; included in the acceptance tests).
- A camera that is disabled (`enabled: false`, §5.2) or flagged `CAMERA_INSIDE_GEOMETRY` (§17) is cleared from `activeMask` for **every** chunk, independently of the frustum test and of the `precull` option.

The same conservative frustum–AABB test also decides which chunks a moved camera can
have affected, and so drives the dirty set of an incremental run (§13.1). Because the
test has no false negatives, a chunk it rejects is guaranteed unaffected.

Frustum containment test (for point p):

```wgsl
let c = cam.viewProj * vec4f(p, 1.0);
let inside = all(abs(c.xy) <= vec2f(c.w)) && c.z >= 0.0 && c.z <= c.w;
```

---

## 8. Visibility Definition (Ray Specification)

For each valid sampling point `p` and each camera `cam`:

```
origin  = p
dist    = length(cam.position - p)
dir     = (cam.position - p) / dist
t_min   = 1e-3                 // prevents self-occlusion of samples adjacent to walls
t_max   = dist - 1e-3          // [CRITICAL] geometry beyond the camera must not be tested
```

- This is an **occlusion query (shadow ray / any-hit)**: hitting any triangle within `(t_min, t_max)` means blocked, and traversal **terminates immediately** — the closest hit is not needed.
- `dist > cam.far` → treated as invisible directly (in practice already excluded by the frustum pass).
- `dist < t_min * 2` (sample nearly coincident with the camera) → treated as visible.
- Ray–triangle: Möller–Trumbore, **no backface culling** (wall normal orientation cannot be relied upon), determinant epsilon = 1e-7.
- If the sampling point itself is invalid (inside SOLID), no ray is cast.

---

## 9. Result Data Formats

### 9.1 Visibility Mask (Mode 1)

`CAM_WORDS` `u32` words per voxel (§7.1; a single u32 when ≤ 32 cameras). Camera *c* maps to bit `c & 31` of `word[c >> 5]`:

```
bit = 1 : visible to that camera (inside frustum, unobstructed, dist ≤ far)
bit = 0 : not visible (occluded / outside frustum / beyond far / invalid voxel)
```

Buffer layout: `visibility[voxelIndex * CAM_WORDS + w]`, words contiguous within a voxel.

### 9.2 Validity Mask

1 bit per voxel (`u32` array, one word per 32 voxels):

```
1 = valid sampling point (participates in analysis and statistics)
0 = invalid (inside SOLID / excluded by sampling policy)
```

Without a validity mask, "visibility = 0" cannot distinguish "occluded from all cameras" from "not an analysis point at all", polluting both statistics and visualization.

The mask depends on the scene and `SamplingConfig` only, so it is built once and cached per chunk (§6.4) rather than derived per `compute()`.

### 9.3 Coverage Buffer (Mode 2 only)

Multi-sampling produces counts of 0–8, which a 1-bit mask cannot carry. Format: 4 bits per voxel per camera (range 0–8 needs 4 bits), i.e. **4 × CAM_WORDS u32 per voxel** (32 cameras = 16 B, 128 cameras = 64 B per voxel).

With `numCameras > 32`, the Mode 2 dense buffer cost is significant (128 cameras → 128 MB per 2M-voxel chunk); in that case Mode 2 is **only permitted on ROI-designated chunks**, and the engine automatically subdivides such chunks until a single coverage buffer is ≤ 64 MB.

```
bits [4*(c%8) .. 4*(c%8)+3] of word[c / 8] = visible sample count of camera c
```

A standard visibility mask is simultaneously derived via threshold `k` (default 1): `count ≥ k → bit 1`, keeping Mode 1 / Mode 2 interface-identical for downstream consumers (statistics, visualization).

### 9.4 Per-chunk Memory (default 2M voxels)

| Buffer | Size |
|---|---|
| Visibility mask | 2M × 4B × CAM_WORDS = 8–32 MB |
| Validity mask | 2M / 8 = 0.25 MB |
| Coverage buffer (Mode 2 only) | 2M × 16B × CAM_WORDS = 32–128 MB (ROI-only above 32 cameras, see §9.3) |
| Candidate list + candMasks (worst case) | 2M × 4B × (1 + CAM_WORDS) = 16–40 MB |

Chunks are computed one at a time; GPU buffers are released immediately after readback. Results for all 100 chunks must **never** reside on the GPU simultaneously; the CPU side always stores results in the merged format of §9.5.

### 9.5 Merged Compressed Storage (SVO: Sparse Voxel Octree)

Visibility results are highly spatially coherent (masks change only at occlusion boundaries and frustum boundaries); adjacent voxels with an identical `(validity, visibility mask)` are merged and stored as an **SVO**. Rationale for SVO over linear RLE: the hierarchy of a regular grid is implicit (node coordinates derive from the tree path and need not be stored), large homogeneous 3D regions collapse into single nodes, and it natively provides visualization LOD and hierarchical region queries.

**Layering principle**:

| Layer | Representation | Rationale |
|---|---|---|
| During GPU compute | Dense buffers (§9.1–9.3) | Pass 2 needs random writes to arbitrary voxels; tree structures are unsuitable as GPU write targets |
| CPU result store / Worker↔main-thread transfer | **SVO** | Homogeneous-region collapse, O(depth) point queries, zero coordinate redundancy |
| Visualization instancing | An SVO leaf *is* a merged axis-aligned cube — instances come straight from leaves, with a depth cap for LOD |

**Spatial definition**:

- One octree per chunk. The chunk voxel grid (default 100 × 200 × 100, X × Y × Z) is virtually padded to `rootSize³ = 256³` (`depth = log2(256) = 8`).
- Voxels in the padded region (outside the chunk's actual extent) are uniformly treated as key = `(mask = 0, valid = 0)` — identical to invalid voxels — and immediately collapse into a few large leaves; the overhead is negligible. The query interface does not accept out-of-bounds coordinates.
- **Merge key**: `CAM_WORDS × 32 + 1` bits = visibility words + valid bit. A node becomes a leaf only when all its voxels share the exact same key. With `CAM_WORDS = 1` the leaf stores the mask directly in `nodeKey`; with `CAM_WORDS > 1` the mask goes into the `palette` (same mechanism as Mode 2) and `nodeKey` stores the palette index.

**Node format** (structure-of-arrays, 9 bytes/node, root at index 0):

```ts
const LEAF = 0xFFFFFFFF;

interface SvoChunk {
  chunkId: number;
  rootSize: number;            // 256
  nodeChild: Uint32Array;      // internal: index of the first of 8 contiguous children; leaf: LEAF
  nodeKey:   Uint32Array;      // leaf: visibility word (palette index when CAM_WORDS > 1 or Mode 2); internal: 0
  nodeValid: Uint8Array;       // leaf: validity 0/1; internal: 0
  palette?:  Uint32Array;      // CAM_WORDS > 1 or Mode 2: deduplicated mask / coverage values, each entry
                               //   occupying CAM_WORDS (Mode 1) or 4 × CAM_WORDS (Mode 2) u32s
}
```

Octant encoding: child index offset = `bit0 = x, bit1 = y, bit2 = z` (taking each axis's coordinate bit at the current level).

**Construction (after readback, in WASM inside the Worker)**:

Bottom-up, level-by-level merging: with the dense buffer as input, first form the lowest-level 2×2×2 groups; if all 8 children are leaves with an identical key, collapse them into a single leaf, proceeding upward to the root. A single linear scan; 2M voxels < 20 ms, after which the dense buffer is released. Nodes are written in depth-first order with the 8 children contiguous, guaranteeing `nodeChild + octant` addressing.

**Point query** (O(depth) = at most 8 array accesses; the SVO implementation of `VoxelAccessor`):

```
fn getKey(i, j, k):
    node  = 0
    level = 7                        // depth - 1
    while nodeChild[node] != LEAF:
        octant = ((i >> level) & 1)
               | ((j >> level) & 1) << 1
               | ((k >> level) & 1) << 2
        node  = nodeChild[node] + octant
        level = level - 1
    return (nodeKey[node], nodeValid[node])
```

**LOD traversal (visualization only)**:

`forEachLeaf(callback, maxDepth?)` traverses depth-first: on reaching a leaf it reports `(min, size, mask, valid, maskWords)` — an axis-aligned cube with edge length `2^(depth - level)` voxels. If `maxDepth` is given, internal nodes reached at that depth are reported as approximate leaves using their subtree's majority key. Visualization adjusts `maxDepth` by camera distance to obtain LOD, entirely skipping padded regions and subtrees excluded by the filter.

The `mask` argument carries **word 0 only** (cameras 0–31) and is retained for callers written against the single-word layout. `maskWords` is a `Uint32Array` of length `CAM_WORDS` carrying the **complete** mask; callers that must be correct for `numCameras > 32` — anything that popcounts a leaf, tests "seen by no camera", or tests a specific camera bit — **must** read `maskWords`, never `mask`. `maskWords` is a **scratch buffer owned by the accessor and reused across callback invocations**: it is valid only for the duration of that call, and a caller that retains a leaf must copy it. The majority key used for `maxDepth` approximation is computed over the **full `CAM_WORDS`-word key**, so LOD approximation is not biased toward the first 32 cameras.

**Mode 2 (palette indirection)**:

Coverage values are `4 × CAM_WORDS` u32s; placing them in nodes would bloat the node. Instead, at tree-build time all occurring values are deduplicated into a `palette`, and the leaf's `nodeKey` stores a palette index. Values in homogeneous regions are highly repetitive, so the palette is typically far smaller than the voxel count. Mode 1 masks with `CAM_WORDS > 1` reuse the same mechanism.

**Compression ratio degrades with camera count**: more cameras means more fragmented mask combinations between adjacent voxels and more leaves; expect storage of 5%–20% of dense at 128 cameras (1%–10% at 32). Palette deduplication absorbs most of the key-width blowup. The fallback rule is unchanged.

**Fallback guarantee**:

Worst case (checkerboard mask distribution): node count ≈ voxelCount × 8/7 ≈ 2.3M, about 21 MB — larger than the 8.25 MB dense form. After tree construction, if `size(SVO) > size(dense)`, that chunk keeps the dense encoding; `ChunkResult.encoding` indicates the actual format.

**Expected benefit**: in typical indoor scenes, large homogeneous regions collapse directly into high-level nodes; storage drops to 1%–10% of dense (full results for 100 chunks drop from ~825 MB to the tens-of-MB range), Worker → main-thread transfer cost drops accordingly, and visualization LOD comes for free.

**Statistics**: coverage statistics are always taken from GPU Pass 3 (§11). If ever recomputed from the SVO, a leaf's weight is the number of voxels it covers **within the actual chunk extent** (the padded region must be subtracted); implementations must not simply count `8^level`.

---

## 10. BVH System

### 10.1 Builder

- Execution environment: Rust WASM (inside a Web Worker)
- Algorithm: **Binned SAH** (16 bins), max leaf size = 8 triangles
- Output: a depth-first-ordered threaded (stackless) node array + a triangle array reordered by leaf
- Multithreading (rayon + wasm-bindgen-rayon) is **optional**: it requires SharedArrayBuffer, i.e. the deployment must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without cross-origin isolation, it automatically falls back to single-threaded.
- Performance reference: single-threaded binned SAH ≈ 1M tris/s; 2M tris ≈ 2 s, executed once at load time — acceptable.

### 10.2 Node Layout

Depth-first ordering: **on an AABB hit, the next node is always `i + 1` (implicit; the left child is not stored)**, and the freed field stores the miss link. Fixed 32 bytes; vec3 is forbidden:

```rust
#[repr(C)]
pub struct GpuBvhNode {
    pub min_x: f32,
    pub min_y: f32,
    pub min_z: f32,
    pub miss:  u32,   // node index to jump to on AABB miss (or after finishing a leaf); 0xFFFFFFFF = end
    pub max_x: f32,
    pub max_y: f32,
    pub max_z: f32,
    pub prim:  u32,   // 0 = internal node; otherwise leaf:
                      //   count = prim >> 28          (1..=8)
                      //   first = prim & 0x0FFF_FFFF  (start index into the triangle array)
}
```

Limits: triangle count < 2^28 = 268M (far above target), leaf size ≤ 15 (≤ 8 in practice).

### 10.3 Traversal (WGSL, any-hit)

```wgsl
fn occluded(origin: vec3f, dir: vec3f, tMin: f32, tMax: f32) -> bool {
  var node: u32 = 0u;
  while (node != INVALID) {
    let n = bvh[node];
    if (rayAabb(origin, dir, tMin, tMax, n)) {
      if (n.prim != 0u) {                       // leaf
        let first = n.prim & 0x0FFFFFFFu;
        let count = n.prim >> 28u;
        for (var t = 0u; t < count; t++) {
          if (rayTri(origin, dir, tMin, tMax, first + t)) { return true; } // any-hit early out
        }
        node = n.miss;
      } else {
        node = node + 1u;                       // hit link (implicit)
      }
    } else {
      node = n.miss;
    }
  }
  return false;
}
```

The GPU uses no dynamic stack. Empty-space skipping is provided naturally by the BVH (empty regions have no nodes); no additional empty-space structure is needed. The **empty ≠ visible** invariant is guaranteed by always completing the traversal.

---

## 11. GPU Compute Pipeline (per chunk)

### Pass 1: Frustum Cull + Stream Compaction

- Dispatch: one thread per logical voxel (workgroup size **64**, 1D dispatch; when voxelCount / 64 exceeds `maxComputeWorkgroupsPerDimension`, switch to 2D dispatch and recompute the index in the shader).
- Flow:
  1. Read the validity bit; invalid → return
  2. For each camera in `activeMask` (§7.2), compute frustum containment, forming `frustumMask: u32[CAM_WORDS]`
  3. `frustumMask` all zero → return
  4. `slot = atomicAdd(&candidateCount, 1)`; write `candidates[slot] = voxelIndex`, `candMasks[slot] = frustumMask`
- `candidateCount` stays **GPU-resident**: it is never read back to size Pass 2, and no indirect-dispatch buffer is built (§11.1).

### Pass 2: BVH Ray Visibility

- Dispatch: `ceil(validCount / 64)` workgroups — one thread per *potential* candidate slot — using the CPU-side `validCount` from the §6.4 validity cache. A candidate must be a valid voxel, so `candidateCount ≤ validCount` always; the bound is therefore safe, and at most `validCount − candidateCount` threads return immediately at the `slot >= candidateCount` guard. This is what keeps the count GPU-resident: no readback, no indirect buffer, no prep pass (§11.1), paid for with a few idle threads. The bound also inherits Pass 1's `maxComputeWorkgroupsPerDimension` validation, since `ceil(validCount/64) ≤ ceil(voxelCount/64)`.
- Each thread iterates the set bits of `candMasks[slot * CAM_WORDS .. +CAM_WORDS]` (skipping any word that is 0), runs the §8 occlusion ray for each camera, and writes results to `visibility[voxelIndex * CAM_WORDS + w]`. Ray count is determined by the number of in-frustum cameras and does not grow linearly with numCameras.
- Mode 2: an outer loop over the 8 sample offsets accumulates counts into the coverage buffer (§9.3).

### Pass 3: Stats Reduction

- One thread per voxel; valid voxels atomicAdd `stats.validCount`, atomicAdd `stats.visibleCount[c]` for each set-bit camera, and increment `stats.coveredCount` if any bit is set.
- Stats buffer: `u32 × (2 + numCameras)` (validCount, coveredCount, visibleCount[numCameras]), accumulated across chunks on the CPU after readback.

Metric definitions:
- Per-camera coverage rate = `visibleCount[c] / validCount`
- Overall coverage rate = `coveredCount / validCount` (visible to ≥ 1 camera)

### Buffer Binding Overview

| Buffer | Type | Purpose |
|---|---|---|
| `bvh` | storage read | `GpuBvhNode[]` |
| `triangles` | storage read | 12 × f32 per tri (3 vertices, xyz + padding each, 48 B) |
| `cameras` | storage read | `Camera[≤128]` + `cameraCount: u32` (uniform) |
| `validity` | storage read | chunk validity bits |
| `candidates` / `candMasks` | storage read_write | Pass 1 output |
| `visibility` | storage read_write | results |
| `coverage` | storage read_write | Mode 2 only |
| `stats` | storage read_write, atomic | Pass 3 |
| `chunkInfo` | uniform | chunk origin, grid dimensions, voxelSize, mode, threshold, `activeMask[4]` (§7.2) |

### 11.1 Submission and Readback

Per chunk, **every pass goes into one command encoder and one `submit()`, followed by
exactly one GPU→CPU synchronization.** No intra-chunk readback may gate a dispatch.

- The buffer clears (`candidateCount`, `visibility`, `stats`, and `coverage` in Mode 2)
  and Passes 1–3 are recorded in that single encoder. Ordering is guaranteed by
  recording them as successive compute passes; no explicit barrier is required.
- Everything the caller needs is copied into **one** staging buffer and mapped once.
  `copyBufferToBuffer` offsets and sizes are 4-byte aligned; `getMappedRange` offsets
  are 8-byte aligned, so segments are padded to an 8-byte boundary.
- **The staging buffer is validated before it is created.** `stats` and — when the
  caller consumes them — `visibility` and `coverage` are resident in it *simultaneously*,
  so its peak size is their **sum**, not their max. A chunk whose combined readback
  exceeds the device's `maxBufferSize` is rejected with `SCENE_TOO_LARGE` naming the
  required and available sizes, rather than being left to a swallowed
  `GPUValidationError` and a rejected `mapAsync`. The per-chunk GPU buffers are released
  on every exit path, failure included.
- **Per-voxel readback is conditional.** When the caller supplies no `onChunkDone`
  (§16.1), `visibility` and (Mode 2) `coverage` are neither copied nor mapped — the
  staging buffer carries `stats` alone. The GPU-side buffers are still allocated and
  written, because Pass 2 writes `visibility` and Pass 3 reads it; `CoverageSummary`
  is bit-identical either way.

  *Rationale.* A stats-only run is the inner loop of camera-placement search and of any
  "how good is this layout" query. On unified memory the copy itself is cheap — measured
  at ~5–10% of a whole `compute()` — but it also allocates a fresh dense `Uint32Array`
  per chunk, up to 62 MB per `compute()` at 0.1 m voxels with 128 cameras, which is pure
  GC churn; on a discrete GPU the same copy crosses PCIe.

---

## 12. Memory Budget and Supported Limits

WebGPU's default `maxStorageBufferBindingSize` is only 128 MiB; even requesting the adapter maximum, 10M triangles (BVH ≈ 20M nodes × 32 B = 640 MB + 480 MB of triangles) is infeasible on most consumer GPUs. Target specification:

| Item | Default target | Memory required | Ceiling (requires adapter limits) |
|---|---|---|---|
| Triangles | **2M** | 96 MB | 10M (requires binding ≥ 512 MB; checked at startup, load rejected with an error if insufficient) |
| BVH nodes | ≤ 4M (≈ 2× tris) | 128 MB | 20M |
| Cameras | 32 | 12 KB @128 | **128** (CAM_WORDS = 4; beyond that, compute in batches and merge on the CPU) |
| Logical voxels | 200M | 0 (index space) | — |
| Voxels per chunk | 2M | §9.4 | degraded per GPU |
| Chunks resident simultaneously | 1 | — | — |

Startup flow (Capability Detection):

1. `navigator.gpu.requestAdapter()`; failure → explicit error (see §16.4)
2. Read `adapter.limits`: `maxStorageBufferBindingSize`, `maxBufferSize`, `maxComputeWorkgroupsPerDimension`, `maxComputeInvocationsPerWorkgroup`
3. `requestDevice({ requiredLimits })`: requiredLimits = min(actual scene requirement, adapter ceiling)
4. Based on the available binding size, decide: triangle ceiling, chunk size (may drop to 5 m × 5 m), and whether Mode 2 is available

---

## 13. Dynamic Camera Update

The scene is fixed → the BVH is immutable. When cameras are added, removed, or moved:

1. The CPU recomputes viewProj for affected cameras and updates only the Camera buffer (`writeBuffer`, ≤ 12 KB @ 128 cameras)
2. Re-run Passes 1–3 for all chunks (no BVH rebuild, no occupancy rebuild, **no validity rebuild** — the mask is camera-independent and served from the §6.4 cache)
3. **Interactive optimization** (§13.1): when only camera poses changed, recompute only the chunks touched by the union of each moved camera's old and new frusta

### 13.1 Incremental Recompute

Step 2 is the correct-but-unconditional path: every chunk pays for every edit. Under a
gizmo drag the host re-runs `compute()` many times per second while only one camera has
moved by centimetres, so nearly all of that work reproduces the previous answer. An
**incremental run** recomputes only the chunks that can have changed and reuses the
retained per-chunk statistics for the rest.

Incremental recompute is **opt-in** — `compute({ incremental: true })` (§16.1). Omitted
or `false` runs the full path of step 2, unchanged. The engine may always decline and
run full; a caller cannot distinguish a declined run from a full one except through
`onRunStart` (§16.1).

#### Baseline

The engine retains a **baseline** describing the last fully completed `compute()`:

| Retained | Purpose |
|---|---|
| Ordered camera ids, and each camera's prepared pose/intrinsics | Eligibility check + the "old frustum" half of the dirty set |
| `mode`, `threshold`, and whether per-voxel output was emitted (§11.1) | Eligibility check — retained results describe *those* options |
| Per chunk: `{ validCount, coveredCount, visibleCount[] }` | Re-summing the whole-scene `CoverageSummary` |

The baseline holds **statistics only, never voxel masks**. It is a few KB (a
`visibleCount` per chunk per camera); the per-voxel data belongs to whoever consumed
`onChunkDone`, and duplicating it inside the engine would defeat §9.4's memory budget.

The baseline is **established or advanced only by a `compute()` that ran to completion
over every chunk it was responsible for**. It is **discarded** by `loadScene()`,
`setSampling()`, any re-`init()` (a `voxelSize` change), and by a `compute()` that
threw. `setCameras()` does **not** touch it — the baseline describes cameras as of the
last completed *run*, not the last *set*, so a host that calls `setCameras()` and then
abandons the run stays correct.

A `compute()` given an explicit `chunks` list (§16.1) leaves the baseline **entirely
untouched** — it neither advances the camera set nor rewrites retained statistics, and
it reports over just the chunks it was given, as it always has. It is a caller-scoped
query, not a run over the scene. Leaving the baseline alone is conservative, not wrong:
the next incremental diff still measures from the older poses and therefore re-dirties
anything the scoped run touched.

Every chunk a non-scoped run visits records a statistics line, **including one with no
valid voxels**, which records an explicit zero rather than nothing. `plan()` requires a
line per chunk before it will run incrementally, so omitting empty chunks would leave a
zone-restricted scene — where most chunks are empty — permanently ineligible.

#### Eligibility

An incremental run requires **index-stable cameras and unchanged result semantics**. The
engine runs full whenever any of these holds:

- there is no baseline;
- the ordered list of camera **ids** differs from the baseline's in membership or order — an add, a delete, or a reorder renumbers mask bits (§7.1) and invalidates every retained mask the host is holding;
- `mode`, `threshold`, or the presence of `onChunkDone` differs from the baseline's — retained statistics describe the baseline's options, and a host that previously ran stats-only never received the masks a chunk-skipping run would decline to re-send.

`precull` is deliberately **not** an eligibility input: §7.2 requires it to be lossless,
so a run may toggle it freely without invalidating anything.

Toggling `enabled` (§5.2) is index-stable and therefore **eligible** — that is the
reason the flag exists rather than the host filtering its own list.

#### Dirty set

With the id list fixed, a camera is **changed** if any of its pose or intrinsic fields
(`position`, `rotation`, `fov`, `aspect`, `near`, `far`, `enabled`) differs from the
baseline's, compared exactly — no epsilon. Then:

```
dirty = ⋃  { chunks whose AABB intersects cam_old's frustum }
      over  ∪ { chunks whose AABB intersects cam_new's frustum }
    changed
    cameras
```

using the conservative §7.2 frustum–AABB test for both poses. A disabled camera
contributes no frustum for the pose in which it was disabled.

This is sound because a camera's influence is bounded by its own frustum: a voxel
outside both the old and the new frustum of every changed camera was not visible to any
changed camera before the edit and is not after it, and the bits of unchanged cameras
are untouched by definition. Occlusion cannot leak across the boundary either — an
occluder only ever *removes* visibility along a ray that lies inside the frustum casting
it. Because the frustum test has no false negatives, the set is conservative: it may
contain chunks whose result is unchanged, never omit one whose result changed.

There is **no dirty-set size threshold**. A run that dirties most of the scene costs
proportionally most of a full run plus an O(chunks × changed cameras) diff, so there is
no cliff to guard against and no benefit to switching strategies part-way.

#### Execution and reporting

An incremental run:

1. reports `{ incremental: true, chunkIds: dirty }` through `onRunStart` (§16.1) **before** the first chunk;
2. runs Passes 1–3 for each dirty chunk, over **all** cameras — a recomputed chunk is recomputed whole, so its masks never mix camera generations;
3. invokes `onChunkDone` for dirty chunks **only**;
4. overwrites those chunks' retained statistics, then sums **all** retained statistics into the returned `CoverageSummary` — `overallRate`, `perCamera`, and `validVoxels` describe the **whole scene**, exactly as a full run's do;
5. advances the baseline.

Consequently a host must treat `onChunkDone` on an incremental run as **replace this
chunk**, not **append to a fresh run**; see §16.1.

**Equivalence requirement.** For any eligible edit, an incremental run must produce a
`CoverageSummary` and per-chunk results bit-identical to a full `compute()` at the same
camera configuration. This is an acceptance criterion (§18, 6g), not merely an intent.

### 13.2 Cancellation

A `compute()` accepts an `AbortSignal` (§16.1). Cancellation is **cooperative and
chunk-granular**: the engine checks the signal before starting each chunk and, once
aborted, stops the loop and rejects with `COMPUTE_CANCELED` (§17). A chunk already in
flight always runs to completion — Passes 1–3 are a single GPU submission (§11.1) with
no interruption point inside them — so the worst-case latency of a cancel is one
chunk's compute, not one run's.

A cancelled run **discards the incremental baseline** (§13.1). It stopped part-way, so
its retained statistics straddle two camera generations, exactly the condition a thrown
`compute()` already drops for.

Two mechanics make this work rather than merely look like it works:

- **The event loop must actually turn.** The CPU backend's `computeChunk` is synchronous,
  so `await`ing it drains microtasks only — and a cancel arriving over the Worker
  boundary is a *message*, a macrotask. When a signal is supplied, the engine therefore
  yields to the macrotask queue between chunks. The WebGPU backend already yields at
  `mapAsync`, but the yield is unconditional so both backends behave identically. It is
  skipped entirely when no signal is given, so an uncancellable run pays nothing.
- **Callbacks cannot cross the Worker boundary**, so the signal does not either. The
  client sends the `compute` request, and on abort posts a separate `cancel` message
  naming that request; the host aborts the controller it created for it (§16.1).

Cancellation is a **caller-side optimization, never a correctness mechanism**: a caller
that never cancels behaves exactly as before, and a cancelled run leaves the engine
usable and self-consistent — its next `compute()` is simply a full one.

---

## 14. Precision Modes

**Mode 1 — Center Sampling**: 1 sample per voxel (the center point). Fastest; default.

**Mode 2 — Multi Sampling**: 8 samples per voxel at `center + 0.35 * voxelSize * (±1, ±1, ±1)` (inset corners — avoids sharing samples with adjacent voxels and reduces the chance of samples landing inside walls). Outputs per-camera counts (§9.3), plus a binary mask derived via threshold. Suited to doorways, railings, and boundary regions; cost ≈ 8×, recommended only for user-designated ROI chunks.

---

## 15. Performance Model

Raw scale: 200M voxels × 128 cameras = 25.6B rays — not viable as an interactive workload. Actual reduction path:

| Technique | Effect |
|---|---|
| Sampling policy (height band, etc.) | 200M → millions to tens of millions of valid voxels |
| SOLID culling | further reduction |
| Chunk-level camera pre-cull (§7.2) | each chunk processes only the cameras that touch it; GPU cost decoupled from numCameras |
| Frustum culling + compaction | each camera computes only in-frustum candidates |
| Any-hit early termination | greatly reduces average traversal cost |
| Validity cache (§6.4) | validity is built once per (scene, sampling); camera-only edits pay none of that CPU cost |
| Single submission per chunk (§11.1) | Pass 2 is sized from the cached `validCount`, so no readback gates a dispatch: one submit and one map per chunk instead of three and three |
| Conditional per-voxel readback (§11.1) | a `compute()` with no `onChunkDone` transfers and allocates only the stats buffer |
| Incremental recompute (§13.1) | a pose-only edit runs only the chunks the moved cameras' old ∪ new frusta touch; under a gizmo drag that is typically a handful of chunks out of the workspace, so cost tracks the edit rather than the scene |
| Cancellation (§13.2) | a run whose result is already known to be unwanted — superseded by a resolution, sampling, or scene change — stops at the next chunk boundary instead of running to completion |

**Performance targets (acceptance baseline, RTX 3060 class)**: Passes 1–3 combined for 500k candidates × 8 cameras × 500k triangles < 500 ms; full workspace (100 chunks, height band Y = 0.5–2.0 m, 8 cameras) < 30 s.

---

## 16. Frontend Architecture and API

```
React / TypeScript (UI)
        |
Three.js (preview / camera placement / coverage visualization only)
        |
Web Worker (engine host, keeps the main thread unblocked)
        |
Rust WASM (BVH build, voxelization, flood fill)
        |
WebGPU Compute (requestAdapter inside the Worker; Chrome supports WebGPU in workers)
```

### 16.1 Engine API (TypeScript)

```ts
interface VisibilityEngine {
  init(config: WorkspaceConfig & EngineOptions): Promise<GpuCapabilities>;
  loadScene(mesh: SceneMesh): Promise<SceneStats>;        // voxelization + flood fill + BVH build
  setSampling(config: SamplingConfig): Promise<SamplingStats>;
  setCameras(cameras: CameraConfig[]): void;              // ≤ 128
  compute(opts?: {
    mode?: 1 | 2;
    threshold?: number;                                   // Mode 2, default 1
    chunks?: number[];                                    // omitted = all
    incremental?: boolean;                                // §13.1, default false
    signal?: AbortSignal;                                 // §13.2, cancel at a chunk boundary
    onRunStart?: (info: RunStart) => void;                // fired before the first chunk
    onChunkDone?: (chunkId: number, result: ChunkResult) => void;  // streaming callback
  }): Promise<CoverageSummary>;
  dispose(): void;
}

interface RunStart {
  incremental: boolean;   // false ⇒ every non-empty chunk will be streamed
  chunkIds: number[];     // the chunks this run will compute, in the order it will
}

interface ChunkResult {
  chunkId: number;
  encoding: 'svo' | 'dense';   // §9.5; default svo, falls back to dense when compression yields no benefit
  // encoding === 'svo'
  svo?: SvoChunk;              // see §9.5; Mode 2 coverage is carried by the palette
  // encoding === 'dense'
  visibility?: Uint32Array;    // CAM_WORDS words per voxel
  validity?: Uint32Array;      // 1 word per 32 voxels
  coverage?: Uint32Array;      // Mode 2: 4 × CAM_WORDS words per voxel
  stats: { validCount: number; coveredCount: number; visibleCount: number[] };
}

// Downstream code always reads through the accessor, unaware of the encoding
interface VoxelAccessor {
  getMask(i: number, j: number, k: number): number;   // visibility word 0 (cameras 0..31)
  getMaskWord(i: number, j: number, k: number, word: number): number;  // any word (§7.1)
  isValid(i: number, j: number, k: number): boolean;
  // LOD traversal (§9.5): reports merged cubes; degrades to per-voxel reporting for dense encoding
  forEachLeaf(
    cb: (
      min: [number, number, number],
      size: number,
      mask: number,            // word 0 only — use maskWords when numCameras > 32
      valid: boolean,
      maskWords: Uint32Array,  // CAM_WORDS words; accessor-owned scratch, copy if retained
    ) => void,
    maxDepth?: number
  ): void;
}

interface CoverageSummary {
  perCamera: { id: string; coverageRate: number }[];
  overallRate: number;       // fraction visible to ≥ 1 camera
  validVoxels: number;
  elapsedMs: number;
}
```

Omitting `onChunkDone` is **meaningful, not merely optional**: it declares that the
caller wants only the `CoverageSummary`, and the engine then skips per-voxel readback
entirely (§11.1). Because callbacks cannot cross a Worker boundary, the worker client
derives a boolean from the caller's `onChunkDone` and sends it with the compute request;
the host installs a chunk stream only when it is set.

`incremental: true` requests the §13.1 optimization. The engine decides whether it can
honour it and **always** reports the decision through `onRunStart`, which fires exactly
once per run, before any chunk. The two callbacks form one contract:

- `incremental === false` — the run streams every non-empty chunk. A host that
  accumulates chunks should **clear** its store first, as it would for any full run.
- `incremental === true` — the run streams only the chunks in `chunkIds`. A host must
  **not** clear its store; it must key retained chunks by `chunkId` and replace the ones
  it receives, leaving the rest standing. Clearing here would silently drop the majority
  of the scene, and no error would be raised.

`signal` requests cancellation (§13.2). An `AbortSignal` cannot be cloned across the
Worker boundary any more than a callback can, so the client keeps the signal on the main
thread and, when it fires, posts a `cancel` message naming the in-flight compute; the
host aborts the controller it made for that request. The rejection surfaces as
`COMPUTE_CANCELED` (§17) on the original `compute()` promise either way, so a caller
cannot tell whether the engine was in-process or in a Worker.

`onRunStart` crosses the Worker boundary the same way `onChunkDone` does: the client
sends `incremental` as a plain field on the compute request, and the host posts a
`runStart` message before the first `chunk` message.

**Host-side chunk consumption.** `installHost` accepts `onRunStart` and `onChunk` hooks
of its own. When `onChunk` is supplied, the host feeds each `ChunkResult` to it and
**never posts a `chunk` message**: the consumer lives in the worker, so the per-voxel
data — the megabytes per chunk of §9.4 — never crosses the boundary at all. Such a host
always runs with per-voxel output; the client's stats-only intent (§11.1) does not apply,
because there is a local consumer either way.

This exists because "off the main thread" and "in the engine's worker" are the same
place. A host that ships chunks out only for the caller to reduce them to a few
kilobytes of derived data pays the transfer, the main thread's decode, and the main
thread's aggregation — all avoidable by reducing them where they were produced. The
hooks are the seam that lets a caller do that without the SDK knowing anything about
what it derives. The `CoverageSummary` a run returns
covers the whole scene either way (§13.1), so a host that ignores `onRunStart` entirely
and requests full runs behaves exactly as before this feature existed.

All large TypedArrays between the Worker and the main thread are passed as **transferables**; structured-clone copying is forbidden.

### 16.2 Visualization Strategies (2M+ voxels must not be drawn as raw cubes)

1. **Slice view (default)**: pick a height y and write that layer (XZ plane) of visibility into a DataTexture mapped onto a horizontal plane (heatmap: colored by visible-camera count)
2. **Filtered instancing**: render only voxels matching a condition (e.g. "not covered by any camera"), generating merged cube instances directly via §9.5 `forEachLeaf` (InstancedMesh, uniform scale = leaf size), with `maxDepth` adjusted by camera distance for LOD; cap 500k instances — beyond that, prompt the user to tighten the filter or lower maxDepth
3. **Height-band aggregated heatmap**: aggregate along Y (height) into an XZ-plane 2D coverage map, overlaid on the top-down view

### 16.3 Deployment Requirements

- If WASM multithreading is enabled: the server must send the COOP/COEP headers (§10.1)
- Static assets include `.wasm`, which requires the correct `application/wasm` MIME type

### 16.4 Browser Support and Fallback

- Requirement: WebGPU (Chrome / Edge 113+; Safari / Firefox subject to their WebGPU progress)
- Without WebGPU: **no CPU fallback** (the scale does not permit it); show an explicit error and a list of supported browsers. The Three.js preview still works (WebGL).

---

## 17. Error Handling

| Situation | Behavior |
|---|---|
| No WebGPU / adapter | `init` rejects with error code `WEBGPU_UNAVAILABLE` |
| Binding size insufficient for the scene | `loadScene` rejects with `SCENE_TOO_LARGE`, including a suggested ceiling |
| Camera count > 128 | `setCameras` throws `TOO_MANY_CAMERAS` |
| Camera located inside SOLID | that camera's coverage is recorded as 0, with warning `CAMERA_INSIDE_GEOMETRY` |
| Device lost | event reported to the UI; engine enters the disposed state and requires a new `init` |
| Malformed mesh (NaN, degenerate faces) | cleaned at load time; the number of removed elements is reported |
| `compute()` aborted via its signal (§13.2) | rejects with `COMPUTE_CANCELED` at the next chunk boundary; the incremental baseline is dropped and the engine stays usable. Not a failure — a caller that cancels deliberately should not surface it as an error |

---

## 18. Acceptance Criteria and Test Cases

**Correctness (automated tests, fixed-seed scenes)**:

1. *Empty scene*: 1 camera (fov 90, far 50) — all valid voxels inside the frustum and within far have bit = 1; outside the frustum, bit = 0
2. *Single-wall occlusion*: a camera, a 10 × 10 m wall, and a sampling region behind it — voxels behind the wall have bit = 0 for that camera, in front = 1; voxels inside the wall have validity = 0
3. *Camera against a wall*: camera 0.05 m from a wall, facing away — the wall behind the camera must not be judged as an occluder due to a t_max error (regression test for §8)
4. *Closed box*: all voxels inside a closed box are SOLID (solidDetection on); with solidDetection off, interior voxels are valid but fully blocked
5. *Bitmask*: a voxel visible to cameras 0 and 3 has word[0] = `0b1001`; visible to camera 100 → bit 4 of word[3] = 1 (CAM_WORDS = 4 scenario)
5a. *Pre-cull losslessness*: the same scene with chunk-level camera pre-cull on / off produces bit-exact identical visibility buffers
6. *Determinism*: two runs on identical input produce bit-exact identical visibility / validity buffers
6a. *Validity cache* (§6.4): with the scene and sampling fixed, `setCameras()` + `compute()` repeated N times yields validity bit-identical to the first run while each chunk's mask is built **exactly once** — the sampling module's internal build counter reads `chunkCount` (every chunk, built by `setSampling()`), not N × `chunkCount`
6b. *Validity ownership* (§6.4): a `dense`-encoded chunk whose `ChunkResult.validity` buffer has been transferred away (detached) must not break a subsequent `compute()` — the cache hands out a copy, never its own buffer
6c. *Stats-only equivalence* (§11.1): `compute()` with and without `onChunkDone` returns a bit-identical `CoverageSummary` (asserted on both backends); with it omitted, the WebGPU backend's internal `bytesRead` counter excludes the per-voxel buffers
6d. *One submission per chunk* (§11.1): the WebGPU backend records exactly one `submit()` and one buffer mapping per computed chunk (internal counters), while its visibility output stays bit-identical to the CPU reference
6e. *Regions outside a chunk* (§6.4 Build): with a single `box` region covering one corner of a multi-chunk workspace, every chunk the box does not reach reports `validCount === 0`, and a `heightBand` lying entirely above the workspace yields `validVoxels === 0` — the narrowed build loops must not manufacture an edge plane or line of valid voxels
6f. *Oversized readback* (§11.1): a chunk whose combined staging size exceeds `maxBufferSize` throws `SCENE_TOO_LARGE` instead of failing inside `mapAsync`, and the staging plan's size is the sum of the segments it carries
6g. *Incremental equivalence* (§13.1): for a fixed scene and sampling, a full `compute()` at camera set C1 and an incremental `compute()` that reaches C1 from a baseline at C0 (pose-only edits) produce a bit-identical `CoverageSummary` **and** bit-identical per-chunk visibility for every chunk the incremental run emitted — asserted on both backends
6h. *Incremental actually skips work* (§13.1): the same run dispatches the backend only for the chunks reported in `onRunStart.chunkIds`, and that set is a strict subset of the workspace when one camera moves a short distance — a regression that quietly recomputes everything still satisfies 6g, so this counter assertion is what proves the optimization is live
6i. *Incremental fallback* (§13.1): adding, deleting, or reordering a camera, or changing `mode`/`threshold`/`onChunkDone` presence between runs, reports `onRunStart.incremental === false` and streams every non-empty chunk; toggling `enabled` (§5.2) stays `true`; toggling `precull` stays `true`
6j. *Cancellation* (§13.2): a `compute()` aborted mid-run rejects with `COMPUTE_CANCELED`, stops dispatching further chunks, and leaves the engine usable — a subsequent `compute()` returns a summary bit-identical to an uninterrupted run at the same cameras. Aborting before the first chunk dispatches nothing at all; aborting a run that already finished is a no-op
6k. *Cancellation drops the baseline* (§13.2): the `compute()` following a cancelled one reports `onRunStart.incremental === false` even when the camera edit would otherwise have been eligible
7. *Mode 2*: voxels at a door-frame edge have count ∈ (0, 8); threshold behavior is correct

**Performance**: the baselines of §15. **Memory**: GPU residency throughout compute ≤ the declared requiredLimits.

---

## 19. Known Limitations

- SOLID determination is unreliable for non-watertight meshes (documented fallback exists)
- All geometry is treated as opaque; glass and wire mesh will overestimate occlusion
- 128-camera ceiling (CAM_WORDS ≤ 4); more cameras require batched computation with CPU-side mask merging before SVO construction
- Higher camera counts reduce SVO compression ratio (§9.5) and linearly increase readback / tree-build cost
- Coverage = line-of-sight; image quality (PPM), lighting, and lens distortion are not modeled
