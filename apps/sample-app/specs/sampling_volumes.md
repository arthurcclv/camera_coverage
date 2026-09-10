# Sample App — Sampling Zones (BVH-seeded region-of-interest analysis)

The feature spec for the sample app's region-of-interest tool, now **implemented**.
Companion to [`spec.md`](./spec.md); this document owns the full behavior of the
feature, and §12 below lists the edits made to `spec.md` so the two stay consistent
(workflow rule: spec-first, no drift). Those edits have been applied.

> **Naming (confirmed with reviewer).** The editable box entity is a **volume**
> (`SamplingVolume`, ids `volume-N`). A named unit of volumes with its own coverage
> results is a **zone** (`Zone`, ids `zone-N`, scene-file key `zones`). Every volume
> belongs to exactly one zone.

---

## 1. Problem & goal

Today the app samples the **full workspace volume** (`spec.md` §7:
`setSampling({ regions: [{ type: 'full' }] })`). The workspace AABB is the mesh's
bounding box (`spec.md` §4.2, §14.6). For an **irregularly-shaped** mesh — an
L-shaped floor plan, two disjoint buildings, a diagonal footprint — the bounding
box contains large tracts of free space nobody cares about. Those voxels are
legitimately `EMPTY_SPACE` (reachable from the boundary, so the SDK keeps them
valid), enter the coverage denominator, and **dilute the reported coverage rate**
while lighting up the overlay in irrelevant places.

**Goal.** Let the user carve the workspace into **zones** — named regions of
interest, each analyzed independently with its **own coverage results** — built
from **editable boxes** ("volumes") seeded from the scene's **BVH** (which
naturally subdivides space to hug the geometry). Concretely:

- **Volumes** are oriented boxes; move / rotate / resize to shape a region.
- **Zones** group volumes into units; **each zone has its own coverage summary**
  (overall rate, per-camera rates, blind-spot count) computed over just the voxels
  its volumes mark.
- Both are first-class **scene-hierarchy** entities (like Cameras / Probes /
  Sections): selectable, deletable, addable via "+".
- **Generate from geometry** seeds zones+volumes from the first BVH levels.

## 1.1 SDK involvement

> **Superseded in part.** This section originally recorded that the feature needed
> **zero SDK changes**. Points 2 and 3 no longer hold: the SDK gained an aggregation
> API (`camera-coverage-sdk` §19), and zones now reach it as oriented **regions** and
> **groups** rather than as a client-side filter over retained masks. What changed is
> *where* the work runs, not what a zone means — the definitions below and in §2 are
> unchanged. Point 1 (BVH seeding) still holds exactly as written. See §7.2 for the
> current path and `spec.md` §3.3 for the descriptor.

The three facts as originally recorded:

1. **BVH seeding uses already-public SDK building blocks.** `@linkervision/camera-coverage-sdk`
   already exports `cleanMesh` and `buildBvh` (`src/index.ts`, "building blocks for
   visualization / testing"), and the app already holds the merged world-space
   collision mesh (`GeometryBuild.sceneMesh`). The app builds its **own** BVH
   client-side from that mesh — identical to the worker's (both use the default TS
   kernels) — and walks its node array to extract boxes. Nothing new crosses the
   worker boundary.
2. ~~**Marking reuses existing sampling.**~~ Axis-aligned boxes are still expressed
   with the SDK's `{ type: 'box' }` sampling region to bound *what is computed*
   (§7.1, unchanged). But rotation is no longer an app-side filter: an aggregation
   **region** is an OBB and carries the volume's rotation exactly
   (`camera-coverage-sdk` §19.1), so the marked set is evaluated where the masks are.
3. ~~**Per-zone results are client-side aggregation.**~~ Still true that visibility is
   computed per voxel independent of any grouping, so **one** `compute()` pass
   suffices, and still true that zones never change what the SDK *computes*. But the
   partitioning is no longer client-side: a zone is an aggregation **group** and the
   engine returns its summary directly (§7.2).

---

## 2. Model & state

### 2.1 Zone & volume entities

```ts
// scene/samplingVolumes.ts
export interface SamplingVolume {
  id: string;               // 'volume-N', unique across all volumes
  zoneId: string;           // the owning zone (exactly one, §2.2)
  position: Vec3;           // box center, world meters
  rotation: Quat;           // orientation [x,y,z,w]; identity = axis-aligned
  size: Vec3;               // full edge lengths (m) along local X/Y/Z, all > 0
}

export interface Zone {
  id: string;               // 'zone-N', unique, stable identity (never renamed)
  name: string;             // user-editable display label (§6.2); defaults to 'Zone N'
  enabled: boolean;         // contributes to the visualized marked set (§2.2, §7.3); default true
}
```

