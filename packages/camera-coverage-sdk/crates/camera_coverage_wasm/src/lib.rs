//! Camera-coverage compute kernels (§4, §6.2, §9.5, §10), compiled to
//! `wasm32-unknown-unknown` with a raw pointer ABI (no wasm-bindgen).
//!
//! Memory model: JS allocates input buffers with [`alloc`], writes data into
//! WASM linear memory, and calls a kernel. Each kernel allocates its output
//! buffers with the same allocator and returns a pointer to a small u32 *header*
//! describing (ptr,len) of every output plus scalar results. JS reads the
//! header, copies the outputs into JS typed arrays, then frees every buffer
//! (and the header) with [`dealloc`]. All buffers are 4-byte aligned so JS can
//! view them as Uint32Array / Float32Array directly.

use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};
use std::collections::HashMap;

const ALIGN: usize = 4;

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let layout = Layout::from_size_align(size.max(1), ALIGN).unwrap();
    unsafe { sys_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    let layout = Layout::from_size_align(size.max(1), ALIGN).unwrap();
    unsafe { sys_dealloc(ptr, layout) }
}

// --- ABI helpers -----------------------------------------------------------

unsafe fn read_f32(ptr: *const f32, len: usize) -> &'static [f32] {
    std::slice::from_raw_parts(ptr, len)
}
unsafe fn read_u32(ptr: *const u32, len: usize) -> &'static [u32] {
    std::slice::from_raw_parts(ptr, len)
}

/// Copy a byte slice into a freshly allocated WASM buffer; return (ptr, len).
fn out_bytes(bytes: &[u8]) -> (u32, u32) {
    let len = bytes.len();
    let p = alloc(len);
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, len) };
    (p as u32, len as u32)
}
fn out_u32(v: &[u32]) -> (u32, u32) {
    let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) };
    out_bytes(bytes)
}
fn out_f32(v: &[f32]) -> (u32, u32) {
    let bytes = unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) };
    out_bytes(bytes)
}
fn out_u8(v: &[u8]) -> (u32, u32) {
    out_bytes(v)
}

/// Allocate a header from u32 words and return its pointer.
fn make_header(words: &[u32]) -> *mut u32 {
    let (p, _) = out_u32(words);
    p as *mut u32
}

// ===========================================================================
// §5.1 mesh cleaning
// ===========================================================================

/// Header: [tri_ptr, tri_len_bytes, tri_count, removed,
///          aabbMinX,Y,Z (f32 bits), aabbMaxX,Y,Z (f32 bits)]  (10 words)
#[no_mangle]
pub extern "C" fn clean_mesh(
    pos_ptr: *const f32,
    pos_len: usize,
    idx_ptr: *const u32,
    idx_len: usize,
) -> *mut u32 {
    let positions = unsafe { read_f32(pos_ptr, pos_len) };
    let indices = unsafe { read_u32(idx_ptr, idx_len) };
    let tri_count = idx_len / 3;

    let mut out: Vec<f32> = Vec::with_capacity(tri_count * 9);
    let mut removed = 0u32;
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];

    for t in 0..tri_count {
        let ia = indices[t * 3] as usize * 3;
        let ib = indices[t * 3 + 1] as usize * 3;
        let ic = indices[t * 3 + 2] as usize * 3;
        let a = [positions[ia] as f64, positions[ia + 1] as f64, positions[ia + 2] as f64];
        let b = [positions[ib] as f64, positions[ib + 1] as f64, positions[ib + 2] as f64];
        let c = [positions[ic] as f64, positions[ic + 1] as f64, positions[ic + 2] as f64];

        if !finite3(&a) || !finite3(&b) || !finite3(&c) {
            removed += 1;
            continue;
        }
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cr = cross(&ab, &ac);
        let area = 0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
        if area < 1e-10 {
            removed += 1;
            continue;
        }
        for v in [a, b, c] {
            out.push(v[0] as f32);
            out.push(v[1] as f32);
            out.push(v[2] as f32);
            for d in 0..3 {
                if v[d] < mn[d] { mn[d] = v[d]; }
                if v[d] > mx[d] { mx[d] = v[d]; }
            }
        }
    }

    let kept = (out.len() / 9) as u32;
    if kept == 0 {
        mn = [0.0; 3];
        mx = [0.0; 3];
    }
    let (tp, tl) = out_f32(&out);
    make_header(&[
        tp, tl, kept, removed,
        (mn[0] as f32).to_bits(), (mn[1] as f32).to_bits(), (mn[2] as f32).to_bits(),
        (mx[0] as f32).to_bits(), (mx[1] as f32).to_bits(), (mx[2] as f32).to_bits(),
    ])
}

