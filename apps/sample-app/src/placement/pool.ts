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
import type { MarkedFilter } from '../scene/aggregateSpec.ts';
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
  /** Counted voxels in the marked set — the score's denominator (§5.2). */
  markedTotal: number;
}

/**
 * Attempts a constraint may spend to fill its share before giving up (§4.2).
 *
 * A constraint buried entirely inside geometry has to terminate, and a
 * multiplier rather than a fixed count keeps the budget proportional to what was
 * asked for.
 */
export const REJECT_ATTEMPT_FACTOR = 3;

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

/** The constraints an analysis draws from: this group's, enabled only (§4.1). */
export function enabledConstraints(
  group: ConstraintGroup,
  constraints: readonly CameraConstraint[],
): CameraConstraint[] {
  return constraints.filter((c) => c.groupId === group.id && c.enabled);
}

// --- The split (§4.1) --------------------------------------------------------

/**
 * How many positions each constraint contributes, weighted by its primitive
 * measure with a **floor of 1** (§4.1).
 *
 * The floor exists so a single surveyed mount point in a group full of walls is
 * never starved — and it is also that point's correct share, since a
 * `distance = 0` point admits exactly one position. The rounding remainder goes
 * to the largest weights — and so does the overshoot the floor can cause, taken
 * back the same way — so the shares always sum to `poolSize` exactly (or to the
 * number of constraints, when there are more constraints than positions).
 */
export function poolSplit(constraints: readonly CameraConstraint[], poolSize: number): number[] {
  const n = constraints.length;
  if (n === 0) return [];
  if (poolSize <= n) return constraints.map(() => 1);

  const weights = constraints.map(primitiveMeasure);
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
  constraints: readonly CameraConstraint[],
  opts: { held?: ReadonlyMap<string, HeldDraws> } = {},
): PlannedDraw[] {
  const shares = poolSplit(constraints, group.poolSize);
  const draws: PlannedDraw[] = [];
  constraints.forEach((c, i) => {
    const held = opts.held?.get(c.id);
    const want = shares[i] - (held?.kept ?? 0);
    const start = held?.nextSeq ?? 0;
    for (let n = 0; n < want; n++) {
      const k = start + n;
      draws.push({ constraintId: c.id, seqIndex: k, position: drawPosition(c, group.seed, k) });
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
  constraints: readonly CameraConstraint[],
): ReadonlyMap<string, number> {
  const shares = poolSplit(constraints, group.poolSize);
  return new Map(constraints.map((c, i) => [c.id, shares[i]]));
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
): PlannedDraw | null {
  if (spent >= share * REJECT_ATTEMPT_FACTOR) return null;
  return { constraintId: c.id, seqIndex: spent, position: drawPosition(c, group.seed, spent) };
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
  markedRevision: string | number;
  near: number;
  far: number;
}): string {
  return [
    input.geometryRevision,
    input.voxelSize,
    input.markedRevision,
    input.near,
    input.far,
  ].join('|');
}

/** The §5.1 readout for a built pool. */
export function poolSummary(pool: Pool, constraints: readonly CameraConstraint[]): string {
  const parts = [`${pool.positions.length} positions`];
  if (pool.rejected > 0) parts.push(`${pool.rejected} rejected (saw nothing)`);
  if (pool.markedTotal > 0) {
    parts.push(`ceiling ${((100 * pool.poolCeiling) / pool.markedTotal).toFixed(1)}%`);
  }
  let text = parts.join(' · ');
  for (const id of pool.emptyConstraints) {
    const c = constraints.find((x) => x.id === id);
    text += `\n${c ? constraintLabel(c) : id} saw nothing from any sampled position.`;
  }
  return text;
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