**A sampling volume is not a camera constraint**, though the two look alike in the
hierarchy: a volume is an **analysis input** — it changes which voxels are counted, and
every coverage number in the app depends on it — while a camera constraint
(`camera_placement.md` §1.1) is a **generator** that changes no number and only produces
cameras. A volume is also a plain box; a constraint is a point, polyline, or plane dilated
by a tolerance.

**A constraint group may nevertheless *reference* zones**, by id, as its **target zones**
(`camera_placement.md` §3.1.2) — the zones a group of cameras is being planned for. The
dependence is strictly one-way: placement reads zones, zones never read placement. So nothing
in this document has to know about groups, with the single exception of §3.4's replacement
rule, which invalidates those references by construction.

A volume is an OBB: a unit cube scaled by `size`, rotated by `rotation`, translated
to `position` (axis-aligned when `rotation` is identity). `{position, rotation,
size}` maps 1:1 to a Three.js object's `position`/`quaternion`/`scale`, so
`TransformControls` writes them back with no conversion (§5).

Both live in canonical arrays in `App.tsx` — `zones: Zone[]` and `volumes:
SamplingVolume[]` — parallel to `cameras`/`probes`/`sections`. A volume references
its zone by `zoneId`; the hierarchy tree references both by id and carries identity
only (§4).

### 2.2 Membership, activation, marked sets, enabled zones

- **Partition.** Every volume belongs to **exactly one** zone (`zoneId`). A volume
  cannot be zone-less; a zone may be empty. Volumes are moved between zones, never
  shared. When any volume exists, at least one zone exists.
- **Activation.** An app-level boolean **`useZones`** (default **off**) gates
  whether zones restrict coverage.
- **Enabled zones.** Each zone carries an independent **`enabled`** boolean
  (default **true**), exactly like a camera's enabled state or a section's — many
  zones can be enabled at once. It is toggled by the zone's row checkbox (§4.1),
  independent of selection.
- **Per-zone marked set.** For zone *z*:
  `M(z) = { valid voxels whose center ∈ ⋃ OBB(v) for v in z }`.
  A voxel in two zones' volumes is counted in **both** zones (zones may overlap
  spatially even though volumes partition by ownership).
- **Visualized marked set (enabled union).** The overlay/sections/main stats show
  the union of the **enabled** zones: `M(enabled) = ⋃_{z enabled} M(z)` (each voxel
  counted once). Enabling exactly one zone isolates it; enabling several shows their
  union; enabling all is the whole region of interest. Stats always break out **per
  zone** regardless of enabled state (§7.4).
- **Fallback.** When `useZones` is off, or no volume exists, the marked set is **all
  valid voxels** — today's full-volume behavior. So scenes that don't use the tool
  are unchanged.

```
active = useZones && volumes.length > 0
```

### 2.3 Point-in-volume test

```
inVolume(p, v):                                   // world point p, volume v
  local = conj(v.rotation) · (p − v.position)     // into box-local frame
  return |local.x| ≤ v.size.x/2
      && |local.y| ≤ v.size.y/2
      && |local.z| ≤ v.size.z/2

inZone(p, z):    volumes.filter(v => v.zoneId === z.id).some(v => inVolume(p, v))
```

Membership is quantized to the voxel grid (`voxelSize`, `spec.md` §6), like
probe/section reads.

---

## 3. BVH seeding ("Generate from geometry")

### 3.1 Build the app-side BVH

On **Generate**, from the current merged scene mesh (the same `SceneMesh` passed to
`engine.loadScene`):

```ts
import { cleanMesh, buildBvh } from '@linkervision/camera-coverage-sdk';
const bvh = buildBvh(cleanMesh(sceneMesh));   // Bvh: { f32, u32, nodeCount, ... }
```

Cached and reused across level-slider changes; invalidated when scene geometry
changes (§11). Build cost is the SDK binned-SAH builder (~1M tris/s, `spec.md`
§10.1) — negligible for demo scenes, and off the render path.

### 3.2 Node layout recap (read-only)

`Bvh` (SDK `src/geometry/bvh.ts`) is a flattened depth-first 8-word/node array:

