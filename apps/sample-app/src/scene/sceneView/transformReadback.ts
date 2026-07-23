/**
 * Pure per-kind transform readback math (spec §12.4, §13.8; `sampling_volumes.md` §5).
 *
 * After a TransformControls drag, SceneView reads the raw target transform off
 * the gizmo and turns it into an App-domain patch. The two non-trivial pieces —
 * flooring a volume's size to a voxel and decomposing a section box's dragged
 * center back into its bound-pairs — live here, pure and tested
 * (`test/sceneView/transformReadback.test.ts`), rather than inline in the
 * imperative bridge (where the section bound math is exactly the kind of algebra
 * that previously carried a sign bug — see DECISIONS.md). SceneView does only the
 * trivial assembly (which axes to read, via the pure `axisMapping`) around them.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import { minVolumeSize } from '../samplingVolumes.ts';
import type { Section } from '../sectionHeatmap.ts';

/**
 * Floor each axis of a dragged volume's size to at least one voxel so a box never
 * degenerates (`sampling_volumes.md` §5).
 */
export function floorVolumeSize(size: Vec3, voxelSize: number): Vec3 {
  const min = minVolumeSize(voxelSize);
  return [Math.max(min, size[0]), Math.max(min, size[1]), Math.max(min, size[2])];
}

/** A dragged section box's new center along each of its three axes (world m). */
export interface SectionCenters {
  /** Center along the collapse axis (the slab midpoint). */
  mid: number;
  /** Center along in-plane axisA. */
  centerA: number;
  /** Center along in-plane axisB. */
  centerB: number;
}

/** The six section bound fields — the shape a section transform patch carries. */
export interface SectionBounds {
  min: number;
  max: number;
  minA: number;
  maxA: number;
  minB: number;
  maxB: number;
}

/**
 * Re-derive a section box's bound-pairs after a free 3-axis drag (spec §13.8):
 * each pair keeps its current half-extent and re-centers on the dragged center,
 * so thickness / width / height stay fixed while position follows the drag.
 */
export function sectionBoundsFromCenters(current: Section, centers: SectionCenters): SectionBounds {
  const halfThickness = (current.max - current.min) / 2;
  const halfA = (current.maxA - current.minA) / 2;
  const halfB = (current.maxB - current.minB) / 2;
  return {
    min: centers.mid - halfThickness,
    max: centers.mid + halfThickness,
    minA: centers.centerA - halfA,
    maxA: centers.centerA + halfA,
    minB: centers.centerB - halfB,
    maxB: centers.centerB + halfB,
  };
}
