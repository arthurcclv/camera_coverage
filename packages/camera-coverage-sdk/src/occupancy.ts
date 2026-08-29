/**
 * Occupancy computation (Pass 0, §6.2).
 *
 * Classification (§6.2):
 *   EMPTY_SPACE   — free space; a valid sampling candidate
 *   MIXED_SPACE   — a triangle overlaps the voxel (surface); not sampled
 *   SOLID_GEOMETRY— empty but unreachable from the boundary (closed interior)
 *
 * Validity rule (reconciling §6.2/§6.3 with acceptance tests §18.2/§18.4):
 * a voxel is a valid sampling point iff it is EMPTY_SPACE. MIXED voxels sit
 * inside geometry surfaces and SOLID voxels are enclosed interiors — neither is
 * a meaningful free-space sample.
 *
 * **Materialization (§6.2).** The classification is a pure function of (grid,
 * mesh) per voxel, and its only per-voxel consumer is §6.4's validity build,
 * which compresses it 8× to one bit per voxel and caches *that*. So a
 * workspace-wide array is an intermediate that would outlive its own output by
 * the whole session — 95.4 MiB at 0.1 m over 100 × 10 × 100 m, feeding an
 * 11.9 MiB cache. Two sources therefore implement {@link OccupancySource}:
 *
 *  - {@link ChunkOccupancy} — the default. Voxelizes one chunk on demand into a
 *    reused scratch and retains nothing.
 *  - {@link DenseOccupancy} — the workspace grid, built only when
 *    `solidDetection` is on, because the flood fill asks a *global* reachability
 *    question that no single chunk can answer.
 *
 * Note this is scene *preprocessing*, not compute: it runs identically under
 * `backend: 'cpu'` and `backend: 'webgpu'`, neither of which ever sees it. There
 * is no GPU occupancy path, so `MAX_CPU_VOXELS` is not a CPU-backend cap — it
 * bounds the dense grid on every backend.
 */

import { CellType, EngineError, EngineErrorCode, type Vec3 } from './types.ts';
import type { CleanMesh } from './geometry/mesh.ts';
import { triangleOverlapsAabb } from './geometry/triangle-aabb.ts';
import type { ChunkGrid, WorkspaceGrid } from './grid.ts';

/**
 * Ceiling on the **dense** workspace grid (§6.2). Only the `solidDetection`
 * path allocates it; the per-chunk source has no workspace-scale allocation to
 * bound. The flood fill needs a second byte plane and an index worklist on top
 * of `cells`, so the real residency at this cap is several times the count.
 */
const MAX_CPU_VOXELS = 256_000_000;

/** Voxel-count observability, so a test can assert §18 6v/6w. */
export const occupancyCounters = {
  /** Chunks voxelized by {@link ChunkOccupancy} since the last reset. */
  chunkBuilds: 0,
  /** Whole-workspace grids materialized since the last reset. */
  denseBuilds: 0,
  reset(): void {
    occupancyCounters.chunkBuilds = 0;
    occupancyCounters.denseBuilds = 0;
  },
};

export interface OccupancySource {
  readonly dims: Vec3;
  readonly solidDetection: boolean;
  /** Non-null only when a workspace grid was materialized. */
  readonly solidCount: number | null;
  readonly mixedCount: number | null;
  /**
   * One chunk's `CellType` per voxel, chunk-local order (X fastest).
   *
   * A **reused** buffer: valid until the next call, and never to be retained or
   * transferred. §6.4's builder reads it and keeps only the validity mask it
   * derives, which is the entire point of not materializing the workspace.
   */
  cellsForChunk(chunk: ChunkGrid): Uint8Array;
  /**
   * One voxel by global index. Only §18.3's "camera inside geometry" test calls
   * this, and only when solid detection is on — with it off no cell can be
   * SOLID, so the caller skips the question rather than paying for an answer.
   */
  cellAt(i: number, j: number, k: number): CellType;
}

/**
 * Build the occupancy source for a scene (§6.2). `solidDetection` decides which
 * of the two it is: the flood fill is global, so it needs the dense grid.
 */