- `f32[base+0..2]` = AABB min, `f32[base+4..6]` = AABB max.
- `u32[base+3]` = **miss/escape** link (`0xFFFFFFFF` = end) = `nodeIndex + subtreeSize`.
- `u32[base+7]` = `prim`: **0 ⇒ internal**, non-zero ⇒ **leaf**.
- Children of an internal node: **left = `node + 1`**; **right =
  `u32[(node+1)*8 + 3]`** (the left subtree's escape link).

### 3.3 Two-level extraction (one zone per top-level node)

Generation uses **two** cut levels (your decision): a shallow **zone level** whose
nodes each become a zone, and a finer **box level** to which each zone's subtree is
extracted into volumes.

```
generate(zoneLevel, boxLevel):        // boxLevel ≥ zoneLevel
  zones = []; volumes = []
  cutZones(0, 0)
  return { zones, volumes }

cutZones(node, level):
  if isSentinel(node): return          // empty-scene root (inverted AABB), §3.4
  isLeaf = u32[node*8+7] != 0
  if isLeaf || level == zoneLevel:
    z = newZone()                       // 'zone-N', name 'Zone N'
    zones.push(z)
    cutBoxes(node, level, z.id)         // fill this zone with volumes
    return
  left = node+1; right = u32[left*8+3]
  cutZones(left, level+1); cutZones(right, level+1)

cutBoxes(node, level, zoneId):
  isLeaf = u32[node*8+7] != 0
  if isLeaf || level == boxLevel:
    volumes.push(boxFromAABB(node, zoneId))   // position=AABB center, size=extent, rotation=identity
    return
  left = node+1; right = u32[left*8+3]
  cutBoxes(left, level+1, zoneId); cutBoxes(right, level+1, zoneId)
```

Each zone ends up holding the box(es) of its subtree; `boxLevel == zoneLevel` gives
exactly one box per zone (the node's own AABB). Boxes are seeded **axis-aligned**
(identity rotation); the user tilts/refines them afterward. Sibling BVH AABBs may
overlap — fine, the marked set is a union.

### 3.4 Levels, defaults & replacement

- **Zone level** slider: integer **0–6**, default **2** (→ up to 4 zones).
- **Box level** slider: integer **`zoneLevel`–8**, default **4**. Clamped to
  `≥ zoneLevel`.
- Both are **integer sliders** (spec §5.2.1): the value readout is an editable text
  field that **rounds** a typed value to the nearest whole level within range.
- Both re-extract from the cached BVH instantly (no rebuild).
- Each **Generate** (or level change) **replaces the entire `zones` + `volumes`
  set** with the freshly extracted result. Hand-edits since the last Generate are
  discarded — the tool is an explicit re-seed. Generating auto-selects the first
  new zone.
- **It also clears every constraint group's target zones** (`camera_placement.md` §3.1.2,
  §7), and the status area names the groups that lost one. The replacement re-numbers from
  `zone-1`, so `zone-3` still exists after a regenerate and names a *different* box: a
  reference kept across it would point at unrelated geometry, and the group would rebuild its
  pool against a target nobody chose. Deleting a single zone is different — there the id
  genuinely goes away, so it is pruned from the lists instead (`camera_placement.md` §7).
- Skip the **empty-scene sentinel** root (inverted AABB `min = 1e30`,
  `max = -1e30`; `bvh.ts` flatten) — it yields no zone.

> **Why shallow levels.** Shallow BVH AABBs are large and overlapping, so a zone's
> union tends to *enclose* interior free space (what we want); deep cuts hug the
> geometry surface and can *exclude* interior. Defaults are deliberately shallow,
> and the seed is a starting point the user refines.

---

## 4. Scene hierarchy integration (`spec.md` §5.5)

The "Sampling Zones" area introduces the first **user-created, selectable
sub-groups** (zones), a small extension to today's auto-derived, passive type
groups.

### 4.1 Tree structure

```
Zones                         (group umbrella — passive; expand/collapse only)
├── Zone 1                    (zone node — SELECTABLE and expandable)
│   ├── volume-1              (volume node — selectable leaf)
│   └── volume-2
└── Zone 2
    └── volume-3
```

- **Node model (`scene/sceneTree.ts`).** Add two `SceneNode` variants:
  - `{ kind: 'zone'; id; label; zoneId; childIds: string[] }` — **both selectable
    and expandable** (new: today groups are passive, entities are leaves; a zone is
    both). `childIds` are its volume nodes.
  - `{ kind: 'volume'; id; label; volumeId }` — selectable leaf.
  Plus a passive `{ kind: 'group'; id: 'group:zones'; label: 'Zones' }` umbrella
  over the zone nodes. Add `nodeIdForZone`/`zoneIdForNode`,
  `nodeIdForVolume`/`volumeIdForNode` helpers (prefixes `zone:` / `volume:`).
  `buildSceneTree(cameras, probes, sections, zones, volumes)` appends the umbrella
  + zone subtrees when `zones.length > 0` — so a freshly-added **empty** zone (no
  volumes yet) shows immediately, as an expandable node with no children.
  `flattenVisible` generalizes "has children" from `kind==='group'` to "any node
  with a non-empty `childIds`" so zone nodes expand/collapse too.
- **Rows.**
  - **Zone row** — an **enabled checkbox** (leading, `.tree-row-toggle`, like a
    camera's enable / a section's — checked when the zone contributes to the
    visualized union, §2.2, §7.3), the zone name, a passive child-count, and a
    **coverage badge** (`overall NN%`, from that zone's summary, §7.4), mirroring
    the camera coverage-rate badge; omitted when there is no usable run. A disabled
    zone dims like a disabled camera. The checkbox is **independent** per zone and
    **decoupled from selection**.
  - **Volume row** — the volume label and a **size** badge (`2.0 × 1.5 × 3.0 m`).
- **Selection.** The unified selection gains `'zone'` and `'volume'`:
  `{ kind: 'camera'|'probe'|'section'|'zone'|'volume'; id } | null`. Selecting any
  one deselects the others. Clicking a **zone** node selects it (drives the §6
  `ZonePanel`) *and* toggles nothing about expansion except via its caret;
  selection does **not** change which zones are enabled. Clicking a **volume**
  selects it (drives the §6 `VolumePanel` + the §5 transform gizmo). The passive
  **"Zones" umbrella** header only expands/collapses (no selection), like
  Cameras/Probes/Sections headers.
- **Adding (the "+" menu).** Two new entries:
  - **Zone** — creates an empty **enabled** zone (`zone-N`, "Zone N"), auto-selected.
    Does not mark stale (an empty zone marks no voxels).
  - **Volume** — adds a 1 m cube at the workspace center into the **target zone**
    (the selected zone, or the selected volume's zone, or the first zone; creating
    "Zone 1" first if none exist), auto-selected. Marks stale (§4.2).
- **Reordering.** Zone rows reorder among themselves and volume rows among their
  own zone's volumes, by drag (`spec.md` §5.5.1). A zone drags as a **subtree** —
  its volumes move with it, and the gaps between another zone's volumes are not
  legal drop positions for a zone. Dragging **never** moves a volume between zones;
  that is the volume panel's `zoneId` control (§6.1). Reordering permutes the
  `zones`/`volumes` arrays, so it round-trips in the scene file and — unlike every
  other volume edit — does **not** mark the result stale.
- **Deleting.** Right-click → **Delete**. Deleting a **volume** removes it (and
  marks stale). Deleting a **zone** removes the zone **and all its volumes** (marks
  stale if it had any). Deleting the selected entity clears the selection.
- **Stale coupling (key difference from probes/sections).** Volumes are **coverage
  input**. Adding/deleting/moving/rotating/resizing a volume, deleting a non-empty
  zone, generating, and toggling `useZones` all **mark the result stale** (`spec.md`
  §8.1) → Auto-run recomputes (§8). Creating an empty zone, renaming a zone, and
  **enabling/disabling a zone** do **not** mark stale — the enabled union is a pure
  client-side re-filter of the retained masks (§7.3, §8), exactly like a section's
  visibility. **Reordering** a zone or volume row does not mark stale either: it
  permutes an array whose order is display-only and leaves the marked set identical.

---

## 5. Viewport representation & editing (`spec.md` §2.4, §5.2)

- **Gizmo.** Each volume renders as a **wireframe box** (edges + faint translucent
  fill) at its `position`/`rotation`/`size` via a new `SamplingVolumeGizmoSet`
  (`scene/samplingVolumeGizmos.ts`). Volumes of **visible** zones render normally —
  the enabled zones union every drawable group's target `zoneIds`
  (`camera_placement.md` §3.1.2, `spec.md` §2.4.3). A volume outside that set draws nothing unless it
  is the selection (`spec.md` §2.4.3). The
  selected volume is highlighted. Boxes are **pickable** like camera/probe bodies —
  the viewport pick (`spec.md` §5.2) returns the nearest hit across cameras,
  probes, **and volumes**. Zones themselves have no viewport body (selected from
  the hierarchy); sections stay non-pickable. The translucent **fill** draws **last**
  of the in-scene transparent layers (`scene/renderOrder.ts`), so it tints over any
  earlier one while still being occluded by any section plane in front of it
  (`spec.md` §13.5). The coverage fog is **not** one of them — it renders in its own
  pass and composites over the whole scene, the fill included, so the fog tints the
  fill rather than the other way round (`volumetric_rendering.md` §4).
- **TransformControls.** Selecting a **volume** attaches the gizmo in **translate /
  rotate / scale**. This adds a third transform mode — **Scale** — to the top-left
  toolbar (`spec.md` §2.4), available **only while a volume is selected** (cameras
  keep Move/Rotate, probes Move-only, sections Move-only axis-locked). Scale edits
  `size` (box-local frame); translate edits `position`; rotate edits `rotation`.
  Selecting a **zone** attaches **no** gizmo (it is a container).
- **Two-way sync** with the §6 panel; any drag/edit marks stale (§4.2). A minimum
  `size` per axis (≥ `voxelSize`, floor ~0.05 m) prevents a degenerate box.

---

## 6. Controls & panels

### 6.1 Selected-volume editor — `VolumePanel.tsx` (left detail panel)

Header `Volume — <id>`, showing its zone; **Position X/Y/Z**, **Rotation X/Y/Z**
(= pitch/yaw/roll, Euler⇄quat via `cameras/math.ts`, quaternion is source of truth;
`spec.md` §5.1), and **Size X/Y/Z** — each a **grouped row of numeric text fields**
(`spec.md` §5.2.1); plus a **Zone** dropdown to reassign the volume to another zone.
Size keeps its per-axis floor (§5) as a clamp; position/rotation follow the
clamp-meaningful/free-the-rest rule of `spec.md` §5.2.1. Every edit marks stale
(§4.2). Delete is via the context menu (§4).

### 6.2 Selected-zone panel — `ZonePanel.tsx` (left detail panel)

Header `Zone — <name>`, an editable **name** field, **member count**, and the
zone's **coverage stats** (below). Whether the zone is **enabled** (contributes to
the visualized union) is controlled by the zone row's checkbox in the hierarchy
(§4.1, §7.3), not here.

**Editable name.** The name field is a plain text input, prefilled with the zone's
current `name`, that writes back to `Zone.name` on change (live, no confirm step).
Rules:

- The zone's **stable identity is `id`** (`zone-N`, §2.1); the name is a pure
  display label. Renaming never changes `id`, `zoneId` links, or the marked set.
- **No uniqueness requirement** — two zones may share a name (ids stay distinct);
  duplicates are allowed and not flagged.
- The value is **trimmed**; an all-whitespace/empty name **falls back to the
  default `Zone N`** (derived from the id) rather than showing a blank label.
- Renaming updates the label **everywhere live** — the hierarchy zone row (§4.1)
  and any zone reference in stats — and is **persisted** to `scene.json` (§9).
- Renaming is **not** a coverage input: it **never marks the result stale** and
  never triggers a recompute (§4.2, §8), like enabling/disabling a zone.

The zone's **coverage stats** — the per-zone analog of the §10 stats panel, over
`M(z)`:

- overall coverage (covered by ≥1 camera), **blind-spot** count/%, **per-camera**
  coverage rate (decoded from the retained run's enabled-camera snapshot, `spec.md`
  §12.2, and labeled by the camera's **display name**, `spec.md` §5.6). "Run coverage
  to see results." / stale-hint states as elsewhere.

### 6.3 Global tool controls — `SamplingVolumeControls.tsx` (right sidebar)

A **"Sampling Zones"** block (above `StatsPanel`, since it governs the coverage
denominator):

- **Restrict coverage to zones** — the `useZones` toggle (§2.2), default off.
- **Generate from geometry** — button (§3), replacing the zone+volume set.
- **Zone level** / **Box level** sliders (§3.4).
- **Marked voxels** readout — for the enabled-zones union, the count and **% of the
  full valid volume** (e.g. `12,480 voxels · 38% of full`), the tool's payoff. "Run
  coverage" placeholder before the first run. (There is no focus/zone selector here
  — which zones are enabled is set from the hierarchy row checkboxes, §4.1.)

---

## 7. Effect on the coverage calculation (`spec.md` §7, §9, §10, §13)

### 7.1 What the SDK computes (`setSampling`)

> **`setSampling` is fed every volume, regardless of its zone's `enabled`.** Activation and
> the marked set are §2.2's business — `enabled` decides what is *counted*, never what is
> *computed*. This is what lets a constraint group target a globally-disabled zone
> (`camera_placement.md` §3.1.2): the voxels are there to be seen, and only the counting
> filter ever looked at the flag.

The run path (§8) derives the SDK regions from **all** volumes across **all** zones:

```ts
regions =
  active
    ? volumes.map(v => ({ type: 'box', min: aabbMin(v), max: aabbMax(v) }))  // world AABB of each OBB
    : [{ type: 'full' }];
setSampling({ regions });   // SDK unions the regions (existing behavior)
```

`aabbMin/aabbMax(v)` = the world AABB of the oriented box (transform its 8 corners,
take min/max). Axis-aligned volumes give an exact box; rotated volumes give a
conservative superset refined client-side (§7.2). One `setSampling`/`compute`
covers every zone — grouping is purely an aggregation concern. This is the "narrow
SDK" half of the earlier decision: the SDK computes only the boxes' neighborhood,
cutting empty voxels out of the calculation and reducing compute.

### 7.2 Per-zone aggregation (engine-side)

Per-zone summaries come back from the SDK's aggregation (`camera-coverage-sdk` §19,
`spec.md` §3.3), evaluated next to the masks rather than scanned on the main thread.
The mapping is direct:

