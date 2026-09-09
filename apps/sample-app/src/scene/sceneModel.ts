/**
 * The unified `Scene` model (spec §14.1): geometry + cameras + probes + sections
 * + sampling zones/volumes + splat captures, the shape serialized to/from a scene folder
 * (`sceneFile.ts`) and rebuilt by `sceneGeometryBuild.ts`. `defaultScene()` is the
 * single source of both the boot state and the "Reset to default" action (spec
 * §14.7).
 */
import type { SceneCamera } from '../cameras/camera.ts';
import { defaultCameras } from '../cameras/defaults.ts';
import { defaultGeometry } from './buildRoom.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';
import type { SamplingVolume, Zone } from './samplingVolumes.ts';
import type { CameraConstraint, ConstraintGroup } from '../placement/region.ts';
import type { SplatObject } from './splats.ts';

export interface Scene {
  geometry: GeometryObject[];
  /** App camera entities — `CameraConfig` + a display `name` (spec §5.6, §14.1);
   * converted to plain `CameraConfig` at the `setCameras()` boundary. */
  cameras: SceneCamera[];
  probes: Probe[];
  sections: Section[];
  /** Id of the section currently clipping the scene (spec §13.9), or null. */
  clipSectionId: string | null;
  /** Region-of-interest zones (`sampling_volumes.md` §2.1, §9). */
  zones: Zone[];
  /** Oriented boxes belonging to zones (`sampling_volumes.md` §2.1, §9). */
  volumes: SamplingVolume[];
  /** Whether zones restrict coverage (`sampling_volumes.md` §2.2, §9); default off. */
  useZones: boolean;
  /** Camera-placement groups (`camera_placement.md` §3.1, §9). */
  constraintGroups: ConstraintGroup[];
  /** Mount regions belonging to groups (`camera_placement.md` §3.1, §9). */
  constraints: CameraConstraint[];
  /**
   * 3D Gaussian Splat captures shown behind the analysis (`gaussian_splats.md`
   * §2.1, §8). A **separate array, deliberately not a fourth `GeometryObject`
   * kind**: a capture contributes no triangles, so it would break §14.6's "every
   * geometry object contributes to occlusion", and it is selectable and
   * editable, which §14.9 rules out for geometry.
   */
  splats: SplatObject[];
}

export function defaultScene(): Scene {
  // Zones/volumes and constraint groups/constraints seed empty — the default
  // room is unchanged until the user generates or adds (`sampling_volumes.md`
  // §9, `camera_placement.md` §9).
  return {
    geometry: defaultGeometry(),
    cameras: defaultCameras(),
    probes: [],
    sections: [],
    clipSectionId: null,
    zones: [],
    volumes: [],
    useZones: false,
    constraintGroups: [],
    constraints: [],
    // Splats seed empty too — visual only, and never an analysis input
    // (`gaussian_splats.md` §1.1, §2.1).
    splats: [],
  };
}