export function computeOccupancy(
  grid: WorkspaceGrid,
  mesh: CleanMesh,
  solidDetection: boolean,
): OccupancySource {
  return solidDetection
    ? DenseOccupancy.build(grid, mesh)
    : new ChunkOccupancy(grid, mesh);
}

// ---------------------------------------------------------------------------
// Triangle → chunk index
// ---------------------------------------------------------------------------

/**
 * CSR-style map from chunk id to the triangles whose AABB overlaps it (§6.2).
 *
 * Without it a chunk's build would rescan the whole mesh, making the run
 * `O(triangles × chunks)`. Built once per `loadScene`, and small: a triangle
 * spans one or two chunks in a typical site, so this is ~1.5 `u32` per triangle
 * against the mesh's 36 bytes of vertices.
 */
class TriangleChunkIndex {
  readonly offsets: Uint32Array;
  readonly tris: Uint32Array;

  constructor(grid: WorkspaceGrid, mesh: CleanMesh) {
    const chunkCount = grid.chunkCount;
    const counts = new Uint32Array(chunkCount + 1);
    // Two passes: count spans, prefix-sum, then fill. One pass into arrays of
    // arrays would allocate a JS array per chunk for the same information.
    this.forEachSpan(grid, mesh, (id) => { counts[id + 1]++; });
    for (let c = 0; c < chunkCount; c++) counts[c + 1] += counts[c];
    this.offsets = counts;
    this.tris = new Uint32Array(counts[chunkCount]);
    const cursor = counts.slice(0, chunkCount);
    this.forEachSpan(grid, mesh, (id, t) => { this.tris[cursor[id]++] = t; });
  }

