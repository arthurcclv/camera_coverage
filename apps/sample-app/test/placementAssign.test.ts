/**
 * The Apply plan (`camera_placement.md` §5.3, §13).
 *
 * The load-bearing property is that the assignment is genuinely
 * minimum-total-distance, so it is checked against **brute force over every
 * permutation** at small n rather than against a hand-computed answer: a greedy
 * that happens to be optimal on three friendly cases would pass the latter.
 *
 * The rest of this file guards the surplus half: Apply switches the cameras the
 * layout does not need **off** rather than deleting them (§5.3.1), and every
 * rule about *which* cameras get stood down lives here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  appliedLabel,
  boundCameras,
  planApply,
  planLabel,
  type MovableCamera,
  type TargetPosition,
} from '../src/placement/assign.ts';

function cams(...xs: number[]): MovableCamera[] {
  return xs.map((x, i) => ({ id: `cam-${i + 1}`, position: [x, 0, 0] as Vec3 }));
}

function targets(...xs: number[]): TargetPosition[] {
  return xs.map((x, i) => ({ position: [x, 0, 0] as Vec3, constraintId: `con-${i + 1}` }));
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Every way to match `k = min(n, m)` cameras to positions, exhaustively. */
function bruteForceCost(bound: MovableCamera[], ts: TargetPosition[]): number {
  const n = bound.length;
  const m = ts.length;
  const k = Math.min(n, m);
  let best = Infinity;

  const chooseAndPermute = (pool: number[], take: number, cb: (picked: number[]) => void) => {
    const walk = (start: number, picked: number[]) => {
      if (picked.length === take) return cb(picked);
      for (let i = start; i < pool.length; i++) walk(i + 1, [...picked, pool[i]]);
    };
    walk(0, []);
  };
  const permutations = (xs: number[]): number[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  // Pick which cameras take part, which positions they take, and in what pairing.
  chooseAndPermute(
    bound.map((_, i) => i),
    k,
    (camIdx) => {
      chooseAndPermute(
        ts.map((_, j) => j),
        k,
        (tgtIdx) => {
          for (const perm of permutations(tgtIdx)) {
            let total = 0;
            for (let i = 0; i < k; i++) total += dist(bound[camIdx[i]].position, ts[perm[i]].position);
            if (total < best) best = total;
          }
        },
      );
    },
  );
  return best;
}

// --- Optimality (§5.3.2) -----------------------------------------------------

test('the assignment is minimum-total-distance, checked against brute force', () => {
  // Cases chosen to include the one greedy-nearest gets wrong: a camera that is
  // closest to a position another camera needs far more.
  const cases: [number[], number[]][] = [
    [[0, 50, 52], [1, 48, 53]],
    [[0, 10], [9, 1]],
    [[0, 1, 2, 3], [3, 2, 1, 0]],
    [[5, 5, 5], [0, 5, 10]],
    [[0, 100], [49, 51]],
    [[10, 20, 30], [11, 31]],
    [[10, 20], [11, 21, 31]],
  ];
  for (const [cs, ts] of cases) {
    const plan = planApply(cams(...cs), targets(...ts));
    const truth = bruteForceCost(cams(...cs), targets(...ts));
    assert.ok(
      Math.abs(plan.totalDistance - truth) < 1e-9,
      `cameras ${cs} → positions ${ts}: got ${plan.totalDistance}, optimum ${truth}`,
    );
  }
});

test('greedy-nearest would lose on this case, so the test can tell them apart', () => {
  // Greedy pairs the globally closest first (cam-1→1, 1 m), then is left with
  // cam-2(50)→53 and cam-3(52)→48: 3 + 4 = 7, total 8. The optimum is 4.
  const plan = planApply(cams(0, 50, 52), targets(1, 48, 53));
  assert.ok(Math.abs(plan.totalDistance - 4) < 1e-9, `expected 4 m of travel, got ${plan.totalDistance}`);
});

test('ties resolve by hierarchy order, so the plan is reproducible', () => {
  // Two identical cameras, two identical positions: nothing distinguishes the
  // pairings by cost, so the index order must decide.
  const a = planApply(cams(0, 0), targets(10, 10));
  const b = planApply(cams(0, 0), targets(10, 10));
  assert.deepEqual(
    a.moves.map((m) => m.cameraId),
    b.moves.map((m) => m.cameraId),
  );
  assert.deepEqual(a.moves.map((m) => m.cameraId).sort(), ['cam-1', 'cam-2']);
});

// --- Moves, creates, deletes (§5.3.1) ---------------------------------------

test('more positions than cameras: every camera moves, the rest are created', () => {
  const plan = planApply(cams(0, 10), targets(1, 11, 40));
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.disables.length, 0);
  assert.deepEqual(plan.creates[0].position, [40, 0, 0]);
  // The ordinal is the position's place in the layout — the created camera's
  // name suffix (§5.3.3).
  assert.equal(plan.creates[0].ordinal, 3);
});

