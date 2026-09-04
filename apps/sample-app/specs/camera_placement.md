# Sample App — Camera Placement (constraint-driven random search over mount positions)

Feature spec for the sample app's camera **placement** tool. Companion to
[`spec.md`](./spec.md); this document owns the full behavior of the feature, and §14
lists the edits made to `spec.md`, to [`aim_optimization.md`](./aim_optimization.md), and
to the SDK spec so they stay consistent (workflow rule: spec-first, no drift).

> **Scope.** The placement tool chooses **positions**, and adds cameras at them. It never
> chooses an orientation: a placed camera gets the app's default rotation and is aimed
> afterwards by the aim optimizer (`aim_optimization.md`). "Placement" in this document
> always means "choose a set of mount positions".

This is the feature `aim_optimization.md` §13 parked as "optimizing **position** as well as
orientation, and adding or removing cameras (placement, not aiming)".

---

## 1. Problem & goal

Aiming existing cameras cannot fix a layout that has no camera near the loading bay. But
positions are not free variables either: a camera can only go where something exists to
mount it on — a wall, a pole, a gantry rail, a specific bracket already installed. A tool
that proposes coordinates in mid-air proposes nothing.

**Goal.** Let the user describe *where a camera may physically be mounted*, then search
those places for a small set of positions that together see as much of the workspace as
possible — and report how much each additional camera is worth, so the user can decide how
many to buy.

### 1.1 What a constraint is

A **camera constraint** is a region of space a camera may be mounted in. It is described
as a **primitive** — a point, a polyline, or a bounded plane rectangle — **dilated** by a
tolerance `distance`:

```
region(c) = { p : distanceToPrimitive(p, c) ≤ c.distance }
```

so a point becomes a ball, a polyline a chain of capsules, and a plane rectangle a
rounded slab. `distance` is a **tolerance, not a standoff**: it says "anywhere within
0.4 m of this rail", not "exactly 0.4 m off this rail". At `distance = 0` a region
degenerates to the primitive itself, which is how a fixed bracket ("exactly here"), a bare
rail, or a wall surface is expressed.

A **constraint group** is a named container of constraints — the unit the search runs
over, and the unit that carries the prospective camera's model and the search's own
parameters (§3.1). Group : constraint is exactly zone : sampling volume
(`sampling_volumes.md` §2.1): a constraint belongs to **exactly one** group, groups may be
empty, and the group is where the numbers a user acts on live.

**Constraints are not analysis inputs.** Unlike a sampling volume, a constraint changes
nothing about what is computed or counted: it does not restrict the marked set, does not
appear in the aggregation descriptor, and cannot move a single coverage number. It only
generates cameras. This is what makes the tool safe to leave in a scene.

**A group may nevertheless *point at* sampling zones** (§3.1.2). Its `zoneIds` list names
the zones the group plans for, and the invariant above survives intact: the list is read by
the pool build and by nothing else, so it changes which cameras the tool proposes and still
moves no number any panel displays. The direction of dependence is one-way — placement
reads the zone tool's output; the zone tool never reads placement's.

### 1.2 The objective

A camera's **reachable set** `R(p)` is the set of counted voxels a camera mounted at `p`
could see at *some* orientation — the same quantity `aim_optimization.md` §2 defines, and
for the same reason: of the three conditions in the SDK's visibility rule
(`camera-coverage-sdk` §8), only the frustum test depends on where the camera points, so
the set a mount point can reach is fixed by the position alone.

A **layout** is a set of positions. Its score is

```
score(L) = | ⋃_{p ∈ L} R(p) |
```

— the number of counted voxels reachable from *any* of its positions, every voxel worth
**1**, counted **once**.

**"Counted" is the group's own target set** (§3.1.2). By default it is the app's marked set
— the enabled zones' union, or the whole valid volume when zones are off — which is what
makes this percentage comparable with the stats panel's. A group that lists **target zones**
replaces it with those zones' volumes; §5.2 then names the target on the axis, because the
two panels' percentages are no longer percentages of the same thing.

**Every voxel is worth the same, and other cameras are ignored.** There is no redundancy
weight here and no `n_others`: the score does not care whether the scene's existing
cameras already see a voxel. Placement answers "where do mounts need to be", and the
redundancy-aware question — "given these mounts, where should each camera look" — is
already answered, by the objective of `aim_optimization.md` §1.1. Splitting the two is
what keeps each one simple enough to state in a line.

**The union is doing the real work.** Because a voxel counts once, two positions that see
the same hall score barely better than one of them, so a clustered layout is *penalised by
the objective itself*. That is why this feature needs no minimum-separation knob, no
overlap heuristic, and no distance proxy: the thing that would justify them is measured
directly.

### 1.3 What the objective does not model

**Aim.** A real camera sees one frustum, not its whole reachable set, so `score(L)` is an
upper bound on what `L` will actually cover — and it is blind to the difference between a
mount in the middle of a hall and one in its corner, which reach the same voxels but
deliver very different coverage through a 60° lens. The workflow closes this by construction:
place, then run **Optimize all aims**, then read the measured coverage the stats panel
already reports. **No number this tool prints is a coverage prediction for the placed
cameras**, and §5.2 labels its axis accordingly.

**Image quality**, incident angle, and lighting are outside the SDK's model
(`camera-coverage-sdk` §20), exactly as in `aim_optimization.md` §1.3. The lever that is
available is the group's **`far`** (§3.1) — set it to the real identification distance and
the reachable set counts only what such a camera could use.

**Cost, cabling, and mounting effort** are not modelled. The tool reports the score at
every camera count (§4.4) precisely because the trade-off between the last camera and its
price is the user's to make, not the objective's.

---

## 2. Why a cached pool, and not a run per trial

The obvious implementation scatters `m` positions, computes the layout's coverage, and
repeats. That costs one `compute()` per trial, and each trial's dirty set
(`camera-coverage-sdk` §13.1) is `m` reachable balls scattered across the site — on the
real 440 × 201 × 1120 m workspace that is most of the chunks, most of the time. Thirty
trials cost half an hour of GPU and every parameter change costs it again.

It is also **slot-bound**. A capture rig is six cameras (§2.1), disabled cameras still
consume mask bits, and `MAX_CAMERAS` is 128 — so `6m + existingCameras ≤ 128` caps `m` at
**5** on a 96-camera site.

Both problems come from the same mistake: re-measuring, every trial, something that cannot
change between trials.

### 2.1 The capture rig and the reachable set

A **build step** places the six-camera **capture rig** of `aim_optimization.md` §2.1 at one position —
`fov = 90°`, `aspect = 1`, oriented along ±X, ±Y, ±Z, at the default `near` and the
group's `far` (§3.1.1) — and reads back which voxels those six frusta see. Their frusta tile the sphere, so their
union is exactly `R(p)`.

The rig is ordinary cameras computed by the ordinary Pass 2, which is what makes a
reachable set agree with the engine's visibility rule by construction rather than by a
second implementation that could drift.

The readback is `AggregateLeafCounts` (`camera-coverage-sdk` §19.1) with
`AggregateSpec.cameras` set to the rig's six bits and the marked filter of §3.3 applied.
A leaf's `count` is the popcount of `mask & cameras`, so **`count > 0` ⇔ the leaf's voxels
are valid, inside the marked set, and reachable from `p`** — the reachable set, already
merged into power-of-two cubes.

**The build step must be `incremental: true`, and that is safe.** An incremental run fires
`onAggregate` only for the chunks it computed, and its dirty set is the moved rig's
`old ∪ new` frusta — so every chunk the *new* position can reach is necessarily in it. A
chunk outside the dirty set holds no voxel the new rig sees, so its absence reads as zero,
which is correct rather than merely tolerable.

### 2.2 Why the reachable set can be cached

`R(p)` depends on the position, the geometry, the voxel grid, the marked set, and
`near`/`far`. It does **not** depend on the other cameras, on their orientations, on how
many cameras exist, or on which other positions a trial happens to draw — because §1.2
gave every voxel the same weight and ignored other cameras.

So the search caches one reachable set per **pool position** and evaluates every trial on
the CPU as a set union. One rig is resident at a time, which collapses both problems of
§2 at once:

| | GPU per trial | Cached pool |
|---|---|---|
| dispatches | one per trial, ~40 of 50 chunks dirty | one per pool position, ~4 of 50 chunks dirty |
| spare slots needed | `6 × maxCount` | **6** — the aim optimizer's own budget |
| `maxCount` ceiling on a 96-camera site | 5 | none |
| cost of changing `maxCount` or `trials` | the whole search again | zero — re-search the cache |
| cost of changing `epsilon` | the whole search again | zero — a scan of the curve in hand (§4.5) |

### 2.3 What this costs, and what it does not

**GPU:** `poolSize` build steps, each an incremental run over the chunks one reachable ball
touches. At the SDK's acceptance baseline (`camera-coverage-sdk` §15: 100 chunks in under
30 s) and `far = 50 m` on the real site, that is roughly 1.2 s per build step — a few minutes
for a 200-position pool, once, with a progress line and Cancel (§5.1).

**CPU:** one trial rasterizes its layout's cached cubes into an accumulating bitset,
counting newly-set bits, so it costs `Σ|R(p)|` writes — a few million, tens of
milliseconds. Thousands of trials are affordable, which matters: the search quality of a
random layout search is set almost entirely by how many layouts it sees.

**Memory:** the cache holds merged cubes, not voxels — `camera-coverage-sdk` §9.5 measures
2.7–5.0 bytes per voxel on a cluttered scene and 0.005 on a large sparse site, so a pool
is megabytes, not gigabytes, and the pool size is not bounded by memory in practice.

**The residual approximations are two**, and neither is hidden: the search only ever
considers the `poolSize` positions it drew (§4.1), and the score is aim-free (§1.3).

---

## 3. Model & state

### 3.1 Constraint group & constraint entities

```ts
// scene/cameraConstraints.ts
export interface ConstraintGroup {
  id: string;            // 'cg-N', unique, stable identity (never renamed)
  name: string;          // user-editable label; defaults to 'Group N'
  enabled: boolean;      // skipped by the search when false; default true

  // Camera template — the model of camera this group is planning for (§3.1.1).
  // Three fields, not five: `near` and `aspect` are placement-wide constants.
  fov: number;           // degrees, vertical
  far: number;           // range in metres; a build-step input (§2.1)
  namePrefix: string;    // placed cameras are named `${namePrefix} N`; '' ⇒ blank names

  // How many candidate positions Build produces (§4.1). Not part of the strategy:
  // it sizes the pool rather than the search over it, it is spent on the GPU
  // rather than on trials, and the panel shows it beside the button that spends
  // it (§5.1).
  poolSize: number;      // P, positions built
  seed: number;          // integer; offsets every constraint's draw sub-sequence
                         // (§4.1) and picks each trial's subset (§4.4). A draw
                         // input first, so it lives beside `poolSize` (§5.1).

  // Target zones (§3.1.2) — which sampling zones this group plans for, and what the
  // list is for. Empty ⇒ the app's own marked set, and both flags are inert.
  zoneIds: string[];         // ids of `Zone`s (`sampling_volumes.md` §2.1); order not significant
  restrictScoring: boolean;  // the target set is these zones' volumes; default true
  restrictMounts: boolean;   // mounts must lie inside these zones' volumes; default false

  // Analysis strategy (§4.4) — persisted, so a run is reproducible from the file (§9).
  maxCount: number;      // the largest layout the analysis considers
  trials: number;        // T, layouts drawn

  // Review policy (§4.5, §5.2) — read *after* the trials, never during them.
  epsilon: number;       // knee tolerance, percentage points of the score rate
}

export type CameraConstraint = {
  id: string;            // 'con-N', unique across all constraints
  groupId: string;       // the owning group (exactly one)
  name: string;          // user-editable label; defaults to 'Constraint N'
  enabled: boolean;      // contributes pool positions when true; default true
  distance: number;      // dilation tolerance in metres, ≥ 0
} & (
  | { kind: 'point'; position: Vec3 }
  | { kind: 'polyline'; points: Vec3[] }                       // ≥ 2 vertices, open
  | { kind: 'plane'; position: Vec3; rotation: Quat; size: [number, number] }
);
```

Both live in canonical arrays in `App.tsx` — `constraintGroups: ConstraintGroup[]` and
`constraints: CameraConstraint[]` — parallel to `cameras`/`probes`/`sections`/`zones`/
`volumes`, and the hierarchy tree references them by id (§7).

**A polyline is open and carries no `closed` flag.** A closed perimeter is expressed by
repeating the first vertex as the last. Two coincident vertices the user must keep in sync
is the cost; the alternative is a flag that every sampler, every measure, every renderer,
and the file format all have to honour, for a case the vertex list can already state.

**Three kinds, and no more, because the group unions.** A four-vertex polyline and three
separate two-point polylines in one group sample **identically** (§4.1 splits by measure
and §1.2 unions the result). The polyline kind therefore buys editing convenience, not
expressiveness — which is exactly why it is worth having a draw mode (§6.2) and not worth
having a fourth kind.

#### 3.1.1 Why the template is on the group, and why it is three fields

The rig runs at the camera's range (§2.1), so **`far` must be known before the pool is
built** — and at that point no camera exists yet. Putting it on the group makes the
search's own input persist beside the cameras it produced, so a layout remains explicable
months later, and it lets one scene plan two camera models (a group of wide-angle fixed
units on the walls, a group of long-range units on the gantry).

The alternative — the `NEW_CAMERA` intrinsics a manually added camera gets
(`scene/sceneReducer.ts`) — has a trap worth naming: a user who places
cameras and then edits their Range has a layout that was chosen for a different `far`,
silently, because every number involved stays plausible.

`fov` does **not** affect the reachable set at all. It is on the template because the
placed camera needs it, not because the search does; `namePrefix` is there for the same
reason.

**`near` and `aspect` are not on the group.** Both come from `DEFAULT_TEMPLATE` — the same
constants a manually added camera gets — for two different reasons:

- `aspect` provably cannot change a reachable set (the rig is six `aspect = 1` frusta) and
  Apply never writes it onto an existing camera (§5.3.3), so a per-group value could only
  ever reach a *created* camera. A field that decides nothing about the search and one
  field of one new camera is not worth a slider in the mode.
- `near` *is* a build-step input, but it is not a **decision**: a metre-scale site has no
  reason to want anything but the default, and every value that differs from it quietly
  rebuilds the pool for a difference no plot can show. Fixing it removes a way to spend
  minutes of GPU by accident (§3.3.1).

Both stay real fields on the placed `Camera`, which is where they are still editable
(`spec.md` §5.2.1). What is gone is a per-group copy of them.

#### 3.1.2 Target zones: what a group plans for, and where it may mount

A group's `zoneIds` names sampling zones (`sampling_volumes.md` §2.1). Two independent flags
say what the list is *for*:

