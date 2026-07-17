/**
 * Sparse Voxel Octree merged storage + VoxelAccessor (§9.5, §16.1).
 *
 * The merge key is `CAM_WORDS × 32 + 1` bits: the visibility mask words plus
 * the validity bit. With CAM_WORDS == 1 the mask is stored directly in
 * `nodeKey`; with CAM_WORDS > 1 the mask goes into a deduplicated `palette` and
 * `nodeKey` stores the palette index.
 *
 * Mode 2 raw coverage counts are exposed through the dense `ChunkResult.coverage`
 * field; the SVO always stores the derived (thresholded) visibility mask so the
 * accessor interface is identical across modes (§9.3).
 */

import type { SvoChunk, Vec3 } from './types.ts';

export const LEAF = 0xffffffff;
const ROOT_SIZE = 256;
const DEPTH = 8; // log2(256)

export interface DenseChunk {
  dims: Vec3;
  camWords: number;
  visibility: Uint32Array; // voxelCount * camWords
  validity: Uint32Array; // ceil(voxelCount/32)
}

interface TreeNode {
  leaf: boolean;
  valueId: number; // meaningful for leaves
  children?: TreeNode[];
}

interface ValueEntry {
  valid: number;
  mask: number[]; // camWords words
}

export function buildSvo(chunkId: number, dense: DenseChunk): SvoChunk | null {
  const [nx, ny, nz] = dense.dims;
  const cw = dense.camWords;
  const vis = dense.visibility;
  const valid = dense.validity;

  // --- value interning ------------------------------------------------------
  const valueMap = new Map<string, number>();
  const values: ValueEntry[] = [];
  const internValue = (validBit: number, mask: number[]): number => {
    const key = validBit + '|' + mask.join(',');
    let id = valueMap.get(key);
    if (id === undefined) {
      id = values.length;
      valueMap.set(key, id);
      values.push({ valid: validBit, mask: mask.slice() });
    }
    return id;
  };
  const EMPTY_ID = internValue(0, new Array(cw).fill(0));

  const voxelValueId = (i: number, j: number, k: number): number => {
    const li = i + nx * (j + ny * k);
    const validBit = (valid[li >> 5] >>> (li & 31)) & 1;
    if (validBit === 0) return EMPTY_ID; // invalid voxels carry an all-zero mask
    const mask: number[] = new Array(cw);
    for (let w = 0; w < cw; w++) mask[w] = vis[li * cw + w] >>> 0;
    return internValue(1, mask);
  };

  // --- bottom-up merge via top-down recursion with padding prune ------------
  const build = (x: number, y: number, z: number, size: number): TreeNode => {
    if (x >= nx || y >= ny || z >= nz) {
      return { leaf: true, valueId: EMPTY_ID }; // fully outside chunk extent
    }
    if (size === 1) {
      return { leaf: true, valueId: voxelValueId(x, y, z) };
    }
    const half = size >> 1;
    const children: TreeNode[] = new Array(8);
    let allLeaf = true;
    for (let o = 0; o < 8; o++) {
      const cx = x + (o & 1 ? half : 0);
      const cy = y + (o & 2 ? half : 0);
      const cz = z + (o & 4 ? half : 0);
      const child = build(cx, cy, cz, half);
      children[o] = child;
      if (!child.leaf) allLeaf = false;
    }
    if (allLeaf) {
      const id0 = children[0].valueId;
      let uniform = true;
      for (let o = 1; o < 8; o++) if (children[o].valueId !== id0) { uniform = false; break; }
      if (uniform) return { leaf: true, valueId: id0 };
    }
    return { leaf: false, valueId: -1, children };
  };

  const root = build(0, 0, 0, ROOT_SIZE);

  // --- flatten (DFS, 8 children contiguous per internal node) ---------------
  const nodeChild: number[] = [];
  const nodeKeyId: number[] = []; // valueId per leaf (patched into nodeKey below)
  const nodeValid: number[] = [];

  const pushNode = (): number => {
    const idx = nodeChild.length;
    nodeChild.push(0);
    nodeKeyId.push(0);
    nodeValid.push(0);
    return idx;
  };
  const writeFields = (idx: number, node: TreeNode) => {
    if (node.leaf) {
      nodeChild[idx] = LEAF;
      nodeKeyId[idx] = node.valueId;
      nodeValid[idx] = values[node.valueId].valid;
    } else {
      nodeChild[idx] = 0; // patched in setSubtree
      nodeKeyId[idx] = 0;
      nodeValid[idx] = 0;
    }
  };
  const setSubtree = (slot: number, node: TreeNode) => {
    const base = nodeChild.length;
    for (let o = 0; o < 8; o++) pushNode();
    nodeChild[slot] = base;
    for (let o = 0; o < 8; o++) writeFields(base + o, node.children![o]);
    for (let o = 0; o < 8; o++) {
      const c = node.children![o];
      if (!c.leaf) setSubtree(base + o, c);
    }
  };

  const rootIdx = pushNode();
  writeFields(rootIdx, root);
  if (!root.leaf) setSubtree(rootIdx, root);

  const nodeCount = nodeChild.length;

  // --- palette + nodeKey ----------------------------------------------------
  const usePalette = cw > 1;
  const nodeKey = new Uint32Array(nodeCount);
  let palette: Uint32Array | undefined;

  if (!usePalette) {
    for (let i = 0; i < nodeCount; i++) {
      nodeKey[i] = nodeChild[i] === LEAF ? (values[nodeKeyId[i]].mask[0] >>> 0) : 0;
    }
  } else {
    // Deduplicate mask tuples (validity is stored separately in nodeValid).
    const palMap = new Map<string, number>();
    const palList: number[][] = [];
    const palIndexOf = (mask: number[]): number => {
      const key = mask.join(',');
      let id = palMap.get(key);
      if (id === undefined) {
        id = palList.length;
        palMap.set(key, id);
        palList.push(mask);
      }
      return id;
    };
    for (let i = 0; i < nodeCount; i++) {
      if (nodeChild[i] === LEAF) nodeKey[i] = palIndexOf(values[nodeKeyId[i]].mask);
      else nodeKey[i] = 0;
    }
    palette = new Uint32Array(palList.length * cw);
    for (let p = 0; p < palList.length; p++) {
      for (let w = 0; w < cw; w++) palette[p * cw + w] = palList[p][w] >>> 0;
    }
  }

  const svo: SvoChunk = {
    chunkId,
    rootSize: ROOT_SIZE,
    depth: DEPTH,
    dims: [nx, ny, nz],
    camWords: cw,
    mode: 1,
    nodeChild: Uint32Array.from(nodeChild),
    nodeKey,
    nodeValid: Uint8Array.from(nodeValid),
    palette,
  };

  // --- fallback: keep dense if the tree is not smaller (§9.5) ---------------
  const svoBytes = nodeCount * 9 + (palette ? palette.byteLength : 0);
  const denseBytes = vis.byteLength + valid.byteLength;
  if (svoBytes >= denseBytes) return null;

  return svo;
}

