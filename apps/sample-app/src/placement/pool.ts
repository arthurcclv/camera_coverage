/**
 * The pool: how positions are drawn from a group's constraints, what a build step
 * runs under, and when one is rejected (`camera_placement.md` §3.3, §4.1–§4.3).
 *
 * This module knows the SDK's shapes and the app's camera entity; `analyze.ts`
 * knows neither, which is what keeps the algorithm testable without a GPU
 * (§12) — the same split `aim_optimization.md` draws between `session.ts` and
 * `greedy.ts`.
 */
import {
  MAX_CAMERAS,
  camWords,
  type AggregateSpec,
  type CameraConfig,
  type Vec3,
} from '@linkervision/camera-coverage-sdk';
import type { SceneCamera } from '../cameras/camera.ts';
import { toCameraConfig } from '../cameras/camera.ts';
import { markedFilterForZones, type MarkedFilter } from '../scene/aggregateSpec.ts';
import {
  inAnyVolume,
  volumesOfZones,
  zoneLabel,
  type SamplingVolume,
  type Zone,
} from '../scene/samplingVolumes.ts';
import { CAPTURE_SLOTS, captureRig } from '../optimize/cubeRig.ts';
import { ballOffset, constraintOffset, haltonPoint } from './halton.ts';
import { EMPTY_LEAF_SET, type LeafSet } from './leafSet.ts';
import {
  constraintLabel,
  DEFAULT_TEMPLATE,
  pointOnPrimitive,
  primitiveMeasure,
  type CameraConstraint,
  type ConstraintGroup,
} from './region.ts';

/**
 * What a group's target zones resolve to for one build (§3.1.2).
 *
 * One value rather than four accessors because all of it is derived from the same
 * `(group.zoneIds, zones, volumes)` and every consumer needs it consistent: a
 * filter from the listed zones with a total from the enabled ones would be a
 * percentage of the wrong denominator, computed without anything looking wrong.
 */
export interface GroupTarget {
  /** The filter every build step of this group counts under (§3.3). */
  filter: MarkedFilter;
  /** Counted voxels in the target set — the §5.2 denominator; 0 before any run. */
  total: number;
  /** The volumes the mount filter tests against; empty ⇒ no mount filter (§4.1.1). */
  mountVolumes: readonly SamplingVolume[];
  /** Display labels of the resolved target zones, for §5.2's axis; empty ⇒ untargeted. */
  zoneNames: string[];
  /** What the target set is, for the §3.3.1 fingerprint. */
  markedRevision: string | number;
  /** What the mount filter is, for the §3.3.1 fingerprint. */
  mountRevision: string;
}

/** One drawn position, and — once built — its reachable set (§3.3). */
export interface PoolPosition {
  /** Draw order within the pool; stable identity across an extension. */
  index: number;
  constraintId: string;
  /** The constraint's own sequence index this position came from (§4.1). */
  seqIndex: number;
  position: Vec3;
  /** Reachable set ∩ marked set, as merged cubes (§2.1). */
  set: LeafSet;
  /** `set.count` — the position's own score, shading the scatter (§5.2). */
  count: number;
}

/** A built pool and what it is only valid for (§3.3). */
export interface Pool {
  groupId: string;
  /** Everything the sets are valid for; a change discards the pool (§3.3.1). */
  fingerprint: string;
  /**
   * The `poolSize` this pool was built at (§3.3.1).
   *
   * Not `positions.length`: a constraint that exhausts its rejection budget
   * leaves the pool short of what was asked for (§4.2), and a Build button that
   * compared the *kept* count against the field would then read `Extend` forever
   * on a scene with a buried constraint.
   */
  size: number;
  /**
   * The group's `seed` these positions were drawn from (§3.3.1).
   *
   * Recorded rather than folded into `fingerprint` because the seed changes no
   * *scene*: a seed edit must re-label Build as a **Rebuild** — an extend would
   * append new-seed positions to old-seed ones — without dimming the result and
   * claiming the scene moved underneath it (§5.1).
   */
  seed: number;
  positions: PoolPosition[];
  /** Positions drawn and built but rejected for seeing nothing (§4.2). */
  rejected: number;
  /** Constraints every one of whose drawn positions was rejected (§4.2). */
  emptyConstraints: string[];
  /** `|⋃ every position's set|` — the ceiling any layout from this pool reaches. */
  poolCeiling: number;
  /** Counted voxels in the group's target set — the score's denominator (§5.2). */
  markedTotal: number;
  /**
   * Every enabled constraint's §4.1.1 overlap with the group's target zones,
   * in constraint order. Empty when the group has no mount filter.
   *
   * Kept on the pool because it is what the §5.1 card reports instead of a
   * discard count: under effective-measure splitting a discard count is the
   * sampler hitting its expected rate and says nothing, while `North wall 4%`
   * names the constraint to move, widen, or stop listing.
   */
  overlaps: ConstraintOverlap[];
}