test('more cameras than positions: the surplus are the ones furthest from the layout', () => {
  // Positions at 0 and 1; cameras at 0, 2, 90, 91. The two far cameras are the
  // ones nothing wants, and they are what Apply stands down.
  const plan = planApply(cams(0, 2, 90, 91), targets(0, 1));
  assert.equal(plan.moves.length, 2);
  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.disables.sort(), ['cam-3', 'cam-4']);
});

test('an empty group creates everything; an empty layout disables everything', () => {
  const fresh = planApply([], targets(1, 2, 3));
  assert.equal(fresh.moves.length, 0);
  assert.equal(fresh.creates.length, 3);
  assert.deepEqual(fresh.creates.map((c) => c.ordinal), [1, 2, 3]);

  const none = planApply(cams(0, 1), []);
  assert.deepEqual(none.disables, ['cam-1', 'cam-2']);
  assert.equal(none.moves.length, 0);
});

test('equal counts: a pure re-arrange, nothing added and nothing stood down', () => {
  const plan = planApply(cams(0, 10, 20), targets(21, 11, 1));
  assert.equal(plan.moves.length, 3);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.disables.length, 0);
  // Each camera goes to its nearest, so the whole plan is 3 m of travel.
  assert.ok(Math.abs(plan.totalDistance - 3) < 1e-9);
});

// --- Rebinding within the group (§5.3) --------------------------------------

test('a move carries the constraint of the position it took, not the camera\'s old one', () => {
  // cam-1 is bound to con-1 in the scene; the position it wins belongs to con-2.
  // A group is one budget over one set of mount options, so this is allowed and
  // the binding is rewritten to match (§5.3, §6.3).
  const plan = planApply(cams(0), [{ position: [5, 0, 0], constraintId: 'con-2' }]);
  assert.equal(plan.moves[0].cameraId, 'cam-1');
  assert.equal(plan.moves[0].constraintId, 'con-2');
  assert.ok(Math.abs(plan.moves[0].distance - 5) < 1e-9);
});

test('boundCameras takes any constraint of the group, and nothing else', () => {
  const scene = [
    { id: 'cam-1', position: [0, 0, 0] as Vec3, constraintId: 'con-1' },
    { id: 'cam-2', position: [0, 0, 0] as Vec3, constraintId: 'con-2' },
    { id: 'cam-3', position: [0, 0, 0] as Vec3, constraintId: 'con-9' }, // another group
    { id: 'cam-4', position: [0, 0, 0] as Vec3 }, // unbound
  ];
  const mine = boundCameras(scene, new Set(['con-1', 'con-2']));
  assert.deepEqual(mine.map((c) => c.id), ['cam-1', 'cam-2']);
});

test('a disabled bound camera is still movable hardware', () => {
  // The point of disabling rather than deleting (§5.3.1): a camera an earlier
  // Apply stood down is a mount the site still has, so the next search must be
  // able to pick it up instead of creating a new one beside it (§5.3.2).
  const scene = [
    { id: 'cam-1', position: [0, 0, 0] as Vec3, constraintId: 'con-1', enabled: false },
    { id: 'cam-2', position: [50, 0, 0] as Vec3, constraintId: 'con-1', enabled: true },
  ];
  const mine = boundCameras(scene, new Set(['con-1']));
  assert.deepEqual(mine.map((c) => c.id), ['cam-1', 'cam-2']);

  // And being disabled buys it no discount: the plan is pure distance, so the
  // near camera wins the near position whichever flag it carries.
  const plan = planApply(mine, targets(1));
  assert.equal(plan.moves[0].cameraId, 'cam-1');
  assert.deepEqual(plan.disables, ['cam-2']);
});

// --- The label (§5.3.1) ------------------------------------------------------

test('the button states the plan, naming a disable explicitly', () => {
  assert.equal(planLabel(planApply(cams(0, 1, 2), targets(0, 1, 2))), 'Apply · move 3');
  assert.equal(planLabel(planApply(cams(0), targets(0, 1, 2))), 'Apply · move 1 · add 2');
  assert.equal(planLabel(planApply(cams(0, 1, 2), targets(0))), 'Apply · move 1 · disable 2');
  assert.equal(planLabel(planApply([], targets(0, 1))), 'Apply · add 2');
});

// --- The completion line (§5.3.3) --------------------------------------------

test('the completion line counts the placed cameras and sends the user to aim them', () => {
  // Moves and creates both count: they are the contributing cameras the chosen
  // count promised. Disables are not placed, so they stay out of the number.
  assert.equal(
    appliedLabel(planApply(cams(0), targets(0, 1, 2))),
    '3 cameras placed. Run Optimize all aims to aim them.',
  );
  assert.equal(
    appliedLabel(planApply(cams(0, 1, 2), targets(0))),
    '1 camera placed. Run Optimize all aims to aim them.',
  );
  // Nothing placed still reads as a sentence, not as `0 cameras`-shaped debris.
  assert.equal(appliedLabel(planApply([], [])), '0 cameras placed. Run Optimize all aims to aim them.');
});