// ===========================================================================
// §10 BVH (binned SAH, threaded stackless node layout)
// ===========================================================================

const MAX_LEAF: usize = 8;
const BINS: usize = 16;
const BVH_INVALID: u32 = 0xffff_ffff;

struct TN {
    min: [f64; 3],
    max: [f64; 3],
    leaf: bool,
    start: usize,
    count: usize,
    left: Option<Box<TN>>,
    right: Option<Box<TN>>,
}

struct Builder {
    tri_min: Vec<f64>,
    tri_max: Vec<f64>,
    cent: Vec<f64>,
    order: Vec<u32>,
}

impl Builder {
    fn range_bounds(&self, start: usize, count: usize) -> ([f64; 3], [f64; 3]) {
        let mut mn = [f64::INFINITY; 3];
        let mut mx = [f64::NEG_INFINITY; 3];
        for i in 0..count {
            let t = self.order[start + i] as usize;
            for d in 0..3 {
                if self.tri_min[t * 3 + d] < mn[d] { mn[d] = self.tri_min[t * 3 + d]; }
                if self.tri_max[t * 3 + d] > mx[d] { mx[d] = self.tri_max[t * 3 + d]; }
            }
        }
        (mn, mx)
    }

    fn centroid_bounds(&self, start: usize, count: usize) -> ([f64; 3], [f64; 3]) {
        let mut mn = [f64::INFINITY; 3];
        let mut mx = [f64::NEG_INFINITY; 3];
        for i in 0..count {
            let t = self.order[start + i] as usize;
            for d in 0..3 {
                let c = self.cent[t * 3 + d];
                if c < mn[d] { mn[d] = c; }
                if c > mx[d] { mx[d] = c; }
            }
        }
        (mn, mx)
    }