/** One constraint's share of its own draws that pass the mount filter (§4.1.1). */
export interface ConstraintOverlap {
  constraintId: string;
  /** `hits / OVERLAP_SAMPLES`, in [0, 1]. Zero ⇒ the constraint is dropped. */
  fraction: number;
}

/**
 * Attempts a constraint may spend to fill its share before giving up (§4.2).
 *
 * A constraint buried entirely inside geometry has to terminate, and a
 * multiplier rather than a fixed count keeps the budget proportional to what was
 * asked for.
 */
export const REJECT_ATTEMPT_FACTOR = 3;

/**
 * The largest pool the `Size` field will accept (§5.1).
 *
 * Not a limit of the method — a pool is a flat list of positions and costs
 * megabytes at any size in range — but a guard against a mistyped digit
 * committing an unattended GPU run.
 */
export const POOL_SIZE_MAX = 10_000;

// --- Blocking (§10) ----------------------------------------------------------

/**
 * Why the pool cannot be built, or `null` when it can (§10).
 *
 * The slot check is the aim optimizer's own (`aim_optimization.md` §3.1): one
 * rig is resident at a time, so a placement analysis needs the same six spare
 * bits on a scene of any size — which is the whole reason the pool is cached
 * rather than re-measured per trial (§2.2).
 */
export function poolBlocker(
  cameras: readonly SceneCamera[],
  group: ConstraintGroup | null,
  constraints: readonly CameraConstraint[],
  opts: {
    samplingPending?: boolean;
    aimSessionOpen?: boolean;
    /**
     * Whether the engine has finished `init → loadScene → setSampling` and is
     * not in an error state.
     *
     * Checked first, and checked at all because a build step is the one entry point
     * that does not go through the app's own Run gate: without it a click during
     * startup reaches a worker that holds no engine yet, and the failure surfaces
     * as an SDK `INVALID_STATE` naming nothing the user can act on.
     */
    engineReady?: boolean;
  } = {},
): string | null {
  if (opts.engineReady === false) return 'Wait for the engine to finish loading the scene.';
  if (cameras.length + CAPTURE_SLOTS > MAX_CAMERAS) {
    return `Camera placement needs ${CAPTURE_SLOTS} spare camera slots; the scene uses ${cameras.length} of ${MAX_CAMERAS}.`;
  }
  if (opts.aimSessionOpen) return 'Close the aim optimizer before placing cameras.';
  if (opts.samplingPending)
    return 'Run coverage once to apply the sampling change, then build the candidate positions.';
  if (!group) return 'Create a constraint group to place cameras.';
  if (!enabledConstraints(group, constraints).length) {
    return 'This group has no enabled constraint to sample.';
  }
  return null;
}

/** What a finished build step means (§4.2). */
export type BuildStepOutcome = 'failed' | 'rejected' | 'kept';

/** One sampled candidate position and what it reached (§4.6). */
export interface PositionSample {
  position: Vec3;
  count: number;
}

/**
 * The position a **reposition** moves its camera to (§4.6).
 *
 * A `maxCount = 1` search needs no trials: with one camera the layout's score
 * *is* that position's own `count`, so the best layout is the best position.
 * Ties keep the earlier draw, which is what makes a re-run on an unchanged
 * scene land the camera in the same place; and a sample that saw nothing is
 * never a candidate, so an all-rejected constraint returns `null` rather than
 * moving the camera somewhere blind.
 */
export function bestSample(samples: readonly PositionSample[]): PositionSample | null {
  let best: PositionSample | null = null;
  for (const s of samples) {
    if (s.count > 0 && (best === null || s.count > best.count)) best = s;
  }
  return best;
}

