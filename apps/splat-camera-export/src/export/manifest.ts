/**
 * Pure `cameras.json` manifest construction (spec §9.4) — enough to reproduce or
 * post-process an exported batch.
 *
 * Built by a pure function from the very same inputs the run used, so the manifest
 * cannot drift from what was actually rendered.
 */
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import type { Alignment } from '../align/alignment.ts';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';
import type { ImageSize } from '../render/imageSize.ts';

export const MANIFEST_FILENAME = 'cameras.json';
const GENERATOR = '@linkervision/splat-camera-export';

/** The image encoding of a run (§8.5). */
export type ImageFormat = 'png' | 'jpeg';

/** The render settings a run was executed with (§10.3), as recorded in the manifest. */
export interface RenderSettings {
  format: ImageFormat;
  /** JPEG quality in (0, 1]; omitted from the manifest for PNG. */
  quality: number;
  /** Render-target multi-sample count; 1 disables (§9.1). */
  samples: number;
  /** Frames awaited after the sort settles, per camera (§8.2). */
  settleFrames: number;
  /** Clear color as `[r, g, b, a]` in 0..1 (§8.1). */
  background: [number, number, number, number];
  transparentBackground: boolean;
  /** The render far plane; `null` when clipping at each camera's own `far` (§5.2). */
  farOverride: number | null;
}

export interface SplatSource {
  filename: string;
  byteSize: number;
}

/** One camera's manifest entry (§9.4). */
export interface ManifestCamera {
  file: string;
  id: string;
  name: string;
  position: Vec3;
  rotation: Quat;
  fov: number;
  aspect: number;
  near: number;
  /** The `scene.json` value, as authored. */
  far: number;
  /** The far plane actually used — differs from `far` unless clipping at camera far (§5.2). */
  farRendered: number;
  width: number;
  height: number;
  enabled: boolean;
}

export interface Manifest {
  generator: string;
  sourceScene: string;
  splat: SplatSource;
  alignment: Alignment;
  render: Omit<RenderSettings, 'quality'> & { quality?: number };
  cameras: ManifestCamera[];
}

/** One rendered camera, pairing the source camera with what the run produced for it. */
export interface ExportedCamera {
  camera: PreviewCamera;
  file: string;
  size: ImageSize;
}

/**
 * The far plane a camera was rendered with (§5.2): its authored `far` when the run
 * clips at camera far, otherwise the run's override.
 */
export function farRenderedFor(camera: PreviewCamera, farOverride: number | null): number {
  return farOverride === null ? camera.far : farOverride;
}

/** Builds the manifest for a completed run (§9.4). */
export function buildManifest(args: {
  sourceScene: string;
  splat: SplatSource;
  alignment: Alignment;
  render: RenderSettings;
  exported: readonly ExportedCamera[];
}): Manifest {
  const { sourceScene, splat, alignment, render, exported } = args;

  // `quality` is meaningless for PNG, so it is omitted rather than recorded as a
  // value that had no effect on the output.
  const { quality, ...rest } = render;
  const renderRecord = render.format === 'jpeg' ? { ...rest, quality } : { ...rest };

  return {
    generator: GENERATOR,
    sourceScene,
    splat,
    alignment,
    render: renderRecord,
    cameras: exported.map(({ camera, file, size }) => ({
      file,
      id: camera.id,
      name: camera.name,
      position: camera.position,
      rotation: camera.rotation,
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      farRendered: farRenderedFor(camera, render.farOverride),
      width: size.width,
      height: size.height,
      enabled: camera.enabled,
    })),
  };
}

/** The `cameras.json` bytes (§9.4). */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