  /** Visit (chunkId, triangleIndex) for every chunk a triangle's AABB reaches. */
  private forEachSpan(
    grid: WorkspaceGrid,
    mesh: CleanMesh,
    visit: (chunkId: number, tri: number) => void,
  ): void {
    const verts = mesh.triVerts;
    const vs = grid.voxelSize;
    const [ox, , oz] = grid.worldMin;
    const [vpcX, , vpcZ] = grid.chunkVoxels;
    const { chunkCountX, chunkCountZ } = grid;
    // Chunks partition XZ only (§9.1), so a triangle's chunk span is a 2D box.
    const chunkOf = (w: number, origin: number, per: number, n: number) => {
      const c = Math.floor((w - origin) / (vs * per));
      return c < 0 ? 0 : c >= n ? n - 1 : c;
    };
    for (let t = 0; t < mesh.triangleCount; t++) {
      const b = t * 9;
      const x0 = Math.min(verts[b], verts[b + 3], verts[b + 6]);
      const x1 = Math.max(verts[b], verts[b + 3], verts[b + 6]);
      const z0 = Math.min(verts[b + 2], verts[b + 5], verts[b + 8]);
      const z1 = Math.max(verts[b + 2], verts[b + 5], verts[b + 8]);
      const cx0 = chunkOf(x0, ox, vpcX, chunkCountX);
      const cx1 = chunkOf(x1, ox, vpcX, chunkCountX);
      const cz0 = chunkOf(z0, oz, vpcZ, chunkCountZ);
      const cz1 = chunkOf(z1, oz, vpcZ, chunkCountZ);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) visit(cx + chunkCountX * cz, t);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-chunk source (the default)
// ---------------------------------------------------------------------------

/**
 * Voxelizes one chunk at a time and retains nothing per voxel (§6.2).
 *
 * The scratch is grown to the largest chunk asked for and handed out as an exact
 * subarray, following the SDK's reused-buffer rule (see `ai/ARCHITECTURE.md`):
 * fully written on every hand-out — `fill(EmptySpace)` here — so a chunk never
 * inherits its predecessor's cells.
 */
export class ChunkOccupancy implements OccupancySource {
  readonly dims: Vec3;
  readonly solidDetection = false;
  readonly solidCount = null;
  readonly mixedCount = null;

  private grid: WorkspaceGrid;
  private mesh: CleanMesh;
  private index: TriangleChunkIndex;
  private scratch = new Uint8Array(0);

  constructor(grid: WorkspaceGrid, mesh: CleanMesh) {
    this.grid = grid;
    this.mesh = mesh;
    this.dims = grid.gridDims;
    this.index = new TriangleChunkIndex(grid, mesh);
  }

  cellsForChunk(chunk: ChunkGrid): Uint8Array {
    occupancyCounters.chunkBuilds++;
    if (this.scratch.length < chunk.voxelCount) {
      this.scratch = new Uint8Array(chunk.voxelCount);
    }
    const cells = this.scratch.subarray(0, chunk.voxelCount);
    cells.fill(CellType.EmptySpace);

    const { offsets, tris } = this.index;
    voxelizeWindow(
      cells,
      this.mesh,
      this.dims,
      this.grid.worldMin,
      this.grid.voxelSize,
      // Chunks partition XZ only, so the window spans the full height (§3).
      { base: [chunk.base[0], 0, chunk.base[2]], dims: chunk.dims },
      tris,
      offsets[chunk.chunkId],
      offsets[chunk.chunkId + 1],
    );
    return cells;
  }

  /**
   * With solid detection off, no cell is ever SOLID, so the only caller (§18.3's
   * camera test) skips this entirely. Answering it correctly still costs a
   * chunk build, which is why the caller must not ask.
   */
  cellAt(i: number, j: number, k: number): CellType {
    const [gx, gy, gz] = this.dims;
    if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) {
      return CellType.EmptySpace;
    }
    const [vpcX, , vpcZ] = this.grid.chunkVoxels;
    const chunk = this.grid.chunk(
      Math.floor(i / vpcX) + this.grid.chunkCountX * Math.floor(k / vpcZ),
    );
    const cells = this.cellsForChunk(chunk);
    const [nx, ny] = chunk.dims;
    const li = (i - chunk.base[0]) + nx * (j + ny * (k - chunk.base[2]));
    return cells[li] as CellType;
  }
}

// ---------------------------------------------------------------------------
// Dense workspace source (solidDetection only)
// ---------------------------------------------------------------------------

/**
 * The workspace-wide grid, built only when `solidDetection` is on (§6.2).
 *
 * The flood fill decides whether an EMPTY cell is reachable from the workspace
 * boundary, which is a property of the whole grid: a sealed interior can span
 * chunks, so no chunk-local pass can answer it.
 */
export class DenseOccupancy implements OccupancySource {
  readonly dims: Vec3;
  readonly solidDetection = true;
  readonly solidCount: number;
  readonly mixedCount: number;
  /** `CellType` per voxel of the whole grid, X fastest then Y then Z. */
  readonly cells: Uint8Array;

  private grid: WorkspaceGrid;
  private scratch = new Uint8Array(0);

  /**
   * Wraps a finished grid. `cells` is the classification; everything else on
   * this class is layout over it, which is what lets the WASM kernel (§4) hand
   * in its own array and still answer the same questions.
   */
  constructor(grid: WorkspaceGrid, cells: Uint8Array, solidCount: number, mixedCount: number) {
    this.grid = grid;
    this.dims = grid.gridDims;
    this.cells = cells;
    this.solidCount = solidCount;
    this.mixedCount = mixedCount;
  }

  /** Voxelize and flood-fill the whole workspace (§6.2). */
  static build(grid: WorkspaceGrid, mesh: CleanMesh): DenseOccupancy {
    occupancyCounters.denseBuilds++;
    const [nx, ny, nz] = grid.gridDims;
    const cells = new Uint8Array(assertDenseFits(grid)); // default EmptySpace (0)
    const mixed = voxelizeWindow(
      cells,
      mesh,
      grid.gridDims,
      grid.worldMin,
      grid.voxelSize,
      { base: [0, 0, 0], dims: grid.gridDims },
      null,
      0,
      mesh.triangleCount,
    );
    const solid = floodFillSolid(cells, nx, ny, nz);
    return new DenseOccupancy(grid, cells, solid, mixed);
  }