/**
 * Why a camera cannot be repositioned, or `null` when it can (§4.6, §10).
 *
 * A reposition *is* a pool build, just of one constraint, so it inherits every
 * §10 rule `poolBlocker` enforces and adds only the two that are its own: the
 * camera has to be bound, and the constraint it names has to still exist — a
 * scene load can retire a constraint out from under a camera that still carries
 * its id.
 */
export function repositionBlocker(
  camera: SceneCamera,
  cameras: readonly SceneCamera[],
  constraints: readonly CameraConstraint[],
  groups: readonly ConstraintGroup[],
  opts: Parameters<typeof poolBlocker>[3] = {},
): string | null {
  if (camera.constraintId === undefined) return 'Bind this camera to a constraint first.';
  const constraint = constraints.find((c) => c.id === camera.constraintId);
  if (!constraint) return "This camera's constraint no longer exists.";
  const owner = groups.find((g) => g.id === constraint.groupId) ?? null;
  return poolBlocker(cameras, owner, [constraint], opts);
}

/**
 * Classify one build step attempt (§4.2).
 *
 * **`failed` and `rejected` are not the same thing**, and this function exists
 * because they were once conflated. `engine.compute` reports a failure by
 * returning null rather than throwing (`engine/useEngine.ts`), and a failed run
 * yields no chunks — which is indistinguishable, at the call site, from a
 * position that legitimately saw nothing. Treating the first as the second made
 * a broken engine look like the rejection rule firing on every draw: no error
 * was raised, the session kept its capture slots, and the Run button stayed
 * disabled with nothing on screen explaining why.
 *
 * So the caller must know whether the run *happened* (`ran`) separately from
 * what it found (`reachableCount`), and this is where the two become an outcome.
 */
export function classifyBuildStep(ran: boolean, reachableCount: number): BuildStepOutcome {
  if (!ran) return 'failed';
  return reachableCount === 0 ? 'rejected' : 'kept';
}

// --- The mount filter and the effective measure (§4.1.1) ---------------------

/**
 * Draws spent estimating one constraint's overlap with the target zones (§4.1.1).
 *
 * At 256 a constraint that estimates to zero had well under ~1% usable extent,
 * which is the accuracy the §5.1 readout needs to be worth trusting; and the
 * draws are not wasted, since they are the prefix the real draw consumes next.
 */
export const OVERLAP_SAMPLES = 256;

/**
 * CPU attempts a constraint may spend clearing the mount filter (§4.1.1).
 *
 * Far larger than {@link REJECT_ATTEMPT_FACTOR} because the two budgets buy
 * different things: a §4.2 rejection costs ~1.2 s of GPU, while this test is a
 * few dozen flops against a handful of OBBs. A constraint with a 1% overlap is
 * genuinely usable and must not be starved by a cap sized for the expensive one.
 */
export const MOUNT_ATTEMPT_FACTOR = 200;

/**
 * The fraction of a constraint's own draws that land inside `volumes` (§4.1.1).
 *
 * **The estimator is the sampler**: it takes positions from the same
 * five-dimensional sub-sequence {@link drawPosition} does, primitive point *plus*
 * ball offset. That is what makes it honour `distance` — a rail 0.3 m outside a
 * zone with `distance = 2` yields plenty of valid mounts, and an estimator that
 * measured the bare primitive's overlap would call it zero and drop it — and it
 * is why the number is directly the acceptance rate the rejection loop will see.
 */
export function overlapFraction(
  c: CameraConstraint,
  seed: number,
  volumes: readonly SamplingVolume[],
): number {
  if (volumes.length === 0) return 0;
  let hits = 0;
  for (let k = 0; k < OVERLAP_SAMPLES; k++) {
    if (inAnyVolume(drawPosition(c, seed, k), volumes)) hits++;
  }
  return hits / OVERLAP_SAMPLES;
}

/** What a draw actually runs over: which constraints, at what weight (§4.1, §4.1.1). */
export interface DrawBasis {
  /** The constraints that contribute positions, in scene order. */
  constraints: CameraConstraint[];
  /** `constraints[i]`'s weight for the §4.1 split. */
  weights: number[];
  /** Every **enabled** constraint's overlap — including the dropped ones (§5.1). */
  overlaps: ConstraintOverlap[];
  /** The volumes a drawn position must land in; empty ⇒ no mount filter. */
  mountVolumes: readonly SamplingVolume[];
}

