# Sample App — Aim Optimization (redundancy-weighted camera re-aiming)

Feature spec for the sample app's camera **aim optimizer**. Companion to
[`spec.md`](./spec.md); this document owns the full behavior of the feature, and §12
lists the edits made to `spec.md` and to the SDK spec so the three stay consistent
(workflow rule: spec-first, no drift).

> **Scope.** The optimizer changes **orientation only**. Positions, FOV, range, aspect,
> near, and the camera set are inputs, never outputs. "Optimize" in this document always
> means "choose a yaw and a pitch".

---

## 1. Problem & goal

A site's cameras are usually aimed by hand, one at a time, without any view of what the
*other* cameras already cover. The result is a layout where several cameras pile onto the
same easy corridor while a loading bay nobody checked is blind.

**Goal.** For each enabled camera, find the orientation that maximizes how much it
contributes *that no other camera already contributes*, and offer that orientation to the
user — per camera with a live preview, or across the whole scene in one pass.

### 1.1 The objective

For camera `c` at a candidate orientation `θ`:

```
score_c(θ) = Σ_{v seen by c at θ}  f(n_others(v)),      f(n) = 1 / (n + 1)^α
```

where `n_others(v)` is the number of **other** enabled cameras that see voxel `v`, and
`v` ranges over the valid sampling voxels of the workspace (`spec.md` §7 — the sampling
zones, when zones are in use).

A voxel nobody else sees is worth a full point; one that others already see is worth less.
Turning away from a corridor only this camera covers therefore costs the full value of that
corridor, while turning away from one several cameras cover costs little — which is the
behavior the feature exists to produce.

**α = 2** (`REDUNDANCY_EXPONENT`). The exponent decides how much the objective still cares
about a voxel somebody else already sees, and it is not a free parameter — measured on two
scenes, running the §4 loop from the same start to convergence:

| α | scene A (4 cameras, 1 occluder) | scene B (6 cameras, 2 occluders) |
|---|---|---|
| 1 | 93.79% | 97.34% |
| 1.5 | 95.13% | 97.43% |
| **2** | **95.44%** | **97.43%** |
| 2.5 | 95.49% | 97.43% |
| 3 | 95.62% | 97.43% |
| 4 | 95.08% | 97.43% |
| pure marginal (`f(0)=1`, else 0) | 95.22% | 97.43% |

(start: 77.52% / 90.14%.)

α = 1 was the original default and is the **only** value that loses meaningfully: at that
discount a voxel two cameras already see is still worth a third of a blind one, so the
optimizer spends real aim budget thinning redundancy instead of filling blind spots. α ≥ 1.5
is uniformly at least as good, and 2 captures nearly all of the gain.

Sharper is not monotonically better: α = 4 gives some back, and **pure marginal coverage is
worse than α = 2 on scene A**. A weight that collapses to zero has no tiebreaker left
between two orientations that cover equally many blind voxels, and the tail is what breaks
those ties.

The same measurement isolates what is *not* the cause: eight rounds score exactly the same
as three (the loop had converged), and disabling the §4.4 gate changes nothing. The
exponent was the whole effect.

### 1.2 Why this objective converges

Define the scene potential from the weight itself — for **any** `f` that depends only on
`n`:

```
Φ = Σ_v G(n(v)),        G(n) = Σ_{k<n} f(k)        (G(0) = 0)
```

over the same voxels, where `n(v)` counts **all** enabled cameras. `G` is the running sum
of `f`, so `f(n) = G(n+1) − G(n)`, and therefore

```
score_c(θ) = Σ_{v seen by c} [ G(n_others(v) + 1) − G(n_others(v)) ]
           = Φ(with c at θ) − Φ(without c)
```

so `score_c` is exactly `c`'s marginal contribution to `Φ`. Holding every other camera
fixed and maximizing `score_c` therefore maximizes `Φ`, and **`Φ` is non-decreasing across
the whole procedure** — which is what makes the sequential-greedy loop of §4 converge
rather than cycle. §4.4's acceptance rules only ever pick an orientation whose score is at
least the current one's, so they do not break this.

**The exponent therefore costs nothing theoretically**, and this is why §1.1 was free to
pick α on measured coverage alone. `Φ` is stated in terms of `G` rather than a closed form
precisely so that tuning α cannot invalidate the argument.

At α = 1, `G` is the harmonic numbers `H(n) = 1 + 1/2 + … + 1/n` — a pleasing closed form,
and the only reason 1 was the first default. It is a special case, not the definition; at
the shipped α = 2, `G(n) = Σ_{k<n} 1/(k+1)²`, which has no name and needs none.