  cellsForChunk(chunk: ChunkGrid): Uint8Array {
    // Copy the chunk's slice out so both sources present the same chunk-local
    // layout to §6.4's builder. The copy is 1 byte per voxel on the path that
    // already pays 1 byte per voxel of the workspace.
    if (this.scratch.length < chunk.voxelCount) {
      this.scratch = new Uint8Array(chunk.voxelCount);
    }
    const out = this.scratch.subarray(0, chunk.voxelCount);
    const [nx, ny, nz] = chunk.dims;
    const [gx, gy] = this.dims;
    const [i0, , k0] = chunk.base;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const src = i0 + gx * (j + gy * (k0 + k));
        out.set(this.cells.subarray(src, src + nx), nx * (j + ny * k));
      }
    }
    return out;
  }

  cellAt(i: number, j: number, k: number): CellType {
    const [gx, gy, gz] = this.dims;
    if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) {
      return CellType.EmptySpace;
    }
    return this.cells[i + gx * (j + gy * k)] as CellType;
  }
}

/**
 * Mark every voxel a triangle overlaps as MIXED (§6.2 Voxelization). Returns the
 * MIXED count. Shared shape with {@link ChunkOccupancy.cellsForChunk}: same AABB
 * range, same exact SAT test, different extent.
 */
/**
 * Voxelize `tris` into the `window` of the grid, writing `MIXED_SPACE` where the
 * exact SAT test hits (§6.2). Returns the number of cells newly marked.
 *
 * One function for both sources, because the classification has to agree
 * *bit-for-bit* between them (§18 6u) and two copies of this arithmetic agree
 * only by luck. What differs is the window and the triangle set, so those are
 * the parameters:
 *
 *  - the dense source passes the whole grid and every triangle;
 *  - the per-chunk source passes one chunk's extent and that chunk's index slice.
 *
 * Voxel centers and AABB ranges are always computed in **global** index space
 * off `worldMin`, never off the window's own origin. Both are float arithmetic,
 * and `worldMin + (i0 + i + 0.5) * vs` is not bit-identical to
 * `(worldMin + i0 * vs) + (i + 0.5) * vs` — at 0.1 m over 100 m that drift
 * reclassified ~48k voxels at chunk seams. Only the *storage index* is
 * window-local.
 */
function voxelizeWindow(
  cells: Uint8Array,
  mesh: CleanMesh,
  gridDims: Vec3,
  worldMin: Vec3,
  vs: number,
  window: { base: [number, number, number]; dims: Vec3 },
  /** Triangle ids to test, or `null` for every triangle in the mesh. */
  tris: Uint32Array | null,
  lo: number,
  hi: number,
): number {
  const [gx, gy, gz] = gridDims;
  const [nx, ny] = window.dims;
  const [i0, j0, k0] = window.base;
  const iEnd = i0 + window.dims[0] - 1;
  const jEnd = j0 + window.dims[1] - 1;
  const kEnd = k0 + window.dims[2] - 1;
  const [wx, wy, wz] = worldMin;
  const half: Vec3 = [vs * 0.5, vs * 0.5, vs * 0.5];
  const verts = mesh.triVerts;
  let mixedCount = 0;

  for (let s = lo; s < hi; s++) {
    const b = (tris ? tris[s] : s) * 9;
    const a: Vec3 = [verts[b], verts[b + 1], verts[b + 2]];
    const bb: Vec3 = [verts[b + 3], verts[b + 4], verts[b + 5]];
    const c: Vec3 = [verts[b + 6], verts[b + 7], verts[b + 8]];

    // The global range, intersected with the window. `clampI` first, so a
    // triangle outside the grid lands on the edge index and is decided by the
    // SAT test rather than skipped.
    const loI = Math.max(i0, clampI(Math.floor((Math.min(a[0], bb[0], c[0]) - wx) / vs), gx));
    const hiI = Math.min(iEnd, clampI(Math.floor((Math.max(a[0], bb[0], c[0]) - wx) / vs), gx));
    const loJ = Math.max(j0, clampI(Math.floor((Math.min(a[1], bb[1], c[1]) - wy) / vs), gy));
    const hiJ = Math.min(jEnd, clampI(Math.floor((Math.max(a[1], bb[1], c[1]) - wy) / vs), gy));
    const loK = Math.max(k0, clampI(Math.floor((Math.min(a[2], bb[2], c[2]) - wz) / vs), gz));
    const hiK = Math.min(kEnd, clampI(Math.floor((Math.max(a[2], bb[2], c[2]) - wz) / vs), gz));
    // A chunk's triangle index is an XZ-only AABB test, so a listed triangle may
    // not actually reach it. An empty range is how that shows up.
    if (loI > hiI || loJ > hiJ || loK > hiK) continue;

    for (let gk = loK; gk <= hiK; gk++) {
      const cz = wz + (gk + 0.5) * vs;
      const kLocal = gk - k0;
      for (let gj = loJ; gj <= hiJ; gj++) {
        const cy = wy + (gj + 0.5) * vs;
        const rowBase = nx * (gj - j0 + ny * kLocal);
        for (let gi = loI; gi <= hiI; gi++) {
          const ci = rowBase + (gi - i0);
          if (cells[ci] === CellType.MixedSpace) continue;
          if (triangleOverlapsAabb(a, bb, c, [wx + (gi + 0.5) * vs, cy, cz], half)) {
            cells[ci] = CellType.MixedSpace;
            mixedCount++;
          }
        }
      }
    }
  }
  return mixedCount;
}