/**
 * Resolve a group's draw inputs (§4.1.1).
 *
 * With no mount filter this is exactly the pre-feature behaviour: every enabled
 * constraint, weighted by its primitive measure. With one, each constraint's
 * weight becomes its **effective measure** — `measure × overlapFraction` — and a
 * constraint that estimates to **zero** is dropped from the list entirely rather
 * than kept at weight 0. Dropping it is what keeps §4.1's floor of 1 meaningful:
 * a floor position on a constraint no draw can satisfy would burn its attempt cap
 * and still leave the pool one short of `poolSize`.
 */
export function drawBasis(
  group: ConstraintGroup,
  constraints: readonly CameraConstraint[],
  mountVolumes: readonly SamplingVolume[] = [],
): DrawBasis {
  const enabled = enabledConstraints(group, constraints);
  if (mountVolumes.length === 0) {
    return {
      constraints: enabled,
      weights: enabled.map(primitiveMeasure),
      overlaps: [],
      mountVolumes: [],
    };
  }
  const overlaps = enabled.map((c) => ({
    constraintId: c.id,
    fraction: overlapFraction(c, group.seed, mountVolumes),
  }));
  const kept: CameraConstraint[] = [];
  const weights: number[] = [];
  enabled.forEach((c, i) => {
    if (overlaps[i].fraction <= 0) return;
    kept.push(c);
    weights.push(primitiveMeasure(c) * overlaps[i].fraction);
  });
  return { constraints: kept, weights, overlaps, mountVolumes };
}

/**
 * The basis for a draw over **one** constraint — §4.6's Reposition.
 *
 * It takes the constraint it was invoked on whatever its measure or its overlap:
 * a Reposition is a user pointing at a constraint, not a search allocating a
 * budget across several, so the §4.1.1 zero-hit drop has nothing to decide here.
 * The mount filter still applies to the draw itself, because it is the same draw.
 */
export function soloBasis(
  c: CameraConstraint,
  mountVolumes: readonly SamplingVolume[] = [],
): DrawBasis {
  return { constraints: [c], weights: [primitiveMeasure(c)], overlaps: [], mountVolumes };
}

/**
 * Every enabled constraint's §4.1.1 overlap with a group's target zones, or
 * **empty** when the group has no mount filter to judge them by.
 *
 * Pure, and separate from {@link drawBasis}, because two things read it that
 * never build a pool: §5's gizmo dimming and the readout beside it. Taking the
 * group rather than a flag keeps "does this group have a mount filter" in one
 * place — a caller that tested `restrictMounts` itself and forgot `zoneIds`
 * would paint every constraint of an untargeted group as unmountable.
 */
export function constraintOverlaps(
  group: ConstraintGroup | null,
  constraints: readonly CameraConstraint[],
  volumes: readonly SamplingVolume[],
): ConstraintOverlap[] {
  if (!group || !group.restrictMounts || group.zoneIds.length === 0) return [];
  const mountVolumes = volumesOfZones(volumes, group.zoneIds);
  if (mountVolumes.length === 0) return [];
  return enabledConstraints(group, constraints).map((c) => ({
    constraintId: c.id,
    fraction: overlapFraction(c, group.seed, mountVolumes),
  }));
}

/** The no-mount-filter case: nothing dims. Shared so the view cannot churn on it. */
export const NO_UNMOUNTABLE: ReadonlySet<string> = new Set<string>();

/** The constraints of {@link constraintOverlaps} no draw can land on (§4.1.1). */
export function unmountableIds(overlaps: readonly ConstraintOverlap[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const o of overlaps) if (o.fraction <= 0) out.add(o.constraintId);
  return out.size > 0 ? out : NO_UNMOUNTABLE;
}

/**
 * The app's own marked set — what a group with no target zones scores against
 * (§3.1.2). One value, so {@link resolveGroupTarget} cannot pair a filter with
 * somebody else's denominator.
 */
export interface AppMarkedSet {
  filter: MarkedFilter;
  /** Counted voxels in it — 0 before any run has produced one. */
  total: number;
  /** What it is, for the §3.3.1 fingerprint. */
  revision: string | number;
}