- **`restrictScoring`** (default **true**) — the group's **target set** is the listed zones'
  volumes, replacing the app's marked set as the "counted voxels" of §1.2. This is the
  expressive half: *these cameras are for the loading dock* is a sentence about a group, and
  before this list there was nowhere in the model to write it.
- **`restrictMounts`** (default **false**) — a pool position is kept only when it lies inside
  one of the listed zones' volumes (§4.1.1). This narrows the *mount* region, not the target:
  *on this wall, but only the stretch inside the maintenance bay*.

**One list with two flags, rather than two lists.** The two uses want different sets in
general — mount here, cover there — and a single always-on list would force
mount-region ⊆ target-region, which is frequently wrong on real geometry: zones hug the
surfaces they were seeded from, so the wall bounding a bay often sits just *outside* that
bay's box, and a group targeting the bay would then admit no mount at all. Two checkboxes buy
that expressiveness back without a second list to keep in sync, and a case that genuinely
needs independent sets is served by two groups — which is what groups are for.

**An empty list makes both flags inert**, and the panel disables them (§5). The alternatives
are an empty target set (every position scores 0) and an unsatisfiable mount test (every
position discarded): two different spellings of "empty pool", neither of them a thing anyone
asked for. So an empty list is exactly today's behavior, and the feature costs a scene that
does not use it nothing.

**A non-empty list overrides `useZones` *and* each zone's `enabled`.** The group states its
own target; a display toggle does not get to redefine what a search was run for. Three
consequences, all wanted:

- **Targeting a globally-disabled zone works.** `setSampling` is fed **every** volume
  regardless of `enabled` (`sampling_volumes.md` §7.1), so those voxels are computed and a
  build step can see them. Only the *counting* filter ever read `enabled`, and the group now
  supplies its own.
- **The pool becomes more stable, not less.** The fingerprint (§3.3.1) then covers only the
  **listed** zones' volumes, so toggling an unrelated zone to look at something no longer
  discards minutes of GPU — an improvement on the global coupling it replaces.
- **The group's denominator is no longer the app's**, which §5.2 discloses on the axis
  rather than leaving to be discovered.

**The list lives in `ConstraintGroupPanel`, not in the mode** — the one placement input that
does (§5). It is a **reference to other scene entities** rather than a number: it gives the
group its identity in the hierarchy, it has to survive zone deletion and regeneration (§7,
`sampling_volumes.md` §3.4), and through `restrictMounts` it changes what every constraint in
the group geometrically *means*, which is visible in the viewport whether or not the mode is
open. None of that is true of `fov`, `poolSize`, or `seed`.

### 3.2 The region: membership, measure, projection

For a constraint `c`, let `dist(p, c)` be the distance from `p` to its primitive:

```
point     dist = |p − c.position|
polyline  dist = min over segments of distanceToSegment(p, sᵢ)
plane     dist = |p − nearestPointOnRect(p, c)|
```

where the plane's rectangle spans its **local X and Z** axes with half-extents
`size[0]/2` and `size[1]/2` and its **local Y** is the normal — the same convention a
sampling volume's box uses (`sampling_volumes.md` §2.3), so `{position, rotation}` maps to
a Three.js object with no conversion (§6.1). `nearestPointOnRect` transforms into the
local frame by the conjugate rotation, clamps X and Z to the half-extents, zeroes Y, and
transforms back.

- **Membership:** `inRegion(p, c) ⇔ dist(p, c) ≤ c.distance + REGION_EPSILON`, with
  `REGION_EPSILON = 1e-9` m. The slack is not a tolerance on the user's intent — it is
  arithmetic: the projection below reaches the region's surface by scaling a vector, and
  `0.4 / 30 × 30` is `0.4000000000000001`. Without it the clamp of §6.3 could emit a
  position that fails the very test it was projected into, and a validator would flag a
  camera the app itself just placed. A nanometre is far below any physical meaning on a
  metre-scale site.
- **Measure** — the weight §4.1 splits the pool by. The **primitive's own** measure,
  independent of `distance`: `point ⇒ 1`, `polyline ⇒ Σ|sᵢ|`, `plane ⇒ size[0] × size[1]`.
  Dimension-stable whether `distance` is 0 or 2 m, which region volume is not: at
  `distance = 0` every region's volume is 0 and the split would collapse exactly when the
  user pins things down.
- **Projection** — `projectIntoRegion(p, c)`, used by the drag clamp (§6.3): take `q`, the
  nearest point on the primitive, then `q + min(|p − q|, distance) · unit(p − q)` (and `q`
  itself when `p = q`). The result is always in the region. For a non-convex polyline it is
  not guaranteed to be the *globally* nearest point of the region, which is immaterial for
  a clamp — it is in the region, it is continuous, and it is idempotent.

### 3.3 The pool

```ts
interface PoolPosition {
  index: number;              // position in the group's draw order; stable identity
  constraintId: string;
  position: Vec3;
  /** Reachable set ∩ marked set, as merged power-of-two cubes (§2.1). */
  reachable: LeafCubes;       // { chunkOrigin, index: Uint32Array, size: Uint16Array }[]
  /** |reachable| — the position's own score, shading the scatter (§5.2). */
  count: number;
}

interface Pool {
  groupId: string;
  /** Everything the sets are only valid for (§3.3.1). */
  fingerprint: string;
  /** Positions asked for, not kept — §4.2 can leave the pool short. */
  size: number;
  /** The `seed` the positions were drawn from; compared in §3.3.1. */
  seed: number;
  positions: PoolPosition[];
  /** Positions drawn but dropped by §4.2, for the readout. */
  rejected: number;
  /** |⋃ all positions' reachable sets| — the ceiling any layout from this pool can reach. */
  poolCeiling: number;
  /** Counted voxels in the group's target set — the score's denominator (§5.2). */
  markedTotal: number;
  // Taken from the app's **own display numbers**, never measured during a build
  // step: a build step is `incremental`, so its `onAggregate` fires only for the
  // chunks that rig reaches, and any total assembled there is a partial.
  //   • no target zones — the figure the panels divide by (the enabled zones'
  //     union when zones are in use, else the run's valid volume), which is what
  //     makes the two rates comparable;
  //   • target zones (§3.1.2) — the **sum of the listed zones' own `validVoxels`**,
  //     which the per-zone aggregation already reports for every zone, enabled or
  //     not (`sampling_volumes.md` §7.2). No extra group slot, no extra run. It
  //     over-counts where two listed zones' volumes overlap, so the rate reads
  //     *low* rather than high — the safe direction for a number §1.3 already
  //     calls an upper bound.
  // Before any run has produced one it falls back to `poolCeiling`, so a
  // percentage is never divided by zero.
}
```

**The marked filter comes from `buildAggregateSpec`'s output, never rebuilt.** The build step
descriptor carries the enabled zones' exact OBBs as `regions` and names them in
`leafCounts.maskRegions`, exactly as `aim_optimization.md` §2.2 requires and for the
identical reason: `setSampling` bounds what is *computed* using conservative AABBs, so a
build step that skipped the filter would score the AABB slop and every voxel of every
disabled zone — and then place cameras to see voxels no panel counts. Taking the filter
from the display descriptor rather than rebuilding it is what makes the two unable to
disagree about the word "counted".

**A group with target zones builds its filter the same way, from the same function.**
`aggregateSpec.ts` exports `markedFilterForZones(volumes, zoneIds)`, returning that
same `MarkedFilter` shape over the listed zones' volumes; the no-target path is the identical
function called with the enabled zones' ids, so there is one construction of a filter in the
app rather than two that could disagree. The build-step descriptor carries its **own**
`regions`, unrelated to the display descriptor's, so a target costs no aggregation group and
no zone slot — it is a *smaller* region list, not an extra one.