    fn split_median(&mut self, axis: usize, start: usize, count: usize) -> (usize, usize) {
        let slice = &mut self.order[start..start + count];
        slice.sort_by(|&a, &b| {
            self.cent[a as usize * 3 + axis]
                .partial_cmp(&self.cent[b as usize * 3 + axis])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let left_n = count >> 1;
        (left_n, count - left_n)
    }

    fn build(&mut self, start: usize, count: usize) -> TN {
        let (min, max) = self.range_bounds(start, count);
        if count <= MAX_LEAF {
            return TN { min, max, leaf: true, start, count, left: None, right: None };
        }
        let (cbmin, cbmax) = self.centroid_bounds(start, count);
        let mut axis = 0usize;
        let mut ext = cbmax[0] - cbmin[0];
        for d in 1..3 {
            let e = cbmax[d] - cbmin[d];
            if e > ext { ext = e; axis = d; }
        }
        if ext < 1e-12 {
            return TN { min, max, leaf: true, start, count, left: None, right: None };
        }

        let mut bin_count = [0i32; BINS];
        let mut bin_min = [[f64::INFINITY; 3]; BINS];
        let mut bin_max = [[f64::NEG_INFINITY; 3]; BINS];
        let k = (BINS as f64 * (1.0 - 1e-6)) / ext;
        let bin_of = |cent: &Vec<f64>, t: usize| -> usize {
            let b = ((cent[t * 3 + axis] - cbmin[axis]) * k) as i64;
            b.clamp(0, BINS as i64 - 1) as usize
        };

        for i in 0..count {
            let t = self.order[start + i] as usize;
            let bi = bin_of(&self.cent, t);
            bin_count[bi] += 1;
            for d in 0..3 {
                if self.tri_min[t * 3 + d] < bin_min[bi][d] { bin_min[bi][d] = self.tri_min[t * 3 + d]; }
                if self.tri_max[t * 3 + d] > bin_max[bi][d] { bin_max[bi][d] = self.tri_max[t * 3 + d]; }
            }
        }

        let mut left_area = [0f64; BINS];
        let mut left_count = [0i32; BINS];
        {
            let mut cnt = 0i32;
            let mut bmin = [f64::INFINITY; 3];
            let mut bmax = [f64::NEG_INFINITY; 3];
            for i in 0..BINS {
                if bin_count[i] > 0 {
                    cnt += bin_count[i];
                    for d in 0..3 {
                        bmin[d] = bmin[d].min(bin_min[i][d]);
                        bmax[d] = bmax[d].max(bin_max[i][d]);
                    }
                }
                left_count[i] = cnt;
                left_area[i] = if cnt > 0 { surface_area(&bmin, &bmax) } else { 0.0 };
            }
        }

        let mut best_cost = f64::INFINITY;
        let mut best_split: i32 = -1;
        {
            let mut cnt = 0i32;
            let mut bmin = [f64::INFINITY; 3];
            let mut bmax = [f64::NEG_INFINITY; 3];
            let mut i = BINS - 1;
            while i >= 1 {
                if bin_count[i] > 0 {
                    cnt += bin_count[i];
                    for d in 0..3 {
                        bmin[d] = bmin[d].min(bin_min[i][d]);
                        bmax[d] = bmax[d].max(bin_max[i][d]);
                    }
                }
                let r_area = if cnt > 0 { surface_area(&bmin, &bmax) } else { 0.0 };
                let lc = left_count[i - 1];
                let rc = cnt;
                if lc != 0 && rc != 0 {
                    let cost = left_area[i - 1] * lc as f64 + r_area * rc as f64;
                    if cost < best_cost { best_cost = cost; best_split = i as i32; }
                }
                i -= 1;
            }
        }

        let parent_area = surface_area(&min, &max);
        let leaf_cost = count as f64 * parent_area;
        if best_split < 0 || best_cost >= leaf_cost {
            let (ln, rn) = self.split_median(axis, start, count);
            return self.make_internal(min, max, start, ln, rn);
        }

        // Partition order[start..start+count) by bin < best_split.
        let bs = best_split as usize;
        let mut lo = start;
        let mut hi = start + count - 1;
        while lo <= hi {
            let t = self.order[lo] as usize;
            if bin_of(&self.cent, t) < bs {
                lo += 1;
            } else {
                self.order.swap(lo, hi);
                if hi == 0 { break; }
                hi -= 1;
            }
        }
        let left_n = lo - start;
        if left_n == 0 || left_n == count {
            let (ln, rn) = self.split_median(axis, start, count);
            return self.make_internal(min, max, start, ln, rn);
        }
        self.make_internal(min, max, start, left_n, count - left_n)
    }

    fn make_internal(
        &mut self,
        min: [f64; 3],
        max: [f64; 3],
        start: usize,
        left_n: usize,
        right_n: usize,
    ) -> TN {
        let left = self.build(start, left_n);
        let right = self.build(start + left_n, right_n);
        TN {
            min,
            max,
            leaf: false,
            start,
            count: 0,
            left: Some(Box::new(left)),
            right: Some(Box::new(right)),
        }
    }
}

/// Header: [nodes_ptr, nodes_len_bytes, tri_ptr, tri_len_bytes,
///          node_count, triangle_count]  (6 words)
#[no_mangle]
pub extern "C" fn build_bvh(tri_ptr: *const f32, tri_len: usize) -> *mut u32 {
    let verts = unsafe { read_f32(tri_ptr, tri_len) };
    let n = tri_len / 9;

    let mut tri_min = vec![0f64; n * 3];
    let mut tri_max = vec![0f64; n * 3];
    let mut cent = vec![0f64; n * 3];
    let mut order = vec![0u32; n];
    for t in 0..n {
        let b = t * 9;
        for d in 0..3 {
            let a0 = verts[b + d] as f64;
            let a1 = verts[b + 3 + d] as f64;
            let a2 = verts[b + 6 + d] as f64;
            let mn = a0.min(a1).min(a2);
            let mx = a0.max(a1).max(a2);
            tri_min[t * 3 + d] = mn;
            tri_max[t * 3 + d] = mx;
            cent[t * 3 + d] = (mn + mx) * 0.5;
        }
        order[t] = t as u32;
    }

    let mut builder = Builder { tri_min, tri_max, cent, order };
    let root = if n == 0 {
        TN { min: [0.0; 3], max: [0.0; 3], leaf: true, start: 0, count: 0, left: None, right: None }
    } else {
        builder.build(0, n)
    };

    // Reorder triangle data into leaf order (12 f32 per tri).
    let mut tri_data = vec![0f32; n * 12];
    for i in 0..n {
        let src = builder.order[i] as usize * 9;
        let dst = i * 12;
        for v in 0..3 {
            tri_data[dst + v * 4] = verts[src + v * 3];
            tri_data[dst + v * 4 + 1] = verts[src + v * 3 + 1];
            tri_data[dst + v * 4 + 2] = verts[src + v * 3 + 2];
            tri_data[dst + v * 4 + 3] = 0.0;
        }
    }

    // Flatten: DFS pre-order, compute subtree sizes, escape = idx + size.
    let mut nodes: Vec<&TN> = Vec::new();
    let mut sizes: Vec<u32> = Vec::new();
    fn visit<'a>(node: &'a TN, nodes: &mut Vec<&'a TN>, sizes: &mut Vec<u32>) -> u32 {
        let idx = nodes.len();
        nodes.push(node);
        sizes.push(0);
        let mut size = 1u32;
        if !node.leaf {
            size += visit(node.left.as_ref().unwrap(), nodes, sizes);
            size += visit(node.right.as_ref().unwrap(), nodes, sizes);
        }
        sizes[idx] = size;
        size
    }
    visit(&root, &mut nodes, &mut sizes);

    let count = nodes.len();
    let mut words = vec![0u32; count * 8];
    for i in 0..count {
        let node = nodes[i];
        let base = i * 8;
        words[base] = (node.min[0] as f32).to_bits();
        words[base + 1] = (node.min[1] as f32).to_bits();
        words[base + 2] = (node.min[2] as f32).to_bits();
        words[base + 4] = (node.max[0] as f32).to_bits();
        words[base + 5] = (node.max[1] as f32).to_bits();
        words[base + 6] = (node.max[2] as f32).to_bits();
        let escape = i as u32 + sizes[i];
        words[base + 3] = if escape >= count as u32 { BVH_INVALID } else { escape };
        words[base + 7] = if node.leaf {
            if node.count == 0 { 0 } else { ((node.count as u32) << 28) | (node.start as u32 & 0x0fff_ffff) }
        } else {
            0
        };
    }
    // Empty scene: inverted AABB so rayAabb never hits; immediate INVALID miss.
    if count == 1 && root.leaf && root.count == 0 {
        words[0] = (1e30f32).to_bits();
        words[1] = (1e30f32).to_bits();
        words[2] = (1e30f32).to_bits();
        words[4] = (-1e30f32).to_bits();
        words[5] = (-1e30f32).to_bits();
        words[6] = (-1e30f32).to_bits();
        words[3] = BVH_INVALID;
        words[7] = 0;
    }

    let (np, nl) = out_u32(&words);
    let (tp, tl) = out_f32(&tri_data);
    make_header(&[np, nl, tp, tl, count as u32, n as u32])
}

fn surface_area(min: &[f64; 3], max: &[f64; 3]) -> f64 {
    let dx = (max[0] - min[0]).max(0.0);
    let dy = (max[1] - min[1]).max(0.0);
    let dz = (max[2] - min[2]).max(0.0);
    2.0 * (dx * dy + dy * dz + dz * dx)
}

// ===========================================================================
// §6.2 occupancy: triangle-AABB SAT voxelization + flood-fill SOLID
// ===========================================================================

const EMPTY: u8 = 0;
const MIXED: u8 = 1;
const SOLID: u8 = 2;

/// Header: [cells_ptr, cells_len, solid_count, mixed_count]  (4 words)
#[no_mangle]
pub extern "C" fn compute_occupancy(
    nx: usize,
    ny: usize,
    nz: usize,
    wmin_x: f32,
    wmin_y: f32,
    wmin_z: f32,
    voxel_size: f32,
    tri_ptr: *const f32,
    tri_len: usize,
    solid_detection: u32,
) -> *mut u32 {
    let verts = unsafe { read_f32(tri_ptr, tri_len) };
    let tri_count = tri_len / 9;
    let total = nx * ny * nz;
    let mut cells = vec![EMPTY; total];
    let vs = voxel_size as f64;
    let origin = [wmin_x as f64, wmin_y as f64, wmin_z as f64];
    let half = [vs * 0.5, vs * 0.5, vs * 0.5];
    let idx = |i: usize, j: usize, k: usize| i + nx * (j + ny * k);

    let mut mixed_count = 0u32;
    for t in 0..tri_count {
        let b = t * 9;
        let a = [verts[b] as f64, verts[b + 1] as f64, verts[b + 2] as f64];
        let bb = [verts[b + 3] as f64, verts[b + 4] as f64, verts[b + 5] as f64];
        let c = [verts[b + 6] as f64, verts[b + 7] as f64, verts[b + 8] as f64];

        let lo_i = clamp_i(((a[0].min(bb[0]).min(c[0]) - origin[0]) / vs).floor(), nx);
        let hi_i = clamp_i(((a[0].max(bb[0]).max(c[0]) - origin[0]) / vs).floor(), nx);
        let lo_j = clamp_i(((a[1].min(bb[1]).min(c[1]) - origin[1]) / vs).floor(), ny);
        let hi_j = clamp_i(((a[1].max(bb[1]).max(c[1]) - origin[1]) / vs).floor(), ny);
        let lo_k = clamp_i(((a[2].min(bb[2]).min(c[2]) - origin[2]) / vs).floor(), nz);
        let hi_k = clamp_i(((a[2].max(bb[2]).max(c[2]) - origin[2]) / vs).floor(), nz);

        for k in lo_k..=hi_k {
            for j in lo_j..=hi_j {
                for i in lo_i..=hi_i {
                    let ci = idx(i, j, k);
                    if cells[ci] == MIXED { continue; }
                    let center = [
                        origin[0] + (i as f64 + 0.5) * vs,
                        origin[1] + (j as f64 + 0.5) * vs,
                        origin[2] + (k as f64 + 0.5) * vs,
                    ];
                    if tri_overlaps_aabb(&a, &bb, &c, &center, &half) {
                        cells[ci] = MIXED;
                        mixed_count += 1;
                    }
                }
            }
        }
    }

    let mut solid_count = 0u32;
    if solid_detection != 0 {
        solid_count = flood_fill_solid(&mut cells, nx, ny, nz);
    }

    let (cp, cl) = out_u8(&cells);
    make_header(&[cp, cl, solid_count, mixed_count])
}

fn flood_fill_solid(cells: &mut [u8], nx: usize, ny: usize, nz: usize) -> u32 {
    let total = nx * ny * nz;
    let mut reached = vec![0u8; total];
    let idx = |i: usize, j: usize, k: usize| i + nx * (j + ny * k);
    let mut stack: Vec<usize> = Vec::new();

    let push = |i: usize, j: usize, k: usize, cells: &[u8], reached: &mut [u8], stack: &mut Vec<usize>| {
        let c = idx(i, j, k);
        if cells[c] == EMPTY && reached[c] == 0 {
            reached[c] = 1;
            stack.push(c);
        }
    };

    for j in 0..ny {
        for i in 0..nx {
            push(i, j, 0, cells, &mut reached, &mut stack);
            push(i, j, nz - 1, cells, &mut reached, &mut stack);
        }
    }
    for k in 0..nz {
        for i in 0..nx {
            push(i, 0, k, cells, &mut reached, &mut stack);
            push(i, ny - 1, k, cells, &mut reached, &mut stack);
        }
    }
    for k in 0..nz {
        for j in 0..ny {
            push(0, j, k, cells, &mut reached, &mut stack);
            push(nx - 1, j, k, cells, &mut reached, &mut stack);
        }
    }

    while let Some(c) = stack.pop() {
        let i = c % nx;
        let j = (c / nx) % ny;
        let k = c / (nx * ny);
        if i > 0 { push(i - 1, j, k, cells, &mut reached, &mut stack); }
        if i < nx - 1 { push(i + 1, j, k, cells, &mut reached, &mut stack); }
        if j > 0 { push(i, j - 1, k, cells, &mut reached, &mut stack); }
        if j < ny - 1 { push(i, j + 1, k, cells, &mut reached, &mut stack); }
        if k > 0 { push(i, j, k - 1, cells, &mut reached, &mut stack); }
        if k < nz - 1 { push(i, j, k + 1, cells, &mut reached, &mut stack); }
    }

    let mut solid = 0u32;
    for c in 0..total {
        if cells[c] == EMPTY && reached[c] == 0 {
            cells[c] = SOLID;
            solid += 1;
        }
    }
    solid
}

fn tri_overlaps_aabb(a: &[f64; 3], b: &[f64; 3], c: &[f64; 3], center: &[f64; 3], h: &[f64; 3]) -> bool {
    let v0 = [a[0] - center[0], a[1] - center[1], a[2] - center[2]];
    let v1 = [b[0] - center[0], b[1] - center[1], b[2] - center[2]];
    let v2 = [c[0] - center[0], c[1] - center[1], c[2] - center[2]];
    let e0 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let e1 = [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]];
    let e2 = [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]];

    for e in [e0, e1, e2] {
        if axis_test(0.0, -e[2], e[1], &v0, &v1, &v2, h) { return false; }
        if axis_test(e[2], 0.0, -e[0], &v0, &v1, &v2, h) { return false; }
        if axis_test(-e[1], e[0], 0.0, &v0, &v1, &v2, h) { return false; }
    }
    for d in 0..3 {
        let mn = v0[d].min(v1[d]).min(v2[d]);
        let mx = v0[d].max(v1[d]).max(v2[d]);
        if mn > h[d] || mx < -h[d] { return false; }
    }
    let n = cross(&e0, &e1);
    let d0 = n[0] * v0[0] + n[1] * v0[1] + n[2] * v0[2];
    let r = n[0].abs() * h[0] + n[1].abs() * h[1] + n[2].abs() * h[2];
    if d0 > r || d0 < -r { return false; }
    true
}