/**
 * A constraint group's target (§3.1.2), resolved against the live scene.
 *
 * With no target zones this is exactly what placement did before the feature: the
 * display descriptor's own filter and the denominator the stats panel quotes, so
 * the two rates stay comparable. With target zones it is those zones instead —
 * **regardless of `useZones` and of each zone's `enabled`** — because the group
 * states its own target and a display toggle does not get to redefine what a
 * search was run for. That is safe on the compute side: `setSampling` is fed
 * every volume whatever its zone's `enabled` (`sampling_volumes.md` §7.1), so a
 * listed zone's voxels are always there to be seen.
 *
 * `total` sums the listed zones' own `validVoxels`, which the per-zone
 * aggregation already reports for every zone. It over-counts where two listed
 * zones' volumes overlap, so the rate reads low rather than high — the safe
 * direction for a number that is already an upper bound (§1.3).
 *
 * Each flag is honoured **separately**: `restrictScoring` off with
 * `restrictMounts` on is "mount inside the bay, but score against the app's
 * marked set", which is a sentence a user can mean.
 */
export function resolveGroupTarget(
  group: ConstraintGroup,
  scene: {
    zones: readonly Zone[];
    volumes: readonly SamplingVolume[];
    /** A zone's counted voxels, from the per-zone aggregation; 0 before a run. */
    validVoxels: (zoneId: string) => number;
  },
  app: AppMarkedSet,
): GroupTarget {
  const listed = group.zoneIds.length > 0 ? scene.zones.filter((z) => group.zoneIds.includes(z.id)) : [];
  if (listed.length === 0) {
    return {
      filter: app.filter,
      total: app.total,
      mountVolumes: [],
      zoneNames: [],
      markedRevision: app.revision,
      mountRevision: '',
    };
  }
  const ids = listed.map((z) => z.id);
  const revision = targetRevision(ids, scene.volumes);
  return {
    filter: group.restrictScoring ? markedFilterForZones(scene.volumes, ids) : app.filter,
    total: group.restrictScoring ? ids.reduce((sum, id) => sum + scene.validVoxels(id), 0) : app.total,
    mountVolumes: group.restrictMounts ? volumesOfZones(scene.volumes, ids) : [],
    zoneNames: group.restrictScoring ? listed.map(zoneLabel) : [],
    markedRevision: group.restrictScoring ? revision : app.revision,
    mountRevision: group.restrictMounts ? revision : '',
  };
}

/**
 * §10's regenerate row: the status line naming how many groups lost a target
 * when Generate replaced the zone set (`sampling_volumes.md` §3.4), or null when
 * none held one.
 *
 * Counted from the groups **before** the dispatch, since the reducer clears the
 * lists it is reporting on.
 */
export function regeneratedTargetsNotice(groups: readonly ConstraintGroup[]): string | null {
  const n = groups.filter((g) => g.zoneIds.length > 0).length;
  if (n === 0) return null;
  return `Zones were regenerated; ${n} constraint group(s) lost their target zones.`;
}

/** The constraints an analysis draws from: this group's, enabled only (§4.1). */
export function enabledConstraints(
  group: ConstraintGroup,
  constraints: readonly CameraConstraint[],
): CameraConstraint[] {
  return constraints.filter((c) => c.groupId === group.id && c.enabled);
}

// --- The split (§4.1) --------------------------------------------------------

/**
 * How many positions each constraint of a {@link DrawBasis} contributes,
 * weighted by its measure with a **floor of 1** (§4.1).
 *
 * The basis is the parameter rather than a constraint list and a parallel weight
 * array because the two are only ever correct together: a split over one group's
 * constraints and another's weights is a wrong pool that looks like a pool.
 *
 * The floor exists so a single surveyed mount point in a group full of walls is
 * never starved — and it is also that point's correct share, since a
 * `distance = 0` point admits exactly one position. The rounding remainder goes
 * to the largest weights — and so does the overshoot the floor can cause, taken
 * back the same way — so the shares always sum to `poolSize` exactly (or to the
 * number of constraints, when there are more constraints than positions).
 */
