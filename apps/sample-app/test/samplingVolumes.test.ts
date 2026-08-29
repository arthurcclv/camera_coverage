import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Quat, RegionAccum, Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  extractZonesAndVolumes,
  inVolume,
  MIN_VOLUME_SIZE_FLOOR,
  minVolumeSize,
  obbWorldAabb,
  regionsFromVolumes,
  summaryFromAccum,
  zoneLabel,
  type SamplingVolume,
  type Zone,
} from '../src/scene/samplingVolumes.ts';
import { runCameras } from '../src/scene/runCameras.ts';

const IDENTITY: Quat = [0, 0, 0, 1];
// 90° about Y (xyzw).
const YAW_90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function vol(id: string, zoneId: string, position: Vec3, size: Vec3, rotation: Quat = IDENTITY): SamplingVolume {
  return { id, zoneId, position, rotation, size };
}

// --- OBB membership & world AABB (§2.3, §7.1) --------------------------------

test('inVolume: axis-aligned box contains its interior and excludes the outside', () => {
  const v = vol('volume-1', 'zone-1', [0, 0, 0], [2, 2, 2]);
  assert.equal(inVolume([0, 0, 0], v), true);
  assert.equal(inVolume([0.99, -0.99, 0.99], v), true);
  assert.equal(inVolume([1.01, 0, 0], v), false);
  assert.equal(inVolume([0, 0, 5], v), false);
});

test('inVolume: a rotated box tests membership in its own frame', () => {
  // A long-in-X box yawed 90° becomes long in Z.
  const v = vol('volume-1', 'zone-1', [0, 0, 0], [6, 1, 1], YAW_90);
  assert.equal(inVolume([0, 0, 2.5], v), true); // along rotated long axis (was X)
  assert.equal(inVolume([2.5, 0, 0], v), false); // was the long axis, now short
});

test('obbWorldAabb: axis-aligned box AABB equals the box; a 90° yaw swaps X/Z extents', () => {
  const aligned = obbWorldAabb(vol('v', 'z', [1, 2, 3], [4, 2, 6]));
  assert.deepEqual(aligned.min, [-1, 1, 0]);
  assert.deepEqual(aligned.max, [3, 3, 6]);

  const yawed = obbWorldAabb(vol('v', 'z', [0, 0, 0], [4, 2, 6], YAW_90));
  // X extent (±3) and Z extent (±2) swap under the 90° yaw.
  assert.ok(Math.abs(yawed.min[0] + 3) < 1e-6 && Math.abs(yawed.max[0] - 3) < 1e-6);
  assert.ok(Math.abs(yawed.min[2] + 2) < 1e-6 && Math.abs(yawed.max[2] - 2) < 1e-6);
});

// --- SDK regions (§7.1) ------------------------------------------------------

test('regionsFromVolumes: full-volume fallback when inactive, one box per volume when active', () => {
  const volumes = [vol('v1', 'z1', [0, 0, 0], [2, 2, 2]), vol('v2', 'z1', [5, 0, 0], [2, 2, 2])];
  assert.deepEqual(regionsFromVolumes(false, volumes), [{ type: 'full' }]);

  const regions = regionsFromVolumes(true, volumes);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0], { type: 'box', min: [-1, -1, -1], max: [1, 1, 1] });
});

// --- Zone labels (§6.2) ------------------------------------------------------

test('zoneLabel: trims, falls back to the default Zone N on blank', () => {
  assert.equal(zoneLabel({ id: 'zone-2', name: '  West  ' }), 'West');
  assert.equal(zoneLabel({ id: 'zone-2', name: '   ' }), 'Zone 2');
  assert.equal(zoneLabel({ id: 'zone-5', name: '' }), 'Zone 5');
});

// --- BVH two-level extraction (§3.3) -----------------------------------------

const WORDS = 8;

/** Write one node's AABB (f32) + escape link/prim (u32) into split views. */
function writeNode(
  f32: Float32Array,
  u32: Uint32Array,
  node: number,
  min: Vec3,
  max: Vec3,
  escape: number,
  prim: number,
): void {
  const b = node * WORDS;
  f32[b] = min[0];
  f32[b + 1] = min[1];
  f32[b + 2] = min[2];
  f32[b + 4] = max[0];
  f32[b + 5] = max[1];
  f32[b + 6] = max[2];
  u32[b + 3] = escape;
  u32[b + 7] = prim;
}

