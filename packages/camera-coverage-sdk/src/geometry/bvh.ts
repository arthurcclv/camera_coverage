/**
 * Binned SAH BVH builder (§10).
 *
 * Output:
 *  - `nodes`: interleaved 32-byte GpuBvhNode array (§10.2), depth-first with an
 *    implicit left child (hit → node+1) and an explicit miss/escape link.
 *  - `triData`: triangles reordered by leaf, 12 f32 per triangle (3 verts,
 *    xyz + padding each = 48 B) matching the GPU `triangles` buffer (§11).
 *
 * In the reference architecture this runs in Rust WASM; this is a faithful
 * TypeScript port with identical output semantics.
 */

import type { CleanMesh } from './mesh.ts';

export const BVH_NODE_WORDS = 8; // 32 bytes
export const BVH_INVALID = 0xffffffff;
const MAX_LEAF = 8;
const BINS = 16;

export interface Bvh {
  /** Interleaved node buffer (BVH_NODE_WORDS u32/f32 words per node). */
  nodes: ArrayBuffer;
  nodeCount: number;
  /** f32 view: min_x,min_y,min_z,_,max_x,max_y,max_z,_ per node. */
  f32: Float32Array;
  /** u32 view: _,_,_,miss,_,_,_,prim per node. */
  u32: Uint32Array;
  /** Reordered triangle vertices, 12 f32 per triangle. */
  triData: Float32Array;
  triangleCount: number;
}

interface TreeNode {
  min: [number, number, number];
  max: [number, number, number];
  leaf: boolean;
  start: number; // triangle range start (leaf)
  count: number; // triangle range count (leaf)
  left?: TreeNode;
  right?: TreeNode;
}

export function buildBvh(mesh: CleanMesh): Bvh {
  const n = mesh.triangleCount;
  const verts = mesh.triVerts; // 9 f/tri

  const triMin = new Float32Array(n * 3);
  const triMax = new Float32Array(n * 3);
  const cent = new Float32Array(n * 3);
  const order = new Uint32Array(n);

  for (let t = 0; t < n; t++) {
    const b = t * 9;
    for (let d = 0; d < 3; d++) {
      const a0 = verts[b + d];
      const a1 = verts[b + 3 + d];
      const a2 = verts[b + 6 + d];
      const mn = Math.min(a0, a1, a2);
      const mx = Math.max(a0, a1, a2);
      triMin[t * 3 + d] = mn;
      triMax[t * 3 + d] = mx;
      cent[t * 3 + d] = (mn + mx) * 0.5;
    }
    order[t] = t;
  }

  const build = (start: number, count: number): TreeNode => {
    const { min, max } = rangeBounds(triMin, triMax, order, start, count);
    const node: TreeNode = { min, max, leaf: true, start, count };
    if (count <= MAX_LEAF) return node;

    const cb = centroidBounds(cent, order, start, count);
    let axis = 0;
    let ext = cb.max[0] - cb.min[0];
    for (let d = 1; d < 3; d++) {
      const e = cb.max[d] - cb.min[d];
      if (e > ext) { ext = e; axis = d; }
    }
    if (ext < 1e-12) return node; // all centroids coincide → leaf

    // Bin.
    const binCount = new Int32Array(BINS);
    const binMin = new Float32Array(BINS * 3).fill(Infinity);
    const binMax = new Float32Array(BINS * 3).fill(-Infinity);
    const k = (BINS * (1 - 1e-6)) / ext;
    const binOf = (t: number) =>
      Math.min(BINS - 1, Math.max(0, ((cent[t * 3 + axis] - cb.min[axis]) * k) | 0));

    for (let i = 0; i < count; i++) {
      const t = order[start + i];
      const bi = binOf(t);
      binCount[bi]++;
      for (let d = 0; d < 3; d++) {
        if (triMin[t * 3 + d] < binMin[bi * 3 + d]) binMin[bi * 3 + d] = triMin[t * 3 + d];
        if (triMax[t * 3 + d] > binMax[bi * 3 + d]) binMax[bi * 3 + d] = triMax[t * 3 + d];
      }
    }

    // Sweep to find the SAH-optimal split between bins.
    const leftArea = new Float32Array(BINS);
    const leftCount = new Int32Array(BINS);
    {
      let cnt = 0;
      const bmin = [Infinity, Infinity, Infinity];
      const bmax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < BINS; i++) {
        if (binCount[i] > 0) {
          cnt += binCount[i];
          for (let d = 0; d < 3; d++) {
            bmin[d] = Math.min(bmin[d], binMin[i * 3 + d]);
            bmax[d] = Math.max(bmax[d], binMax[i * 3 + d]);
          }
        }
        leftCount[i] = cnt;
        leftArea[i] = cnt > 0 ? surfaceArea(bmin, bmax) : 0;
      }
    }

    let bestCost = Infinity;
    let bestSplit = -1;
    {
      let cnt = 0;
      const bmin = [Infinity, Infinity, Infinity];
      const bmax = [-Infinity, -Infinity, -Infinity];
      for (let i = BINS - 1; i >= 1; i--) {
        if (binCount[i] > 0) {
          cnt += binCount[i];
          for (let d = 0; d < 3; d++) {
            bmin[d] = Math.min(bmin[d], binMin[i * 3 + d]);
            bmax[d] = Math.max(bmax[d], binMax[i * 3 + d]);
          }
        }
        const rArea = cnt > 0 ? surfaceArea(bmin, bmax) : 0;
        const lc = leftCount[i - 1];
        const rc = cnt;
        if (lc === 0 || rc === 0) continue;
        const cost = leftArea[i - 1] * lc + rArea * rc;
        if (cost < bestCost) { bestCost = cost; bestSplit = i; }
      }
    }

    const parentArea = surfaceArea(min, max);
    const leafCost = count * parentArea;
    if (bestSplit < 0 || bestCost >= leafCost) {
      // No beneficial split. Force a median split so building always terminates
      // for large leaves; keep as a leaf only when at/below MAX_LEAF.
      if (count <= MAX_LEAF) return node;
      return splitMedian(node, cent, order, axis, start, count, build);
    }

    // Partition `order[start..start+count)` by bin < bestSplit.
    let lo = start;
    let hi = start + count - 1;
    while (lo <= hi) {
      const t = order[lo];
      if (binOf(t) < bestSplit) {
        lo++;
      } else {
        order[lo] = order[hi];
        order[hi] = t;
        hi--;
      }
    }
    const leftN = lo - start;
    if (leftN === 0 || leftN === count) {
      return splitMedian(node, cent, order, axis, start, count, build);
    }

    node.leaf = false;
    node.left = build(start, leftN);
    node.right = build(start + leftN, count - leftN);
    return node;
  };

  let root: TreeNode;
  if (n === 0) {
    root = { min: [0, 0, 0], max: [0, 0, 0], leaf: true, start: 0, count: 0 };
  } else {
    root = build(0, n);
  }

  // Reorder triangle data into leaf order (12 f32 per tri).
  const triData = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) {
    const src = order[i] * 9;
    const dst = i * 12;
    for (let v = 0; v < 3; v++) {
      triData[dst + v * 4 + 0] = verts[src + v * 3 + 0];
      triData[dst + v * 4 + 1] = verts[src + v * 3 + 1];
      triData[dst + v * 4 + 2] = verts[src + v * 3 + 2];
      triData[dst + v * 4 + 3] = 0;
    }
  }

  return flatten(root, triData, n);
}