- each **volume** is one aggregation **region** — an OBB carrying the volume's
  `position`, `rotation`, and half-`size`, so a rotated volume is exact rather than a
  conservative AABB refined afterwards;
- each **zone** is a **group** its volumes declare. A zone's volumes may overlap, so a
  zone's total is *not* the sum of its volumes' — a group is what counts each voxel
  once no matter how many of that zone's volumes contain it (`camera-coverage-sdk`
  §19.2);
- the **enabled-zones union** (§7.3, §7.4) is one more group, declared additionally by
  every **enabled** zone's volumes. One descriptor yields both answers in one pass.

Each group's accumulator carries `valid`, `covered`, `blind`, and per-camera `seen`,
per chunk. The app sums them across chunks and derives each zone's `overallRate`,
per-camera `coverageRate`, `validVoxels`, and blind-spot count — the same quantities as
the SDK `CoverageSummary` (`spec.md` §16.1), but per zone.

**Merging across chunks replaces the old per-chunk cache.** The accumulators are
additive, so an incremental run (`spec.md` §8) that replaces a few chunks replaces only
their contributions and every other chunk's stands. The client-side cache that used to
buy this by hand — keyed on the zone set, the volumes' geometry, and the run's camera
list — is gone: it existed to avoid a main-thread rescan that no longer happens.

