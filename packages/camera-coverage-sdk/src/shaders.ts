/**
 * WGSL compute shaders for the per-chunk pipeline (§11). The algorithm mirrors
 * the CPU reference in `kernel.ts` / `compute/cpu.ts` so both backends produce
 * bit-identical visibility buffers (§18 determinism).
 *
 * `CAM_WORDS` is a pipeline-creation `override` (§7.1); nothing hard-codes 32.
 */

// Shared declarations included at the top of every pass.
const COMMON = /* wgsl */ `
override CAM_WORDS : u32 = 1u;
override WG_SIZE   : u32 = 64u;

const BVH_INVALID : u32 = 0xffffffffu;
const T_EPS   : f32 = 1e-3;
const DET_EPS : f32 = 1e-7;

struct Camera {
  viewProj : mat4x4<f32>,   // offset 0
  position : vec4<f32>,     // offset 64
  params   : vec4<f32>,     // offset 80: x=near, y=far
};

struct BvhNode {
  min  : vec3<f32>,
  miss : u32,
  max  : vec3<f32>,
  prim : u32,
};

struct ChunkInfo {
  origin      : vec4<f32>,   // xyz world min, w unused
  dims        : vec4<u32>,   // xyz voxel dims, w = voxelCount
  voxelSize   : f32,
  mode        : u32,         // 1 or 2
  threshold   : u32,
  numCameras  : u32,
  activeMask  : vec4<u32>,   // up to CAM_WORDS words (§7.2)
};

fn voxelCenter(ci: ChunkInfo, li: u32) -> vec3<f32> {
  let nx = ci.dims.x;
  let ny = ci.dims.y;
  let i = li % nx;
  let j = (li / nx) % ny;
  let k = li / (nx * ny);
  return ci.origin.xyz + (vec3<f32>(f32(i), f32(j), f32(k)) + vec3<f32>(0.5)) * ci.voxelSize;
}

fn inFrustum(vp: mat4x4<f32>, p: vec3<f32>) -> bool {
  let c = vp * vec4<f32>(p, 1.0);
  return all(abs(c.xy) <= vec2<f32>(c.w)) && c.z >= 0.0 && c.z <= c.w;
}
`;

const RAY = /* wgsl */ `
fn rayAabb(o: vec3<f32>, invD: vec3<f32>, tMin: f32, tMax: f32, lo: vec3<f32>, hi: vec3<f32>) -> bool {
  let t0 = (lo - o) * invD;
  let t1 = (hi - o) * invD;
  let tsm = min(t0, t1);
  let tbg = max(t0, t1);
  let tn = max(max(tsm.x, tsm.y), max(tsm.z, tMin));
  let tf = min(min(tbg.x, tbg.y), min(tbg.z, tMax));
  return tn <= tf;
}

fn rayTri(o: vec3<f32>, d: vec3<f32>, tMin: f32, tMax: f32, base: u32) -> bool {
  let a = vec3<f32>(triangles[base + 0u], triangles[base + 1u], triangles[base + 2u]);
  let b = vec3<f32>(triangles[base + 4u], triangles[base + 5u], triangles[base + 6u]);
  let c = vec3<f32>(triangles[base + 8u], triangles[base + 9u], triangles[base + 10u]);
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (det > -DET_EPS && det < DET_EPS) { return false; } // no backface cull
  let invDet = 1.0 / det;
  let tvec = o - a;
  let u = dot(tvec, p) * invDet;
  if (u < 0.0 || u > 1.0) { return false; }
  let q = cross(tvec, e1);
  let v = dot(d, q) * invDet;
  if (v < 0.0 || u + v > 1.0) { return false; }
  let t = dot(e2, q) * invDet;
  return t > tMin && t < tMax;
}

fn occluded(o: vec3<f32>, d: vec3<f32>, tMin: f32, tMax: f32) -> bool {
  let invD = vec3<f32>(1.0) / d;
  var node : u32 = 0u;
  loop {
    if (node == BVH_INVALID) { break; }
    let n = bvh[node];
    if (rayAabb(o, invD, tMin, tMax, n.min, n.max)) {
      if (n.prim != 0u) {
        let first = n.prim & 0x0fffffffu;
        let count = n.prim >> 28u;
        for (var t = 0u; t < count; t = t + 1u) {
          if (rayTri(o, d, tMin, tMax, (first + t) * 12u)) { return true; }
        }
        node = n.miss;
      } else {
        node = node + 1u;
      }
    } else {
      node = n.miss;
    }
  }
  return false;
}

// Visibility of a single sample point to camera c (§8).
fn sampleVisible(c: u32, p: vec3<f32>) -> bool {
  let cam = cameras[c];
  if (!inFrustum(cam.viewProj, p)) { return false; }
  let toCam = cam.position.xyz - p;
  let dist = length(toCam);
  if (dist > cam.params.y) { return false; }          // beyond far
  if (dist < 2.0 * T_EPS) { return true; }            // coincident with camera
  let dir = toCam / dist;
  return !occluded(p, dir, T_EPS, dist - T_EPS);
}
`;

