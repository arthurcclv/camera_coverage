/**
 * Per-volume wireframe boxes (`sampling_volumes.md` §5).
 *
 * Each sampling volume renders as a **wireframe box** (edges + a faint
 * translucent fill) at its `position`/`rotation`/`size`. A unit cube is scaled by
 * `size`, so the entry's root object maps 1:1 to `{position, quaternion, scale}`
 * — `TransformControls` (translate / rotate / **scale**) writes them straight
 * back with no conversion (§5). Volumes of **enabled** zones render normally;
 * volumes of disabled zones are dimmed; the selected volume is highlighted. The
 * fill is **pickable** like camera/probe bodies.
 */
import * as THREE from 'three';
import type { Vec3, Quat } from '@linkervision/camera-coverage-sdk';
import type { SamplingVolume } from './samplingVolumes.ts';
import { RenderOrder } from './renderOrder.ts';

interface VolumeEntry {
  /** Attach target + transform carrier: position/quaternion/scale == volume's. */
  root: THREE.Group;
  fill: THREE.Mesh; // translucent unit cube — the pick body
  edges: THREE.LineSegments;
}

const EDGE_COLOR = 0x8bd0c0; // teal — distinct from cameras (blue) / probes (amber)
const SELECTED_EDGE_COLOR = 0xffd23f;
const FILL_COLOR = 0x8bd0c0;

export class SamplingVolumeGizmoSet {
  readonly group = new THREE.Group();
  private entries = new Map<string, VolumeEntry>();

  /**
   * Sync the gizmos to the current volumes. A volume renders normally when its
   * zone is in `enabledZoneIds`; volumes of disabled zones are dimmed (§5, §7.3).
   */
  update(volumes: SamplingVolume[], selectedId: string | null, enabledZoneIds: ReadonlySet<string>): void {
    const seen = new Set<string>();
    for (const v of volumes) {
      seen.add(v.id);
      let entry = this.entries.get(v.id);
      if (!entry) {
        entry = this.createEntry(v.id);
        this.entries.set(v.id, entry);
      }
      const { root, fill, edges } = entry;
      root.position.set(...v.position);
      root.quaternion.set(v.rotation[0], v.rotation[1], v.rotation[2], v.rotation[3]);
      root.scale.set(v.size[0], v.size[1], v.size[2]);

      const selected = v.id === selectedId;
      const enabled = enabledZoneIds.has(v.zoneId);
      const edgeMat = edges.material as THREE.LineBasicMaterial;
      edgeMat.color.setHex(selected ? SELECTED_EDGE_COLOR : EDGE_COLOR);
      edgeMat.opacity = selected ? 1 : enabled ? 0.85 : 0.25;
      const fillMat = fill.material as THREE.MeshBasicMaterial;
      fillMat.opacity = selected ? 0.18 : enabled ? 0.1 : 0.03;
    }
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }
  }

  /** Nearest hit volume id + its ray distance, or null (§5). */
  pickHit(raycaster: THREE.Raycaster): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null;
    for (const [id, entry] of this.entries) {
      const hits = raycaster.intersectObject(entry.fill, false);
      if (hits.length > 0 && (!best || hits[0].distance < best.distance)) {
        best = { id, distance: hits[0].distance };
      }
    }
    return best;
  }

  getAttachTarget(id: string): THREE.Object3D | undefined {
    return this.entries.get(id)?.root;
  }

  /** Read back position/rotation/size after a TransformControls drag (§5). */
  readTransform(id: string): { position: Vec3; rotation: Quat; size: Vec3 } | undefined {
    const root = this.entries.get(id)?.root;
    if (!root) return undefined;
    const p = root.position;
    const q = root.quaternion;
    const s = root.scale;
    return {
      position: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      size: [s.x, s.y, s.z],
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
  }

  private createEntry(id: string): VolumeEntry {
    const root = new THREE.Group();
    root.name = id;

    const box = new THREE.BoxGeometry(1, 1, 1);
    const fill = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({ color: FILL_COLOR, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    fill.name = id;
    // Draw last of the transparent layers so the fill tints over the coverage fog,
    // while still occluded by any section plane in front of it (`renderOrder.ts`).
    fill.renderOrder = RenderOrder.volumeFill;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.85 }),
    );

    root.add(fill);
    root.add(edges);
    this.group.add(root);
    return { root, fill, edges };
  }

  private disposeEntry(entry: VolumeEntry): void {
    this.group.remove(entry.root);
    entry.fill.geometry.dispose();
    (entry.fill.material as THREE.Material).dispose();
    entry.edges.geometry.dispose();
    (entry.edges.material as THREE.Material).dispose();
  }
}