fn axis_test(ax: f64, ay: f64, az: f64, v0: &[f64; 3], v1: &[f64; 3], v2: &[f64; 3], h: &[f64; 3]) -> bool {
    if ax == 0.0 && ay == 0.0 && az == 0.0 { return false; }
    let p0 = ax * v0[0] + ay * v0[1] + az * v0[2];
    let p1 = ax * v1[0] + ay * v1[1] + az * v1[2];
    let p2 = ax * v2[0] + ay * v2[1] + az * v2[2];
    let mn = p0.min(p1).min(p2);
    let mx = p0.max(p1).max(p2);
    let r = ax.abs() * h[0] + ay.abs() * h[1] + az.abs() * h[2];
    mn > r || mx < -r
}

// ===========================================================================
// §9.5 SVO construction
// ===========================================================================

const LEAF: u32 = 0xffff_ffff;
const ROOT_SIZE: usize = 256;
const _DEPTH: u32 = 8;

struct SNode {
    leaf: bool,
    value_id: u32,
    children: Option<Box<[SNode; 8]>>,
}

struct Interner {
    map: HashMap<(u8, Vec<u32>), u32>,
    values: Vec<(u8, Vec<u32>)>,
}
impl Interner {
    fn intern(&mut self, valid: u8, mask: Vec<u32>) -> u32 {
        let key = (valid, mask);
        if let Some(&id) = self.map.get(&key) {
            return id;
        }
        let id = self.values.len() as u32;
        self.values.push(key.clone());
        self.map.insert(key, id);
        id
    }
}