export function poolSplit(basis: DrawBasis, poolSize: number): number[] {
  const { constraints, weights } = basis;
  const n = constraints.length;
  if (n === 0) return [];
  if (poolSize <= n) return constraints.map(() => 1);

  const total = weights.reduce((a, b) => a + b, 0);
  // With no measure anywhere (every constraint a point), share out evenly.
  const shares = weights.map((w) =>
    total > 0 ? Math.max(1, Math.round((poolSize * w) / total)) : Math.max(1, Math.floor(poolSize / n)),
  );

  let assigned = shares.reduce((a, b) => a + b, 0);
  const byWeight = constraints.map((_, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
  // Settle the remainder against the largest weights, in both directions: hand
  // out what the rounding left over, and take back the overshoot the floor of 1
  // causes when it lifts a starved constraint above its fair share. Taking from
  // the largest is what makes the spec's own example land on 1 : 5 : 194 rather
  // than robbing the middle constraint. `poolSize > n` above, so a share is
  // always available to take from and neither sweep can spin.
  for (let i = 0; assigned < poolSize; i = (i + 1) % n) {
    shares[byWeight[i]]++;
    assigned++;
  }
  for (let i = 0; assigned > poolSize; i = (i + 1) % n) {
    const at = byWeight[i];
    if (shares[at] > 1) {
      shares[at]--;
      assigned--;
    }
  }
  return shares;
}

// --- The draw (§4.1) ---------------------------------------------------------

/**
 * The position at a constraint's own sequence index (§4.1).
 *
 * Five Halton dimensions, always: `[u, v]` locate a point on the primitive and
 * `[a, b, c]` an offset inside the dilation ball. The fixed stride is what makes
 * the mapping independent of the kind and of `distance`, so editing either does
 * not reshuffle the pool.
 *
 * Positions therefore sit **near the primitive**, not uniformly in the region: a
 * uniform-in-volume draw would pile samples into the outer shell where the
 * volume is, which is the wrong reading of a tolerance around a rail.
 */
export function drawPosition(c: CameraConstraint, seed: number, seqIndex: number): Vec3 {
  const [u, v, a, b, w] = haltonPoint(constraintOffset(seed, c.id) + seqIndex);
  const base = pointOnPrimitive(c, u, v);
  const off = ballOffset(c.distance, a, b, w);
  return [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
}

/** One planned draw: which constraint, and which of its sequence indices. */
export interface PlannedDraw {
  constraintId: string;
  seqIndex: number;
  position: Vec3;
}

/** What a constraint already holds, for an extension plan (§3.3.1). */
export interface HeldDraws {
  /** Positions kept — what counts against the constraint's share. */
  kept: number;
  /** The first sequence index never drawn: `max(seqIndex) + 1`, rejections included. */
  nextSeq: number;
}

/**
 * The pool's draw plan: every constraint's share, in constraint order.
 *
 * `held` lets an **extension** skip what is already built — position `k` of a
 * constraint is the same position whatever `poolSize` is, so raising 200 to 260
 * draws only what is new (§3.3.1).
 *
 * `kept` and `nextSeq` are two different numbers whenever a position was
 * rejected (§4.2): the share is a target count of *kept* positions, while the
 * sequence has already moved past the rejected draws. Planning from `kept` would
 * rebuild positions already known to see nothing; planning `share − nextSeq`
 * draws would leave the extension short by exactly the rejection count.
 */
export function planDraws(
  group: ConstraintGroup,
  basis: DrawBasis,
  opts: { held?: ReadonlyMap<string, HeldDraws> } = {},
): PlannedDraw[] {
  const shares = poolSplit(basis, group.poolSize);
  const mount = basis.mountVolumes;
  const draws: PlannedDraw[] = [];
  basis.constraints.forEach((c, i) => {
    const held = opts.held?.get(c.id);
    const want = shares[i] - (held?.kept ?? 0);
    let k = held?.nextSeq ?? 0;
    // With a mount filter the sequence is walked rather than sliced: a draw that
    // lands outside the target zones is skipped here, on the CPU, before it can
    // cost a build step (§4.1.1). The cap is what makes a constraint whose
    // estimate over-stated its overlap terminate.
    const cap = k + Math.max(want, 0) * (mount.length > 0 ? MOUNT_ATTEMPT_FACTOR : 1);
    for (let n = 0; n < want && k < cap; k++) {
      const position = drawPosition(c, group.seed, k);
      if (mount.length > 0 && !inAnyVolume(position, mount)) continue;
      draws.push({ constraintId: c.id, seqIndex: k, position });
      n++;
    }
  });
  return draws;
}

/**
 * How many of a constraint's positions survive a **truncation** (§3.3.1).
 *
 * Lowering `poolSize` costs no build step: each constraint keeps the first
 * `share` positions it holds, in draw order, and the rest are dropped.
 */
export function truncatedShares(
  group: ConstraintGroup,
  basis: DrawBasis,
): ReadonlyMap<string, number> {
  const shares = poolSplit(basis, group.poolSize);
  return new Map(basis.constraints.map((c, i) => [c.id, shares[i]]));
}

/**
 * A replacement draw for a rejected position (§4.2): the next sequence index
 * beyond everything already spent on that constraint, capped so a constraint
 * buried inside geometry terminates.
 */
export function replacementDraw(
  group: ConstraintGroup,
  c: CameraConstraint,
  spent: number,
  share: number,
  basis: DrawBasis,
): PlannedDraw | null {
  const mountVolumes = basis.mountVolumes;
  const gpuCap = share * REJECT_ATTEMPT_FACTOR;
  // Out-of-zone draws are skipped rather than returned: they cost no build step,
  // so they must not consume the GPU budget the cap is protecting (§4.1.1).
  const cpuCap = spent + Math.max(share, 1) * MOUNT_ATTEMPT_FACTOR;
  for (let k = spent; k < gpuCap && k < cpuCap; k++) {
    const position = drawPosition(c, group.seed, k);
    if (mountVolumes.length > 0 && !inAnyVolume(position, mountVolumes)) continue;
    return { constraintId: c.id, seqIndex: k, position };
  }
  return null;
}

// --- The build step (§2.1, §4.3) ------------------------------------------------

/**
 * The camera list one build step runs against: the scene's cameras unchanged, then
 * the six-slot rig at the candidate position, at the group's `far` and the
 * placement-wide default `near` (§3.1.1).
 *
 * The scene cameras keep their ids, their order, and their count for the whole
 * session, so every build step after the first is eligible for incremental
 * recompute (SDK spec §13.1) — only the six slots move, and they only ever
 * dirty the chunks around one reachable ball (§2.3).
 */
export function buildStepCameras(
  cameras: readonly SceneCamera[],
  group: ConstraintGroup,
  position: Vec3,
): CameraConfig[] {
  return [
    ...cameras.map(toCameraConfig),
    ...captureRig({ position, near: DEFAULT_TEMPLATE.near, far: group.far }),
  ];
}

/** The mask naming just the six capture slots — the union `covered` counts (§2.1). */
export function rigCameraMask(sceneCameraCount: number): Uint32Array {
  const total = sceneCameraCount + CAPTURE_SLOTS;
  const mask = new Uint32Array(camWords(Math.max(1, total)));
  for (let i = sceneCameraCount; i < total; i++) mask[i >>> 5] |= 1 << (i & 31);
  return mask;
}

/**
 * The descriptor for one build step (§2.1).
 *
 * `leafCounts` with `cameras` set to the rig's six bits makes `count > 0` mean
 * exactly "valid, inside the marked set, and reachable from this position" —
 * the reachable set, already merged into cubes, with no new SDK primitive.
 *
 * `marked` is the display descriptor's own filter, handed over rather than
 * rebuilt (`scene/aggregateSpec.ts`). Without it a build step counts the
 * conservative AABB slop around every rotated volume plus every voxel of every
 * *disabled* zone (`sampling_volumes.md` §7.1) — and then places cameras to see
 * voxels no panel counts (§3.3).
 */
export function buildStepSpec(sceneCameraCount: number, marked: MarkedFilter): AggregateSpec {
  return {
    // `regions` rides along because `maskRegions` names them by index; the SDK
    // rejects a filter on a descriptor that declares none (SDK spec §19.6).
    regions: marked.regions,
    leafCounts: { maskRegions: marked.regions.length > 0 ? marked.maskRegions : [] },
    cameras: rigCameraMask(sceneCameraCount),
  };
}

// --- Fingerprint (§3.3.1) ----------------------------------------------------

/**
 * What the cached sets are valid for: the geometry, the voxel grid, the marked
 * set, and the group's range (§3.3.1). `near` rides along as the constant the
 * rig runs at, so a pool written by one build is not reused by another that
 * changed it.
 *
 * **Camera edits are deliberately absent.** Adding, deleting, moving, aiming,
 * enabling, or disabling a camera cannot change a reachable set, because the
 * score weighs every voxel the same and ignores other cameras (§1.2). That is
 * what makes place → aim → measure → re-search cheap to iterate.
 */
export function poolFingerprint(input: {
  geometryRevision: string | number;
  voxelSize: number;
  /** The **target** set's revision: the listed zones' when the group has them,
   * else the app's marked set (§3.1.2). */
  markedRevision: string | number;
  near: number;
  far: number;
  /** The group's mount filter, or '' when it has none (§4.1.1). */
  mountRevision?: string | number;
}): string {
  return [
    input.geometryRevision,
    input.voxelSize,
    input.markedRevision,
    input.near,
    input.far,
    input.mountRevision ?? '',
  ].join('|');
}

/**
 * The part of a fingerprint that describes a group's target zones (§3.3.1).
 *
 * **Sorted**, because `zoneIds` is a set and its order carries no meaning — a
 * reorder that discarded a pool would cost minutes of GPU for nothing. The
 * volumes' own geometry rides along, since reshaping a listed volume changes the
 * filter every cached set was built under.
 */
export function targetRevision(zoneIds: readonly string[], volumes: readonly SamplingVolume[]): string {
  if (zoneIds.length === 0) return '';
  const parts = volumesOfZones(volumes, zoneIds).map(
    (v) => `${v.id}:${v.position.join(',')}:${v.rotation.join(',')}:${v.size.join(',')}`,
  );
  return [...zoneIds].sort().join(',') + '|' + parts.sort().join(';');
}

/** The §5.1 readout for a built pool. */
export function poolSummary(pool: Pool, constraints: readonly CameraConstraint[]): string {
  const name = labeller(constraints);
  const parts = [`${pool.positions.length} positions`];
  if (pool.rejected > 0) parts.push(`${pool.rejected} rejected (saw nothing)`);
  if (pool.markedTotal > 0) {
    parts.push(`ceiling ${((100 * pool.poolCeiling) / pool.markedTotal).toFixed(1)}%`);
  }
  let text = parts.join(' · ');
  // The §10 row for a pool built under a mount filter no constraint could satisfy.
  // The percentages themselves are {@link overlapSummary}'s, shown by the card
  // whether or not a pool exists (§5.1); this line is about *this pool*, so it
  // reads off what the pool was built under.
  if (pool.overlaps.length > 0 && pool.overlaps.every((o) => o.fraction <= 0)) {
    text += "\nNo constraint overlaps this group's target zones — the pool is empty.";
  }
  for (const id of pool.emptyConstraints) {
    text += `\n${name(id)} saw nothing from any sampled position.`;
  }
  return text;
}

/** Constraint id → its display label, or the bare id for one already deleted. */
function labeller(constraints: readonly CameraConstraint[]): (id: string) => string {
  return (id) => {
    const c = constraints.find((x) => x.id === id);
    return c ? constraintLabel(c) : id;
  };
}

/**
 * The §4.1.1 overlap line — `Dock rail 100% · North wall 4% · Rail 2 0%` — or
 * null when the group has no mount filter.
 *
 * Formatted here rather than in either panel because both show it: §5.1's Build
 * card, where it precedes a build as well as follows one, and §5's group card,
 * where it is the text cue beside the dimmed gizmos (`VISUAL_DESIGN.md` —
 * never encode state in a visual channel alone).
 */
export function overlapSummary(
  overlaps: readonly ConstraintOverlap[],
  constraints: readonly CameraConstraint[],
): string | null {
  if (overlaps.length === 0) return null;
  const name = labeller(constraints);
  return overlaps.map((o) => `${name(o.constraintId)} ${Math.round(100 * o.fraction)}%`).join(' · ');
}

/** An empty pool for a group, before anything is built. */
export function emptyPool(groupId: string, fingerprint: string, size = 0, seed = 0): Pool {
  return {
    groupId,
    fingerprint,
    size,
    seed,
    positions: [],
    rejected: 0,
    emptyConstraints: [],
    poolCeiling: 0,
    markedTotal: 0,
    overlaps: [],
  };
}

/** A position that has been drawn but not built — set empty, count 0. */
export function pendingPosition(index: number, draw: PlannedDraw): PoolPosition {
  return {
    index,
    constraintId: draw.constraintId,
    seqIndex: draw.seqIndex,
    position: draw.position,
    set: EMPTY_LEAF_SET,
    count: 0,
  };
}