export const PASS1_FRUSTUM = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> chunk : ChunkInfo;
@group(0) @binding(1) var<storage, read> cameras : array<Camera>;
@group(0) @binding(2) var<storage, read> validity : array<u32>;
@group(0) @binding(3) var<storage, read_write> candidates : array<u32>;
@group(0) @binding(4) var<storage, read_write> candMasks : array<u32>;
@group(0) @binding(5) var<storage, read_write> candidateCount : atomic<u32>;

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let li = gid.x;
  if (li >= chunk.dims.w) { return; }
  if (((validity[li >> 5u] >> (li & 31u)) & 1u) == 0u) { return; }

  let center = voxelCenter(chunk, li);

  var fmask : array<u32, 4>;
  for (var w = 0u; w < CAM_WORDS; w = w + 1u) { fmask[w] = 0u; }

  var any = false;
  for (var c = 0u; c < chunk.numCameras; c = c + 1u) {
    let w = c >> 5u;
    if (((chunk.activeMask[w] >> (c & 31u)) & 1u) == 0u) { continue; }
    // Mode 2 uses the voxel center for the coarse frustum candidate test; the
    // per-sample test in Pass 2 refines it.
    if (inFrustum(cameras[c].viewProj, center)) {
      fmask[w] = fmask[w] | (1u << (c & 31u));
      any = true;
    }
  }
  if (!any) { return; }

  let slot = atomicAdd(&candidateCount, 1u);
  candidates[slot] = li;
  for (var w = 0u; w < CAM_WORDS; w = w + 1u) {
    candMasks[slot * CAM_WORDS + w] = fmask[w];
  }
}
`;

export const PASS2_VISIBILITY = /* wgsl */ `${COMMON}${RAY}
@group(0) @binding(0) var<uniform> chunk : ChunkInfo;
@group(0) @binding(1) var<storage, read> cameras : array<Camera>;
@group(0) @binding(2) var<storage, read> bvh : array<BvhNode>;
@group(0) @binding(3) var<storage, read> triangles : array<f32>;
@group(0) @binding(4) var<storage, read> candidates : array<u32>;
@group(0) @binding(5) var<storage, read> candMasks : array<u32>;
@group(0) @binding(6) var<storage, read> candidateCount : u32;
@group(0) @binding(7) var<storage, read_write> visibility : array<u32>;
@group(0) @binding(8) var<storage, read_write> coverage : array<u32>;

const M2 = array<vec3<f32>, 8>(
  vec3<f32>(-1.0, -1.0, -1.0), vec3<f32>(1.0, -1.0, -1.0),
  vec3<f32>(-1.0,  1.0, -1.0), vec3<f32>(1.0,  1.0, -1.0),
  vec3<f32>(-1.0, -1.0,  1.0), vec3<f32>(1.0, -1.0,  1.0),
  vec3<f32>(-1.0,  1.0,  1.0), vec3<f32>(1.0,  1.0,  1.0),
);

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = gid.x;
  if (slot >= candidateCount) { return; }
  let li = candidates[slot];
  let center = voxelCenter(chunk, li);

  for (var w = 0u; w < CAM_WORDS; w = w + 1u) {
    var word = candMasks[slot * CAM_WORDS + w];
    while (word != 0u) {
      let bit = firstTrailingBit(word);
      word = word & (word - 1u);
      let c = w * 32u + bit;

      if (chunk.mode == 2u) {
        var cnt = 0u;
        for (var s = 0u; s < 8u; s = s + 1u) {
          let sp = center + 0.35 * chunk.voxelSize * M2[s];
          if (sampleVisible(c, sp)) { cnt = cnt + 1u; }
        }
        let wordsPerVoxel = 4u * CAM_WORDS;
        let cwIdx = li * wordsPerVoxel + (c >> 3u);
        let shift = 4u * (c & 7u);
        coverage[cwIdx] = (coverage[cwIdx] & ~(0xfu << shift)) | ((cnt & 0xfu) << shift);
        if (cnt >= chunk.threshold) {
          visibility[li * CAM_WORDS + w] = visibility[li * CAM_WORDS + w] | (1u << bit);
        }
      } else {
        if (sampleVisible(c, center)) {
          visibility[li * CAM_WORDS + w] = visibility[li * CAM_WORDS + w] | (1u << bit);
        }
      }
    }
  }
}
`;

export const PASS3_STATS = /* wgsl */ `${COMMON}
@group(0) @binding(0) var<uniform> chunk : ChunkInfo;
@group(0) @binding(1) var<storage, read> validity : array<u32>;
@group(0) @binding(2) var<storage, read> visibility : array<u32>;
@group(0) @binding(3) var<storage, read_write> stats : array<atomic<u32>>;
// stats layout: [0]=validCount, [1]=coveredCount, [2+c]=visibleCount[c]

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let li = gid.x;
  if (li >= chunk.dims.w) { return; }
  if (((validity[li >> 5u] >> (li & 31u)) & 1u) == 0u) { return; }

  atomicAdd(&stats[0], 1u);

  var any = false;
  for (var w = 0u; w < CAM_WORDS; w = w + 1u) {
    var word = visibility[li * CAM_WORDS + w];
    if (word != 0u) { any = true; }
    while (word != 0u) {
      let bit = firstTrailingBit(word);
      word = word & (word - 1u);
      let c = w * 32u + bit;
      atomicAdd(&stats[2u + c], 1u);
    }
  }
  if (any) { atomicAdd(&stats[1], 1u); }
}
`;