#[allow(clippy::too_many_arguments)]
fn svo_build_node(
    x: usize, y: usize, z: usize, size: usize,
    nx: usize, ny: usize, nz: usize, cw: usize, empty_id: u32,
    vis: &[u32], validity: &[u32], it: &mut Interner,
) -> SNode {
    if x >= nx || y >= ny || z >= nz {
        return SNode { leaf: true, value_id: empty_id, children: None };
    }
    if size == 1 {
        let li = x + nx * (y + ny * z);
        let valid_bit = ((validity[li >> 5] >> (li & 31)) & 1) as u8;
        let vid = if valid_bit == 0 {
            empty_id
        } else {
            let mut mask = vec![0u32; cw];
            for w in 0..cw {
                mask[w] = vis[li * cw + w];
            }
            it.intern(1, mask)
        };
        return SNode { leaf: true, value_id: vid, children: None };
    }
    let half = size >> 1;
    let mut children: Vec<SNode> = Vec::with_capacity(8);
    let mut all_leaf = true;
    for o in 0..8 {
        let cx = x + if o & 1 != 0 { half } else { 0 };
        let cy = y + if o & 2 != 0 { half } else { 0 };
        let cz = z + if o & 4 != 0 { half } else { 0 };
        let child = svo_build_node(cx, cy, cz, half, nx, ny, nz, cw, empty_id, vis, validity, it);
        if !child.leaf { all_leaf = false; }
        children.push(child);
    }
    if all_leaf {
        let id0 = children[0].value_id;
        if children.iter().all(|c| c.value_id == id0) {
            return SNode { leaf: true, value_id: id0, children: None };
        }
    }
    let arr: Box<[SNode; 8]> = Box::new(children.try_into().unwrap_or_else(|_| unreachable!()));
    SNode { leaf: false, value_id: u32::MAX, children: Some(arr) }
}