/**
 * 6-connected BFS from all EMPTY boundary voxels (§6.2). EMPTY voxels not
 * reached are enclosed interiors → SOLID_GEOMETRY. Returns the SOLID count.
 */
function floodFillSolid(cells: Uint8Array, nx: number, ny: number, nz: number): number {
  const total = nx * ny * nz;
  const reached = new Uint8Array(total);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // A worklist, not a per-voxel field: it holds only cells pending expansion, so
  // it grows to the frontier's high-water mark rather than to `total`. At 100M
  // voxels the fixed `Int32Array(total)` this replaces was 381.6 MiB.
  let stack = new Int32Array(1 << 16);
  let sp = 0;

  const push = (i: number, j: number, k: number) => {
    const c = idx(i, j, k);
    if (cells[c] === CellType.EmptySpace && reached[c] === 0) {
      reached[c] = 1;
      if (sp === stack.length) {
        const grown = new Int32Array(Math.min(total, stack.length * 2));
        grown.set(stack);
        stack = grown;
      }
      stack[sp++] = c;
    }
  };

  // Seed the six faces of the workspace box.
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) { push(i, j, 0); push(i, j, nz - 1); }
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) { push(i, 0, k); push(i, ny - 1, k); }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) { push(0, j, k); push(nx - 1, j, k); }

  while (sp > 0) {
    const c = stack[--sp];
    const i = c % nx;
    const j = ((c - i) / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    if (i > 0) push(i - 1, j, k);
    if (i < nx - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k);
    if (j < ny - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1);
    if (k < nz - 1) push(i, j, k + 1);
  }

  let solid = 0;
  for (let c = 0; c < total; c++) {
    if (cells[c] === CellType.EmptySpace && reached[c] === 0) {
      cells[c] = CellType.SolidGeometry;
      solid++;
    }
  }
  return solid;
}

function clampI(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * The §6.2 ceiling on the dense grid, as an `EngineError` rather than a bare
 * `Error` — an untyped throw crosses the Worker boundary as `INVALID_STATE`
 * (§16.1) and names nothing the caller can act on.
 */
export function assertDenseFits(grid: WorkspaceGrid): number {
  const [nx, ny, nz] = grid.gridDims;
  const total = nx * ny * nz;
  if (total > MAX_CPU_VOXELS) {
    throw new EngineError(
      EngineErrorCode.SCENE_TOO_LARGE,
      `Solid detection needs a dense ${nx}×${ny}×${nz} = ${total}-voxel occupancy grid, ` +
        `over the ${MAX_CPU_VOXELS} ceiling. Increase voxelSize, shrink the workspace, or pass ` +
        `solidDetection: false — which materializes occupancy per chunk instead (§6.2).`,
      { voxelCount: total, ceiling: MAX_CPU_VOXELS },
    );
  }
  return total;
}