**A build step never calls `setSampling`** — it inherits whatever validity mask the engine
holds. So the search is blocked while a sampling edit still awaits a run
(`spec.md` §8's `samplingDirty`), with the message of §10.

#### 3.3.1 What invalidates a pool

The pool's `fingerprint` covers the scene geometry, `voxelSize`, the group's **target set**,
its **mount filter**, and its `far`. A change to any of them discards the pool; the panel
says so and offers to rebuild.

The target set is the listed zones and their volumes when `zoneIds` is non-empty, and the
enabled zones and their volumes otherwise (§3.1.2) — so a group with a target is invalidated
only by *its own* zones, and an unrelated zone's `enabled` toggle or geometry edit costs it
nothing. `restrictMounts` and those same volumes enter the fingerprint whenever that flag is
on, because either changes which positions are admissible. `zoneIds` **order** does not: the
set is what matters, so the fingerprint sorts before hashing.

**Camera edits never invalidate a pool** — not adding, deleting, moving, aiming, enabling,
or disabling. This falls straight out of §1.2 and is the property that makes the tool
pleasant to iterate with: place, aim, measure, re-search, all without paying for the pool
again.

**Changing `poolSize` upward extends the pool**; it does not rebuild it. §4.1 draws each
constraint's positions from a prefix-stable sequence, so position `k` is the same position
whatever `poolSize` is, and raising 200 to 260 costs 60 build steps. Lowering it truncates,
and costs none.

**Changing `seed` rebuilds; it never extends.** The seed offsets *every* constraint's
sub-sequence (§4.1), so position `k` under a new seed is an unrelated point. An extend after
a seed edit would append new-seed positions to old-seed ones and hand the analysis a pool
drawn from two seeds — so the pool records the `seed` it was drawn with, and a mismatch
reads `Rebuild` whatever `Size` did. `seed` and `poolSize` are the two *draw* inputs, both
recorded on the pool, both compared against the group's live values, and both resolved into
the button's label — which is why §5.1 puts them in the same card.

A seed edit is deliberately **not** part of the `fingerprint`: that is what `stalePool`
compares, and a seed in it would dim the curve, disable Apply, and say `The scene changed`
about an edit that changed no scene — contradicting §5.1's own rule that a nudged `Seed`
must not cost a good layout. The pool is re-drawn on the next Build; the result on screen is
marked stale, as it is for any other strategy edit.

**The button says which of the three it is about to do** (§5.1): `Build` with no pool,
`Extend to 260` / `Truncate to 120` against a valid one, `Rebuild` when the seed or the
fingerprint has moved. The cost of a press differs by two orders of magnitude across those cases — on the
real site a rebuild is minutes of GPU and a truncate is instant — and `Size` sits directly
above the button, so it is the field a user nudges. A button that read the same in all three
cases would make the cheap edit and the expensive one look identical.

### 3.4 The placement session

A **placement session** is the window during which the six capture slots exist in the
engine's camera list. It reuses the aim optimizer's session machinery verbatim
(`aim_optimization.md` §3.1) — same six ids `opt-cap-0…5`, same slot budget, same rules:

- the slots are **never scene entities**: not in the hierarchy, not selectable, not
  exported;
- every display descriptor the app builds carries `cameras` = the mask of the real
  cameras, so no panel sees the slots;
- **auto-run is suspended** while a session is open (`spec.md` §8.1) — the session drives
  its own `compute()` calls;
- **closing marks the coverage result stale**, because the retained chunks were last
  written with the slots present;
- the budget check is `cameras.length + 6 ≤ MAX_CAMERAS`, and a session and an aim-optimize
  session are **mutually exclusive** (they would claim the same six ids).

**A placement session lives and dies with the placement mode** (§5): the mode is the only
thing that can open one, the tool's columns are on screen for the session's whole life, and
Apply or Close ends both together. The slots are still claimed *lazily* — by the first build step, not
by opening the mode — so entering and leaving without building costs nothing and marks
nothing stale.

Sharing the slots is not an accident of implementation: it is why a placement analysis costs
the same six spare bits as a re-aim, on a scene of any size.

### 3.5 The search outcome

```ts
interface PlacementResult {
  groupId: string;
  /** Indexed by camera count 1..maxCount; entry k is the best layout found at k. */
  best: { count: number; score: number; positions: PoolPosition[] }[];
  /** Trials actually run (a cancel stops early). */
  trials: number;
  /** The §4.5 knee: the smallest count within `epsilon` of `best[maxCount]`. */
  knee: number;
  /** The count the user has selected in the panel; starts at `knee`. */
  selected: number;
}
```

`score` is a voxel count; the panel shows it as a percentage of `markedTotal` (§5.2).

---

## 4. The algorithm

### 4.1 Drawing the pool

**Split.** Each enabled constraint of the group is weighted by `wᵢ`, its **effective
measure** — the §3.2 primitive measure when the group has no mount filter, and the
zone-filtered value of §4.1.1 when it has one — and receives `round(poolSize × wᵢ / Σw)`
positions, with a **floor of 1** for every contributing constraint and the remainder settled
against the largest weights. The floor exists so a single surveyed mount point in a group
full of walls is never starved — and it is also that point's correct share, since a
`distance = 0` point admits exactly one position. A constraint whose effective measure is
**zero** contributes nothing and takes no floor (§4.1.1), so the shares still sum to
`poolSize`.

The remainder is **signed**, and settled the same way in both directions: a shortfall is
handed to the largest weights, and the overshoot the floor creates is taken back from them.
In the example below the floor lifts the post from 0 to 1, putting the shares one over
`poolSize`; the position comes off the wall, which is why the rail keeps its fifth.

```
group: post(point) + rail(polyline, 60 m) + wall(plane, 60 × 40)
weights   1  :   60  :  2400        poolSize = 200
positions 1  :    5  :   194
```

**Draw.** Positions come from a **Halton sequence** — a deterministic low-discrepancy
sequence, meaning its points spread out evenly by construction instead of clumping the way
independent random draws do, and it is **prefix-stable**: its first `n` points are already
well spread and point `n+1` lands in the largest remaining gap. Five dimensions are
consumed per position, always, whatever the kind:

| dims | use |
|---|---|
| 1–2 | a point on the primitive: arc length for a polyline, `(u, v)` for a plane rect, unused for a point |
| 3–5 | an offset uniform in `ball(distance)`: radius `distance · u₃^{1/3}`, direction from `z = 2u₄ − 1`, `φ = 2πu₅` |

Consuming a fixed five keeps the mapping from sequence index to position independent of
kind and of `distance`, which is what makes §3.3.1's prefix-stability hold across an edit.

Each constraint draws from **its own sub-sequence**, offset by a hash of
`(seed, constraint.id)`. So adding, deleting, or editing one constraint does not reshuffle
another's positions, and a rebuild after an edit rebuilds only what changed. A change
to the seed moves all of them at once, which is why §3.3.1 treats it as a rebuild rather
than an extend.

**Positions sit near the primitive, not uniformly in the region.** Sampling the primitive
by measure and then offsetting into the ball is *not* uniform over the dilated region — a
uniform-in-volume draw would pile samples into the outer shell, where the volume is. That
would be the wrong reading of `distance`: it is a tolerance around a rail, not a
suggestion to mount as far off the rail as allowed.

#### 4.1.1 The mount filter, and the effective measure it implies

With `restrictMounts` on (§3.1.2), a drawn position is kept only when it lies inside one of
the group's listed zones' volumes — the ordinary `inVolume` OBB test of
`sampling_volumes.md` §2.3, on the CPU, before any build step. A discarded position advances
the constraint's sequence and is redrawn, as §4.2's rejection does, but under a separate and
far larger attempt cap: this test costs a few dozen flops where §4.2's costs ~1.2 s of GPU,
so there is no reason to be stingy with it.

**Rejection alone is not enough, because it does not fix the split.** The shares above are
proportional to primitive measure, so a 60 × 40 m wall with 5% of its area inside the target
zones still claims 194 of 200 positions and delivers ten, while the rail beside it — wholly
inside the zone — keeps its five. The pool comes up short *and* misallocated, and the readout
blames the wrong constraint.

**So the split is by effective measure, estimated by running the draw.** For each enabled
constraint take `K` positions from its own five-dimensional Halton sub-sequence exactly as
the draw above produces them — primitive point *plus* ball offset — and count how many pass
the OBB test:

```
effMeasure(c) = measure(c) × hits / K            K = 256
```

The estimator **is** the sampler, which is the whole point:

- **it honours `distance` for free.** A rail 0.3 m outside a zone with `distance = 2` yields
  plenty of valid mounts; an estimator that measured the bare primitive's overlap would call
  it zero and drop it. Clipping each primitive against the OBBs would be exact — segment-slab
  for a polyline, convex-polygon for a plane rect — and it is the obvious alternative, but it
  measures the wrong object.
- **it is the acceptance rate the rejection loop will actually see**, so the attempt cap is
  sized from a measurement rather than a guess;
- **it is one geometry path, not two**, so what is estimated and what is drawn cannot drift;
- **it is deterministic under `seed`**, so a group's shares are reproducible from the file (§9);
- and the `K` draws are **not wasted** — they are the sequence's own prefix, which the draw
  consumes next.

**A zero-hit constraint is dropped, and named.** `effMeasure = 0` ⇒ the constraint
contributes nothing and its floor is redistributed. At `K = 256` a dropped constraint had
well under ~1% usable extent, and the residual risk of a false zero is answered by the
readout rather than by a second, adaptive estimate: §5.1's Build card lists **every**
constraint's overlap percentage, so a `0%` beside a `4%` is a visible fact with two obvious
remedies — widen `distance`, or list the neighbouring zone.

**When every constraint reads zero, Build still runs.** The estimate is an estimate, and a
user who knows something it does not should not be stopped by it; the pool comes back empty,
the readout says exactly why (§10), and nothing was spent but CPU. §4.4's trial loop already
analyses an empty pool to nothing, so the empty case needs no new guard — only an
explanation.

### 4.2 Rejecting unusable positions

A drawn position can be buried inside a building. Such a rig sees nothing, so it scores 0
and can never win a trial — but it still burns a ~1.2 s build step, and it is worth rejecting.

**Occupancy classification cannot do the rejecting, in this app.** `engine.ts` disables a
camera whose voxel is `CellType.SolidGeometry`, but the app hard-codes
`solidDetection: false` (`spec.md` §3.2, §4.2) because the flood fill would otherwise
misclassify the enclosed interior of a watertight imported room — and with solid detection
off, `SOLID_GEOMETRY` is never produced at all (`camera-coverage-sdk` §6.2). Nor would a
finer reading help: at metre voxels a camera flush on a wall and a camera 3 m inside the
building are both `MIXED`/`EMPTY`. **Only a raycast separates them**, which is what a
build step is.

So the authority is the **build step itself**:

- **A build step that did not run is a failure, not a rejection.** `engine.compute` reports a
  failure by *returning null* rather than throwing (`engine/useEngine.ts`), and a failed run
  yields no chunks — which at the call site is indistinguishable from a position that saw
  nothing. Conflating the two made a broken engine look like this rejection rule firing on
  every draw: no error was raised, the session kept its capture slots, and the Run button
  stayed disabled with nothing on screen explaining why. Whether the run *happened* is
  therefore carried separately from what it found, and `classifyBuildStep(ran, count)` is
  where the two meet — `failed` aborts the pool and closes the session, `rejected` redraws.
- A built position whose reachable count is **0** is **rejected**, and the constraint's
  sequence advances to draw a replacement, until the constraint's share is filled or an
  attempt cap of `3 × share` is hit (a constraint buried entirely inside geometry must
  terminate).
- One rule covers every cause — inside a wall, outside the workspace, sealed in a closet,
  or beyond every voxel of the group's target set. All four make the position useless as a
  mount, so none of them needs to be distinguished. **The mount filter is not among them**:
  its discards happen before the build step, cost no GPU, and are already priced into the
  effective measure that sized the share (§4.1.1). Counting them here would put a
  minutes-of-GPU signal and a free one under one number, and `rejected: 190` would read as a
  broken scene when it meant the sampler resampled.
- The count of rejections is reported (§5.1); a constraint that filled nothing is named.
- `CAMERA_INSIDE_GEOMETRY` is **suppressed for the capture slots** for the duration of a
  session (§10). A rig somewhere unusable is this tool's normal operation, not a scene
  misconfiguration, and six warnings per rejected position would bury the status area.

**An optional pre-screen may skip build steps but never decides anything.** Before building,
the tool may cast a short ray from the candidate along each of the six rig axes against the
app-side BVH (`sampling_volumes.md` §3.1) and skip the build step when **all six** hit within
`min(2 · voxelSize, 1 m)` — a position enclosed on every side. A wall-flush mount fails the
test (five of its six rays escape) and is built normally.

This is a **heuristic accelerator, not a classification**: it can only skip build steps whose
outcome would have been a rejection anyway, the post-build rule above stays the authority,
and a scene where the heuristic never fires behaves identically, only slower. That
asymmetry is what makes it safe to use a second geometry structure here, where §4.2's
earlier draft could not — nothing it decides is load-bearing.

### 4.3 Building

Each surviving position is built once (§2.1) and its `LeafCubes` and `count` stored.
Build steps run one at a time with the same six slots, `incremental: true`, and a progress
line; **Cancel** stops at the next build-step boundary and keeps the pool built so far,
which is usable — a partial pool is a smaller pool, not a broken one.

### 4.4 The analysis: trials and the prefix curve

A **trial** draws `maxCount` distinct pool positions, in random order, and scores every
prefix:

```
for t in 0..trials:
  order = shuffle(pool, prng(seed, t))[0..maxCount]      # distinct, random order
  bits.fill(0)                                            # scratch bitset
  n = 0
  for k in 1..maxCount:
    n += rasterize(order[k-1].reachable, bits)            # counts NEWLY set bits only
    best[k] = max(best[k], n)                             # with its positions
```

**One rasterizing pass yields a sample at every count.** A random prefix of a random
scatter *is* a random scatter of the smaller size, so a trial contributes a layout at
1, 2, …, `maxCount` cameras rather than only at `maxCount` — the whole curve for the price
of the largest point on it. Counting only newly-set bits makes the incremental score exact
and makes the pass cost `Σ|R(p)|` rather than `maxCount × |U|`.

Trials are **independent**: nothing carries over between them and the best layout at each
count is kept whole. The PRNG is seeded from `(seed, trialIndex)`, so an analysis is
reproducible from the group's own record (§9) — which is the point of seeding at all, in a
tool whose output ends up on an installation drawing.

**The trial loop is the *analysis*, and the control that runs it is `Analyze` (§5.1).** The
word carries into the code — `analyze.ts`, `runAnalysis` — rather than being a label over a
module still called `search`, so one thing has one name. It is worth saying what an analysis
is *not*: it measures nothing about coverage. It searches layouts over a pool of
already-built reachable sets, and every number it produces is the aim-free upper bound of
§1.3. The axis stays labelled **reachable** (§5.2) for exactly that reason.

Because the pool is drawn proportionally to measure (§4.1), a uniform draw *from the pool*
is already measure-proportional; the trial needs no weighting of its own.

**The best-per-count curve cannot dip.** Every trial contributes a *nested* chain of
layouts, and `best[k]` is the maximum over the same trials of a prefix score that is itself
non-decreasing in `k` — so `best[k] ≥ best[k−1]` holds by construction, not by luck. This
is worth stating because it means a flat stretch of the curve is **not** evidence that more
cameras would not help: it may equally be evidence that too few layouts were tried at that
count. The pool ceiling (§5.2) is what separates those two readings, which is why it is
drawn.

### 4.5 The knee

```
knee = min { k : best[k].score ≥ best[maxCount].score − epsilon·markedTotal/100 }
```

— the fewest cameras whose best layout comes within `epsilon` **percentage points** of the
best score the analysis found at all. `epsilon` defaults to **1.0 pp**.

**The knee is computed from the finished curve, not during the search.** `epsilon` appears
nowhere in §4.4: the trial loop scores every prefix count regardless, and the knee is a
single scan of the curve afterwards. So it is recomputed **live** whenever the tolerance
moves — no new trials, no GPU, and the result is not marked stale (§5.1). It is a reading of
an answer already in hand, which is what makes it a *review* control rather than a search
one, and what puts it in §5.2's column rather than §5.1's.

The knee is a **preselection, not a verdict**. `epsilon` is a policy the user owns — the
`Knee (pp)` slider of §5.2, labelled with its unit because the knee itself is a *count*
while this is the *tolerance* that picks it, and a bare "Knee" holding `1.0` under a
"Count 8" slider reads as the wrong one. `pp` is not a unit every user knows, so the row
carries a **tooltip** spelling the field out — `How far below the best score found still
counts as good enough, in percentage points of the reachable rate. Raise it to accept fewer
cameras.` — which is also its `aria-label`. The
curve is shown beside it, and the count slider (§5.2) moves freely: the same reasoning
`aim_optimization.md` §5.2 gives for shipping a heatmap instead of a single proposed
angle — a user deciding whether to trust an answer needs to see whether it sits on a
plateau or a knife edge.

### 4.6 Repositioning a bound camera

A camera carrying `constraintId` (§6.3) has a **Reposition** action in its own panel. It
pools over **that one constraint** (its `poolSize` share scaled up to the group's
`poolSize`, since it is the only constraint being sampled) and moves the camera to the
highest-`count` position — a `maxCount = 1` search, which needs no trials at all because a
one-camera layout's score is just that position's own `count`.

The camera's rotation, name, id, and intrinsics are untouched. Repositioning is the
answer to "this camera is on the right rail but in the wrong place on it"; it does not
consider the rest of the layout, for the same reason §1.2 does not.

---

## 5. Where the tool lives

**Camera placement is a mode, not a panel.** Opening it keeps the app's three-column shell
and **replaces what the two side columns hold**: the left column becomes the tool's inputs,
the right its review, and the viewport keeps the middle. The hierarchy, the selection
inspector, the run bar, the overlay and zone tools, and the stats panel are all unmounted
for the mode's whole life, and **the session lives and dies with it** (§3.4).

It is a mode, rather than panels added beside the app's own, because of what it must not
allow. While a session is open, auto-run is suspended and the stats panel would be quoting
the *previous* run; no constraint can be edited without invalidating the pool (§3.3.1); and
nothing else is selectable, which is what lets the tool know which group it is working on
without asking. Hiding those columns is not decoration — it removes the two ways a session
could be stranded: navigating away from the tool, and editing the geometry underneath it.

**The mode targets exactly one group — the one selected when it opened** — so there is no
group dropdown. That is why the tool left the sidebar: a dropdown that re-picks the target
is a second selection model living beside the hierarchy's, and it existed only because a
panel that shared the column with everything else had no other way to know which group the
user meant.

What lives in the left column when the mode is **closed** is what belongs to a selected
entity: the group's name, its constraint count, its **target zones** (§3.1.2), and the
**Place cameras** button that opens the mode, in a **`ConstraintGroupPanel`**; and a
constraint's kind, `distance`, geometry, and vertex list in a **`ConstraintPanel`** (§6).

**The camera template is not in that panel** — it is in the mode, as §5.1's third card. It
is an input to a placement run, not a description of the group, and none of its fields is
read until the mode is open. Outside, it cost the panel a heading and a second thought, in a
panel whose one job is to get you into the tool; and it forced the mode to restate the
template read-only (§5.2), because the panel that owned it was hidden.

**The target zones are the one placement input that stays**, for the reasons §3.1.2 gives:
they are a reference to other entities rather than a number, they must outlive zone deletion
and regeneration (§7, `sampling_volumes.md` §3.4), and with `restrictMounts` on they change
what the constraint gizmos in the viewport *mean*. The card is:

```
┌─ CONSTRAINT GROUP — Dock ─────────┐
│  Name          [Dock          ]   │
│  Constraints                  3   │
│  ─────────────────────────────    │
│  Target zones                     │
│   ☑ Restrict scoring to zones     │
│   ☑ Restrict mounts to zones      │
│   Add zone  [ add a zone…    ▾ ]  │
│   Loading dock                ×   │
│   Bay 2                       ×   │
│   Dock rail 100% · N wall 4%      │
│  ─────────────────────────────    │
│  [ Place cameras ]                │
└───────────────────────────────────┘
```

With an empty list the two rows below the flags are replaced by a single `.hint` —
`No target zones — this group scores against the whole marked set.` — so "no zones" reads
as a state rather than as an unfinished control.

- **The `<select>` lists only the zones not already listed**, so it *is* the add control and
  a duplicate is impossible by construction. It is the app's standard `.select` — the same
  control `VolumePanel` uses to reparent a volume — so this card needs no new component and
  no chip or tag styling the app does not already have.
- **One `.row` per listed zone**, showing its `zoneLabel` (`sampling_volumes.md` §6.2) and an
  `.icon-btn` `×`. The list shows only what was picked, so it stays short on a site whose BVH
  cut produced dozens of zones — which a checkbox list of all of them could not.
- **Both checkboxes are disabled while the list is empty** (§3.1.2), with the tooltip
  `Add a target zone to use these.`
- **The `<select>` carries the app's standard `.row` label** (`Add zone`), like every other
  labelled control in the inspector. The label names the control; the option text
  `add a zone…` says the control is an action — the two are not redundant, and dropping the
  label would make this the one control in the column with no name beside it.
- **`restrictMounts` dims the group's constraint gizmos outside the listed volumes** while
  the group is selected (§6.1). A wall with no overlap then looks different from a good one
  *before* Build is pressed, rather than after minutes of GPU.
- **The dimming is never the only cue.** A dimmed gizmo and a *disabled* constraint's gizmo
  take the same ramp deliberately — for a placement run they mean the same thing — so the
  card carries the §4.1.1 overlap percentages as a `.hint` under the list whenever
  `restrictMounts` is on: `Dock rail 100% · North wall 4% · Rail 2 0%`. That is the
  redundant text cue `VISUAL_DESIGN.md` requires beside any state carried in a visual
  channel, it is the same line §5.1's Build card shows, and it names which wall to move,
  widen, or stop listing rather than leaving the viewport to be interpreted.
- **Nothing here is a coverage input** (§1.1): no edit marks the coverage result stale. Every
  edit does move the pool's fingerprint (§3.3.1), so Build's label flips to **Rebuild** the
  next time the mode is opened.

### 5.1 The flow

**Place cameras** sits at the bottom of the selected group's panel. It is disabled, with the
reason stated in place, whenever the group cannot be searched — no constraints, an
aim-optimize session already open, the engine not ready, sampling pending (§10) — so the
mode is never entered straight into a blocker.

Entering the mode swaps both columns and hides the viewport's **transform** toolbar (nothing
is selectable inside it), keeping the **View** selector and the **layer menu**, which is what
shows the scatter and the constraint gizmos (`spec.md` §2.4). It claims no capture slots by
itself: the first build step opens the session (§3.4), so a mode entered and left again costs
nothing and marks nothing stale.