function flatten(root: TreeNode, triData: Float32Array, triangleCount: number): Bvh {
  const nodesList: TreeNode[] = [];
  const sizes: number[] = [];

  const visit = (node: TreeNode): number => {
    const idx = nodesList.length;
    nodesList.push(node);
    sizes.push(0);
    let size = 1;
    if (!node.leaf) {
      size += visit(node.left!);
      size += visit(node.right!);
    }
    sizes[idx] = size;
    return size;
  };
  visit(root);

  const count = nodesList.length;
  const buffer = new ArrayBuffer(count * BVH_NODE_WORDS * 4);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);

  for (let i = 0; i < count; i++) {
    const node = nodesList[i];
    const base = i * BVH_NODE_WORDS;
    f32[base + 0] = node.min[0];
    f32[base + 1] = node.min[1];
    f32[base + 2] = node.min[2];
    f32[base + 4] = node.max[0];
    f32[base + 5] = node.max[1];
    f32[base + 6] = node.max[2];
    const escape = i + sizes[i];
    u32[base + 3] = escape >= count ? BVH_INVALID : escape;
    if (node.leaf) {
      u32[base + 7] = node.count === 0 ? 0 : (node.count << 28) | (node.start & 0x0fffffff);
    } else {
      u32[base + 7] = 0;
    }
  }

  // An empty scene still needs a single root node that never occludes. `prim`
  // must be nonzero so the shader's traversal (WGSL `occluded()`) takes the
  // leaf branch instead of treating this as an interior node and descending
  // to a nonexistent child at index 1 (out-of-bounds read -> effectively
  // infinite GPU loop, since `node` only terminates on BVH_INVALID). The
  // encoded count is still 0, so the leaf branch runs zero ray-triangle tests
  // and falls straight through to the INVALID miss link.
  if (count === 1 && root.leaf && root.count === 0) {
    f32[0] = f32[1] = f32[2] = 1e30;
    f32[4] = f32[5] = f32[6] = -1e30;
    u32[3] = BVH_INVALID;
    u32[7] = 1; // count=0 (top 4 bits), start=1 (dummy, unused when count=0)
  }

  return { nodes: buffer, nodeCount: count, f32, u32, triData, triangleCount };
}

// --- helpers ---------------------------------------------------------------

function rangeBounds(
  triMin: Float32Array,
  triMax: Float32Array,
  order: Uint32Array,
  start: number,
  count: number,
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const t = order[start + i];
    for (let d = 0; d < 3; d++) {
      if (triMin[t * 3 + d] < min[d]) min[d] = triMin[t * 3 + d];
      if (triMax[t * 3 + d] > max[d]) max[d] = triMax[t * 3 + d];
    }
  }
  return { min, max };
}

function centroidBounds(
  cent: Float32Array,
  order: Uint32Array,
  start: number,
  count: number,
): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const t = order[start + i];
    for (let d = 0; d < 3; d++) {
      const c = cent[t * 3 + d];
      if (c < min[d]) min[d] = c;
      if (c > max[d]) max[d] = c;
    }
  }
  return { min, max };
}

function surfaceArea(min: number[], max: number[]): number {
  const dx = Math.max(0, max[0] - min[0]);
  const dy = Math.max(0, max[1] - min[1]);
  const dz = Math.max(0, max[2] - min[2]);
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function splitMedian(
  node: TreeNode,
  cent: Float32Array,
  order: Uint32Array,
  axis: number,
  start: number,
  count: number,
  build: (s: number, c: number) => TreeNode,
): TreeNode {
  const slice = Array.from(order.subarray(start, start + count));
  slice.sort((a, b) => cent[a * 3 + axis] - cent[b * 3 + axis]);
  order.set(slice, start);
  const leftN = count >> 1;
  node.leaf = false;
  node.left = build(start, leftN);
  node.right = build(start + leftN, count - leftN);
  return node;
}
