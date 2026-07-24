/**
 * Per-probe markers + selected-probe sightlines (spec §12.4).
 *
 * A probe renders as a distinct **marker** — its own shape/color, visually
 * separate from camera bodies — pickable like a camera gizmo body and usable as
 * a TransformControls attach target (translate only). While a probe is selected,
 * a green line segment is drawn from it to each camera that sees it.
 *
 * The marker map, reconcile loop, pickHit, getAttachTarget, and the entry side of
 * dispose are the shared `PickableGizmoSet` spine; this file owns the marker entry
 * shape and the (non-entry) sightline overlay.
 */
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import type { Probe } from './probeVisibility.ts';
import { PickableGizmoSet } from './gizmoSet.ts';

interface ProbeEntry {
  /** Attach target + pick body; position == Probe.position. */
  marker: THREE.Mesh;
}

const DEFAULT_COLOR = 0xff9d3f; // amber diamond — distinct from the blue camera bodies
const SELECTED_COLOR = 0xffd23f;
const SIGHTLINE_COLOR = 0x4de08a; // green (spec §12.4)

export class ProbeGizmoSet extends PickableGizmoSet<ProbeEntry> {
  private sightlines: THREE.LineSegments | null = null;

  update(probes: Probe[], selectedId: string | null): void {
    this.reconcile(probes, (entry, probe) => {
      const { marker } = entry;
      marker.position.set(...probe.position);
      const selected = probe.id === selectedId;
      (marker.material as THREE.MeshBasicMaterial).color.setHex(selected ? SELECTED_COLOR : DEFAULT_COLOR);
      marker.scale.setScalar(selected ? 1.4 : 1);
    });
  }

  /** Read back the marker position after a TransformControls drag. */
  readPosition(id: string): Vec3 | undefined {
    const marker = this.entries.get(id)?.marker;
    if (!marker) return undefined;
    return [marker.position.x, marker.position.y, marker.position.z];
  }

  /**
   * Draw a green sightline from `from` to each `target` (visible cameras only,
   * spec §12.4). Passing `null` clears all sightlines. Rebuilt on every call.
   */
  setSightlines(from: Vec3 | null, targets: Vec3[] = []): void {
    this.clearSightlines();
    if (!from || targets.length === 0) return;
    const positions = new Float32Array(targets.length * 6);
    for (let t = 0; t < targets.length; t++) {
      positions.set([from[0], from[1], from[2], targets[t][0], targets[t][1], targets[t][2]], t * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: SIGHTLINE_COLOR, transparent: true, opacity: 0.9 });
    this.sightlines = new THREE.LineSegments(geometry, material);
    this.group.add(this.sightlines);
  }

  /** Also clear the sightline overlay, which lives on the group but outside `entries`. */
  override dispose(): void {
    super.dispose();
    this.clearSightlines();
  }

  protected attachTargetOf(entry: ProbeEntry): THREE.Object3D {
    return entry.marker;
  }

  protected pickTargetOf(entry: ProbeEntry): THREE.Object3D {
    return entry.marker;
  }

  protected createEntry(id: string): ProbeEntry {
    const marker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.28),
      new THREE.MeshBasicMaterial({ color: DEFAULT_COLOR }),
    );
    marker.name = id;
    this.group.add(marker);
    return { marker };
  }

  protected disposeEntry(entry: ProbeEntry): void {
    this.group.remove(entry.marker);
    entry.marker.geometry.dispose();
    (entry.marker.material as THREE.Material).dispose();
  }

  private clearSightlines(): void {
    if (!this.sightlines) return;
    this.group.remove(this.sightlines);
    this.sightlines.geometry.dispose();
    (this.sightlines.material as THREE.Material).dispose();
    this.sightlines = null;
  }
}