**The mode's group counts as selected** for the disabled-entity rule (`spec.md` §2.4.3).
Nothing stops the mode being entered on a group whose own checkbox is off, and its
constraints would then be hidden — leaving Build to scatter a pool of candidate dots over
rails that are not drawn. Treating the open group as selected keeps them on screen at the
selected-disabled tier, and reuses §2.4.3's one exception rather than adding a second.

```
┌─ 340 ──────────────────┬──────────────────────┬─ 340 ────────────────┐
│ CANDIDATE POSITION POOL │                      │ Dock rail            │
│  200 positions ·       │                      │  ╭──●───●            │
│  37 rejected ·         │       VIEWPORT       │ ╭●      reachable    │
│  ceiling 96.2%         │                      │ ●                    │
│  ───────────────       │   pool scatter ·     │  1  4  8  12         │
│  Size        [ 200]    │   plan preview ·     │  count [───●───] 8   │
│  Seed          [ 7]    │   constraint gizmos  │  knee(pp) [─●─] 1.0  │
│  ───────────────       │                      │ Cameras          8   │
│  [Extend to 260]       │                      │ Reachable    94.1%   │
├────────────────────────┤                      │ Pool ceiling 96.2%   │
│ STRATEGY               │                      │ Apply moves 5 ·      │
│  2000 trials ·         │                      │              12.3 m  │
│  knee 8 cameras        │                      ├──────────────────────┤
│  ───────────────       │                      │ [Apply · move 5 ·    │
│  Max cams     [ 12]    │                      │         add 3]       │
│  Trials     [ 2000]    │                      │ [Close]              │
│  ───────────────       │                      │                      │
│  [Analyze]             │                      │                      │
├────────────────────────┤                      │                      │
│ NEW CAMERA DEFAULTS    │                      │                      │
│  Name prefix [Dock]    │                      │                      │
│  FOV     [───●──] 90   │                      │                      │
│  Range   [──●───] 25   │                      │                      │
└────────────────────────┴──────────────────────┴──────────────────────┘
```

**The left column is three cards, and each of the first two owns its own button's
feedback.** *Candidate position pool* holds `Size` and `Seed`, the Build button, its progress
line, its readout, its blocker, and the Cancel that stops a build step. *Strategy* holds the
two fields, the Analyze button, its trial progress, and the Cancel that stops an analysis.
Cause and effect stay adjacent: the reason Build is disabled is read where Build is, not
across the window.

**The third card is *New camera defaults* — the camera template (§3.1.1) — and it sits at
the bottom, under two buttons rather than above them.** It is the least-touched card of the
three: `Name prefix`, `FOV` and `Range` are set once for a group and then left alone, while
`Size`/`Seed` and `Max cams`/`Trials` are what a session iterates on. Putting the settled
card first would push both buttons down the column for the whole of every session. It
carries no button of its own, which is what lets it sit under two that do — nothing in it
needs a press to take effect.

It is titled **defaults** rather than "template" because that is what the fields are from
the scene's point of view: the optics every camera this run *creates* starts at (§5.3.3).
`Range` is the one that is also a search input, and its cost is stated where it is paid —
editing it moves the pool's fingerprint, so Build's label two cards up flips to **Rebuild**
(§3.3.1). `FOV` and `Name prefix` are spent only at Apply and mark nothing stale.

**`Seed` is a draw input, not a search input**, which is what puts it in the first card. It
picks *which* points get built — it offsets every constraint's sub-sequence (§4.1) — so it
is spent on the GPU with Build, and it is the field that decides between an extend and a
rebuild (§3.3.1). `Max cams` and `Trials` re-run for free over the pool in hand; `Seed`
cannot. That is the same test that keeps `Size` out of *Strategy*, and the two
draw inputs now sit together above the button that spends them.

**`Knee (pp)` is not in either card, and for the opposite reason to `Size` and `Seed`.**
Those two are too *early* for the strategy card: they decide the pool the search runs over.
The tolerance is too *late* — it reads the finished curve (§4.5), so the one card it should
not sit in is the card whose button re-runs the trials. There, it was the only field whose
edit demanded an **Analyze** that would spend `trials` trials recomputing a number already
derivable from the plot on screen. It belongs beside that plot, and §5.2 is where it goes.

**Each card states its result directly under its title**, above the controls that produced
it: `200 positions · 37 rejected (saw nothing) · ceiling 96.2%` in the first,
`2000 trials · knee 8 cameras` in the second. It sits above rather than below because it is
what the card is *about* once it exists — reading the pool you have is what tells you
whether the `Size` beneath it is worth changing — and because the two cards then answer the
same question in the same place. The strategy card's line carries the §5.1 stale mark too,
so the fields and the result they no longer describe cannot be read apart.

1. **Build** — draws (§4.1), builds (§4.3), rejecting as it goes (§4.2). A progress line
   reads `building 43/200 · Dock rail`, with **Cancel**. On completion the readout names
   the pool: `200 positions · 37 rejected (saw nothing) · ceiling 96.2%`.

   **With a mount filter on (§3.1.2) the card also lists each constraint's overlap** with the
   target zones — `Dock rail 100% · North wall 4% · Rail 2 0%` — from the §4.1.1 estimate,
   which costs no GPU and so is on screen *before* Build as well as after. It is a percentage
   per constraint rather than a count of discards because that is the number with a remedy
   attached: under effective-measure splitting a discard count is only the sampler hitting its
   expected rate and means nothing on its own, while `North wall 4%` says which wall to move,
   widen, or stop listing.

   **With target zones the card also states the denominator** — `target 2 zones ·
   41,300,000 voxels` — because §5.2's percentages are of that number and not of the one
   the stats panel divides by (§3.3). The count is written the way every other voxel total
   in the app is (`toLocaleString`), so two figures on screen never differ in format when
   they agree in kind.

   The button states the *work*, not the noun — the card's own heading already says what is
   being built, and what the user needs from the label is which of §3.3.1's three cases the
   press will cost: **Build** with no pool, **Extend to 260** or **Truncate to 120** against
   a valid one, **Rebuild** once the fingerprint has moved. "Pool" is the right word in this
   spec and in the code, where its caching rules are the whole design; it is the wrong word
   on a button, where it names an intermediate the user has no reason to think about.
2. **Analyze** — runs `trials` trials (§4.4) on the cached pool. Milliseconds to seconds,
   with a progress line and Cancel; re-runnable at zero GPU cost after any strategy change.
3. **Review** — the curve, the slider, the scatter (§5.2), in the right column.
4. **Apply** (§5.3) or **Close**, pinned below the right column's scroll region.

**An edit marks the result stale rather than clearing it.** Change a strategy field, or a
`Size` that grows or truncates the pool, and the curve dims, takes a `Strategy changed —
Analyze again` note, and keeps its stats, its viewport preview, and a live **Apply**.
`Knee (pp)` is **not** such an edit: it stales nothing, because it asks for no trials (§4.5)
— it recomputes the knee from the curve already held and moves the marked dot.
**Pressing Build does clear it** — a layout is a list of indices into the pool, and Build is
the press that changes the pool underneath them. This is
the app's own stale idiom (`spec.md` §8.1) applied to the analysis, and it is the right
trade in both directions: the fields now sit permanently beside the curve, so silent
disagreement between them would be visible and unexplained — while clearing the result
outright would throw away a good layout because someone nudged `Seed`.

**A session always offers a way out**, and the mode is what guarantees it: the columns
cannot be navigated away from, and **Close** is pinned below the right column's scroll
region rather than flowing after the stats, so it is on screen however far the user has
scrolled. `slotsActive` is what disables the Run button (§3.4), so a session with no visible
exit strands the whole app — which is exactly what a failed build step did in the sidebar
panel, before §4.2 distinguished a failure from a rejection.

**Leaving** — **Apply** or **Close** — closes the session, restores both columns and the
selection the mode was entered from, and marks the coverage result stale if slots were ever
claimed (§3.4).

**Close asks first when a pool is in hand**, and only then:

```
Discard the built pool?
200 positions · rebuilding needs another full pass.
                                    [Keep open]   [Discard]
```

The guard is anchored over the **Close** button that raised it. The asymmetry in the confirm
is the asymmetry in the costs: a pool is minutes of GPU on a real site (§2.3) and every
analysis after it is milliseconds, so Escape and Close are cheap to press and the thing they
throw away is not. With no pool built, Close is silent and immediate; a build step still
running is stopped by its own **Cancel**, not by Close.

Build and Analyze are separate buttons — separate *cards*, now — because their costs differ
by three orders of magnitude, and conflating them would hide which one the user is waiting
for. Changing the strategy invalidates only the analysis; changing anything in §3.3.1
invalidates the pool — and inside the mode, only `Size` and the strategy are editable, so
the pool can only be invalidated by leaving.

### 5.2 The curve, the slider, and the scatter

```
        ┃                              ← headroom above the ceiling
    96% ┤- - - - - - - - - - - - - - -   pool ceiling (dashed)
        ┃                        ●───●
    48% ┤            ◉───●               ◉ knee (8)
        ┃    ●───●
     0% ┤  ●
        ┗━━┬───┬───┬───┬───┬───┬───┬──
           1   2   3   4   6   8  10   cameras

  count      [────────●────────]  8    score 94.1%  ·  pool ceiling 96.2%
  knee (pp)  [──●──────────────]  1.0  ← moves the ◉, spends no trials
  [Apply 8 cameras]   [Close]          ← pinned below the scroll region
```

The whole of this lives in the right column, under the group's name. **There is no
read-only template summary beside it.** One existed only because the panel that owned the
template was hidden for the mode's life; the template is now the left column's third card
(§5.1), editable, one column over — and a read-only copy of an editable field on the same
screen is a thing to keep in sync, not a thing to read.

- **The Y axis is labelled "reachable", never "coverage".** It is `score/markedTotal`, an
  aim-free upper bound (§1.3) — labelling it "coverage" would invite reading it against the
  stats panel's measured rate, which is the one misreading this feature can cause. It is
  **drawn**, not merely named: a value axis with three ticks, labelled as the same
  percentage the stats below quote, so a curve cannot be read as a shape without a scale.
  **With target zones (§3.1.2) the axis names them** — `reachable — Loading dock, Bay 2`, or
  `reachable — 3 zones` past two. §3.3 borrowed the display descriptor's filter precisely so
  that placement and the stats panel could not disagree about the word "counted"; a target
  set breaks that on purpose, so the axis says what it is a percentage *of* rather than
  leaving a user to discover that `94.1%` here and `94.1%` there are percentages of different
  denominators. **The `Reachable` stat line below the plot names it too** — the stat and
  the axis are the same percentage of the same set, so labelling one and leaving the other
  bare is the drift this rule exists to prevent; both take the same one-line treatment,
  two names in full and a count past that. The resolved voxel total sits in the Build card
  beside it (§5.1).
  The plot keeps **at least a tenth of its height empty above the highest value** — the
  ceiling is an asymptote at or near the top of the range, and drawn flush to the frame it
  reads as a border rather than as the bound the curve is approaching. The headroom is taken
  in *value* space, not as a pixel pad, so it stays a tenth whatever height the plot is
  given.
- **The pool ceiling** is drawn as a dashed asymptote. It is what *every* pool position
  together would reach, so it separates "more cameras would not help" from "this pool is
  too small" — two conclusions a bare curve conflates.
- **Moving the slider previews that layout in the viewport** — and because Apply
  re-arranges rather than appends (§5.3), the preview shows
  the **plan**: each moved camera drawn at its chosen position with a line back to where it
  stands today, each created camera drawn at the group's template, and each surplus camera
  marked for the disable of §5.3.1. Every prefix layout is already in hand, so this is free.
  A preview that showed only new cameras would hide both halves of what Apply is about to do.
