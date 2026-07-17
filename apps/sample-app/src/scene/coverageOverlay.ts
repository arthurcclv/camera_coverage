/**
 * Streamed coverage voxel overlay (spec §9): one instanced cube per valid
 * leaf, rendered white with per-voxel opacity encoding the fraction of the
 * involved (enabled) cameras that can see it — fully covered voxels reach the
 * peak opacity, uncovered voxels are transparent, linear in between. Rebuilt
 * incrementally as ChunkResults arrive.
 */
import * as THREE from 'three';
import { accessor } from '@linkervision/camera-coverage-sdk';
import type { ChunkResult } from '@linkervision/camera-coverage-sdk';

interface Leaf {
  x: number;
  y: number;
  z: number;
  size: number; // world edge length
  camCount: number;
}

export interface OverlayOptions {
  /** Involved (enabled) camera count == denominator of the coverage fraction. */
  maxCameraCount: number;
  /** Peak opacity: the opacity of a voxel seen by 100% of involved cameras. */
  opacity: number;
  hideWellCovered: boolean;
  wellCoveredThreshold: number;
  blindSpotsOnly: boolean;
  visible: boolean;
}

const DEFAULT_OPTIONS: OverlayOptions = {
  maxCameraCount: 1,
  // Peak opacity for a fully-covered voxel; partially-covered voxels scale
  // down linearly from here (spec §9).
  opacity: 0.8,
  hideWellCovered: false,
  wellCoveredThreshold: 3,
  blindSpotsOnly: false,
  visible: true,
};

/**
 * Per-voxel overlay opacity (spec §9): white voxels fade from transparent
 * (seen by no involved camera) to `peakOpacity` (seen by all), linearly in the
 * fraction of involved cameras that see the voxel.
 */
export function coverageOpacity(
  camCount: number,
  involvedCameraCount: number,
  peakOpacity: number,
): number {
  const denom = Math.max(1, involvedCameraCount);
  const fraction = Math.max(0, Math.min(1, camCount / denom));
  return fraction * peakOpacity;
}

function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

export class CoverageOverlay {
  readonly object = new THREE.Group();

  private leaves: Leaf[] = [];
  private mesh: THREE.InstancedMesh | null = null;
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
  });
  private opts: OverlayOptions = { ...DEFAULT_OPTIONS };

  constructor() {
    // Per-voxel opacity: carry a per-instance `instanceAlpha` attribute and
    // multiply it into the fragment alpha. InstancedMesh's built-in
    // instanceColor is RGB-only, so alpha needs this shader hook (spec §9).
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying float vInstanceAlpha;',
        )
        .replace(
          '#include <dithering_fragment>',
          'gl_FragColor.a *= vInstanceAlpha;\n#include <dithering_fragment>',
        );
    };
  }

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
      this.leaves.push({
        x: ox + min[0] * vs,
        y: oy + min[1] * vs,
        z: oz + min[2] * vs,
        size: size * vs,
        camCount: popcount32(mask),
      });
    });
    this.rebuild();
  }

  setOptions(opts: Partial<OverlayOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.object.visible = this.opts.visible;
    // Per-voxel opacity (fraction × peak) is baked into instanceAlpha in
    // rebuild(); the material stays at full alpha.
    this.rebuild();
  }

  dispose(): void {
    this.mesh?.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  private rebuild(): void {
    const filtered = this.leaves.filter((leaf) => {
      if (this.opts.blindSpotsOnly) return leaf.camCount === 0;
      if (this.opts.hideWellCovered) return leaf.camCount <= this.opts.wellCoveredThreshold;
      return true;
    });

    if (this.mesh) {
      this.object.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    if (filtered.length === 0) return;

    const mesh = new THREE.InstancedMesh(this.geometry, this.material, filtered.length);
    const m = new THREE.Matrix4();
    const alphas = new Float32Array(filtered.length);
    for (let i = 0; i < filtered.length; i++) {
      const leaf = filtered[i];
      m.makeScale(leaf.size, leaf.size, leaf.size);
      m.setPosition(leaf.x + leaf.size / 2, leaf.y + leaf.size / 2, leaf.z + leaf.size / 2);
      mesh.setMatrixAt(i, m);
      // "Blind spots only" is a binary filter (all shown voxels have camCount
      // 0, whose fractional opacity is 0), so render those at peak opacity
      // rather than invisibly. Otherwise opacity scales with coverage fraction.
      alphas[i] = this.opts.blindSpotsOnly
        ? this.opts.opacity
        : coverageOpacity(leaf.camCount, this.opts.maxCameraCount, this.opts.opacity);
    }
    this.geometry.setAttribute('instanceAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
    this.object.add(mesh);
  }
}
