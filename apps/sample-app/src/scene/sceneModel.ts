/**
 * The unified `Scene` model (spec §14.1): geometry + cameras + probes + sections
 * + sampling zones/volumes, the shape serialized to/from a scene folder
 * (`sceneFile.ts`) and rebuilt by `sceneGeometryBuild.ts`. `defaultScene()` is the
 * single source of both the boot state and the "Reset to default" action (spec
 * §14.7).
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import { defaultCameras } from '../cameras/defaults.ts';
import { defaultGeometry } from './buildRoom.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';
import type { SamplingVolume, Zone } from './samplingVolumes.ts';

export interface Scene {
  geometry: GeometryObject[];
  cameras: CameraConfig[];
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
}

export function defaultScene(): Scene {
  // Zones/volumes seed empty — the default room is unchanged until the user
  // generates or adds (`sampling_volumes.md` §9).
  return { geometry: defaultGeometry(), cameras: defaultCameras(), probes: [], sections: [], clipSectionId: null, zones: [], volumes: [], useZones: false };
}
