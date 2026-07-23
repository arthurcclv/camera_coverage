/**
 * Shared types for the SceneView imperative bridge (spec §5.2, §12.4, §13.8;
 * `sampling_volumes.md` §5). The `sync()` snapshot type (`SceneViewState`) lives
 * with the SceneView class; this file holds the event-out patch type shared by
 * the pure readback helpers (`transformReadback.ts`) and the class.
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

/**
 * A resolved, App-domain transform edit emitted by SceneView after a
 * TransformControls drag — already past the per-kind readback math
 * (`transformReadback.ts`), so App only applies it via its setters. A probe is a
 * point (position only); a section slides as a box (its six bound fields); a
 * camera/volume carry a full rigid (+ scale) transform.
 */
export type TransformChange =
  | { kind: 'camera'; id: string; position: Vec3; rotation: Quat }
  | { kind: 'probe'; id: string; position: Vec3 }
  | { kind: 'volume'; id: string; position: Vec3; rotation: Quat; size: Vec3 }
  | {
      kind: 'section';
      id: string;
      min: number;
      max: number;
      minA: number;
      maxA: number;
      minB: number;
      maxB: number;
    };
