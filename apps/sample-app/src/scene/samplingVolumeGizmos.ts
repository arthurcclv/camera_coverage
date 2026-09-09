/**
 * Per-volume wireframe boxes (`sampling_volumes.md` §5).
 *
 * Each sampling volume renders as a **wireframe box** (edges + a faint
 * translucent fill) at its `position`/`rotation`/`size`. A unit cube is scaled by
 * `size`, so the entry's root object maps 1:1 to `{position, quaternion, scale}`
 * — `TransformControls` (translate / rotate / **scale**) writes them straight
 * back with no conversion (§5). Volumes of **visible** zones render normally;
 * volumes outside that set draw nothing unless selected (`spec.md` §2.4.3); the
 * selected volume is highlighted. The fill is **pickable** like camera/probe
 * bodies.
 *
 * The keyed entry map, reconcile loop, pickHit, getAttachTarget, and dispose are
 * the shared `PickableGizmoSet` spine; this file owns the volume entry shape and
 * its per-frame update.
 */
import * as THREE from 'three';
import type { Vec3, Quat } from '@linkervision/camera-coverage-sdk';
import type { SamplingVolume } from './samplingVolumes.ts';
import { RenderOrder } from './renderOrder.ts';
import { PickableGizmoSet } from './gizmoSet.ts';

interface VolumeEntry {
  /** Attach target + transform carrier: position/quaternion/scale == volume's. */
  root: THREE.Group;
  fill: THREE.Mesh; // translucent unit cube — the pick body
  edges: THREE.LineSegments;
}

const EDGE_COLOR = 0x8bd0c0; // teal — distinct from cameras (blue) / probes (amber)
const SELECTED_EDGE_COLOR = 0xffd23f;
const FILL_COLOR = 0x8bd0c0;

export class SamplingVolumeGizmoSet extends PickableGizmoSet<VolumeEntry> {
  /**
   * Sync the gizmos to the current volumes. A volume renders normally when its
   * zone is in `visibleZoneIds` — the enabled zones union every enabled group's
   * target `zoneIds`, which override a zone's own flag (`camera_placement.md`
   * §3.1.2). A volume outside that set draws nothing at all unless it is the
   * selection, when it takes the selected-disabled tier (`spec.md` §2.4.3, §5).
   */
  update(volumes: SamplingVolume[], selectedId: string | null, visibleZoneIds: ReadonlySet<string>): void {
    this.reconcile(volumes, (entry, v) => {
      const { root, fill, edges } = entry;
      root.position.set(...v.position);
      root.quaternion.set(v.rotation[0], v.rotation[1], v.rotation[2], v.rotation[3]);
      root.scale.set(v.size[0], v.size[1], v.size[2]);

      const selected = v.id === selectedId;
      const visible = visibleZoneIds.has(v.zoneId);
      root.visible = visible || selected;
      if (!root.visible) return;
      const edgeMat = edges.material as THREE.LineBasicMaterial;
      edgeMat.color.setHex(selected ? SELECTED_EDGE_COLOR : EDGE_COLOR);
      // Four tiers, not three (spec §2.4.3): a hidden volume that is *selected*
      // sits between selected and gone, so selecting it to edit it still reads as
      // "this zone is off".
      edgeMat.opacity = selected ? (visible ? 1 : 0.4) : 0.85;
      const fillMat = fill.material as THREE.MeshBasicMaterial;
      fillMat.opacity = selected ? (visible ? 0.18 : 0.06) : 0.1;
    });
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

  protected attachTargetOf(entry: VolumeEntry): THREE.Object3D {
    return entry.root;
  }

  protected pickTargetOf(entry: VolumeEntry): THREE.Object3D {
    return entry.fill;
  }

  protected createEntry(id: string): VolumeEntry {
    const root = new THREE.Group();
    root.name = id;

    const box = new THREE.BoxGeometry(1, 1, 1);
    const fill = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({ color: FILL_COLOR, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    fill.name = id;
    // Draw last of the in-scene transparent layers, still occluded by any section
    // plane in front of it (`renderOrder.ts`). The coverage fog is not one of them —
    // it composites over this fill in its own pass (`volumetric_rendering.md` §4),
    // so the fog tints the fill rather than the other way round.
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

  protected disposeEntry(entry: VolumeEntry): void {
    this.group.remove(entry.root);
    entry.fill.geometry.dispose();
    (entry.fill.material as THREE.Material).dispose();
    entry.edges.geometry.dispose();
    (entry.edges.material as THREE.Material).dispose();
  }
}