**A zone or volume edit does not recompute.** Moving a volume, resizing it, changing its
`zoneId`, or toggling a zone changes only the descriptor, and none of those can change a
mask bit. The app re-requests `aggregateRetained` (`spec.md` §3.3) over the masks the
worker still holds. A volume edit *also* marks sampling dirty (§8), because it changes
what the SDK should *sample* next run — but the summaries update immediately, without
waiting for that run.

*Historical note.* This scan used to run on the main thread after every `compute()`, at
`O(valid voxels × cameras)` over the whole retained run — hundreds of milliseconds at a
fine voxel size, with auto-run firing up to 10×/sec during a camera drag. It carried two
optimizations that are now unnecessary and have been removed: the per-chunk cache above,
and an early-out when no zone held a volume. The latter is subsumed by the descriptor
itself — a run with no volumes declares no regions and adds no pass at all
(`camera-coverage-sdk` §19.6).

### 7.3 Visualization follows the enabled zones

A voxel is included in the overlay / section aggregation iff it is valid **and**
`inMarked(center)`, where the marked set is the **union of the enabled zones**
(§2.2): `M(enabled) = ⋃_{z enabled} M(z)`. It is applied by the aggregation, not by the
app: the enabled zones' volumes are named in `maskRegions` on each section slab and on
`leafCounts` (`camera-coverage-sdk` §19.1), so a voxel outside the union never reaches
the app in the first place. Voxels outside it read as unmarked — the
overlay draws nothing there. For **sections**, an unmarked voxel is **skipped** (it
does not black the cell): a section cell aggregates only its in-marked valid voxels
and is black only when its column has none (§13.3). The skip is applied **before** the
validity check — outside the enabled volumes the SDK doesn't sample, so those voxels
read invalid and are indistinguishable from obstacles; only an **in-marked** invalid
voxel (a wall/box inside the region of interest) blacks the cell as a silhouette.