Φ itself is never materialized: the loop accumulates **ΔΦ** from the accepted score
deltas, which is exact (§6.2), and §6.3 reports measured per-zone coverage instead of an
absolute Φ — a number that is not comparable across scenes and that no user acts on.

### 1.3 What the objective does *not* guarantee

**`Φ` is not the coverage rate, and the two can move in opposite directions.** A camera
that uniquely covers 100 voxels (score 100) can find an orientation seeing 60 blind voxels
plus 90 voxels one other camera already covers — score `60 + 45 = 105`, an improvement,
while the blind count rises by 40.

So the optimizer carries an explicit **blind-count gate** (§4.4): an orientation is only
eligible if it sees at least as many currently-blind voxels as the camera's present
orientation does. The present orientation always satisfies it, so an eligible candidate
always exists.

**Image quality is not modeled.** A voxel 2 m away and a voxel 49 m away count the same;
pixels-per-metre, incident angle, and lighting are outside the SDK's model
(`camera-coverage-sdk` §20). The lever that *is* available is each camera's **Range**
(`far`, `spec.md` §5.2), which the optimizer honours exactly — set it to the camera's real
identification distance and the objective counts only what that camera can actually use.
Adding a distance term was considered and rejected: a camera-dependent weight destroys the
`Φ` argument of §1.2 and with it the convergence guarantee.

---

## 2. Why a panorama, and not a search over `compute()` calls

The naive optimizer evaluates a candidate orientation by moving the camera and re-running
the engine. At ~96 cameras and tens of candidates each, that is thousands of dispatches.

The engine's own visibility rule (`camera-coverage-sdk` §8, `compute/cpu.ts` `sampleVisible`
and the WGSL twin) is:

```
voxel centre inside the frustum            ← depends on orientation
∧ radial distance to the camera ≤ far      ← independent of orientation
∧ the ray camera→centre hits no triangle   ← independent of orientation
```

The far cut is applied **radially**, on top of the projection matrix's depth-based far
plane; since depth ≤ radial distance, the radial cut is the binding one. So of the three
conditions, **only the frustum test depends on where the camera is pointing.**

The set of voxels a camera at a fixed mount point *could* see — call it its **reachable
set** — is therefore fixed, and re-aiming only changes which part of it falls inside the
frustum. Capture that set once, as a weighted angular image, and every candidate
orientation is a summation over bins with no GPU work at all.

### 2.1 The capture rig

Six **capture cameras** are placed at the camera's own mount point, `fov = 90°`,
`aspect = 1`, sharing the camera's `near` and `far`, oriented along ±X, ±Y, ±Z. Their six
90° frusta tile the sphere, so their union is exactly the reachable set.

Nothing about the visibility kernel changes: these are ordinary cameras, computed by the
ordinary Pass 2 (`camera-coverage-sdk` §11), which is why the panorama agrees with the
engine by construction rather than by a second implementation that could drift.

### 2.2 The SDK primitive

The capture reads back through a new aggregation primitive,
`AggregateSpec.projections` (`camera-coverage-sdk` §19.1, §19.3 Pass 7). For a named
camera it bins every voxel **that camera's mask bit says it sees** into that camera's own
image plane at `R × R`, adding a caller-supplied `u32` weight indexed by the voxel's
popcount `n` over `AggregateSpec.cameras`.

The app declares six projections — one per capture camera — with `R = 64` (1.4° per bin)
and **two weight planes**:

| plane | table | what the merged plane holds |
|---|---|---|
| 0 | `W_score[n] = round(16384 / (n + 1)^α)` | `16384 ×` the §1.1 score contributed by that bin |
| 1 | `W_blind[0] = 1`, `W_blind[n>0] = 0` | how many currently-blind voxels that bin holds |

and sets `AggregateSpec.cameras` to the mask of **enabled real cameras except the one being
optimized**, so `n` is exactly `n_others`.

**The capture carries the display descriptor's marked filter.** `setSampling` bounds what
is *computed* using the **axis-aligned AABBs** of the (possibly rotated) sampling volumes,
deliberately conservatively (`sampling_volumes.md` §7.1); the *counted* set is the exact
OBBs, enforced by the aggregation descriptor's `regions` + `maskRegions`. So each of the
six projections carries `maskRegions` (`camera-coverage-sdk` §19.1) naming the enabled
zones' volumes, and the descriptor carries those `regions`.