/// Header: [flag(1=svo,0=dense),
///          child_ptr, child_len_bytes, key_ptr, key_len_bytes,
///          valid_ptr, valid_len_bytes, palette_ptr, palette_len_bytes,
///          node_count]  (10 words)
#[no_mangle]
pub extern "C" fn build_svo(
    nx: usize,
    ny: usize,
    nz: usize,
    cam_words: usize,
    vis_ptr: *const u32,
    vis_len: usize,
    val_ptr: *const u32,
    val_len: usize,
) -> *mut u32 {
    let vis = unsafe { read_u32(vis_ptr, vis_len) };
    let validity = unsafe { read_u32(val_ptr, val_len) };
    let cw = cam_words;

    let mut interner = Interner { map: HashMap::new(), values: Vec::new() };
    let empty_id = interner.intern(0, vec![0u32; cw]);

    let root = svo_build_node(0, 0, 0, ROOT_SIZE, nx, ny, nz, cw, empty_id, vis, validity, &mut interner);
    let values = interner.values;

    // Flatten DFS with 8 contiguous children per internal node.
    let mut node_child: Vec<u32> = Vec::new();
    let mut node_key_id: Vec<u32> = Vec::new();
    let mut node_valid: Vec<u8> = Vec::new();

    fn push_node(nc: &mut Vec<u32>, nk: &mut Vec<u32>, nv: &mut Vec<u8>) -> usize {
        let idx = nc.len();
        nc.push(0);
        nk.push(0);
        nv.push(0);
        idx
    }
    fn write_fields(idx: usize, node: &SNode, values: &[(u8, Vec<u32>)], nc: &mut [u32], nk: &mut [u32], nv: &mut [u8]) {
        if node.leaf {
            nc[idx] = LEAF;
            nk[idx] = node.value_id;
            nv[idx] = values[node.value_id as usize].0;
        } else {
            nc[idx] = 0;
            nk[idx] = 0;
            nv[idx] = 0;
        }
    }
    fn set_subtree(slot: usize, node: &SNode, values: &[(u8, Vec<u32>)], nc: &mut Vec<u32>, nk: &mut Vec<u32>, nv: &mut Vec<u8>) {
        let base = nc.len();
        for _ in 0..8 { push_node(nc, nk, nv); }
        nc[slot] = base as u32;
        let children = node.children.as_ref().unwrap();
        for o in 0..8 {
            write_fields(base + o, &children[o], values, nc, nk, nv);
        }
        for o in 0..8 {
            if !children[o].leaf {
                set_subtree(base + o, &children[o], values, nc, nk, nv);
            }
        }
    }

    let root_idx = push_node(&mut node_child, &mut node_key_id, &mut node_valid);
    write_fields(root_idx, &root, &values, &mut node_child, &mut node_key_id, &mut node_valid);
    if !root.leaf {
        set_subtree(root_idx, &root, &values, &mut node_child, &mut node_key_id, &mut node_valid);
    }

    let node_count = node_child.len();

    // Palette + nodeKey.
    let mut node_key = vec![0u32; node_count];
    let mut palette: Option<Vec<u32>> = None;
    if cw <= 1 {
        for i in 0..node_count {
            node_key[i] = if node_child[i] == LEAF { values[node_key_id[i] as usize].1[0] } else { 0 };
        }
    } else {
        let mut pal_map: HashMap<Vec<u32>, u32> = HashMap::new();
        let mut pal_list: Vec<Vec<u32>> = Vec::new();
        for i in 0..node_count {
            if node_child[i] == LEAF {
                let mask = &values[node_key_id[i] as usize].1;
                let id = if let Some(&id) = pal_map.get(mask) {
                    id
                } else {
                    let id = pal_list.len() as u32;
                    pal_map.insert(mask.clone(), id);
                    pal_list.push(mask.clone());
                    id
                };
                node_key[i] = id;
            }
        }
        let mut pal = vec![0u32; pal_list.len() * cw];
        for p in 0..pal_list.len() {
            for w in 0..cw {
                pal[p * cw + w] = pal_list[p][w];
            }
        }
        palette = Some(pal);
    }

    // Fallback: keep dense if the tree is not smaller (§9.5).
    let palette_bytes = palette.as_ref().map(|p| p.len() * 4).unwrap_or(0);
    let svo_bytes = node_count * 9 + palette_bytes;
    let dense_bytes = vis_len * 4 + val_len * 4;
    if svo_bytes >= dense_bytes {
        return make_header(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    let (cp, cl) = out_u32(&node_child);
    let (kp, kl) = out_u32(&node_key);
    let (vp, vl) = out_u8(&node_valid);
    let (pp, pl) = match &palette {
        Some(p) => out_u32(p),
        None => (0, 0),
    };
    make_header(&[1, cp, cl, kp, kl, vp, vl, pp, pl, node_count as u32])
}

// --- small vector helpers --------------------------------------------------

fn cross(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn finite3(v: &[f64; 3]) -> bool {
    v[0].is_finite() && v[1].is_finite() && v[2].is_finite()
}
fn clamp_i(v: f64, n: usize) -> usize {
    if v < 0.0 { 0 } else if v as usize >= n { n - 1 } else { v as usize }
}
