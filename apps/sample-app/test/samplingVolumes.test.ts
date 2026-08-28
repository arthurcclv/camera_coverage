import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceGrid, type ChunkResult, type Quat, type Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  computeZoneCoverage,
  extractZonesAndVolumes,
  inVolume,
  makeMarkedFilter,
  MIN_VOLUME_SIZE_FLOOR,
  minVolumeSize,
  obbWorldAabb,
  regionsFromVolumes,
  zoneLabel,
  ZoneCoverageStore,
  type SamplingVolume,
  type Zone,
} from '../src/scene/samplingVolumes.ts';

const IDENTITY: Quat = [0, 0, 0, 1];
// 90° about Y (xyzw).
const YAW_90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function vol(id: string, zoneId: string, position: Vec3, size: Vec3, rotation: Quat = IDENTITY): SamplingVolume {
  return { id, zoneId, position, rotation, size };
}

function zone(id: string, name = id): Zone {
  return { id, name, enabled: true };
}

// --- OBB membership & world AABB (§2.3, §7.1) --------------------------------

/** Every listed camera enabled, so bit index == list index (spec §5.4). */
const allEnabled = (ids: string[]) => ({ ids, bits: ids.map((_, n) => n) });

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

// --- Marked-set filter: union of enabled zones (§7.3) ------------------------

