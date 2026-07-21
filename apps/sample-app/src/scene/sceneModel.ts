/**
 * The unified `Scene` model (spec §14.1): geometry + cameras + probes + sections,
 * the shape serialized to/from a scene folder (`sceneFile.ts`) and rebuilt by
 * `sceneGeometryBuild.ts`. `defaultScene()` is the single source of both the boot
 * state and the "Reset to default" action (spec §14.7).
 */
import type { CameraConfig } from '@linkervision/camera-coverage-sdk';
import { defaultCameras } from '../cameras/defaults.ts';
import { defaultGeometry } from './buildRoom.ts';
import type { GeometryObject } from './geometryModel.ts';
import type { Probe } from './probeVisibility.ts';
import type { Section } from './sectionHeatmap.ts';

export interface Scene {
  geometry: GeometryObject[];
  cameras: CameraConfig[];
  probes: Probe[];
  sections: Section[];
}

export function defaultScene(): Scene {
  return { geometry: defaultGeometry(), cameras: defaultCameras(), probes: [], sections: [] };
}
