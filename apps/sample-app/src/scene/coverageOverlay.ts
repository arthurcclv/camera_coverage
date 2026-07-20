/**
 * Coverage visualization (spec §9): maps streamed coverage data onto the
 * generic voxel volumetric renderer (specs/volumetric_rendering.md). This module
 * owns *which* voxels are drawn and *how* coverage maps to each voxel's
 * `intensity` and `color`; the renderer owns *how* voxels are drawn.
 *
 * Two mutually-exclusive modes (spec §9.1):
 *  - 'coverage'   — every valid voxel, intensity = coverage fraction.
 *  - 'blindspots' — only blind-spot voxels (mask == 0), intensity = 1.
 *
 * Both modes draw with the same user-selected overlay hue (spec §9.2); mode fixes
 * *which* voxels and the intensity mapping, not the color.
 *
 * Leaves are accumulated as ChunkResults stream in and rebuilt into the renderer.
 */
import { accessor } from '@linkervision/camera-coverage-sdk';
import type { ChunkResult } from '@linkervision/camera-coverage-sdk';
import {
  VoxelVolumetricRenderer,
  DEFAULT_INTENSITY_SCALE,
  type Voxel,
} from './volumetric.ts';

export type OverlayMode = 'coverage' | 'blindspots';

interface Leaf {
  /** Voxel center, world space. */
  cx: number;
  cy: number;
  cz: number;
  size: number; // world edge length
  camCount: number; // popcount(mask): enabled cameras that see this voxel
}

export interface OverlayOptions {
  /** Overlay visibility on/off. */
  visible: boolean;
  /** Active visualization mode (spec §9.1). */
  mode: OverlayMode;
  /** Overlay fog hue in degrees (0..360), shared by both modes (spec §9.2). */
  overlayHue: number;
  /** Renderer global brightness multiplier (specs/volumetric_rendering.md §1). */
  intensityScale: number;
  /** Involved (enabled) camera count == denominator of the coverage fraction. */
  involvedCameraCount: number;
}

/** Default overlay hue (spec §9.2): red. */
export const DEFAULT_OVERLAY_HUE = 0;

/**
 * Convert a hue (degrees) to an RGB triple (components 0..1) at full saturation and
 * 50% lightness — `hsl(hue, 100%, 50%)` (spec §9.2). This is the fog color the user
 * picks with the overlay-color slider; full saturation makes the slider a clean
 * rainbow spectrum.
 */
export function hueToRgb(hue: number): [number, number, number] {
  const h = ((((hue % 360) + 360) % 360)) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

/**
 * Coverage fraction (spec §13): the share of the involved (enabled) cameras that
 * see a voxel, `popcount(mask) / involvedCameraCount`, clamped to [0, 1].
 * 0 == blind spot, 1 == seen by every enabled camera.
 */
export function coverageFraction(camCount: number, involvedCameraCount: number): number {
  const denom = Math.max(1, involvedCameraCount);
  return Math.max(0, Math.min(1, camCount / denom));
}

/** Bit population count of a 32-bit mask word. Shared with `sectionHeatmap.ts` (§13.3). */
export function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

export class CoverageOverlay {
  private readonly renderer = new VoxelVolumetricRenderer();
  readonly object = this.renderer.object;

  private leaves: Leaf[] = [];
  private opts: OverlayOptions = {
    visible: true,
    mode: 'coverage',
    overlayHue: DEFAULT_OVERLAY_HUE,
    intensityScale: DEFAULT_INTENSITY_SCALE,
    involvedCameraCount: 1,
  };

  /** Clear accumulated chunks before starting a new compute() run. */
  reset(): void {
    this.leaves = [];
    this.rebuild();
  }

  /** Append a streamed ChunkResult's valid leaves. Assumes camWords === 1 (<=32 cameras). */
  addChunk(result: ChunkResult): void {
    const acc = accessor(result);
    const [ox, oy, oz] = result.origin;
    const vs = result.voxelSize;
    acc.forEachLeaf((min, size, mask, valid) => {
      if (!valid) return;
      const world = size * vs;
      this.leaves.push({
        cx: ox + min[0] * vs + world / 2,
        cy: oy + min[1] * vs + world / 2,
        cz: oz + min[2] * vs + world / 2,
        size: world,
        camCount: popcount32(mask),
      });
    });
    this.rebuild();
  }

  setOptions(opts: Partial<OverlayOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.renderer.setVisible(this.opts.visible);
    this.renderer.setIntensityScale(this.opts.intensityScale);
    this.rebuild();
  }

  dispose(): void {
    this.renderer.dispose();
  }

  /** Map the accumulated leaves onto renderer voxels for the active mode (spec §9.1). */
  private rebuild(): void {
    // Both modes share the user-selected overlay hue (spec §9.2).
    const color = hueToRgb(this.opts.overlayHue);
    const voxels: Voxel[] = [];
    for (const leaf of this.leaves) {
      const center: [number, number, number] = [leaf.cx, leaf.cy, leaf.cz];
      if (this.opts.mode === 'blindspots') {
        // Only blind spots (no enabled camera sees them); fixed full intensity
        // since their coverage fraction is 0 and would otherwise be invisible.
        if (leaf.camCount !== 0) continue;
        voxels.push({ center, size: leaf.size, intensity: 1, color });
      } else {
        // Coverage: every valid voxel, intensity == coverage fraction.
        voxels.push({
          center,
          size: leaf.size,
          intensity: coverageFraction(leaf.camCount, this.opts.involvedCameraCount),
          color,
        });
      }
    }
    this.renderer.reset();
    this.renderer.addVoxels(voxels);
  }
}