test('makeMarkedFilter: null when inactive; union of enabled zones when active', () => {
  const volumes = [vol('v1', 'z1', [0, 0, 0], [2, 2, 2]), vol('v2', 'z2', [10, 0, 0], [2, 2, 2])];
  const z1 = zone('z1');
  const z2 = zone('z2');
  assert.equal(makeMarkedFilter(false, volumes, [z1, z2]), null);

  // Both enabled → union of both.
  const both = makeMarkedFilter(true, volumes, [z1, z2])!;
  assert.equal(both(0, 0, 0), true);
  assert.equal(both(10, 0, 0), true);
  assert.equal(both(5, 0, 0), false);

  // z2 disabled → only z1's volume is in the marked set.
  const onlyZ1 = makeMarkedFilter(true, volumes, [z1, { ...z2, enabled: false }])!;
  assert.equal(onlyZ1(0, 0, 0), true);
  assert.equal(onlyZ1(10, 0, 0), false);

  // All disabled → marks nothing.
  const none = makeMarkedFilter(true, volumes, [{ ...z1, enabled: false }, { ...z2, enabled: false }])!;
  assert.equal(none(0, 0, 0), false);
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

// --- Per-zone aggregation (§7.2) ---------------------------------------------

/** A 2×1×2 dense chunk at the origin, voxelSize 1, one camWord, all voxels valid. */
function chunk(masks: [number, number, number, number]): ChunkResult {
  const visibility = Uint32Array.from(masks);
  const validity = Uint32Array.of(0b1111); // 4 valid voxels
  return {
    chunkId: 0,
    dims: [2, 1, 2],
    origin: [0, 0, 0],
    voxelSize: 1,
    camWords: 1,
    mode: 1,
    stats: { validVoxels: 4, coveredVoxels: 0, elapsedMs: 0 } as never,
    encoding: 'dense',
    visibility,
    validity,
    coverage: new Uint8Array(4),
  } as ChunkResult;
}

test('computeZoneCoverage: per-zone rates, union, and blind spots', () => {
  // Voxel centers (li = i + 2k): 0→(0.5,0.5,0.5) mask 0b01; 1→(1.5,0.5,0.5) blind;
  // 2→(0.5,0.5,1.5) mask 0b11; 3→(1.5,0.5,1.5) blind.
  const c = chunk([0b01, 0b00, 0b11, 0b00]);
  const zones = [zone('zone-1')];
  // Box over x∈[0,1] (excludes the x=1.5 column) → marks voxels 0 and 2.
  const volumes = [vol('v1', 'zone-1', [0.5, 0.5, 1], [1, 1, 2])];

  const cov = computeZoneCoverage([c], allEnabled(['c0', 'c1']), zones, volumes);
  // The "% of full" denominator is NOT sourced here — when active the retained
  // chunks cover only the boxes, so no workspace-full count exists (§7.1, §7.4).
  assert.equal('fullValidVoxels' in cov, false);

  const z1 = cov.perZone.get('zone-1')!;
  assert.equal(z1.validVoxels, 2);
  assert.equal(z1.overallRate, 1); // both marked voxels are covered
  assert.equal(z1.blindVoxels, 0);
  assert.equal(z1.perCamera[0].coverageRate, 1); // c0 sees both
  assert.equal(z1.perCamera[1].coverageRate, 0.5); // c1 sees only voxel 2

  // Single enabled zone → the enabled union equals it.
  assert.equal(cov.enabledUnion.validVoxels, 2);
  assert.equal(cov.enabledUnion.overallRate, 1);
});

test('computeZoneCoverage: a voxel in two zones counts in both zones but once in the union', () => {
  const c = chunk([0b01, 0b00, 0b00, 0b00]); // only voxel 0 covered
  const zones = [zone('zone-1'), zone('zone-2')];
  // Both zones have a volume enclosing voxel 0's center (0.5,0.5,0.5).
  const volumes = [
    vol('v1', 'zone-1', [0.5, 0.5, 0.5], [1, 1, 1]),
    vol('v2', 'zone-2', [0.5, 0.5, 0.5], [1, 1, 1]),
  ];
  const cov = computeZoneCoverage([c], allEnabled(['c0']), zones, volumes);
  assert.equal(cov.perZone.get('zone-1')!.validVoxels, 1);
  assert.equal(cov.perZone.get('zone-2')!.validVoxels, 1);
  assert.equal(cov.enabledUnion.validVoxels, 1); // counted once in the union
});

test('computeZoneCoverage: a disabled zone is excluded from the union but still gets per-zone stats', () => {
  const c = chunk([0b01, 0b00, 0b00, 0b11]); // voxels 0 and 3 covered
  const zones = [zone('zone-1'), { ...zone('zone-2'), enabled: false }];
  const volumes = [
    vol('v1', 'zone-1', [0.5, 0.5, 0.5], [1, 1, 1]), // voxel 0
    vol('v2', 'zone-2', [1.5, 0.5, 1.5], [1, 1, 1]), // voxel 3
  ];
  const cov = computeZoneCoverage([c], allEnabled(['c0', 'c1']), zones, volumes);
  // Per-zone stats exist for the disabled zone.
  assert.equal(cov.perZone.get('zone-2')!.validVoxels, 1);
  // The union counts only the enabled zone's voxel.
  assert.equal(cov.enabledUnion.validVoxels, 1);
});

test('computeZoneCoverage reads each camera at its own mask bit (spec §5.4)', () => {
  // Three cameras passed to setCameras, 'c1' disabled — so 'c2' sits at bit 2.
  // Voxel 0 is seen by bits 0 and 2, voxel 2 by bit 2 only.
  const c = chunk([0b101, 0b000, 0b100, 0b000]);
  const zones = [zone('zone-1')];
  const volumes = [vol('v1', 'zone-1', [0.5, 0.5, 1], [1, 1, 2])]; // marks voxels 0 and 2

  const cov = computeZoneCoverage([c], { ids: ['c0', 'c2'], bits: [0, 2] }, zones, volumes);
  const z1 = cov.perZone.get('zone-1')!;

  assert.deepEqual(
    z1.perCamera.map((p) => p.id),
    ['c0', 'c2'],
    'the disabled camera gets no row',
  );
  assert.equal(z1.perCamera[0].coverageRate, 0.5, 'c0 (bit 0) sees voxel 0 only');
  // Reading by list index would look at bit 1 — empty — and report 0 here.
  assert.equal(z1.perCamera[1].coverageRate, 1, 'c2 (bit 2) sees both marked voxels');
  assert.equal(z1.overallRate, 1);
  assert.equal(z1.blindVoxels, 0);
});

test('computeZoneCoverage skips the voxel scan when no zone holds a volume (§7.2)', () => {
  // The scan is O(valid voxels × cameras) on the main thread after every run, so
  // it must not run to produce a result of all zeroes. Asserted by counting
  // accessor reads: a scan would touch the chunk, an early-out never does.
  const c = chunk([0b11, 0b11, 0b11, 0b11]);
  let reads = 0;
  const counted = new Proxy(c, {
    get(t, k) {
      if (k === 'visibility' || k === 'validity') reads++;
      return Reflect.get(t, k);
    },
  }) as ChunkResult;

  const empty = computeZoneCoverage([counted], allEnabled(['c0', 'c1']), [], []);
  assert.equal(reads, 0, 'no zones ⇒ the chunk is never decoded');
  assert.equal(empty.enabledUnion.validVoxels, 0);
  assert.deepEqual([...empty.perZone.keys()], []);

  // A zone with no volumes in it is the same situation, and must be caught too —
  // the guard is on the volumes, not on the zone list being empty.
  const zoneOnly = computeZoneCoverage([counted], allEnabled(['c0', 'c1']), [zone('zone-1')], []);
  assert.equal(reads, 0, 'a volume-less zone ⇒ still no decode');
  const z1 = zoneOnly.perZone.get('zone-1')!;
  assert.equal(z1.validVoxels, 0, 'the zone still gets a (zeroed) summary for its badge');
  assert.deepEqual(
    z1.perCamera.map((p) => p.id),
    ['c0', 'c1'],
  );

  // Sanity: with a volume present the scan does run.
  computeZoneCoverage([counted], allEnabled(['c0', 'c1']), [zone('zone-1')], [
    vol('v1', 'zone-1', [1, 0.5, 1], [2, 1, 2]),
  ]);
  assert.ok(reads > 0, 'a zone with a volume must still be aggregated');
});

// --- Per-chunk accumulator cache (§7.2) --------------------------------------

/** The same 2×1×2 dense chunk, placed at an arbitrary chunk id / X offset. */
function chunkAt(chunkId: number, x: number, masks: [number, number, number, number]): ChunkResult {
  return { ...chunk(masks), chunkId, origin: [x, 0, 0] } as ChunkResult;
}

const ZONES = [zone('zone-1')];
/** Covers both chunks' voxels: x ∈ [0,4], y ∈ [0,1], z ∈ [0,2]. */
const VOLS = [vol('v1', 'zone-1', [2, 0.5, 1], [4, 1, 2])];
const CAMS = [
  { id: 'c0', enabled: true },
  { id: 'c1', enabled: true },
];

function zoneStore(chunks: ChunkResult[]): ZoneCoverageStore {
  const s = new ZoneCoverageStore();
  s.reset(new WorkspaceGrid({ worldMin: [0, 0, 0], worldMax: [4, 1, 2], voxelSize: 1, chunkSizeXZ: 2 }), CAMS);
  for (const c of chunks) s.addChunk(c);
  return s;
}

test('the cached store agrees with an uncached whole-scene scan (§7.2)', () => {
  const chunks = [chunkAt(0, 0, [0b01, 0b00, 0b11, 0b00]), chunkAt(1, 2, [0b10, 0b11, 0b00, 0b01])];
  const cached = zoneStore(chunks).compute(ZONES, VOLS)!;
  const direct = computeZoneCoverage(chunks, allEnabled(['c0', 'c1']), ZONES, VOLS);
  assert.deepEqual(cached.enabledUnion, direct.enabledUnion);
  assert.deepEqual(cached.perZone.get('zone-1'), direct.perZone.get('zone-1'));
});

test('replacing one chunk rescans only it, and the merged answer still updates (§7.2)', () => {
  const s = zoneStore([chunkAt(0, 0, [0b01, 0b00, 0b11, 0b00]), chunkAt(1, 2, [0b00, 0b00, 0b00, 0b00])]);
  const before = s.compute(ZONES, VOLS)!.perZone.get('zone-1')!;
  assert.equal(before.overallRate, 0.25, '2 of 8 marked voxels covered');

  // An incremental run re-sends chunk 1 with everything now visible.
  s.addChunk(chunkAt(1, 2, [0b11, 0b11, 0b11, 0b11]));
  const after = s.compute(ZONES, VOLS)!.perZone.get('zone-1')!;
  assert.equal(after.overallRate, 0.75, 'chunk 1 fully covered, chunk 0 unchanged');
  // Chunk 0's cached contribution is still the one it originally produced.
  assert.equal(after.validVoxels, 8);
});

test('a zone or volume edit invalidates every cached chunk (§7.2)', () => {
  const s = zoneStore([chunkAt(0, 0, [0b11, 0b11, 0b11, 0b11]), chunkAt(1, 2, [0b11, 0b11, 0b11, 0b11])]);
  assert.equal(s.compute(ZONES, VOLS)!.perZone.get('zone-1')!.validVoxels, 8);

  // Shrinking the volume to chunk 0's half must not be served from a cache keyed
  // only on the chunks — the accumulators themselves depend on the geometry.
  const narrowed = [vol('v1', 'zone-1', [1, 0.5, 1], [2, 1, 2])];
  assert.equal(s.compute(ZONES, narrowed)!.perZone.get('zone-1')!.validVoxels, 4);

  // Disabling the zone empties the union while the per-zone summary stands.
  const off = [{ ...ZONES[0], enabled: false }];
  const disabled = s.compute(off, VOLS)!;
  assert.equal(disabled.enabledUnion.validVoxels, 0);
  assert.equal(disabled.perZone.get('zone-1')!.validVoxels, 8);
});