Which zones are enabled is set **only** by the per-zone **enabled checkbox** in the
hierarchy row (§4.1), **decoupled from selection** (selecting a zone never changes
it) — exactly like a camera's enabled state or a section's visibility. Each zone
toggles independently: enabling one isolates it, enabling several shows their union,
disabling all marks nothing. **Toggling a zone never triggers a recompute** — it changes
which regions the marked-set group and the slab/`leafCounts` filters name, and the app
re-reduces the retained masks through `aggregateRetained` (`spec.md` §3.3), like
changing a section's orientation. Overlay/sections **dim** when the retained run is stale, as today.

**Counting and drawing part company here.** The enabled union governs what is
*counted*, as above. What is *drawn* follows the **visible** set of `spec.md` §2.4.3 —
the enabled zones union every drawable group's target `zoneIds` — so a disabled zone a
group targets contributes no voxels to the overlay yet keeps its box on screen, which
is the region that group's pool is being built into (`camera_placement.md` §3.1.2).
Without that union a Build would scatter candidate dots through a box nothing draws.

- **Sections (`spec.md` §13.3).** Voxels **outside the enabled union** are **skipped
  first**, not blacked. Among the **in-union** voxels, if any is invalid the cell is
  **black** (obstacle/out-of-range silhouette within the ROI); otherwise the cell
  aggregates them and is black only when the column has no in-union voxel. This keeps a
  horizontal section from going all-black when its tall column pokes out of a shorter
  volume.
- **Probes (`spec.md` §12).** Conceptually unchanged (a point observer, not part of
  any zone). Because the SDK now samples only the boxes' neighborhood, a probe
  outside it reads *"No coverage data at this point"* (an existing state).

