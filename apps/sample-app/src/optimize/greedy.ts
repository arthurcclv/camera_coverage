/**
 * The sequential-greedy round loop (`aim_optimization.md` §4.1, §4.2, §7.1).
 *
 * Deliberately engine-free: it is handed `capture` and `apply` and knows nothing
 * about the SDK, the worker, or React. Ordering, rounds, the blind gate, the
 * gain threshold and the ΔΦ accumulation are then a pure function a scripted
 * capture callback can test without a GPU (`test/greedy.test.ts`).
 */
import type { Quat } from '@linkervision/camera-coverage-sdk';
import { quatToEuler, eulerToQuat } from '../cameras/math.ts';
import type { Panorama } from './panorama.ts';
import { scoreOrientation, searchBest, type Lens } from './search.ts';

/** §4.2. Three passes is where the order dependence has washed out in practice. */
export const MAX_ROUNDS = 3;
/**
 * §4.4. A physical camera that has to be reached by ladder should not move for
 * noise, and the threshold is also what ends a round instead of letting it churn
 * on fractions of a percent.
 */
export const MIN_GAIN = 0.01;

/** What the loop needs to know about one camera; the caller owns the entity. */
export interface OptimizableCamera {
  id: string;
  rotation: Quat;
  lens: Lens;
  /** Enabled and unlocked cameras are optimized; the rest are skipped (§4.1). */
  optimizable: boolean;
}

export interface AimProposal {
  cameraId: string;
  current: { yaw: number; pitch: number; score: number; blind: number };
  best: { yaw: number; pitch: number; score: number; blind: number };
  /** `best.score / current.score − 1`, or `Infinity` from a zero baseline. */
  gain: number;
  moved: boolean;
  /** The orientation to write if this proposal is applied. */
  rotation: Quat;
}

export interface GreedyHooks {
  /** One `compute()` for one camera — the only engine call the loop makes. */
  capture(camera: OptimizableCamera, index: number): Promise<Panorama>;
  /**
   * Push an accepted orientation to the engine, so the *next* camera's capture
   * sees it. Distinct from writing it to the scene, which §6.1 defers to Apply.
   */
  apply(camera: OptimizableCamera, rotation: Quat, index: number): void;
  /** Progress, once per camera. */
  onProgress?(info: { round: number; index: number; total: number; proposal: AimProposal }): void;
  /** Checked before each camera; true aborts the loop (§6.1 Cancel). */
  aborted?(): boolean;
}

export interface GreedyResult {
  /** One per camera the loop examined, in the order it examined them. */
  proposals: AimProposal[];
  /** Rounds actually run. */
  rounds: number;
  /** Σ of accepted `best.score − current.score` — exactly the change in Φ (§1.2). */
  deltaPhi: number;
  canceled: boolean;
}

/** Evaluate one camera against its panorama without deciding anything. */
export function proposeFor(camera: OptimizableCamera, pano: Panorama): AimProposal {
  const euler = quatToEuler(camera.rotation);
  const cur = scoreOrientation(pano, camera.rotation, camera.lens);
  const best = searchBest(pano, camera.lens, cur.blind);

  // A camera seeing nothing has no baseline to improve on by ratio, so any
  // positive score is an improvement — otherwise it could never be re-aimed.
  const gain = cur.score > 0 ? best.score / cur.score - 1 : best.score > 0 ? Infinity : 0;
  const moved = Number.isFinite(best.score) && gain >= MIN_GAIN;
  return {
    cameraId: camera.id,
    current: { yaw: euler.yaw, pitch: euler.pitch, score: cur.score, blind: cur.blind },
    best: { yaw: best.yaw, pitch: best.pitch, score: best.score, blind: best.blind },
    gain,
    moved,
    rotation: moved
      ? eulerToQuat({ yaw: best.yaw, pitch: best.pitch, roll: camera.lens.roll })
      : camera.rotation,
  };
}

/**
 * Run the loop to convergence (§4.2).
 *
 * `cameras` is read fresh at the start of each round because an accepted move
 * changes a camera's rotation, and the *next* round must score it from there.
 * It must therefore report the **session's** view — the scene's rotations with
 * this run's accepted moves layered over them — not the scene state, which §6.1
 * deliberately leaves untouched until Apply.
 */
export async function optimizeAims(
  cameras: () => OptimizableCamera[],
  hooks: GreedyHooks,
): Promise<GreedyResult> {
  const net = new Map<string, NetProposal>();
  let deltaPhi = 0;
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round;
    const list = cameras();
    let movedThisRound = 0;
    let roundDelta = 0;

    for (let i = 0; i < list.length; i++) {
      if (hooks.aborted?.()) return { proposals: order(net, cameras()), rounds, deltaPhi, canceled: true };
      const cam = list[i];
      if (!cam.optimizable) continue;

      const proposal = proposeFor(cam, await hooks.capture(cam, i));
      record(net, cam.id, proposal);
      if (proposal.moved) {
        movedThisRound++;
        roundDelta += proposal.best.score - proposal.current.score;
        hooks.apply(cam, proposal.rotation, i);
      }
      hooks.onProgress?.({ round, index: i, total: list.length, proposal });
    }

    deltaPhi += roundDelta;
    // Φ is non-decreasing (§1.2), so a round that moved nothing cannot be
    // followed by one that does: every camera would face the same panorama.
    if (movedThisRound === 0 || roundDelta <= 0) break;
  }

  return { proposals: order(net, cameras()), rounds, deltaPhi, canceled: false };
}

/**
 * What a camera's proposals across every round add up to.
 *
 * **A camera's reported proposal spans the run, not the last round.** The loop
 * converges by running a round in which nothing moves, so recording each round's
 * proposal verbatim overwrote a camera's accepted move with that final no-move
 * one — and the summary then reported "nothing improved" and refused to apply
 * rotations it was already holding. It failed on exactly the successful case, and
 * looked correct only when the loop ran out of rounds still moving.
 */
interface NetProposal {
  /** Where the camera started, from the first round that examined it. */
  origin: AimProposal['current'];
  /** The last round whose move was accepted, or null if none ever was. */
  accepted: AimProposal | null;
  /** The most recent proposal, which describes a camera that never moved. */
  last: AimProposal;
}

function record(net: Map<string, NetProposal>, id: string, proposal: AimProposal): void {
  const prev = net.get(id);
  net.set(id, {
    origin: prev?.origin ?? proposal.current,
    accepted: proposal.moved ? proposal : (prev?.accepted ?? null),
    last: proposal,
  });
}

/**
 * Proposals in hierarchy order, dropping cameras no round reached.
 *
 * An accepted camera reports `origin → final`, with the gain recomputed over that
 * span: the before/after columns must describe the run the user is about to
 * apply, and a multi-round gain is not any single round's.
 */
function order(net: Map<string, NetProposal>, list: OptimizableCamera[]): AimProposal[] {
  const out: AimProposal[] = [];
  for (const cam of list) {
    const n = net.get(cam.id);
    if (!n) continue;
    if (!n.accepted) {
      out.push(n.last);
      continue;
    }
    const { origin, accepted } = n;
    out.push({
      ...accepted,
      current: origin,
      gain: origin.score > 0 ? accepted.best.score / origin.score - 1 : Infinity,
      moved: true,
    });
  }
  return out;
}
