/**
 * The export run (spec §9): render each camera in turn, encode, package, download.
 *
 * Impure orchestration only — every decision it makes (sizes, filenames, manifest)
 * comes from the pure modules so the run cannot disagree with what it reports.
 */
import type { Entity } from 'playcanvas';
import type { Alignment } from '../align/alignment.ts';
import { cameraLabel } from '../cameras/label.ts';
import type { PreviewCamera } from '../cameras/sceneCameras.ts';
import { ExportRig, type RigSettings } from '../render/exportRig.ts';
import { imageSizeFor, type ResolutionMode } from '../render/imageSize.ts';
import { encodeImage, extensionFor } from '../render/png.ts';
import { buildFilenames } from './filenames.ts';
import {
  buildManifest,
  MANIFEST_FILENAME,
  serializeManifest,
  type ExportedCamera,
  type ImageFormat,
  type RenderSettings,
  type SplatSource,
} from './manifest.ts';
import { downloadBytes, formatBytes, zipEntries, type ZipEntry } from './zip.ts';

export interface ExportRunSettings {
  resolution: ResolutionMode;
  format: ImageFormat;
  quality: number;
  samples: number;
  settleFrames: number;
  background: [number, number, number, number];
  transparentBackground: boolean;
  farOverride: number | null;
}

export interface ExportProgress {
  /** Cameras completed so far. */
  done: number;
  total: number;
  /** The label of the camera currently rendering. */
  current: string;
  /** Accumulated encoded bytes, for the §9.5 readout. */
  bytes: number;
}

export interface ExportRunArgs {
  rig: ExportRig;
  viewportCameras: readonly Entity[];
  cameras: readonly PreviewCamera[];
  settings: ExportRunSettings;
  alignment: Alignment;
  splat: SplatSource;
  sourceScene: string;
  onProgress: (p: ExportProgress) => void;
  /** Polled between cameras; when true the run stops and downloads nothing (§9.5). */
  isCancelled: () => boolean;
}

export type ExportRunResult =
  | { status: 'done'; filename: string; bytes: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

/** The zip's filename, derived from the scene file so batches are distinguishable. */
function zipName(sourceScene: string): string {
  const stem = sourceScene.replace(/\.json$/i, '') || 'scene';
  return `${stem}-camera-renders.zip`;
}

/**
 * Runs the export (§9). Cancelling stops before the next camera and downloads
 * **nothing** — a partial zip presented as a deliverable is worse than no zip (§9.5).
 */
export async function runExport(args: ExportRunArgs): Promise<ExportRunResult> {
  const { rig, viewportCameras, cameras, settings, alignment, splat, sourceScene, onProgress, isCancelled } = args;

  if (cameras.length === 0) return { status: 'error', error: 'No cameras selected for export.' };

  const extension = extensionFor(settings.format);
  const filenames = buildFilenames(
    cameras.map((c) => ({ id: c.id, label: cameraLabel(c) })),
    extension,
  );

  const rigSettings: RigSettings = {
    samples: settings.samples,
    settleFrames: settings.settleFrames,
    background: settings.background,
    transparentBackground: settings.transparentBackground,
    farOverride: settings.farOverride,
  };

  const entries: ZipEntry[] = [];
  const exported: ExportedCamera[] = [];
  let bytes = 0;

  rig.beginRun(viewportCameras);
  try {
    for (const [i, camera] of cameras.entries()) {
      if (isCancelled()) return { status: 'cancelled' };

      const label = cameraLabel(camera);
      onProgress({ done: i, total: cameras.length, current: label, bytes });

      const size = imageSizeFor(camera.aspect, settings.resolution, rig.maxTextureSize);

      let encoded: Uint8Array;
      try {
        const pixels = await rig.render(camera, size, rigSettings);
        encoded = await encodeImage(pixels, size.width, size.height, settings.format, settings.quality);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Abort the run naming the camera, rather than shipping a short batch (§9.5).
        return { status: 'error', error: `Failed to render "${label}": ${message}` };
      }

      entries.push({ filename: filenames[i], bytes: encoded });
      exported.push({ camera, file: filenames[i], size });
      bytes += encoded.byteLength;
    }
  } finally {
    rig.endRun();
  }

  if (isCancelled()) return { status: 'cancelled' };

  const renderSettings: RenderSettings = {
    format: settings.format,
    quality: settings.quality,
    samples: settings.samples,
    settleFrames: settings.settleFrames,
    background: settings.background,
    transparentBackground: settings.transparentBackground,
    farOverride: settings.farOverride,
  };
  const manifest = buildManifest({ sourceScene, splat, alignment, render: renderSettings, exported });
  entries.push({
    filename: MANIFEST_FILENAME,
    bytes: new TextEncoder().encode(serializeManifest(manifest)),
  });

  onProgress({ done: cameras.length, total: cameras.length, current: 'packaging', bytes });

  try {
    const archive = await zipEntries(entries);
    const filename = zipName(sourceScene);
    downloadBytes(archive, filename);
    return { status: 'done', filename, bytes: archive.byteLength };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: `Failed to package the zip (${formatBytes(bytes)}): ${message}` };
  }
}