- **The pool scatter**: all `poolSize` positions drawn as small dots shaded by their own
  `count`, with the selected layout's positions highlighted. It answers "where are the good
  mounts on this wall", which is the question a user asks immediately after seeing the
  curve, and it costs nothing — the data was already built. The dots are sized in **screen**
  space, a few pixels each: the same overlay has to read on a 6 m demo room and on a
  440 × 201 × 1120 m site, and a world-space dot small enough for the first is under a pixel
  in the second — drawn, and invisible. For the same reason it is drawn as an instanced
  **sprite** rather than as points: WebGPU's point primitives are fixed at one pixel
  (three's `PointsNodeMaterial` says so, and names the sprite as the fix), so a `Points`
  scatter renders and cannot be seen. Toggled by the
  **Constraints** entry in the viewport layer menu (`spec.md` §2.4), which also governs the
  constraint gizmos — the one menu the mode keeps, because this is what it is showing.
- **The knee tolerance sits directly under the count slider**, as a second slider with the
  same editable readout (`spec.md` §5.2.1). It is the knee's own definition — how far below
  the best score found still counts as good enough — and the ◉ it moves is marked on the plot
  immediately above, so scrubbing the tolerance walks that dot along the curve. It is
  recomputed live (§4.5): no trials, no GPU, and no stale mark. `pp` is not a unit every user
  knows, so the row carries a tooltip, which is also its `aria-label`:

  > How far below the best score found still counts as good enough, in percentage points of
  > the reachable rate. Raise it to accept fewer cameras.

  It is stated in **percentage points** and not in `%` because the drop is absolute in the
  rate the axis is ticked in — `top − epsilon·markedTotal/100` (§4.5), not a fraction of
  `top`. The two agree to a rounding error at a 94% ceiling and diverge at a low one, which
  is exactly the site where a user would be reading the number carefully.
- **The count follows the knee until the user overrides it.** An analysis selects the knee;
  a tolerance edit re-selects the *new* knee, but only while the count still sits on the old
  one. Once the count slider has been moved by hand, the tolerance moves the ◉ and the
  readout and leaves the count alone: a hand-picked count is a decision, and the tolerance is
  only the policy that suggested one. The next **Analyze** clears the override.
- **Both rows are the app's standard slider-plus-field** (`spec.md` §5.2.1). Two adjacent
  sliders in one card, one carrying an editable readout and one not, would read as two
  different kinds of control — so `count` gains the same typeable field every other slider
  in the app already has.
- **A stale result is dimmed, not withdrawn** (§5.1). The curve, the slider, the scatter and
  the preview all stay: they are the last answer over a real pool, and the note says what
  would change if it were recomputed.

### 5.3 Apply — re-arrange first, create only what is missing

**Apply moves the cameras the group already has onto the chosen positions**, and creates
new ones only when the layout needs more than the group has. It is one state update — one
staleness mark, one auto-run (`spec.md` §8.1) — and it closes the session and leaves the
mode (§5.1), so the run the user is about to read happens with the app's own columns back.

This is the difference between a placement tool and a camera generator. A site already has
cameras on its rails; the answer to "where should eight cameras go" is *these eight
cameras, moved there*, not eight more bolted up beside them. Appending was the first
design, and it turned every re-search into a scene the user then had to prune by hand.

**The group's bound cameras are the pool of movable hardware.** A camera counts as the
group's when its `constraintId` names **any** constraint of that group (§6.3) — so Apply
may hand a camera a position on a *different* constraint of the same group, and rewrite its
binding to match. That is deliberate: a group is one budget of cameras over one set of
mount options, and a rail and the wall beside it are alternatives, not separate budgets.

#### 5.3.1 The plan

Given `positions` (the selected layout, `|positions| = selected`) and `bound` (the group's
cameras, in hierarchy order), Apply derives three lists:

| | when | what happens |
|---|---|---|
| **moves** | `min(|bound|, |positions|)` of them | an existing camera is re-arranged onto a position |
| **creates** | `|positions| − |bound|`, if positive | a new camera at a position the group could not staff |
| **disables** | `|bound| − |positions|`, if positive | a surplus camera the chosen count does not need, switched off where it stands |

**A surplus camera is disabled, not deleted.** Only its `enabled` flag goes false; its id,
name, position, rotation, lens, and binding all stay. That is exactly the state the
hierarchy's own eye toggle produces (`spec.md` §5.4) — a dimmed gizmo, still selectable and
still editable, contributing nothing to `compute()` — so the result reads as *the approved
layout, plus the hardware the layout did not need*.

Deleting them was the first design, and it was wrong in both directions: it destroyed names
and per-camera edits in an app with no undo, and it threw away the very thing the user is
deciding about. A camera the search did not use is not a mistake; it is a mount the site
still has, and the next search at a higher count will pick it straight back up (§5.3.3).

**The button still states the plan** — `Apply · move 8 · disable 4`, or
`Apply · move 5 · add 3` — but now as information rather than as a warning: nothing is
lost, and any one of those four can be switched back on by hand.

#### 5.3.2 Which camera goes where

The pairing minimises the **total distance moved** over all pairs, solved as an assignment
problem (Hungarian, `O(n³)` — microseconds at these sizes).

Every metre is a physical re-installation, so total travel is the real cost, and at these
sizes there is no reason to approximate it: greedy-nearest can be forced into an
arbitrarily long move by one early pick, and hierarchy order ignores distance altogether
and can send every camera across the site for nothing. Ties are broken by hierarchy order
so the result is deterministic.

When there are more positions than cameras, the assignment runs over the cameras and the
positions **win** them; the unstaffed positions become `creates`. When there are more
cameras than positions, the assignment runs over the positions and the cameras that win
none become `disables` — so the cameras switched off are the ones furthest from anywhere
the layout wants, which is the right four to stand down.

**A disabled camera is still movable hardware.** `bound` is every camera bound to a
constraint of the group, enabled or not — which is what makes a disable reversible by
re-searching rather than only by hand. The cost stays pure distance: the assignment does
**not** discount a camera for being already-disabled, because flipping a flag costs nothing
on site while every metre of travel is a physical re-installation.

#### 5.3.3 What a move writes, and what it leaves alone

A re-arranged camera keeps its identity. Apply writes **only what the search depended on**:

| written | left alone |
|---|---|
| `position` — the chosen position | `id`, `name` |
| `constraintId` — that position's constraint | `rotation` — **placement does not aim** (§1.3) |
| `near`, `far` — the range the pool was built at (§2.1) | `fov`, `aspect` |
| `enabled: true` — the layout's cameras are live | `aimLocked` |

`near`/`far` are overwritten because the pool was built at that range (§2.1) — `far`
from the group, `near` from the placement default (§3.1.1): a camera with a different range
was scored against a reachable set it does not have, so the applied layout would not be the
layout that was searched. `fov` and `aspect` are left alone
because they provably do not affect a reachable set (§3.1.1) — the search never depended on
them, so Apply has no business touching a lens the user tuned.

`enabled` is written **true** on every move, because a previous Apply may have disabled that
same camera (§5.3.1). A layout the curve scored at 8 cameras has to be 8 *contributing*
cameras, or the number on the button is not the number in the scene. It is the one field
Apply both sets and clears, and the asymmetry is the point: within the group, the chosen
count is the authority on how many cameras are live.

A **created** camera gets the next free `cam-N` id, a `name` of `"<namePrefix> <i>"` (blank
when `namePrefix` is empty, displaying as `Camera N` per `spec.md` §5.6), the group's
`fov`/`far` with the default `aspect`/`near` (§3.1.1), that position's `constraintId`,
`enabled: true`, and
`rotation = IDENTITY_QUAT` — the same rotation `addCamera` gives a manually added camera
(`scene/sceneReducer.ts`).

**Nothing is aimed.** The completion line says so: `8 cameras placed. Run Optimize all
aims to aim them.` Moves and creates both count toward the number — they are the
contributing cameras the chosen count promised — and disables do not.

Apply closes the mode (§5.1), so the line cannot live in the review column: the panel that
would carry it unmounts in the same commit. It goes to the **status area** beside the run
bar, which is the column Apply returns the user to and which sits directly above **Optimize
all aims**. It clears when the aims are applied — the thing it asked for — or when a new
session opens, so a stale line never outlives its plan.

#### 5.3.4 Gating

Apply is gated on **`cameras.length + creates.length ≤ MAX_CAMERAS`** — a re-arrange
consumes no new slot, and a disable frees none: a disabled camera stays in the scene and
keeps its mask-bit index (`spec.md` §5.4). Only `creates` can push a scene over the limit,
so a plan of moves and disables never hits it, however full the scene is.

**Close** drops the pool and the result, closes the session, and leaves the mode (§5.1) —
asking first whenever there is a pool to lose.

Nothing here is a measured number. The honest measured statement is the run that follows,
and after the user aims the cameras the stats panel and the per-zone table
(`sampling_volumes.md` §7.4) report it in the terms they already use — which is why this
feature deliberately ships no before/after table of its own.

---

## 6. Viewport representation & editing

### 6.1 Gizmos

A constraint draws as its **primitive plus its dilation**, in a distinct colour from the
sampling-volume boxes (`VISUAL_DESIGN.md`):

| kind | primitive | dilation shown as |
|---|---|---|
| point | a small sphere handle | a translucent sphere of radius `distance` |
| polyline | a polyline through vertex handles | a translucent capsule chain of radius `distance` |
| plane | a translucent rectangle with an outline | a translucent rounded slab of half-thickness `distance` |

`distance = 0` draws the primitive alone. The dilation is translucent and non-pickable —
the handles are what the pointer hits.

**Every filled body is translucent, primitive or dilation.** A constraint marks out where
cameras may go; drawn opaque it hides the geometry the user is placing them against, which
is the one thing they need to see at the same time. So a plane's rectangle takes the same
opacity ramp as a dilation — 0.16 selected, 0.10 enabled, 0.06 selected-disabled
(`VISUAL_DESIGN.md`) — and only the crisp parts, the vertex/point handles and a polyline's
segments, draw opaque. This is what "a translucent rectangle" above means: the rectangle
is a fill, not just an outline, and it reads the way the point constraint's ball does.

**A disabled constraint is not drawn at all**, nor is any constraint of a disabled
group (`spec.md` §2.4.3) — the ramp's old bottom rung, a 0.04 disabled fill, is gone.
A disabled constraint reappears only as the selection, at the 0.06 selected-disabled
fill with its handles and lines at 0.35, which is the same pair a selected but
**mount-excluded** constraint takes (§4.1.1): both mean *selected, and contributing
nothing*. Selection is the only way to see a disabled constraint, which is also the
only way to edit one without re-ticking its box first.

**No normal indicator is drawn**, and this is deliberate. An earlier draft of the table
gave the plane "a normal tick" — a stub along its local +Y — to make the orientation of a
sheet-thin rectangle legible edge-on. The fill now does that job from every angle but
exactly edge-on, and more to the point the normal carries **no meaning here**: a plane's
region is a slab extending `distance` to *both* sides (§3.2) and nothing seeds camera aim
from it, so a tick would advertise a distinguished face the tool does not distinguish.
Don't add one back without a rule that makes one side different from the other.

Transform gizmos follow `spec.md` §2.4's modes: a **point** is Move-only; a **plane** gets
Move, Rotate, and **Scale** (scaling `size`, exactly as a sampling volume does,
`sampling_volumes.md` §5, so `{position, rotation}` needs no conversion); a **polyline**
attaches its Move gizmo to the **selected vertex** (§6.2) and has no whole-constraint
transform.

A vertex is a **sub-selection on the selected constraint** (`selectedVertex: number | null`),
not a new selection kind — the entity being edited is still the constraint, and modelling it
as a kind would put a vertex in the hierarchy, the context menu, and the scene file for no
gain.

**A polyline always has one vertex selected.** Two routes set it:

- **Clicking a vertex handle in the viewport** selects that vertex — and the constraint with
  it, if it was not already selected. The handles are pickable geometry (they are what the
  pointer hits, above), so this needs no armed tool: the ordinary click that selects a
  constraint resolves to a vertex when the ray hit a handle rather than the body.
- **Selecting the polyline any other way** — its body, the hierarchy, a duplicate, or the
  commit that created it — selects its **last** vertex. So a freshly drawn polyline is
  selected at the end the user stopped drawing at, which is the end **Extend** (§6.2) grows
  and the end the next click is most likely aimed at.

Nothing about a polyline is edited without a vertex selected, so there is no "no vertex"
state to design a panel or a gizmo for. The cost is that **Insert** (§6.2) starts disabled
on a newly selected polyline, since the last vertex has no next one — the deliberate
trade for never making the user click twice to edit the end they just drew.

### 6.2 Polyline draw mode

The draw mode is armed from the hierarchy's **"+ ▸ Constraint ▸ Polyline"** (§7) — a
polyline with no vertices is not a thing the user wants, so the menu row that would spawn
one arms this instead. It is a repeating variant of **Place on surface** and behaves exactly
as `spec.md` §2.4.2 specifies: the `TransformControls` gizmo detaches, the pointer is a
crosshair, viewport clicks neither select nor deselect, orbit/pan/zoom keep working, the
click-vs-drag threshold applies, and **the click's** hit test is against **scene geometry
only** with gizmos and the overlay transparent to the ray and clip-band intersections
discarded. **The hover is the one rule it does not inherit** — see the rubber band below.

**It has no viewport-toolbar button**, and so it is the one armed tool with no highlighted
button: the crosshair is its armed signal. A button there would be a second way to make the
same entity, sitting in a toolbar that otherwise only ever *moves* what is already selected
— and it had to be disabled until a group existed, while the menu row it duplicated creates
one on demand (§7). **Extend** keeps its highlight, since its button is in the panel of the
polyline it grows.

It differs in three ways, all of them because a polyline has many vertices:

- it **appends** rather than assigns: each click adds a vertex, with a rubber-band segment
  from the last vertex to the cursor. **The draft draws as it is built** — a dot per
  clicked vertex and a **solid** segment between them — so the first click is visible
  before there is a second to draw a line to, and a click that landed never reads as a
  click that did not register. The cursor end carries **no dot**: that is where the *next*
  vertex would go, not one the user has clicked. The draft draws **above the scene**, depth
  test off (`spec.md` §2.4, `VISUAL_DESIGN.md`): every vertex is a point *on* a surface by
  construction, so a depth-tested line through two of them is coplanar with the wall being
  drawn on and z-fights itself away. **Solid, not dashed** — two dashed constructions were
  drawn and could not be seen under this app's WebGPU backend, and a draft the user cannot
  see is worth less than one that does not distinguish itself by dashing
  (`CONVENTIONS.md`).

  **The rubber band's far end is resolved against a plane, not the scene mesh.** A click
  raycasts the geometry as §2.4.2 says; a *hover* intersects the pointer ray with a single
  **hover plane** and nothing else. The plane passes through the last committed click's hit
  point, with that hit's **geometric face normal** in world space. **Why:** the geometry
  raycast is `O(triangles)` with no acceleration structure, and on an imported site glTF it
  is the most expensive thing in the frame — paid on every pointer move, at pointer rate,
  for a preview. The next vertex is nearly always on the same surface as the last one (a
  rail along a wall, a line across a floor), so the plane *through that surface* is where
  the band belongs anyway, and the arithmetic is a dot product. **The click stays exact**,
  so no vertex is ever placed on the approximation.

  **Where the approximation shows: turning a corner.** Between the last click on wall A and
  the next click on wall B, the band tracks A's plane, not B's. Accepted — the band previews
  *direction*, the click decides the *point*, and it re-seeds onto B the moment that click
  lands.

  **A degenerate ray draws no band.** If the ray is parallel or near-parallel to the plane,
  or meets it behind the camera, the hover resolves to nothing and the band is simply not
  drawn; the clicked vertices still are. A band whose far end sits at effectively infinite
  distance is worse than no band. **The clip band does not filter the hover** — there is no
  intersection list to filter, and only clicks discard clipped hits;
- it is **not one-shot**: **Enter** or a **double-click** commits, **Escape** cancels the
  whole in-progress polyline, and **Backspace** removes the last vertex. **A double-click
  contributes no vertex of its own**: its first click appends one like any other click, and
  the commit then takes that vertex back out, so the polyline ends at the last
  single-clicked vertex. Ending the line *is* the gesture — a vertex where the user
  double-clicked to **stop** is not one they asked for, and appending both clicks of the
  pair would leave a zero-length final segment for the region test (§3.2) to carry.
  **Enter** commits the draft exactly as drawn, since it adds no click to take back;
- it commits only with **≥ 2 vertices**; committing with one vertex creates a **point**
  constraint instead, which is what the user drew.

Reusing §2.4.2's rules rather than inventing a second armed-tool grammar is deliberate: the
app already teaches the user what an armed placement tool does.

**A committed polyline is edited one vertex at a time.** The panel shows the *selected*
vertex (§6.1) and no other — a rail on the real site runs to dozens of vertices, and a list
of them all is a wall of numbers in which the one the user is holding in the viewport is the
hardest row to find. So the panel's vertex section is a single header naming which vertex is
selected out of how many, that vertex's coordinates, and four actions:

| action | what it does | unavailable when |
|---|---|---|
| coordinates | `Vec3Field` numeric edit of the selected vertex (`spec.md` §5.2.1's commit/revert rules) | — |
| **Insert** (`+`) | inserts a vertex **midway between the selected vertex and the next one**, and selects it | the selected vertex is the **last** — it has no next one, and the tooltip names **Extend** as the way to add past the end |
| **Delete** (`−`) | deletes the selected vertex; the vertex that takes its index becomes selected, or the new last vertex if the deleted one was last | the polyline has **2 vertices** — refused, not silently converted to a point |
| **Extend** | arms appending onto this polyline (below) | never — it is the one action that is always offered |

Dragging the selected vertex's Move gizmo still works (§6.1), and **Place on surface**
(`spec.md` §2.4.2) now applies to it: with a polyline vertex selected the tool is enabled,
and its click writes that vertex rather than a whole entity's position. A vertex is a point
on a wall or a rail, so the tool that answers "put this *there*, on the geometry I can see"
is the same one, and it beats teaching a second gesture for a vertex.

**Extend** is the draw mode again, bound to an existing polyline instead of a draft: same
crosshair, same geometry-only **click** hit test, same rubber band, and each click **appends a vertex
to the polyline and selects it** — so the next click continues from where the last one
landed. Which end grows is the selected vertex's: **vertex 1 prepends** (the polyline grows
backward from its start), **any other vertex appends** past the end. That is what lets a
rail be grown at either end without reversing it, and pairing it with §6.1's
select-the-last-vertex default means the common case — keep drawing the polyline I just
finished — needs no selection at all. **Extend wants a band before its first click**, and
has no click to take a plane from, so it seeds one through **the vertex being grown from**
with a **world-up** normal, replaced by the real surface plane on the first click. Drawing
needs no such seed: there is no band until a first vertex exists, and that first click
seeds the plane.

Extend differs from drawing in one way, and it follows from editing a committed entity
rather than a draft: **every click is a committed edit**. **Enter** and **Escape** just
disarm the tool — there is nothing to commit or to cancel — and **Backspace is not bound**,
since a vertex the user regrets is already selected and `−` removes it.

A **double-click** ends Extend under the same no-vertex-of-its-own rule as drawing, which
here means the insert its first click committed is **deleted again**: the polyline is left
ending at the last single-clicked vertex. The vertex to remove needs no bookkeeping — every
Extend click selects the vertex it inserted, so the one to take back out is the selected
one. (The 2-vertex floor cannot bite: the click being undone had just raised the count.)

**Clicking a segment does not insert a vertex.** An earlier draft of this section had it
place a vertex at the clicked point; **Insert** now covers insertion, and one insertion path
is worth more than the pixel-accuracy the segment click bought — it also frees a viewport
click on a polyline to mean exactly one thing, "select the nearest vertex", with no
segment-versus-handle priority rule to learn or to test.

### 6.3 The drag clamp

A camera may carry **`constraintId?: string`** — the constraint it is bound to. Every
placed camera gets one (§5.3), and the camera panel offers a dropdown to bind, rebind, or
unbind manually.

**The binding names a constraint, but the *group* is the camera's budget.** Apply may
re-arrange a bound camera onto a position on any constraint of the same group and rewrite
its `constraintId` to match (§5.3) — a rail and the wall beside it are alternatives, not
separate budgets. Between applies the binding is exact, and the clamp below holds it to the
one constraint it currently names.

**A bound camera's position is projected into its region** (§3.2) on every write: gizmo
drag (`spec.md` §5.2), numeric position commit (§5.2.1), place-on-surface (§2.4.2),
Reposition (§4.6), and **the bind itself** — a binding that left the camera off its rail
would not be a constraint. So the gizmo slides along the rail and stops at its ends, and
typing a coordinate off the wall snaps back to the wall.

**Reshaping a constraint re-clamps the cameras bound to it**, and that is the one
constraint edit that *is* a coverage input: it moves a camera, so it marks the result stale
exactly as dragging that camera would. A reshape that leaves every bound camera inside
marks nothing — the rule is "did a camera actually move", not "was a constraint touched".

This is what makes the binding a *constraint* rather than a label: a layout the user
reviewed and approved cannot silently drift into positions where no mount exists. The
camera panel shows the binding and the clamp is visible in the numeric fields, so a snapped
value is never a mystery.

**The clamp never honours the mount filter** (§3.1.2), even for a camera bound to a group
that has one. Target zones govern the *draw*; a user dragging a camera by hand is expressing
an intent the sampler could not. The implementation agrees: `projectIntoRegion` was chosen in
§3.2 for being closed-form, continuous, and idempotent, and a projection into
(dilated primitive ∩ union of OBBs) has none of those properties — that set is not even
connected in general, so the clamp would jump discontinuously mid-drag.

Deleting a constraint **unbinds** every camera bound to it (the cameras stay, their
positions stay); deleting a group deletes its constraints and unbinds theirs.

---

## 7. Scene hierarchy integration (`spec.md` §5.5)

The tree gains a **"Constraints"** umbrella, present when any group exists — including an
empty one — over **selectable + expandable group nodes**, each holding its constraint
children. This is the same shape the "Zones" umbrella has
(`sampling_volumes.md` §4.1), and for the same reason: the group is a user-created
sub-group, not an auto-derived type group.

- **Node kinds** gain `{ kind: 'constraintGroup' }` (selectable + expandable) and
  `{ kind: 'constraint' }` (a selectable leaf). `buildSceneTree` takes the two new arrays.
- **Root order** becomes Cameras → Probes → Sections → Zones → Constraints, fixed.
- **Rows.** A group row carries an **enabled checkbox** (§3.1) and a badge with its
  **constraint count** (`3 constraints`). A constraint row carries an **enabled checkbox**
  and a badge with its kind and measure (`polyline · 60 m`). Labels resolve from `name`,
  falling back to `Group N` / `Constraint N`.

  The group badge carries **no search result**. An earlier draft appended the selected count
  and reachable rate (`3 constraints · 8 cams · 94%`), which made sense while the tool lived
  in the sidebar beside the visible tree. Under §5 the hierarchy is hidden for a session's
  whole life and no result outlives it, so that half of the badge could never be seen — and
  a rate that survived the session would be a stale upper bound (§1.3) sitting in the tree
  with nothing to invalidate it.
- **"+" menu** gains a single nested **Constraint ▸** row (`spec.md` §5.5) whose submenu
  holds **Group**, **Point**, **Polyline**, and **Plane**. A point spawns at the
  workspace centre; a plane spawns as a 4 × 4 m rectangle at the centre; **Polyline**
  arms the draw mode (§6.2) instead of spawning geometry, since a polyline with no
  vertices is not a thing the user wants. The three types are enabled **even with no
  group present**: they fall through to the target-group rule below, which creates
  "Group 1" and adds the constraint to it. The earlier flat menu hid them until a group
  existed, which contradicted that rule — the reducer had always created the group — and
  left a first-time user staring at a menu offering only "Constraint group" with no way
  to see what a constraint was.
- **Reordering** by drag works within the group and constraint lists, exactly as §5.5.1
  specifies; **reparenting** is not offered — a constraint changes group from its panel.
- **Context menu** offers Duplicate and Delete on both kinds. Duplicating a group deep-copies
  its constraints **and copies `zoneIds`/`restrictScoring`/`restrictMounts` verbatim** — the
  copy plans for the same place, which is the only reading of "duplicate" that is useful;
  duplicating a constraint keeps it in the same group.
- **Deleting a zone prunes it from every group's `zoneIds`** (`sampling_volumes.md` §3.4),
  the same eager pruning `clipSectionId` and a camera's `constraintId` already get in the
  reducer's `deleteEntity`. A group left with an empty list falls back to the app's marked
  set (§3.1.2) rather than becoming unusable, and its pool reads **Rebuild** because its
  fingerprint moved (§3.3.1) — correct, since the cached sets were filtered by the old
  target. Deleting an **unlisted** zone costs a targeted group nothing.
- **Regenerating zones clears every group's list** (`sampling_volumes.md` §3.4). Generation
  replaces the whole zone set with freshly-numbered entities, so `zone-3` still exists and
  names a different box: eager pruning would never fire, and the group would silently
  retarget to unrelated geometry and rebuild against a target nobody chose — exactly the
  plausible-wrong-number failure §3.3 exists to prevent. The lists are emptied and §10's
  status line names the groups, so the failure is loud instead of silent. A stable per-zone
  uuid would preserve the references and is the better long-term answer; it changes the id
  scheme the zone spec calls "stable identity, never renamed", the file format, and every
  id-based lookup, so it is §15's business and not this feature's.
- **Staleness.** No hierarchy action on a group or a constraint marks the coverage result
  stale, because constraints are not analysis inputs (§1.1). This is the one place the new
  entities differ sharply from zones and volumes, and it is worth stating explicitly so
  nobody adds a stale mark "for symmetry".

---

## 8. Effect on the coverage calculation

**None.** Constraints and groups do not enter the aggregation descriptor
(`spec.md` §3.3), do not restrict the marked set, do not appear in `setSampling`, and are
absent from every reduction. The only way this feature changes a coverage number is by the
cameras the user chooses to Apply.

What the feature *does* touch is the session (§3.4): while a session is open the six
capture slots are in the engine's camera list and the retained chunks carry their bits, so
every display descriptor masks them out and closing the session marks the result stale.
Both rules are `aim_optimization.md` §3.1's, unchanged.

---

## 9. Scene file (`spec.md` §14)

- **`Scene` model (§14.1).** Add `constraintGroups: ConstraintGroup[]` and
  `constraints: CameraConstraint[]`; `defaultScene()` seeds both **empty**. `Camera` gains
  optional **`constraintId`**.
- **`scene.json` (§14.3).** Add top-level `"constraintGroups"` and `"constraints"` arrays.
  Bump **`formatVersion` to `3`**; the reader **accepts 1, 2, and 3** (a v1/v2 file reads as
  empty groups and constraints); version > 3 is rejected (§14.8).
- **A group's `aspect` and `near` are read and ignored.** They were persisted before they
  became constants (§3.1.1); the writer omits them and the reader accepts any value, or
  none, without validating it. No version bump, because a file written by either build
  loads in both to the same scene — the two keys never fed anything a reader needs.
- **The target zones persist** — `zoneIds`, `restrictScoring`, `restrictMounts` — and all
  three are **optional on read**, defaulting to `[]` / `true` / `false`. **No version bump:**
  the change is purely additive, a v3 file still reads, and a file written by this build still
  opens in one that predates it as a group with no target — the same treatment `enabled` and
  `namePrefix` already get. Bumping to 4 would lock a file out of older builds for a key they
  would have ignored anyway.
- **A `zoneIds` entry naming an unknown zone is dropped, not rejected**, exactly as
  `parseVolumes` drops a volume whose `zoneId` is dangling. The reader therefore takes the
  parsed `zones` as a second argument. A scene that legitimately lost a zone through editing
  must still reload; a hand-edited typo silently losing a target is the lesser harm, and §5's
  panel shows the resolved list.
- **The draw inputs and the whole strategy persist** — `poolSize` and `seed`, `maxCount`,
  `trials`, `epsilon` — beside the template. A seeded search that cannot be reproduced from the file is a seeded
  search for nothing: the file would record the cameras without the inputs that chose them.
- **Not persisted:** the pool itself (megabytes of derived data, invalidated by
  §3.3.1), the `PlacementResult`, the selected count, the target group, and the scatter
  toggle. All are session or view state, the same line `sampling_volumes.md` §9 drew for the
  generation levels.

```json
{
  "formatVersion": 3,
  "constraintGroups": [
    { "id": "cg-1", "name": "Dock", "enabled": true,
      "fov": 60, "far": 50, "namePrefix": "Dock",
      "zoneIds": ["zone-3", "zone-7"], "restrictScoring": true, "restrictMounts": false,
      "poolSize": 200, "maxCount": 10, "trials": 1000, "epsilon": 1.0, "seed": 1 }
  ],
  "constraints": [
    { "id": "con-1", "groupId": "cg-1", "name": "Gantry rail", "enabled": true,
      "kind": "polyline", "distance": 0.4,
      "points": [[12, 6, 40], [12, 6, 98], [40, 6, 98]] },
    { "id": "con-2", "groupId": "cg-1", "name": "North wall", "enabled": true,
      "kind": "plane", "distance": 0.3,
      "position": [0, 5, -40], "rotation": [0, 0, 0, 1], "size": [60, 8] }
  ],
  "cameras": [ { "id": "cam-11", "name": "Dock 1", "constraintId": "con-1", "…": "…" } ]
}
```

**Validation (§14.8).** Group ids and constraint ids unique within their categories; every
`constraint.groupId` must reference an existing group (dangling rejected); a
`camera.constraintId`, when present, must reference an existing constraint (dangling
rejected); `kind` one of the three; `distance ≥ 0` and finite; a polyline's `points` length
≥ 2 with finite components; a plane's `size` components > 0; `fov ∈ (0, 180)`,
`far > 0`; `poolSize ≥ 1`, `maxCount ≥ 1`, `trials ≥ 1`,
`epsilon ≥ 0`, `seed` an integer; `enabled` a boolean when present; `zoneIds` an array of
strings when present, with unknown ids dropped and duplicates collapsed;
`restrictScoring`/`restrictMounts` booleans when present; a missing or blank
`name` reads as the default, never an error. Otherwise all-or-nothing import, as ever.

---

## 10. Error handling (`spec.md` §11)

| Situation | Behavior |
|---|---|
| the engine has not finished loading the scene, or is in an error state | Build candidate positions and Reposition disabled, `Wait for the engine to finish loading the scene.` — **checked first**, since every other message misleads while the engine holds no scene. A build step is the one entry point that does not pass the app's own Run gate (`spec.md` §8), so it needs its own readiness check; without it a click during startup reaches a worker holding no engine, and the failure arrives as an SDK `INVALID_STATE` naming nothing the user can act on. **The engine loads on scene load rather than on the first run (`spec.md` §8), so this window is that load, and it closes on its own** — the message asks the user to wait, and waiting is now actually sufficient |
| fewer than 6 spare camera slots | Build candidate positions disabled, `aim_optimization.md` §3.1's message |
| an aim-optimize session is open | Build candidate positions disabled, `Close the aim optimizer before placing cameras.` |
| a sampling edit still awaits a run | Build candidate positions disabled, `Run coverage once to apply the sampling change, then build the candidate positions.` (§3.3) |
| the target group has no enabled constraint | Build candidate positions disabled, `This group has no enabled constraint to sample.` |
| a build step `compute()` fails — rejects **or returns null** | build steps stop, the session closes and releases its slots, the partial pool is discarded, and the status area carries `The engine could not run the build step — see the status area.` beside the engine's own message (§4.2) |
| every drawn position of a constraint was rejected (§4.2) | the pool proceeds without it; the readout names it: `Rail 2 saw nothing from any sampled position.` |
| `restrictMounts` on and a constraint has **zero** overlap with the target zones (§4.1.1) | the constraint is dropped from the draw and its floor redistributed; the Build card shows its `0%` beside the others' percentages. Not an error, and Build is **not** disabled |
| `restrictMounts` on and **no** constraint overlaps any target zone | Build still runs (§4.1.1) and returns an empty pool; the readout carries `No constraint overlaps this group's target zones — the pool is empty.` The estimate is an estimate, and only CPU was spent, so it warns rather than blocks |
| zones were regenerated while some group held target zones (`sampling_volumes.md` §3.4) | the lists are cleared and the status area names them: `Zones were regenerated; N constraint group(s) lost their target zones.` |
| `CAMERA_INSIDE_GEOMETRY` for a **capture slot** | **suppressed** for the session's duration (§4.2); the position is dropped instead |
| the pool is invalidated mid-review (§3.3.1) | the result is dimmed, Apply disabled, `The scene changed; rebuild the pool.` |
| the plan would exceed `MAX_CAMERAS` after its creates (§5.3.4) | Apply disabled, `Placing N cameras would exceed the 128-camera limit; the scene uses M.` Only a create consumes a slot, so a plan of moves and disables cannot fire this |
| the plan disables cameras (§5.3.1) | **not** an error, not a modal, and no longer a warning: the button states it — `Apply · move 8 · disable 4` — so the count is legible before it is pressed, and every one of those cameras is recoverable from the hierarchy's eye toggle afterwards |
| `COMPUTE_CANCELED` from the user's own Cancel | not an error, surfaced nowhere (`spec.md` §8.1) |

---

## 11. Terminology (`spec.md` §16)

| Term | Meaning |
|---|---|
| **camera constraint** | a region a camera may be mounted in: a point, polyline, or plane rectangle dilated by `distance` — §1.1 |
| **constraint group** | a named container of constraints; the unit an analysis runs over, carrying the camera template, the pool size, and the strategy — §3.1 |
| **camera template** | the `fov`/`far`/`namePrefix` of the camera model a group plans for; `far` is a build-step input, and `near`/`aspect` are placement-wide constants — §3.1.1 |
| **strategy** | the group's `maxCount`/`trials`: how the analysis searches the pool. `poolSize` and `seed` are not among them — they are the **draw inputs**, deciding which positions the pool holds rather than the search over it (§3.3.1, §5.1) — and neither is `epsilon`, which is read after the search — §3.1 |
| **knee tolerance** | `epsilon`: a **review policy**, read off the finished curve rather than during the trials, so it moves the knee and never the search. The `Knee (pp)` slider of §5.2 — §3.1, §4.5 |
| **build step** | one `compute()` over the capture rig at one position, producing that position's reachable set. What `aim_optimization.md` calls a *capture*; this feature says **build** throughout, because that is what its button says — §2.1, §4.3 |
| **analysis** | the trial loop over a built pool, run by **Analyze**; produces the prefix curve, and measures no coverage — §4.4 |
| **reachable set** | the counted voxels a mount point could see at *some* orientation — §1.2, `aim_optimization.md` §2 |
| **layout** | a set of mount positions; the unit a trial scores — §1.2 |
| **target zones** | a group's `zoneIds`: the sampling zones it plans for. With `restrictScoring` they define its **target set** (what §1.2 counts); with `restrictMounts` they also bound where it may mount — §3.1.2 |
| **target set** | the voxels a group's score counts: its target zones' volumes when it has them, else the app's marked set — §1.2, §3.1.2 |
| **mount filter** | the `restrictMounts` test — a drawn position is kept only inside a target zone's volume. A *draw* rule, never a clamp (§6.3) — §4.1.1 |
| **effective measure** | a constraint's §3.2 measure scaled by the fraction of its own draws that pass the mount filter; what §4.1 splits the pool by — §4.1.1 |
| **pool** | the `poolSize` built positions an analysis draws its layouts from — §3.3 |
| **pool ceiling** | `|⋃ all pool positions' reachable sets|`; the most any layout from this pool can reach — §5.2 |
| **trial** | one random layout of `maxCount` positions, scored at every prefix count — §4.4 |
| **knee** | the fewest cameras within `epsilon` of the best score found — §4.5 |
| **placement session** | the window during which the six capture slots exist; shares the aim optimizer's slots — §3.4 |
| **binding** | a camera's `constraintId`: provenance, plus a clamp that keeps it in the region — §6.3 |

---

## 12. Modules

```
src/placement/
  region.ts        §3.1 the entities and their defaults; §3.2 membership, measure,
                   nearest point, projectIntoRegion, the primitive parameterization,
                   and the `constraintProblem`/`groupProblem` validators the scene-file
                   reader and the panels share
  halton.ts        §4.1 the sequence, the ball map, the per-constraint offsets
  pool.ts          §4.1–§4.3 the split, the draw, the build cameras and descriptor,
                   the rejection budget, the §3.3.1 fingerprint, §10's blockers, and
                   §4.1.1's mount filter — the effective-measure estimate, the
                   zero-hit drop, and the CPU rejection loop. Also §3.1.2 as pure
                   decisions App renders through: `resolveGroupTarget` (a group's
                   zone list + the app's marked set → one `GroupTarget`),
                   `constraintOverlaps` / `unmountableIds` (the §5 gizmo dimming and
                   its readout), `overlapSummary`, and §10's regenerate notice
  leafSet.ts       §2.1 LeafChunk/LeafSet from an AggregateResult, and the
                   `VoxelBitset` a trial rasterizes into (§4.4)
  analyze.ts       §4.4, §4.5 the trial loop, the prefix curve, the knee — engine-free
  mode.ts          §5, §5.1 the placement mode's lifecycle as a pure reducer —
                   open / requestClose / keepOpen / confirmClose / applied /
                   groupGone → next state + `closeSession`; and `buildAction`,
                   which turns (pool, fingerprint, size) into
                   Build / Extend / Truncate / Rebuild (§3.3.1)
  assign.ts        §5.3 the apply plan: the minimum-total-distance assignment and the
                   moves / creates / disables it resolves to — pure, no engine, no React
  usePlacement.ts  §3.4, §4.6, §5 the session as React state; the only module that
                   calls the engine
src/ui/
  CandidatePositionsPanel.tsx  §5.1 left column, card 1: `Size`, the Build button and its
                            own progress, readout, blocker, and Cancel; plus the §3.1.2
                            denominator line and the §4.1.1 overlaps, both of which
                            precede a build
  StrategyPanel.tsx         §5.1 left column, card 2: the two strategy fields, `Analyze`,
                            and its own progress and Cancel
  NewCameraDefaultsPanel.tsx §5.1 left column, card 3: the camera template — `Name prefix`,
                            `FOV`, `Range` — and no button of its own
  PlacementReviewPanel.tsx  §5.2, §5.3 right column: group name, curve,
                            slider, stats, and the pinned Apply / Close with the §5.1 guard
  ConstraintGroupPanel.tsx  §5 selected group: name, constraint count, the §3.1.2 target
                            zone list, its two flags, the §4.1.1 overlap readout, and
                            `Place cameras`
  ConstraintPanel.tsx       §6 selected constraint: kind, distance, geometry, and the
                            selected vertex with Insert / Delete / Extend
src/scene/
  aggregateSpec.ts          §3.3 `markedFilterForZones(volumes, zoneIds)` — the one
                            construction of a `MarkedFilter`, shared by the display
                            descriptor, the aim capture, and a targeted build step
  constraintGizmos.ts       §6.1 primitive handles + the exact translucent dilation,
                            plus the `PlacementOverlay` that draws the §5.2 pool
                            scatter and the §6.2 draft polyline — both are the
                            placement tool's picture, so they share a layer toggle
  polylineDraw.ts           §6.2 the armed draw mode's pure state, over §2.4.2's hit test
                            for clicks and hoverPlane.ts for hovers
src/scene/sceneView/
  hoverPlane.ts             §6.2 the hover plane and the ray/plane intersection, with the
                            near-parallel and behind-the-camera guards — pure, the hover
                            counterpart of surfaceHit.ts's click
  surfaceHit.ts             §2.4.2 the click's nearest eligible hit — now the hit **point
                            and its world-space geometric face normal**, since §6.2's
                            hover plane is seeded from the normal
```

**`analyze.ts` is engine-free.** It takes the pool as data — an array of `{ count,
rasterize }` — and returns a `PlacementResult`. Everything in §4.4 and §4.5 is then a pure
function testable with synthetic sets and no GPU, no worker, and no React, exactly as
`aim_optimization.md` §7.1 arranges for `greedy.ts`.

**Three ui files, not one, because each card owns one button's feedback** (§5.1). The file
boundary is what keeps a button's progress line, readout and blocker beside it instead of
drifting into a shared status area.

---

## 13. Testing

The two things that can be wrong while still producing plausible percentages are the cached
reachable sets and the CPU union. Both are pinned by outcome.

- **`test/placementParity.test.ts`** — the contract. On a small CPU-backend scene spanning
  **four chunks**, the CPU union of a layout's cached leaf cubes must **exactly equal** a
  real `compute()` carrying all `6N` rigs at once with `AggregateSpec.cameras` covering them
  and one `RegionAccum.covered` read. Exact, not approximate: `camera-coverage-sdk` §19.5
  makes both reductions integral and bit-identical, so any inequality is a bug and not a
  tolerance. Four chunks, because a per-chunk base offset is exactly the arithmetic that
  produces a plausible-but-wrong union. Further cases: a **rotated** marked zone, whose
  filtered union must match the in-zone ground truth *and* be strictly smaller than the
  workspace's — the regression a missing §3.3 filter would cause; a single position, pinning
  the per-position half of the contract before any union arithmetic enters; and an assertion
  that the three mounts genuinely overlap, so a summed score could not have passed either.
- **The outcome check is synthetic, deliberately.** Two disjoint rooms with one constraint
  each and `maxCount = 2` must return **one position in each room** — a score that summed
  instead of unioned puts both in the larger room and passes every unit test in this list.
  It lives in `placementAnalyze.test.ts` over hand-built sets rather than in an engine-backed
  file of its own, because the parity test above already pins "a cached set is what the
  engine reports". The two compose: parity ties the cache to the engine, the outcome test
  ties the search to the cache, and an engine-level outcome test would only re-cross the
  seam parity has already covered.
- **`test/placementPool.test.ts`** — the §3.3.1 pool arithmetic Build now depends on:
  raising `poolSize` plans **only the new draws** (`planDraws`'s `from`), lowering it plans
  **none** and truncates the positions already held, the kept prefix is bit-identical to what
  a full build step would have produced, and a fingerprint change plans every draw again however
  the size moved. Then the §4.1 split — **the worked example above asserted exactly**
  (1 : 5 : 194, which truncation and a smallest-first take-back both miss), measure
  weights, floor of 1, remainder,
  and that it ignores `distance` so it cannot collapse at 0 — prefix-stability (positions
  1..200 of a 260-pool are the 200-pool verbatim), extension draws only what is new,
  per-constraint sub-sequences (editing one constraint leaves another's positions untouched),
  every drawn position satisfies `inRegion` across all three kinds, the five-dimension stride
  holds so changing `distance` keeps the primitive point, the rejection budget terminates,
  §10's blockers in priority order, and the build-step descriptor's mask and handed-over filter.
  Then §4.1.1's **mount filter**, whose failure mode is a pool that is merely *smaller* and
  therefore looks fine: the effective-measure split reproduces a worked example (a wall with
  5% overlap loses its share to the rail beside it, which the unfiltered split gets wrong by
  two orders of magnitude); every kept position satisfies both `inRegion` **and** `inVolume`
  for some listed zone; a constraint whose primitive lies outside the zones but whose
  `distance` reaches in is **not** dropped — the regression a primitive-only estimator would
  cause; a genuinely-outside constraint estimates to 0, is dropped, and its floor is
  redistributed so the shares still sum to `poolSize`; prefix-stability still holds under
  rejection (positions 1..200 of a filtered 260-pool are the filtered 200-pool verbatim); the
  estimate is deterministic under `seed` and moves with it; and the fingerprint covers the
  **listed** zones only — toggling an unlisted zone's `enabled` leaves a targeted pool valid
  while editing a listed zone's volume invalidates it.
  Then §4.6's two pure decisions: `bestSample` (highest count, ties to the earlier draw, a
  blind constraint yielding no move) and `repositionBlocker` (its own two rules first, then
  every §10 rule inherited whole), plus that a lone constraint takes the whole pool budget.
- **`test/placementTargetZones.test.ts`** — the §3.1.2 semantics as pure functions, since
  every one of them fails as a plausible number rather than a crash: a non-empty list
  overrides `useZones` and each zone's `enabled` (a globally-disabled listed zone is still
  counted); an empty list reproduces today's filter **exactly**, so a scene not using the
  feature is bit-identical; `markedFilterForZones` over the enabled zones' ids returns the
  same `MarkedFilter` the display descriptor builds, which is what lets one function serve
  both; and `markedTotal` sums the listed zones' `validVoxels` and falls back to
  `poolCeiling` at zero. Then the lifecycle in `sceneReducer`/`sceneFile`: deleting a listed
  zone prunes it from every group, deleting an unlisted one changes no group, regenerating
  zones clears every list, `duplicateConstraintGroup` copies all three fields, and the reader
  round-trips them, defaults all three when absent (a v3 file), and drops a dangling id
  without failing the import. Then §5's readouts as pure functions, since a panel cannot be
  rendered in this suite: `resolveGroupTarget` pairs a filter and a denominator from the
  same resolution and never crosses them, `constraintOverlaps`/`unmountableIds` name exactly
  the zero-overlap constraints of the group they were asked about (and nothing at all
  without a mount filter), `overlapSummary` labels every constraint including the zero,
  and §10's regenerate notice counts only the groups that actually held a target.
- **`test/constraintGizmos.test.ts`** — §6.1's fill ramp, and §5's mount-filter dimming on
  top of it: a constraint the selected group's filter excludes takes a **weaker** fill than
  the same constraint unfiltered and drops its edges to the disabled treatment, an excluded
  *and* selected constraint still reads stronger than an excluded unselected one, and
  clearing the set restores the ordinary ramp — the reconcile path, not just the pure
  `fillOpacity`, since the entry flag is what the renderer actually reads.
- **`test/placementCurvePlot.test.ts`** — §5.2's plot geometry, whose failure mode is that
  the curve renders perfectly and selects the wrong count. The **round trip** is the
  property: a click at the fraction `curveX` draws a count at picks that same count back,
  for every count at several pool sizes. Plus the margins clamping to the nearest real
  count, and the §5.2 headroom holding as a fraction of the range at any `top`.
- **`test/placementAnalyze.test.ts`** — the union primitive and the trial loop, over synthetic
  sets: a voxel two positions reach is counted **once**, a cube rasterizes to its whole
  volume in the right voxels, a chunk base offset lands where it should, an oversized grid is
  refused with a usable message; then the best-per-count curve is non-decreasing by
  construction, a layout is `count` distinct positions, the two-rooms outcome above holds,
  the same seed reproduces a search exactly and a different one does not, **chunking the
  trials cannot change the answer**, `maxCount` clamps to the pool size, an empty pool
  analyses to nothing, and the knee is the smallest count within `epsilon` percentage points
  — asked of the **curve** rather than of a live `AnalysisState`, since §5.2's panel holds
  only the curve and recomputes the knee from it on every tolerance edit (§4.5). Plus the
  §5.2 follow rule as a pure function: an unpinned count tracks the live knee, a pinned one
  does not, and an analysis clears the pin.
- **`test/placementOverlay.test.ts`** — the §5.2 scatter, over real Three.js objects. Its
  two failure modes are both silent — no crash, no wrong number, just nothing on screen — so
  both are pinned: the scatter is an instanced **sprite**, never `THREE.Points` (WebGPU's
  point primitives are one pixel), and it is not frustum-culled (every instance is placed by
  the material's `positionNode`, so the sprite's own transform sits at the origin and culling
  against it would drop the whole scatter); and the dot size is in **screen** space, a few
  pixels wide. Then: the dots do not write depth (they are a set, and must not occlude each
  other or the gizmos they sit on) but do test it (a position behind a wall is hidden, which
  is information); an empty pool hides the scatter and draws no instances; a smaller pool
  draws fewer instances rather than leaving the stale tail; the instance buffers grow past
  their capacity but are **reused** within it, since re-pointing the material's nodes
  recompiles the shader and the count slider re-sets the pool on every tick; and
  `poolDotColor` ramps with a position's own `count` while a chosen position takes the
  selection colour outright rather than a bright point on that ramp — with `top = 0`
  handled, since an unbuilt pool has one.
- **`test/placementRegion.test.ts`** — `inRegion`/`distToPrimitive` for all three kinds
  including a polyline's joints and caps and a plane rectangle's corners (the cases a
  per-axis box test gets wrong), a rotated rectangle in its own frame, `primitiveMeasure`,
  `projectIntoRegion` (identity inside, in-region outside, idempotent, and pinning at
  `distance = 0`), the arc-length parameterization, the labels, and both validators.
- **`test/placementAssign.test.ts`** — the §5.3 plan, pure: the assignment really is
  minimum-total-distance (checked against brute force over every permutation at small n,
  so it cannot pass by agreeing with a greedy that happens to be optimal); ties break by
  hierarchy order, so the plan is deterministic; more cameras than positions yields the
  right **disables** (the ones furthest from anywhere the layout wants — switched off, never
  removed) and more positions than cameras the right **creates**; a camera bound to
  constraint A can be moved onto a position on constraint B **of the same group** and has its
  binding rewritten; a move writes `position`/`constraintId`/`near`/`far`/`enabled: true` and
  leaves `id`/`name`/`rotation`/`fov`/`aspect` alone; an already-disabled bound camera is
  still movable hardware and comes back **on** when it wins a position; and the gate counts
  only the creates, so a plan of moves and disables passes on a full 128-camera scene. Plus
  §5.3.3's completion line: moves and creates both count toward the number, disables do not,
  and the singular reads `1 camera placed`.
- **`test/placementMode.test.ts`** — the §5 mode, over `mode.ts`'s pure reducer: opening
  targets the group it was pressed on and re-opening replaces that target outright (the mode
  holds one group for its whole life, which is why it needs no selector); Close with no pool
  closes straight through, while Close with a pool asks first, does **not** close the session
  behind the guard, and takes a second Close as the Discard it is asking for; **Keep open**
  leaves the state exactly as it was; a running build step is not closeable however the pool
  stands, because Cancel is what stops it; Apply leaves the mode **without** a second
  `closeSession` (the session closed itself in §5.3, and closing again would hand the engine
  a camera list the reducer has just replaced); a vanished group closes both; every event on
  a closed mode is inert; and the entry gate refuses each of §10's blockers in priority
  order, so `Place cameras` is never pressable into one. Plus `buildAction` (§3.3.1): no
  pool → **Build**; a valid pool and a larger `Size` → **Extend to N**; a smaller `Size` →
  **Truncate to N**; a moved fingerprint → **Rebuild** whatever the size did; a moved `seed` →
  **Rebuild** whatever the size did, since an extend must never mix seeds (§3.3.1); and an
  unchanged size against a valid pool → **Rebuild**, since pressing a button that would do
  nothing is worse than pressing one that rebuilds; and a pool left short by a constraint
  that exhausted its rejection budget still reads **Rebuild**, because `Pool.size` records
  what was *asked for* rather than what was kept. Plus `analysisStamp`, §5.1's stale rule as
  a pure comparison: each of `poolSize`/`maxCount`/`trials`/`seed` moves it, `epsilon` does
  **not** (it asks for no trials, §4.5), and no template field does — `fov` cannot change a
  reachable set at all, and `far` is caught by the pool's own fingerprint, which discards the
  pool rather than marking a result. `seed` moves both the stamp and `buildAction`, and deliberately **not** the
  fingerprint: a nudged `Seed` marks the result and re-labels Build, and never claims the
  scene changed (§3.3.1).
- **`test/placementSession.test.ts`** — the build-step descriptor passes the SDK's own §19.6
  validation as built (with and without a marked filter), the rig mask names exactly the six
  slots across a word boundary, placement needs the *same* six spare slots the aim optimizer
  does, the two sessions are mutually exclusive and claim the same ids, the `samplingDirty`
  block, a build step never mutates a scene entity, the scene cameras keep their ids and order
  so a build step stays incremental, and the display mask hides the slots.
- **`test/sceneView/hoverPlane.test.ts`** — the §6.2 hover, pure: a ray meeting the plane
  square returns the exact intersection; a ray **parallel** to the plane and one
  **near-parallel** within the guard both return nothing; a plane **behind** the camera
  returns nothing rather than the negative-`t` point; the plane is honoured in its own
  orientation (a vertical wall plane, not just the horizontal case that a naive
  `y = const` implementation would pass); and the seed rule — a click's hit replaces the
  plane, while Extend's pre-click plane is world-up through the anchor. Plus, in
  **`test/sceneView/surfaceHit.test.ts`**, that the returned normal is the **geometric
  face** normal transformed into world space by the hit object's matrix — not the
  interpolated shading normal (which `computeVertexNormals` averages across a box corner
  into something that is no face's plane) and not the untransformed local one (which a
  glTF object carrying a transform would make wrong).
- **`test/sceneReducer.test.ts`** — the constraint half of the reducer: no constraint edit
  marks the result stale, **except** reshaping one a camera is bound to, which moves that
  camera and therefore does (and a reshape that moves nothing marks nothing); the clamp
  fires on bind, on drag, and on a typed position; an unbound or dangling-bound camera is
  never clamped; deleting a constraint or group unbinds its cameras without deleting them; a
  vertex cannot be deleted below two; `placeCameras` appends the whole layout in one edit;
  and constraints reorder within their own group only.
- **`test/sceneTree.test.ts`** / **`test/entityDuplication.test.ts`** / **`test/reorder.test.ts`**
  — the Constraints umbrella appears with an empty group, each group takes only its own
  constraints out of the interleaved array, Constraints is the last root group, a duplicated
  group deep-copies its constraints, its pool size and its whole strategy while a duplicated polyline owns its
  vertices, and `moveConstraintBefore` never reparents.
- **`test/sceneFile.test.ts`** — groups, constraints, and `constraintId` round-trip;
  `formatVersion` 3 is written and 1/2/3 accepted; a dangling `groupId` or `constraintId`
  is rejected; every §9 validation rule has a case.
- **No SDK-side test**, because the feature needs no SDK change (§14). The rejection rule
  of §4.2 is exercised in `placementPool.test.ts` with a constraint placed inside a sealed
  box: every position is rejected, the attempt cap terminates the draw, and the constraint
  is named in the readout rather than silently contributing nothing.

---

## 14. Edits made elsewhere (consistency)

**`camera-coverage-sdk/specs/spec.md`** — **no change.** The feature is built entirely
from primitives the SDK already has: the six-camera rig is ordinary cameras, the reachable
set is `AggregateLeafCounts` with `AggregateSpec.cameras` (§19.1), the re-reduction path is
`aggregateRetained` (§19.4), and the build step is an ordinary `incremental` `compute()`. An
earlier draft of this spec added a `classifyPoints` occupancy query to pre-screen positions;
§4.2 records why it was dropped — the app runs with `solidDetection: false`, under which the
class it would have tested is never produced.

**`apps/sample-app/specs/spec.md`**

- §2.2 — the two new left-panel editors, and the **placement mode**: the same three-column
  shell with both side columns' *contents* replaced — the tool's inputs left, its review
  right (§5).
- §2.4 — **Constraints** in the layer menu, and which overlays survive the placement mode
  (View selector and layer menu yes, transform toolbar no). The draw mode has **no** button
  in that toolbar; it is armed from the §5.5 hierarchy menu.
- §2.4.2 — a note that the draw mode is a repeating variant, and its three differences; and
  that the tool's placeable kinds gain a **polyline vertex** (§6.2), the one target that is
  a sub-selection rather than an entity.
- §3.3 — a line stating constraints are absent from the descriptor, and that
  `markedFilterForZones` is the one place a `MarkedFilter` is built.
- §5 — `Camera` gains `constraintId`; §5.2 / §5.2.1 gain the clamp; the panel gains the
  binding dropdown and **Reposition**.
- §5.5 / §5.5.1 — the Constraints umbrella, the two node kinds, rows, the "+" menu, ordering,
  the context menu, and the no-stale rule.
- §8.1 — auto-run suspension covers a placement session.
- §11 — the §10 rows.
- §14.1 / §14.3 / §14.8 — the `Scene` fields, `formatVersion` 3, the validation rules, and
  the group's three **optional** target-zone keys (additive, no version bump — §9).
- §15 — camera placement leaves "out of scope" and points here.
- §16 — the §11 terms.

**`apps/sample-app/specs/aim_optimization.md`**

- §13 — "optimizing position" and "adding or removing cameras" leave out-of-scope and point
  here; a note that the two features **share** the six capture slots and are mutually
  exclusive.
- §3.1 — a cross-reference that a placement session claims the same slots.

**Shared app modules generalized rather than copied**

- `scene/reorder.ts` — `moveVolumeBefore`'s within-parent splice becomes
  `moveWithinParentBefore(items, id, beforeId, parentOf)`, with `moveVolumeBefore` and the
  new `moveConstraintBefore` as one-line wrappers. Volumes key on `zoneId` and constraints
  on `groupId`, and both interleave parents in one flat array for the same reason (new
  children append), so the rule is one function rather than two copies that could drift.
- `scene/gizmoSet.ts` — `PickableGizmoSet` gains a `pickRecursive` flag. A camera body, a
  probe marker, and a volume's fill are each one mesh; a constraint's body is several
  (§6.1), so that set opts into the recursive raycast rather than every set paying for it.

**`apps/sample-app/specs/sampling_volumes.md`**

- §2.1 — a note distinguishing a sampling volume (an analysis input) from a camera
  constraint (a generator), since the two look alike in the hierarchy; plus the one-way
  reference a constraint group may hold to a zone (§3.1.2).
- §3.4 — **Generate replaces the zone set, so it clears every constraint group's target
  zones** and says so in the status area; ids are reused for different boxes, so keeping the
  references would silently retarget a group (§7).
- §7.1 — a note that `setSampling` is fed *every* volume regardless of `enabled`, which is
  what makes a group's override of `enabled` safe (§3.1.2).

**`ai/` docs** (both packages, per `CLAUDE.md`): `ARCHITECTURE.md` (the new module set and
the worker-side pool), `DECISIONS.md` (newest at top: per-group target zones override the global marked set;
one zone list with two flags rather than two lists; the mount filter splits by an
effective measure estimated with the sampler itself; regeneration clears target lists;
placement is a mode; aim-free placement scoring; cached pool over per-trial runs; leaf
cubes over bitsets; tolerance over standoff; the strategy in the file), `CONVENTIONS.md` (`LeafCubes` and the bitset-rasterize idiom, and
the pure-reducer-for-a-mode idiom), `STACK.md` (no new dependency), and the app's
`VISUAL_DESIGN.md` (the constraint palette, the dilation translucency, the curve and scatter
styling, the target-zone list card and the dimmed-gizmo treatment of §5, and the
**placement mode**: which columns it replaces, its two input cards, and the
pinned action footer).

---

## 15. Out of scope / future

- **Aim-aware placement.** Scoring a position by its best achievable single-orientation
  score rather than its whole reachable set (`aim_optimization.md` §4.3's search is already
  free once a build step exists). This is the single largest available improvement in
  proposal quality and is deliberately deferred: it changes the objective, so it needs its
  own spec change and its own measurement.
- **Redundancy-aware placement** — weighting a voxel by how many existing cameras already
  see it, as `aim_optimization.md` §1.1 does for aiming.
- **Smarter search** — keeping good positions and re-scattering the weak ones (iterated
  local search), greedy max-coverage over the pool, or any surrogate-model optimizer.
  §4.4's independent trials are the deliberate simple baseline; `search.ts` is the seam.
- **Joint placement and aiming**, and optimizing `fov` or `far`.
- **Relocating cameras across groups.** Apply re-arranges within one group's budget (§5.3);
  a camera bound to another group, or unbound, is never moved or disabled by it.
- **Cost, cabling, or mount-effort terms** in the objective.
- **Constraint kinds** beyond the three: circles/arcs, meshes as mountable surfaces, or
  "anywhere on this wall the BVH found" auto-generation (the analogue of
  `sampling_volumes.md` §3).
- **A stable per-zone uuid**, so a constraint group's target zones survive a regenerate
  instead of being cleared (§7). It is the right answer and it is not this feature's: it
  changes the id scheme, the file format, and every id-based lookup in the zone tool.
- **Per-zone coverage requirements** — "this zone must reach 80%" as a constraint the search
  must satisfy, rather than a target set the objective maximises over.
- **A `closed` polyline flag**, and vertex naming.
- **Persisting a pool** across a reload, or a proposal history beyond the session's Close.
