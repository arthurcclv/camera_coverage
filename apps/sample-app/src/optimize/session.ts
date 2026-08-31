/**
 * The optimize session (`aim_optimization.md` §3.1): the six capture slots, the
 * descriptor a capture runs under, and the camera mask that keeps those slots
 * out of every number the app displays.
 *
 * Split from `greedy.ts` on purpose. This module knows the SDK's shapes and the
 * app's camera entity; `greedy.ts` knows neither, which is what makes the loop
 * testable without a GPU (§7.1).
 */
import {
  MAX_CAMERAS,
  camWords,
  prepareCamera,
  type AggregateProjection,
  type AggregateSpec,
  type CameraConfig,
  type Quat,
} from '@linkervision/camera-coverage-sdk';
import type { SceneCamera } from '../cameras/camera.ts';
import type { MarkedFilter } from '../scene/aggregateSpec.ts';
import { toCameraConfig } from '../cameras/camera.ts';
import { quatToEuler } from '../cameras/math.ts';
import { captureRig, CAPTURE_SLOTS, CUBE_FACES } from './cubeRig.ts';
import { PANORAMA_RESOLUTION } from './panorama.ts';
import { blindWeights, scoreWeights } from './weights.ts';
import type { OptimizableCamera } from './greedy.ts';

/** Whether a camera participates in the optimizer at all (§4.1, §4.5). */
export function isOptimizable(camera: SceneCamera): boolean {
  return camera.enabled && !camera.aimLocked;
}

/** Why the entry points are disabled, or null when they are available (§3.1, §10). */
export function sessionBlocker(
  cameras: readonly SceneCamera[],
  /**
   * Whether a sampling edit is still waiting for a run to apply it
   * (`spec.md` §8). A capture does **not** call `setSampling` — it inherits
   * whatever validity mask the engine holds — so running one now would score
   * over the *previous* zone set while the panels describe the new one.
   */
  samplingPending = false,
): string | null {
  if (cameras.length + CAPTURE_SLOTS > MAX_CAMERAS) {
    return `Aim optimization needs ${CAPTURE_SLOTS} spare camera slots; the scene uses ${cameras.length} of ${MAX_CAMERAS}.`;
  }
  if (samplingPending) return 'Run coverage once to apply the sampling change, then optimize.';
  if (!cameras.some(isOptimizable)) return 'No camera is available to optimize.';
  return null;
}

/**
 * The camera list a session hands `setCameras()`: the scene's cameras with this
 * run's accepted rotations layered over them, then the six capture slots.
 *
 * The scene cameras keep their ids, their order, and their count for the whole
 * session, so every capture after the first is eligible for incremental
 * recompute (SDK spec §13.1) — only the six slots move, and they only ever dirty
 * the chunks around one mount point.
 */
export function sessionCameras(
  cameras: readonly SceneCamera[],
  overrides: ReadonlyMap<string, Quat>,
  mount: SceneCamera | null,
): CameraConfig[] {
  const list = cameras.map((c) => {
    const rotation = overrides.get(c.id);
    return toCameraConfig(rotation ? { ...c, rotation } : c);
  });
  if (!mount) return list;
  const at = overrides.get(mount.id);
  return [...list, ...captureRig(at ? { ...mount, rotation: at } : mount)];
}

/**
 * The mask of camera bits every reduction counts (SDK spec §19.1).
 *
 * Excludes the six capture slots — otherwise they would inflate zone coverage,
 * the overlay's camera counts, and every popcount the app reads — and, when
 * `exceptId` names the camera being optimized, excludes it too, which is what
 * turns Pass 7's `n` into §1.1's `n_others`.
 */
export function realCameraMask(
  cameras: readonly SceneCamera[],
  totalCameras: number,
  exceptId?: string,
): Uint32Array {
  const mask = new Uint32Array(camWords(Math.max(1, totalCameras)));
  cameras.forEach((c, i) => {
    if (!c.enabled || c.id === exceptId) return;
    mask[i >>> 5] |= 1 << (i & 31);
  });
  return mask;
}

/**
 * The descriptor for one capture (§2.2).
 *
 * `marked` is the display descriptor's own filter, handed over rather than
 * rebuilt (`scene/aggregateSpec.ts`). It is what makes the optimizer score the
 * **counted** set: `setSampling` bounds what is *computed* with conservative
 * AABBs of the rotated volumes (`sampling_volumes.md` §7.1), so without it a
 * capture bins the AABB slop and every voxel of every *disabled* zone — and the
 * optimizer aims cameras at voxels no panel counts.
 */
export function captureSpec(
  cameras: readonly SceneCamera[],
  overrides: ReadonlyMap<string, Quat>,
  mount: SceneCamera,
  marked: MarkedFilter,
  resolution = PANORAMA_RESOLUTION,
): AggregateSpec {
  const all = sessionCameras(cameras, overrides, mount);
  const numCameras = all.length;
  const score = scoreWeights(numCameras);
  const blind = blindWeights(numCameras);
  const first = cameras.length;
  const projections: AggregateProjection[] = CUBE_FACES.map((_, face) => ({
    camera: first + face,
    viewProj: Array.from(prepareCamera(all[first + face]).viewProj),
    resolution,
    maskRegions: marked.maskRegions,
    weights: [score, blind],
  }));
  return {
    // `regions` rides along because `maskRegions` names them by index; the SDK
    // rejects a filter on a descriptor that declares none (SDK spec §19.6).
    regions: marked.regions,
    projections,
    cameras: realCameraMask(cameras, numCameras, mount.id),
  };
}

/** The display descriptor's camera filter: the scene's cameras, never the slots. */
export function displayCameraMask(
  cameras: readonly SceneCamera[],
  sessionOpen: boolean,
): Uint32Array | undefined {
  if (!sessionOpen) return undefined;
  return realCameraMask(cameras, cameras.length + CAPTURE_SLOTS);
}

/** A scene camera as the greedy loop sees it (§7.1). */
export function toOptimizable(camera: SceneCamera, rotation: Quat): OptimizableCamera {
  return {
    id: camera.id,
    rotation,
    lens: {
      fov: camera.fov,
      aspect: camera.aspect ?? 16 / 9,
      // Roll passes through untouched, the same invariant the aim drag and the
      // rotation fields keep (spec §5.1, §5.2).
      roll: quatToEuler(rotation).roll,
    },
    optimizable: isOptimizable(camera),
  };
}