### 7.4 Stats panel (`spec.md` §10)

- The main **StatsPanel** reflects the **enabled-zones union** — its `overallRate`,
  per-camera rates, `validVoxels`, blind-spot count all come from §7.2's union
  summary over the enabled zones.
- The **hierarchy camera rows** (`spec.md` §5.5) read from the **same** union
  summary: a camera row's coverage-rate badge and its coverage dot show that
  camera's rate over `M(enabled)`, so the badge and the StatsPanel's "Per camera"
  line for the same camera are always the same number, formatted the same way —
  **one decimal** (`NN.N%`), matching the panel. A camera absent from the union summary —
  including when the enabled zones mark nothing — shows no badge, as when there
  is no run.
- **Per-zone numbers** are always available: on each **zone row** as a coverage
  badge (§4), and in the **ZonePanel** (§6.2) for the selected zone.
- The **Marked voxels** readout (§6.3) shows the enabled-union size vs full,
  where **full** is the workspace's full valid-voxel count — the SDK's
  full-volume `SamplingStats.validVoxels` established at init and refreshed on
  re-init (a `voxelSize` or geometry change). It is **not** derived from the
  retained run, which when active samples only the boxes' neighborhood (§7.1)
  and so never covers the workspace.
- When `useZones` is off, the StatsPanel is exactly as today (SDK summary, full
  volume).

---

## 8. Run path & staleness (`spec.md` §8)

Volume/zone state feeds `setSampling`, so the run path must call it (today the app
only re-runs `setCameras` + `compute`):

- A **sampling-dirty** flag is set whenever the volume set, a volume transform, its
  `zoneId`, a non-empty zone's deletion, or `useZones` changes (in addition to the
  existing camera-edit stale flag).
- A run does: if sampling-dirty, `setSampling(regionsFromVolumes())` (§7.1) and
  clear the flag; then `setCameras(enabled)` if needed; then
  `compute({ mode: 1, onChunkDone })`; then recompute per-zone summaries (§7.2).
- `setSampling` needs **no re-init** (only a `voxelSize` change does, `spec.md`
  §6), so volume edits stay far cheaper than a resolution change. They are **not**
  as cheap as camera edits, though: a `setSampling` rebuilds the validity mask over
  the whole grid (SDK spec §6.4), whereas a camera edit is O(cameras) and reuses the
  cached mask.
- Auto-run throttling (≤10 runs/s) is unchanged; dragging a volume gizmo coalesces.
- **Zone enable/disable** and **zone rename** changes bypass the run entirely
  (§7.3) — pure client-side re-filter/relabel.

`useEngine.ts` gains a thin `setSampling` wrapper (mirrors `setCameras`) exposing
the returned `SamplingStats`.

---

## 9. Scene file (import / export, `spec.md` §14)

- **`Scene` model (`spec.md` §14.1).** Add `zones: Zone[]` and `volumes:
  SamplingVolume[]`; `defaultScene()` seeds both **empty** — the default room is
  unchanged until the user generates/adds.
- **`scene.json` (`spec.md` §14.3).** Add top-level `"zones"` and `"volumes"`
  arrays plus the `"useZones"` boolean (analysis setting — persisted; default
  `false` when absent). Each serialized zone carries **`{ id, name, enabled }`** —
  the user-edited **`name` round-trips** (§6.2) and the per-zone **`enabled` flag
  round-trips** (§7.3; default `true` when absent); each serialized volume carries
  `{ id, zoneId, position, rotation, size }`. Bump **`formatVersion` to `2`**; the
  reader **accepts 1 and 2** (a v1 file → empty zones/volumes, `useZones` false);
  version **> 2** was rejected. (The format has since moved to **3** for camera
  constraints, `camera_placement.md` §9; `spec.md` §14.3 carries the current rule and the
  reader accepts 1, 2, and 3. Zones and volumes are unchanged by that bump.) Sections serialize their per-entity
  flag as **`enabled`** too (renamed from the legacy `visible`, which the reader
  still accepts for back-compat). Rotations quaternions `[x,y,z,w]`, meters, Y-up.
- **Validation (`spec.md` §14.8).** Zone ids and volume ids unique within their
  categories; **every `volume.zoneId` must reference an existing zone** (dangling
  reference rejected); `size` components > 0; a missing/blank `name` reads as the
  default `Zone N` (§6.2), never an error; `enabled` (zone/section) must be a
  boolean when present; otherwise all-or-nothing import.
- **Not persisted.** The generation **levels** (zone/box, §3.4) are tool state,
  **not** written to `scene.json` — only the zones (name + enabled), the volumes,
  and `useZones` are.

Example addition to the §14.3 sketch:

