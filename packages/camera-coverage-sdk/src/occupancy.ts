/**
 * Occupancy computation (Pass 0, §6.2).
 *
 * Spec reference uses a hierarchical L0/L1/L2 sparse grid to avoid dense
 * allocation at full workspace scale. This implementation computes occupancy
 * directly at voxel resolution over the logical grid — correct and simple, and
 * appropriate for the CPU reference backend / test-scale scenes. Very large
 * workspaces are rejected with a clear error (the GPU path is the production
 * route for those).
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
 */

import type { Vec3 } from './types.ts';
import { CellType } from './types.ts';
import type { CleanMesh } from './geometry/mesh.ts';
import { triangleOverlapsAabb } from './geometry/triangle-aabb.ts';
import type { WorkspaceGrid } from './grid.ts';

const MAX_CPU_VOXELS = 256_000_000;

export interface Occupancy {
  dims: Vec3;
  cells: Uint8Array; // CellType per voxel, X fastest then Y then Z
  solidDetection: boolean;
  solidCount: number;
  mixedCount: number;
}

export function computeOccupancy(
  grid: WorkspaceGrid,
  mesh: CleanMesh,
  solidDetection: boolean,
): Occupancy {
  const [nx, ny, nz] = grid.gridDims;
  const total = nx * ny * nz;
  if (total > MAX_CPU_VOXELS) {
    throw new Error(
      `Occupancy grid ${nx}×${ny}×${nz} = ${total} voxels exceeds the CPU cap ` +
        `(${MAX_CPU_VOXELS}); reduce the workspace/voxelSize or use the GPU path.`,
    );
  }
  const cells = new Uint8Array(total); // default EmptySpace (0)
  const vs = grid.voxelSize;
  const origin = grid.worldMin;
  const half: Vec3 = [vs * 0.5, vs * 0.5, vs * 0.5];

  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  // --- Voxelization: mark MIXED cells overlapping each triangle -------------
  const verts = mesh.triVerts;
  let mixedCount = 0;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const b = t * 9;
    const a: Vec3 = [verts[b], verts[b + 1], verts[b + 2]];
    const bb: Vec3 = [verts[b + 3], verts[b + 4], verts[b + 5]];
    const c: Vec3 = [verts[b + 6], verts[b + 7], verts[b + 8]];

    // Triangle AABB → voxel index range (clamped to grid).
    const loI = clampI(Math.floor((Math.min(a[0], bb[0], c[0]) - origin[0]) / vs), nx);
    const hiI = clampI(Math.floor((Math.max(a[0], bb[0], c[0]) - origin[0]) / vs), nx);
    const loJ = clampI(Math.floor((Math.min(a[1], bb[1], c[1]) - origin[1]) / vs), ny);
    const hiJ = clampI(Math.floor((Math.max(a[1], bb[1], c[1]) - origin[1]) / vs), ny);
    const loK = clampI(Math.floor((Math.min(a[2], bb[2], c[2]) - origin[2]) / vs), nz);
    const hiK = clampI(Math.floor((Math.max(a[2], bb[2], c[2]) - origin[2]) / vs), nz);

    for (let k = loK; k <= hiK; k++) {
      for (let j = loJ; j <= hiJ; j++) {
        for (let i = loI; i <= hiI; i++) {
          const ci = idx(i, j, k);
          if (cells[ci] === CellType.MixedSpace) continue;
          const center: Vec3 = [
            origin[0] + (i + 0.5) * vs,
            origin[1] + (j + 0.5) * vs,
            origin[2] + (k + 0.5) * vs,
          ];
          if (triangleOverlapsAabb(a, bb, c, center, half)) {
            cells[ci] = CellType.MixedSpace;
            mixedCount++;
          }
        }
      }
    }
  }

  let solidCount = 0;
  if (solidDetection) {
    solidCount = floodFillSolid(cells, nx, ny, nz);
  }

  return { dims: grid.gridDims, cells, solidDetection, solidCount, mixedCount };
}

/**
 * 6-connected BFS from all EMPTY boundary voxels (§6.2). EMPTY voxels not
 * reached are enclosed interiors → SOLID_GEOMETRY. Returns the SOLID count.
 */
function floodFillSolid(cells: Uint8Array, nx: number, ny: number, nz: number): number {
  const total = nx * ny * nz;
  const reached = new Uint8Array(total);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const stack = new Int32Array(total);
  let sp = 0;

  const push = (i: number, j: number, k: number) => {
    const c = idx(i, j, k);
    if (cells[c] === CellType.EmptySpace && reached[c] === 0) {
      reached[c] = 1;
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