Without it the optimizer scores a **superset** of what every panel reports: the AABB slop
outside each rotated box, plus every voxel of every *disabled* zone — and then aims cameras
at voxels nobody counts. The filter is taken from `buildAggregateSpec`'s output rather than
rebuilt (§7), so the two descriptors cannot disagree about what "counted" means.

**A capture never calls `setSampling`** — it inherits whatever validity mask the engine
holds. So while a sampling edit is still waiting for a run to apply it
(`spec.md` §8's `samplingDirty`), both entry points are blocked with
`Run coverage once to apply the sampling change, then optimize.` Running a capture then
would score the *previous* zone set while the panels describe the new one.

**Fixed point.** `16384` is chosen so a single chunk's contribution to one bin cannot
overflow a `u32`: the ceiling is 262,144 voxels of one chunk projecting into one 1.4° bin,
against a worst case of ~72k (a bin at 50 m is ~1.2 m across and the whole depth column
behind it is visible, so at 0.1 m voxels it holds ~12 × 12 × 500). Cross-chunk merging is
done in `Float64Array` (§3.2), so only the per-chunk bound applies.

It was `4096`, which sufficed for α = 1 but rounds `1/(n+1)²` to **zero above n = 90** —
silently truncating the objective's tail the moment the exponent moved off 1. At `16384`
nothing truncates through the 128-camera ceiling at α = 2.

### 2.3 What this costs, and what it does not

One `compute()` per camera per round, `incremental: true`, whose dirty set is the chunks
the six capture frusta reach (`camera-coverage-sdk` §13.1) — a sphere of radius `far`
around the mount point, plus the previous camera's old and new frusta. Every candidate
orientation after that is free.

The residual approximation is **bin quantization**: the panorama knows a voxel's direction
only to 1.4°, so an orientation whose frustum edge cuts through a populated bin is scored
as if that bin were wholly in or wholly out. This affects *which* orientation is chosen
(§8's acceptance criterion bounds the damage), never the numbers the app reports — those
come from ordinary runs after the orientation is applied.

---

## 3. Model & state

### 3.1 The optimize session

An **optimize session** is the window during which the six capture slots exist in the
engine's camera list. It is opened by either entry point (§5, §6) and closed when both are
idle.

- **Opening** appends six cameras with ids `opt-cap-0` … `opt-cap-5` to the list handed to
  `setCameras()`. They are **never** scene entities: they do not appear in the hierarchy,
  are not selectable, are not exported to `scene.json`, and hold no `name`.
- **While open**, every display descriptor the app builds (`spec.md` §3.3) carries
  `cameras` = the mask of the real cameras, so zone coverage, section cells, the overlay's
  camera counts, and probe masks all read as though the capture slots were not there.
- **Closing** removes the six slots and **marks the coverage result stale**. The
  camera-list length changes, so the engine declines incremental recompute
  (`camera-coverage-sdk` §13.1) and the next run is full — which is what re-establishes
  the display numbers.

  The stale mark is not housekeeping. A capture recomputes its dirty chunks with the six
  slots present *and* with the camera under optimization at its proposed aim, and the
  worker **retains** those masks (`spec.md` §3.1). Closing without a recompute would leave
  every panel reading a layout the user just rejected — silently, because the numbers stay
  plausible. Apply marks stale through the camera edit it makes; Discard and a failed
  capture mark it explicitly.
- **Auto-run is suspended while a session is open** (`spec.md` §8.1). A session drives its
  own `compute()` calls; letting the staleness poller fire in parallel would interleave two
  runs with different camera lists.

**Slot budget.** A session requires `enabledAndDisabledCameraCount + 6 ≤ MAX_CAMERAS`
(128). Above that the entry points are disabled with the message
`Aim optimization needs 6 spare camera slots; the scene uses N of 128.`

**The placement tool claims the same six ids** (`camera_placement.md` §3.4), so an aim
session and a placement session are **mutually exclusive** and each disables the other's
entry points while open. Sharing them is deliberate: a feature that wanted its own six
would double the spare-slot requirement of every scene, for two tools a user never runs
simultaneously.

**Pending sampling.** A capture inherits the engine's validity mask rather than setting it,
so a session is also blocked while a sampling edit awaits a run (§2.2).

**No re-initialization on open or close.** `chunkSizeFor` (`App.tsx`) always sizes chunks
for `cameras.length + 6`, so `CAM_WORDS` and the suggested `chunkSizeXZ` are the same
whether or not a session is open, and opening one never triggers the §6 re-init pipeline.

### 3.2 The panorama

```ts
interface Panorama {
  resolution: number;           // R
  /** The pyramid, finest first: `levels[0]` is the R × R bin grid, the last
      level is one cell per face (§7.2). */
  levels: PanoramaLevel[];
  /** 6 × R × R × 3, unit world-space direction of each bin centre. */
  dir: Float32Array;
  /** Σ of `levels[0].score` — the whole reachable set, in fixed point. */
  totalScore: number;
  /** Σ of `levels[0].blind`. */
  totalBlind: number;
}

interface PanoramaLevel {
  /** Cells per axis, per face. */
  size: number;
  /** 6 × size × size, face-major then row-major. `SCORE_SCALE` × the §1.1
      score summed over the cell (§2.2). */
  score: Float64Array;
  /** 6 × size × size. Voxels in the cell that no other enabled camera sees. */
  blind: Float64Array;
  /** 6 × size × size × 12 — the four unit corner directions of each cell,
      world space, precomputed because only the frustum moves (§7.2). */
  corners: Float32Array;
}
```

The bin grid and the pyramid are one structure: `score` and `blind` live on
`levels[0]`, and every coarser level holds the same two quantities summed over its
subtree. There is no separate flat copy — §7.2's walk reads whichever level it is on.

`levels[0]` is built by summing every chunk's six `ProjectionAccum`s; each coarser level
sums its four children, halving with a **ceiling** so an odd level leaves a half-width
cell rather than a padded one — a cell is described by its own corners, so nothing is
assumed about what lies past the face edge. `Float64Array` rather than `Uint32Array`
because the merge is across up to 60 chunks and each chunk may legitimately contribute
close to the per-chunk `u32` bound (§2.2).

Face order is `[−Z, −X, +Z, +X, +Y, −Y]`, matching the yaw/pitch pairs
`(0,0) (90,0) (180,0) (270,0) (0,90) (0,−90)` under the app's `YXZ` convention
(`cameras/math.ts`).

### 3.3 Per-camera outcome

```ts
interface AimProposal {
  cameraId: string;
  current: { yaw: number; pitch: number; score: number; blind: number };
  best:    { yaw: number; pitch: number; score: number; blind: number };
  /** `best.score / current.score − 1`; `Infinity` when the camera currently sees
      nothing and a candidate sees something, 0 when neither does (§4.4). */
  gain: number;
  /** False when no eligible candidate beat the current orientation by §4.4's 1%. */
  moved: boolean;
  /** The orientation to write if the proposal is applied: `best` when `moved`,
      the camera's present rotation otherwise, with `roll` carried through (§4.3). */
  rotation: Quat;
}
```

`score` here is in §1.1 units — the raw bin sums divided by `SCORE_SCALE` (§2.2).

---

## 4. The algorithm

### 4.1 Sequential greedy

Cameras are processed **one at a time**, in **scene-hierarchy order** (`spec.md` §5.5), and
each camera's new orientation is pushed to the engine before the next camera is captured.
The next camera's `n_others` therefore reflects every decision already made in this round.

Order is hierarchy order rather than worst-first because greedy order changes the outcome
and a deterministic order is reproducible, testable, and predictable for the user. Multiple
rounds wash out most of the order dependence.

Only cameras that are **enabled** (`spec.md` §5.4) and **not locked** (§4.5) are optimized.
Disabled cameras keep their mask-bit slot but contribute no bits, so they neither affect
`n_others` nor get a proposal.

### 4.2 Rounds and convergence

A round is one pass over every optimizable camera. Rounds repeat while

- at least one camera moved in the round, **and**
- the round's `ΔΦ` (the sum of accepted `best.score − current.score`, §1.2) is positive,

up to a maximum of **3 rounds**.

`ΔΦ` is exactly the round's change in `Φ`, because each accepted move changes `Φ` by its
own score delta with every other camera held fixed.

### 4.3 Search

The panorama is searched **exhaustively** on a 1° grid: `yaw ∈ [−180, 180)` (360 values),
`pitch ∈ [−89, 89]` (179 values), 64,440 candidates. `roll` is carried through from the
camera's present orientation, untouched — a mounted camera's horizon stays level, the same
invariant `aimDelta` and the rotation fields enforce (`spec.md` §5.1, §5.2).

The winner is then refined on a 0.25° grid over ±1° in both axes.

Every candidate is scored by the pyramid walk of §7.2; there is no gradient, no surrogate
model, and no random component. The search is a pure function of the panorama and the
camera's FOV / aspect / roll.

### 4.4 Acceptance

A candidate is **eligible** iff

```
blind(candidate) ≥ blind(current)
```

— it must not abandon more currently-blind voxels than it gains (§1.3). The current
orientation is trivially eligible, so the eligible set is never empty.

Among eligible candidates the highest `score` wins, and it is **applied only if**

```
score(best) ≥ score(current) × (1 + 0.01)
```

A camera is not re-aimed for less than a 1% gain: a physical camera that has to be sent up
a ladder should not move for noise, and the threshold also ends rounds sooner. When
`score(current)` is 0 (the camera currently sees nothing) any positive score is accepted.

### 4.5 Locking a camera

Every camera carries `aimLocked?: boolean` (default false). A locked camera is skipped by
the whole-scene run and its per-camera **Optimize** button is disabled with the reason. The
flag lives on the camera entity, round-trips through `scene.json` (§9), and is toggled from
the camera panel — the one part of this feature that belongs beside the camera's own
fields rather than in the tool panel (§5).

Locking is the answer to "this camera's angle is fixed by contract"; there is deliberately
**no angular constraint** beyond `pitch ∈ [−89, 89]`. A camera turned toward a wall scores
near zero on its own, so the objective already rejects the orientations a bracket limit
would have.

---

## 5. Where the panel lives

**One panel, in the right sidebar, directly below the sampling-zone tool**
(`sampling_volumes.md` §6.3) and above the stats panel. It carries both entry points.

The right sidebar is the app's **tool** column — the controls that act on the whole scene
(run, overlay, sampling zones, stats) — while the left column is the *selection inspector*
(`spec.md` §2.2). Aim optimization is a tool: its whole-scene entry point has no selection
at all, and its per-camera entry point *reads* the selection rather than editing it. Putting
it in the left column would also stack a 2:1 heatmap on top of the camera editor's numeric
fields and push them out of view — the two would compete on the axis the inspector needs.

What stays in the camera panel is the one thing that is a property of the camera: the
**aim-lock checkbox** (§4.5).

### 5.1 Per-camera flow

Selecting a camera and pressing **Optimize <name>** in that panel:

1. Opens a session (§3.1) if one is not open.
2. Runs one capture for that camera and builds its panorama.
3. Renders the **score heatmap** (§5.2) and the proposal (§3.3) in the panel.
4. Draws that camera **at its proposed aim** in the viewport.

Preview is the camera moved, not a second ghost frustum beside it: at one mount point two
frusta read as two cameras, and the thing being decided is where this one points. The
scene state is untouched either way (§6.1), which is what makes Discard exact.

The user may then

- **hover the heatmap**, to read the score at any orientation and see the camera swing to
  it — free, since scoring is a panorama lookup;
- **click the heatmap** to *pick* that orientation, which replaces the proposal as what
  Apply will write. The optimizer maximizes one objective; a user with a reason it does not
  model — a doorway that matters more than its voxel count — needs a way to say so, and the
  score map already tells them what they are giving up. A **clear** control reverts to the
  proposal. This is also the answer when the proposal is "no improvement": the camera can
  still be re-aimed by hand from the same map.
- press **Apply** to write the picked orientation, or the proposal when nothing is picked,
  which marks the result stale like any other camera edit (`spec.md` §8.1);
- press **Discard**, or select a different entity, to drop the panorama and close the
  session.

The panel keeps the panorama until the camera's **position**, `fov`, `aspect`, `near`,
`far`, the enabled set, the sampling zones, or the resolution changes — any of which
invalidates the reachable set or the weights. A pure *rotation* edit of the same camera
does **not** invalidate it, which is exactly what makes the drag preview free.

---

### 5.2 The score heatmap

A `yaw × pitch` image of `scoreOrientation`, 2° per pixel — 180 × 90 = 16,200 samples,
one pyramid walk each, computed once per panorama. Yaw runs −180…180° left to right,
pitch +89…−89° top to bottom, and the ramp is normalized to the panorama's own maximum.

It exists because §2 made it nearly free, and because a single proposed number is not
reviewable: a user deciding whether to trust a re-aim wants to see whether the optimum is
a broad plateau or a knife edge, and whether the current aim was near it.

## 6. Whole-scene flow

**Optimize all aims**, the panel's second button, starts the §4 loop over every
optimizable camera. It needs no selection.

### 6.1 During the run

- A progress line reports `round r/3 · camera k/N` and the camera's name.
- The engine is advanced camera by camera (§4.1), but the **app's scene state is not
  written**. Proposed orientations live in the session and the viewport draws each camera
  at its proposal, so the emerging layout is visible without any of it being committed.
- **Cancel** aborts at the next camera boundary, discards every proposal, pushes the
  original orientations back to the engine, and closes the session.

Not writing to scene state during the loop is what makes Cancel exact rather than an
"undo everything" button, and it keeps the loop from firing the §8.1 staleness machinery
once per camera.

### 6.2 On completion — the proposal

The summary lists, per moved camera, its `gain` and its yaw/pitch delta, plus the round
count and the run's **ΔΦ** — the sum of accepted `best.score − current.score`, which is
exactly the change in Φ (§1.2).

**A reported proposal spans the run, not the last round.** The loop converges by running a
round in which nothing moves (§4.2), so a camera's entry records its **original** aim, its
**final** aim, and the gain over that span. Recording each round's proposal verbatim
instead overwrote an accepted move with that final no-move one, and the summary then
reported that nothing improved and refused to apply rotations the session was already
holding — a failure that occurred on exactly the *successful* case, and looked correct only
when the loop ran out of rounds still moving.

**Apply is enabled by what it writes.** It writes the session's accepted rotations, so it
is gated on those being non-empty — not on a count derived from the proposal rows. The two
disagreeing is the bug above; deriving the gate from the thing being applied is what makes
it impossible.

**Apply all** writes every proposal into the scene in one state update — one staleness
mark, one auto-run — and closes the session. **Discard** drops them and closes the session.

Nothing here is an "after" coverage figure. The panorama can predict its own objective and
nothing else: it is one weighted angular image per camera, with no zone decomposition and a
1.4° quantization (§2.3), so a predicted per-zone coverage delta would be a number the app
could not stand behind. The measured comparison below is the honest version.

### 6.3 After the apply — measured, per zone

**ΔΦ is the right thing to maximize and the wrong thing to report.** It is one number over
the whole counted set, and a zoned site is zoned precisely because its parts are *not*
interchangeable: "Φ went up" cannot say whether the loading bay improved or paid for the
corridor. §1.3's failure mode is real and per-zone, so the report has to be too.

So the run that reconciles an apply produces a **measured before/after table**, one row per
sampling zone plus a union row:

| Zone | Coverage | Blind |
|---|---|---|
| All enabled zones | 50.0% → 62.0% **+12.0** | 500 → 380 |
| Dock | 80.0% → 55.0% **−25.0** | 80 → 180 |
| Corridor | 30.0% → 67.0% **+37.0** | 420 → 198 |

Both columns are measured, from real runs — the app already computes a `ZoneSummary` per
zone on every run (`sampling_volumes.md` §7.2), so the "before" is a snapshot taken at
apply time and the "after" is the reconciling run's own output. The union row is labelled
**Whole workspace** when zones are not in use, since there is then no union the user created.

**Rows are ordered regressions first**, then by improvement, and any regression raises a
warning banner. A sacrifice buried under a list of wins is a sacrifice that goes unnoticed,
and this is the one outcome the optimizer's own score cannot rule out.

A drop smaller than `RATE_EPSILON` (0.05 percentage points) is reported but **not flagged**:
coverage is a ratio of integer voxel counts and moves by a voxel or two for reasons
unrelated to aim, so flagging that would make the banner meaningless.

The comparison describes a *past* apply, so it is hidden while a new session is open —
showing the last run's outcome beside this run's proposal invites reading one as the other.

**Per-zone Φ is deliberately not reported.** Φ needs the popcount *distribution* over a
zone's voxels; `RegionAccum` carries `valid`/`covered`/`blind`/`seen[]`, which is not
enough, and `leafCounts` is filtered to the marked set as a whole rather than per zone.
Coverage rate and blind count are exact per zone and are what the user acts on.

---

## 7. Modules

```
src/optimize/
  weights.ts          §2.2 fixed-point weight tables
  cubeRig.ts          §2.1 the six capture cameras for a mount point
  panorama.ts         §3.2 merge ProjectionAccums → Panorama; bin directions; the pyramid
  search.ts           §4.3, §4.4 scoreOrientation / searchBest / eligibility
  greedy.ts           §4.1, §4.2 the round loop, as a pure driver over a capture callback
  session.ts          §3.1 slot management, camera masks, descriptor assembly (including
                      the marked filter handed over from `scene/aggregateSpec.ts`)
  comparison.ts       §6.3 measured per-zone before/after; pure, no engine
  useAimOptimizer.ts  §3.1, §5, §6 the session as React state; the only module that
                      calls the engine
src/ui/
  OptimizePanel.tsx   §5, §5.2, §6 the panel, the heatmap, the summary
```

Three App-level wirings hold the session's invariants (§3.1):

- `chunkSizeFor` always adds `CAPTURE_SLOTS`, so opening a session never changes
  `chunkSizeXZ` and never triggers the §6 re-init pipeline.
- the display descriptor carries `cameras: displayCameraMask(...)` while `maskSlots` is
  set, and a completed **full** run clears it — a capture overwrites the worker's retained
  chunks, so the slots' bits stay in those masks until every chunk is replaced.
- auto-run and the Run button are gated on `optimizer.busy`, and closing a session marks
  the result stale so the auto-run that follows is the full run that clears the mask.

### 7.1 `greedy.ts` is engine-free

The round loop takes `capture(cameraIndex) => Promise<Panorama>` and
`apply(cameraIndex, quat) => void` as parameters. Everything in §4 — ordering, rounds, the
gate, the gain threshold, `ΔΦ` accumulation — is then a pure function testable with a
scripted capture callback and no GPU, no worker, and no React.

### 7.2 The pyramid walk

Scoring one orientation by testing all `6 · 64²` = 24,576 bins would cost 1.6 × 10⁹ tests
across the search. Instead each face carries a mip pyramid (64 → 32 → … → 1) whose nodes
hold the summed `score` / `blind` of their subtree and the four **corner directions** of
their cell.

A candidate's frustum is five half-spaces through the origin (front, left, right, bottom,
top). A cube-face cell projects to a **convex** spherical polygon, so:

- all four corners inside all five half-spaces ⇒ the whole cell is inside ⇒ add the node's
  sums and stop;
- all four corners outside any **one** half-space ⇒ the whole cell is outside ⇒ stop;
- otherwise descend.

At leaf level the **bin centre** decides, which is where §2.3's 1.4° quantization enters.
Cost per candidate falls to the frustum's boundary length in bins — a few hundred tests.

---

## 8. Testing

The panorama derivation is the part of this design that can be wrong in a way that still
produces plausible numbers, so it is pinned by its **outcome**, not by its intermediate
values:

- **`test/optimizeAcceptance.test.ts`** — on a small CPU-backend scene, brute-force the
  true `score_c(θ)` on a coarse orientation grid using real `compute()` runs, then assert
  that the orientation `searchBest` returns from a single capture scores **≥ 99% of the
  brute-force optimum**. This is the feature's contract; quantization is only a failure if
  it changes the choice. A second case adds a **rotated** marked zone and asserts the
  filtered panorama's score matches the *in-zone* ground truth (not the scene-wide one),
  and that honouring the zone aims at least as well inside it as ignoring it — the
  regression the missing filter caused.
- **`test/panorama.test.ts`** — bin directions round-trip through the capture cameras'
  projection; the pyramid's summed nodes equal a direct sum over their leaves; a
  fully-containing frustum scores the whole panorama.
- **`test/optimizeComparison.test.ts`** — the §6.3 diff: a zone that lost coverage while
  the union improved is flagged and listed first, improvements are ordered by size, a
  sub-epsilon drop is reported but not flagged, an empty zone is omitted while a zone that
  *became* empty still appears, and labels come from the live zone list so a rename shows.
- **`test/optimizeObjective.test.ts`** — runs the §4 loop end to end on a small
  CPU-backend scene at α = 1 and at the production α, and asserts the default reaches at
  least as much **measured coverage**. This is the only kind of test that can see a *worse
  layout*: every unit test passed while α = 1 was leaving 1.7 points of coverage on the
  table. Also asserts the weight table never truncates to zero at the default exponent.
- **`test/greedy.test.ts`** — with a scripted capture callback: a camera moved in round 1
  is still reported as moved after a converging round 2, and its reported proposal spans
  original → final aim (§6.2's regression); hierarchy order is
  respected, locked and disabled cameras are skipped, the blind gate rejects a
  higher-scoring candidate that abandons blind voxels, the 1% threshold suppresses a
  0.5% gain, `ΔΦ` accumulates accepted deltas, and the loop stops on a no-move round.
- **`test/optimizeSession.test.ts`** — the slot budget check, the `cameras` mask excludes
  both the capture slots and the camera under optimization, the scene list keeps its
  identity across captures (so incremental recompute survives), an override never mutates
  the scene entity, and the descriptor passes the SDK's own §19.6 validation as built.
- **`test/sceneFile.test.ts`** — `aimLocked` round-trips and is omitted when false (§9).

On the SDK side (`camera-coverage-sdk` §19.5), `test/aggregate.test.ts` gains CPU/WebGPU
parity for Pass 7 and for the `cameras` mask, plus §19.6 validation cases.

---

## 9. Scene file (`spec.md` §14.3)

`Camera` gains one optional key:

```jsonc
{ "id": "cam-3", "name": "Dock", "aimLocked": true, … }
```

Absent ⇒ `false`. The capture slots are session-only and never appear (§3.1). No other
scene-file change: the optimizer's output is the camera `rotation` that is already there.

---

## 10. Error handling (`spec.md` §11)

| Situation | Behavior |
|---|---|
| fewer than 6 spare camera slots | entry points disabled, §3.1's message in the status area |
| a capture `compute()` rejects | the loop stops, the session closes, proposals are discarded, the SDK message goes to the status area |
| every optimizable camera is locked or disabled | **Optimize all aims** is disabled with `No camera is available to optimize.` |
| a sampling edit still awaits a run | both entry points blocked, `Run coverage once to apply the sampling change, then optimize.` (§2.2) |
| the camera under optimization sees nothing at any orientation | `moved: false`, reported as "no improvement found" |

A `COMPUTE_CANCELED` from the user's own Cancel is not an error and is surfaced nowhere
(`spec.md` §8.1).

---

## 11. Terminology (`spec.md` §17)

| Term | Meaning |
|---|---|
| **reachable set** | the voxels a camera at a fixed mount point could see at *some* orientation — §2 |
| **panorama** | the weighted angular image of that set, `6 × R × R` bins — §3.2 |
| **capture** | one `compute()` that produces one camera's panorama — §2.1 |
| **capture slot** | one of the six session-only cameras that perform a capture — §3.1 |
| **proposal** | a camera's current-vs-best orientation and its gain — §3.3 |
| **Φ** | the scene potential `Σ_v G(n(v))`, `G` the running sum of the weight `f`; the quantity the greedy loop increases — §1.2 |
| **α** | `REDUNDANCY_EXPONENT`, how sharply `f(n) = 1/(n+1)^α` discounts an already-covered voxel. 2 — §1.1 |
| **blind gate** | the eligibility rule that a candidate not abandon blind voxels — §4.4 |

---

## 12. Edits made elsewhere (consistency)

**`camera-coverage-sdk/specs/spec.md`**

- §19 preamble — a fifth primitive, and the SDK is domain-free about it too.
- §19.1 — `AggregateSpec.cameras`, `AggregateSpec.projections`, `AggregateProjection`,
  and why a projection carries its own matrix.
- §19.2 — `ProjectionAccum`, and why the weights are a caller-supplied `u32` table.
- §19.3 — Pass 7, and the orientation-independence rationale.
- §19.4 — "Passes 4–6" → "Passes 4–7"; the staging-size bound gains the projection term.
- §19.6 — six new validation rows.

**`spec.md`**

- §5 — `Camera` gains `aimLocked`.
- §8.1 — auto-run is suspended while an optimize session is open.
- §14.3 — `aimLocked` in the scene-file camera record.
- §16 — the optimizer leaves "out of scope" and points here.
- §17 — the §11 terms.

---

## 13. Out of scope / future

- **Position placement shipped** — choosing *where* cameras go, from user-declared mount
  regions, is [`camera_placement.md`](./camera_placement.md). It is a separate feature
  rather than an extension of this one because its objective is deliberately different:
  every voxel worth 1, other cameras ignored, unioned over a layout (that spec's §1.2).
  The two compose in one direction — place, then aim — and **share the six capture slots**
  of §3.1, so only one session can be open at a time. Optimizing **FOV or range** remains
  out of scope for both.
- Any objective term for image quality — pixels-per-metre, incident angle, lighting.
- **Removing** or relocating existing cameras. `camera_placement.md` only adds.
- Per-camera angular limits beyond the `pitch ∈ [−89, 89]` clamp and the lock flag.
- Optimizing several cameras simultaneously (joint rather than sequential-greedy), and the
  surrogate-model optimizers — Bayesian optimization, CMA-ES, differential evolution — that
  a more expensive per-candidate evaluation would justify. §4.3's search is exhaustive
  because §2 made a candidate cost microseconds; if a future objective makes it expensive
  again, `search.ts` is the seam to replace.
- Persisting proposals across a reload, or a proposal history / undo stack beyond the
  session's Discard.