```json
{
  "formatVersion": 2,
  "useZones": true,
  "zones": [ { "id": "zone-1", "name": "West wing", "enabled": true } ],
  "volumes": [
    { "id": "volume-1", "zoneId": "zone-1",
      "position": [3, 1.5, -2], "rotation": [0, 0.259, 0, 0.966], "size": [4, 3, 6] }
  ]
}
```

(Generation levels are omitted by design — they are tool state, like the other
app-local view prefs in `spec.md` §14.)

---

## 10. Terminology (`spec.md` §17)

- **Sampling volume** — a user-placed, editable **oriented box**. Coverage input
  (unlike a probe/section observer): it changes which voxels are counted. Belongs
  to exactly one zone.
- **Zone** — a named unit of sampling volumes with its **own coverage results**,
  aggregated over the union of its volumes (`M(z)`). The primary region-of-interest
  unit.
- **Marked set** — the valid voxels counted for a given aggregation: `M(z)` for a
  zone, `M(enabled) = ⋃_{z enabled} M(z)` for the visualized union, or all valid
  voxels when zones are inactive.
- **Enabled zone** — a zone whose per-zone `enabled` flag is on, so it contributes
  to the visualized marked set (the union of enabled zones drives the overlay,
  sections, and the main stats panel). Toggled from the hierarchy row checkbox,
  independent per zone and decoupled from selection; toggling is a client-side
  re-filter, not a recompute.

---

## 11. Interaction with scene load & resolution

- **Scene load (`spec.md` §14.4).** Import **replaces** `zones`/`volumes` from the
  file (may be empty). The cached app-side BVH (§3.1) is invalidated and rebuilt
  lazily on the next Generate. Not auto-generated on load (generation is manual).
- **Resolution change (`spec.md` §6).** Volumes are world-meter defined,
  independent of `voxelSize`; a resolution change leaves them unchanged and only
  re-quantizes marked-set membership on the next run.

---

## 12. Edits required in `spec.md` (consistency)

| `spec.md` section | Edit |
|---|---|
| §2.2 Layout / file map | Add `scene/samplingVolumes.ts`, `scene/samplingVolumeGizmos.ts`, `ui/VolumePanel.tsx`, `ui/ZonePanel.tsx`, `ui/SamplingVolumeControls.tsx`; note the Zones umbrella + right-sidebar block. |
| §2.4 Viewport toolbar | Add the **Scale** transform mode (volume-only). |
| §5.2 / §5.5 Hierarchy & selection | Add `'zone'` + `'volume'` selection cases; the Zones umbrella and **selectable+expandable zone nodes** (the first user-created groups); a unified **`onToggleEnabled`** row checkbox (camera/section/zone); "+"→Zone/Volume; the **stale coupling** (volumes are coverage input; enabling a zone is not). |
| §7 Sampling | Replace "fixed to full volume" with zone-driven regions (§7.1) + the full-volume fallback. |
| §8 / §8.1 Run & staleness | Add `setSampling` to the run path, the sampling-dirty flag, and per-zone aggregation. |
| §9 / §10 / §13 | State that the **enabled-zones union marked set** replaces "all valid voxels" for the overlay/sections and the main stats; per-zone results in zone rows + ZonePanel. |
| §13.6 / §14.3 Sections | Rename the per-section `visible` field/label to **`enabled`** ("Enable/Disable section"); scene-file key `enabled` (legacy `visible` still read). |
| §14.1/§14.3/§14.8 | Add `zones` + `volumes` + `useZones`; zone/section `enabled`; bump `formatVersion` to 2; back-compat read of v1 + legacy `visible`; validation incl. `zoneId` referential integrity. |
| §16 Out of scope | Move "box sampling regions as a live control" to shipped; add the §13-here items as the new future list. |
| §17 Terminology | Add **sampling volume**, **zone**, **marked set**, **enabled zone**. |

---

## 13. Out of scope / future

- **Subtractive / exclusion** volumes (carve out) — additive union only (§2.2).
- **Oriented-box SDK sampling region** — rotation stays an app-side refine (§1.1);
  no OBB region is added to the engine (rotated boxes cost a small conservative
  AABB over-compute, refined client-side).
- **Multi-zone membership / ungrouped volumes** — strict partition, one zone per
  volume (§2.2).
- **Per-zone *distinct* colored overlay** — several zones can be enabled and shown
  **at once** (their union, §7.3), but as one overlay in the single overlay hue,
  not one color per zone. A per-zone colored overlay is out of scope.
- **Per-zone colormaps / colors, comparison views, zone reordering/nesting** beyond
  one level.
- **Generated-vs-manual distinction / merge** — Generate replaces the whole set
  (§3.4).
- **Auto-generate on scene load** — generation is manual (§11).
- **Sub-voxel membership** — quantized to the voxel grid (§2.3).