// ---------------------------------------------------------------------------
// VoxelAccessor
// ---------------------------------------------------------------------------

export interface VoxelAccessor {
  getMask(i: number, j: number, k: number): number; // visibility word 0
  getMaskWord(i: number, j: number, k: number, word: number): number;
  isValid(i: number, j: number, k: number): boolean;
  forEachLeaf(
    cb: (min: Vec3, size: number, mask: number, valid: boolean) => void,
    maxDepth?: number,
  ): void;
}

export function svoAccessor(svo: SvoChunk): VoxelAccessor {
  const { nodeChild, nodeKey, nodeValid, palette, camWords, depth, dims } = svo;

  const descend = (i: number, j: number, k: number): number => {
    let node = 0;
    let level = depth - 1;
    while (nodeChild[node] !== LEAF) {
      const octant =
        ((i >> level) & 1) |
        (((j >> level) & 1) << 1) |
        (((k >> level) & 1) << 2);
      node = nodeChild[node] + octant;
      level--;
    }
    return node;
  };

  const maskWordAt = (node: number, word: number): number => {
    if (!palette) return word === 0 ? nodeKey[node] : 0;
    return palette[nodeKey[node] * camWords + word] >>> 0;
  };

  return {
    getMask(i, j, k) {
      checkBounds(i, j, k, dims);
      return maskWordAt(descend(i, j, k), 0);
    },
    getMaskWord(i, j, k, word) {
      checkBounds(i, j, k, dims);
      return maskWordAt(descend(i, j, k), word);
    },
    isValid(i, j, k) {
      checkBounds(i, j, k, dims);
      return nodeValid[descend(i, j, k)] === 1;
    },
    forEachLeaf(cb, maxDepth) {
      const [nx, ny, nz] = dims;
      const walk = (node: number, x: number, y: number, z: number, level: number) => {
        const size = 1 << (level + 1); // voxels covered per axis at this node
        if (x >= nx || y >= ny || z >= nz) return; // padded region — skip entirely
        const isLeaf = nodeChild[node] === LEAF;
        const atMaxDepth = maxDepth !== undefined && depth - 1 - level >= maxDepth;
        if (isLeaf || atMaxDepth) {
          let mask: number;
          let valid: boolean;
          if (isLeaf) {
            mask = maskWordAt(node, 0);
            valid = nodeValid[node] === 1;
          } else {
            const maj = majorityLeaf(svo, node);
            mask = maj.mask;
            valid = maj.valid;
          }
          cb([x, y, z], size, mask, valid);
          return;
        }
        const half = size >> 1;
        for (let o = 0; o < 8; o++) {
          const cx = x + (o & 1 ? half : 0);
          const cy = y + (o & 2 ? half : 0);
          const cz = z + (o & 4 ? half : 0);
          walk(nodeChild[node] + o, cx, cy, cz, level - 1);
        }
      };
      walk(0, 0, 0, 0, depth - 1);
    },
  };
}

/** Majority (by covered-voxel weight) leaf key of a subtree, for LOD approximation. */
function majorityLeaf(svo: SvoChunk, root: number): { mask: number; valid: boolean } {
  const { nodeChild, nodeValid, camWords, palette, nodeKey } = svo;
  const counts = new Map<string, { w: number; mask: number; valid: boolean }>();
  const walk = (node: number, weight: number) => {
    if (nodeChild[node] === LEAF) {
      const mask = palette ? palette[nodeKey[node] * camWords] >>> 0 : nodeKey[node];
      const valid = nodeValid[node] === 1;
      const key = mask + ':' + (valid ? 1 : 0);
      const e = counts.get(key);
      if (e) e.w += weight;
      else counts.set(key, { w: weight, mask, valid });
    } else {
      for (let o = 0; o < 8; o++) walk(nodeChild[node] + o, weight >> 3);
    }
  };
  walk(root, 1 << 24);
  let best = { w: -1, mask: 0, valid: false };
  for (const e of counts.values()) if (e.w > best.w) best = e;
  return { mask: best.mask, valid: best.valid };
}

function checkBounds(i: number, j: number, k: number, dims: Vec3): void {
  if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) {
    throw new RangeError(`voxel (${i},${j},${k}) out of chunk bounds ${dims.join('×')}`);
  }
}