test('extractZonesAndVolumes: one zone per top-level node, one box each at boxLevel == zoneLevel', () => {
  // root (internal) → left leaf [0,0,0]-[4,4,4], right leaf [5,0,0]-[10,4,4].
  const f32 = new Float32Array(3 * WORDS);
  const u32 = new Uint32Array(3 * WORDS);
  writeNode(f32, u32, 0, [0, 0, 0], [10, 4, 4], 3, 0); // internal (prim 0)
  writeNode(f32, u32, 1, [0, 0, 0], [4, 4, 4], 2, (1 << 28) | 0); // leaf, escape → right child index 2
  writeNode(f32, u32, 2, [5, 0, 0], [10, 4, 4], 3, (1 << 28) | 1); // leaf

  const { zones, volumes } = extractZonesAndVolumes(f32, u32, 3, /*triangleCount*/ 10, 1, 1, /*voxelSize*/ 0.5);
  assert.equal(zones.length, 2);
  assert.deepEqual(zones.map((z) => z.id), ['zone-1', 'zone-2']);
  assert.equal(volumes.length, 2);
  assert.equal(volumes[0].zoneId, 'zone-1');
  assert.deepEqual(volumes[0].position, [2, 2, 2]);
  assert.deepEqual(volumes[0].size, [4, 4, 4]);
  assert.deepEqual(volumes[1].position, [7.5, 2, 2]);
});

test('extractZonesAndVolumes: an empty scene (no triangles) yields nothing', () => {
  const f32 = new Float32Array(WORDS);
  const u32 = new Uint32Array(WORDS);
  // Inverted-AABB sentinel root, as the SDK flatten produces for an empty scene.
  writeNode(f32, u32, 0, [1e30, 1e30, 1e30], [-1e30, -1e30, -1e30], 0xffffffff, 1);
  const { zones, volumes } = extractZonesAndVolumes(f32, u32, 1, 0, 2, 4, /*voxelSize*/ 0.5);
  assert.equal(zones.length, 0);
  assert.equal(volumes.length, 0);
});

test('extractZonesAndVolumes: a flat edge is floored to at least a voxel (§5)', () => {
  const f32 = new Float32Array(WORDS);
  const u32 = new Uint32Array(WORDS);
  writeNode(f32, u32, 0, [0, 0, 0], [2, 0, 2], 0xffffffff, (1 << 28) | 0); // flat in Y
  // voxelSize 0.5 > the 0.05 floor ⇒ the degenerate Y edge is floored to voxelSize,
  // not the old hard 0.05 constant (which would sample below a voxel).
  const { volumes } = extractZonesAndVolumes(f32, u32, 1, 4, 0, 0, /*voxelSize*/ 0.5);
  assert.equal(volumes.length, 1);
  assert.equal(volumes[0].size[1], 0.5);
  assert.equal(volumes[0].size[1], minVolumeSize(0.5));
});

test('minVolumeSize: at least a voxel, floored at MIN_VOLUME_SIZE_FLOOR', () => {
  assert.equal(minVolumeSize(0.5), 0.5); // ≥ voxelSize dominates
  assert.equal(minVolumeSize(2), 2);
  assert.equal(minVolumeSize(0.01), MIN_VOLUME_SIZE_FLOOR); // tiny voxel ⇒ absolute floor
});

// --- summaryFromAccum (§7.2) -------------------------------------------------

function accum(valid: number, covered: number, seen: number[]): RegionAccum {
  return { valid, covered, blind: valid - covered, seen: Uint32Array.from(seen) };
}

test('summaryFromAccum: rates are derived from the group accumulator', () => {
  const cams = runCameras([
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
  ]);
  const s = summaryFromAccum(accum(10, 7, [5, 2]), cams);
  assert.equal(s.validVoxels, 10);
  assert.equal(s.overallRate, 0.7);
  assert.equal(s.blindVoxels, 3);
  assert.deepEqual(s.perCamera, [
    { id: 'a', coverageRate: 0.5 },
    { id: 'b', coverageRate: 0.2 },
  ]);
});

test('summaryFromAccum reads each camera at its own mask bit (spec §5.4)', () => {
  // Camera 'b' is disabled, so 'c' keeps mask bit 2 — not the index 1 it holds
  // among the enabled cameras. Reading by position would report 'b's count.
  const cams = runCameras([
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },
    { id: 'c', enabled: true },
  ]);
  const s = summaryFromAccum(accum(4, 4, [4, 0, 1]), cams);
  assert.deepEqual(s.perCamera, [
    { id: 'a', coverageRate: 1 },
    { id: 'c', coverageRate: 0.25 },
  ]);
});

test('summaryFromAccum: a zone with no group reads as all-zero, not as missing', () => {
  const cams = runCameras([{ id: 'a', enabled: true }]);
  const s = summaryFromAccum(null, cams);
  assert.equal(s.validVoxels, 0);
  assert.equal(s.overallRate, 0);
  assert.equal(s.blindVoxels, 0);
  assert.deepEqual(s.perCamera, [{ id: 'a', coverageRate: 0 }]);
});

test('summaryFromAccum: an empty group does not divide by zero', () => {
  const cams = runCameras([{ id: 'a', enabled: true }]);
  const s = summaryFromAccum(accum(0, 0, [0]), cams);
  assert.equal(s.overallRate, 0);
  assert.equal(s.perCamera[0].coverageRate, 0);
});
