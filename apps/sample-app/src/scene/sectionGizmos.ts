/**
 * Per-section heatmap plane + faint bound outlines + transform target (spec
 * §13.5, §13.8). Pure Three.js rendering layer: consumes the `SectionCellGrid`s
 * computed by `sectionHeatmap.ts` (via `sectionHeatmapTextureData`) and draws
 * them; owns no aggregation logic itself.
 *
 * A section's heatmap plane and bound outlines are **not pick targets** (spec
 * §13.8) — selection happens from the hierarchy row only — so their `raycast`
 * is stubbed to a no-op regardless of what a caller's raycaster later does, and
 * this set extends the plain (non-pickable) `GizmoSet` spine.
 */
import * as THREE from 'three';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  axisMapping,
  collapseAxisNormalSign,
  sectionHeatmapTextureData,
  sectionPlaneRotation,
  type Section,
  type SectionCellGrid,
} from './sectionHeatmap.ts';
import { RenderOrder } from './renderOrder.ts';
import { GizmoSet } from './gizmoSet.ts';

const OUTLINE_COLOR = 0x9aa3b0;
const OUTLINE_OPACITY = 0.35;
const STALE_OPACITY = 0.35;
const NORMAL_OPACITY = 1;

interface SectionEntry {
  /** Repositioned/rotated as a unit per orientation; holds the heatmap plane + outlines. */
  group: THREE.Group;
  heatmapMesh: THREE.Mesh;
  heatmapMaterial: THREE.MeshBasicMaterial;
  texture: THREE.DataTexture;
  minOutline: THREE.LineSegments;
  maxOutline: THREE.LineSegments;
  outlineMaterial: THREE.LineBasicMaterial;
  /** Invisible TransformControls attach target at the box center; dragged freely on all 3 axes (spec §13.8). */
  attachTarget: THREE.Object3D;
  lastOrientation: string | null;
  /** Plane/outline geometry is rebuilt when orientation or footprint size changes. */
  lastWidth: number;
  lastHeight: number;
  lastDimsA: number;
  lastDimsB: number;
}

function noRaycast(this: THREE.Object3D, ..._args: unknown[]): void {
  // Intentionally empty: section visuals are never pick targets (spec §13.8).
}

// A rectangle outline as 4 disconnected segments — this project's renderer
// (three/webgpu, both the WebGPU and WebGL2 paths) doesn't support the
// `THREE.LineLoop` primitive, only `Line`/`LineSegments`.
function outlineGeometry(width: number, height: number): THREE.BufferGeometry {
  const hw = width / 2;
  const hh = height / 2;
  const corners: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const positions = new Float32Array(24);
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    positions.set([x0, y0, 0, x1, y1, 0], i * 6);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geom;
}

export class SectionGizmoSet extends GizmoSet<SectionEntry> {
  /**
   * Push current section state + computed cell grids into the scene.
   * `cellGrids` holds a grid per section that has retained data (spec §13.4);
   * a missing entry means no run yet (rendered as an all-invalid/black plane).
   */
  update(
    sections: Section[],
    cellGrids: ReadonlyMap<string, SectionCellGrid | null>,
    masterVisible: boolean,
    stale: boolean,
    /** The selected section, which draws even when disabled (spec §2.4.3). */
    selectedId: string | null = null,
  ): void {
    this.reconcile(sections, (entry, section) => {
      const grid = cellGrids.get(section.id) ?? null;
      this.updateEntry(entry, section, grid, masterVisible, stale, section.id === selectedId);
    });
  }

  /** Read back the attach target's position on `axis` after a constrained drag (spec §13.8). */
  readAxisPosition(id: string, axis: 0 | 1 | 2): number | undefined {
    const target = this.entries.get(id)?.attachTarget;
    if (!target) return undefined;
    return axis === 0 ? target.position.x : axis === 1 ? target.position.y : target.position.z;
  }

  protected attachTargetOf(entry: SectionEntry): THREE.Object3D {
    return entry.attachTarget;
  }

  // Section meshes aren't keyed by id (selection is by hierarchy row), so the
  // reconcile id is ignored here.
  protected createEntry(): SectionEntry {
    const group = new THREE.Group();

    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;

    const heatmapMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      // Discard fully-transparent no-data/empty texels (spec §13.3/§13.5) so they
      // write neither color nor depth and reveal the scene behind the plane. The
      // epsilon is well below the stale-dimming opacity (0.35) so dimmed colored
      // cells still render.
      alphaTest: 0.01,
    });
    const heatmapMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), heatmapMaterial);
    heatmapMesh.raycast = noRaycast;
    // Draw first of the transparent layers: it is the only one that writes depth,
    // so the fog/fill depth-test against it (spec §13.5, `renderOrder.ts`).
    heatmapMesh.renderOrder = RenderOrder.sectionPlane;

    const outlineMaterial = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: OUTLINE_OPACITY });
    const minOutline = new THREE.LineSegments(outlineGeometry(1, 1), outlineMaterial);
    const maxOutline = new THREE.LineSegments(outlineGeometry(1, 1), outlineMaterial);
    minOutline.raycast = noRaycast;
    maxOutline.raycast = noRaycast;

    group.add(heatmapMesh, minOutline, maxOutline);
    this.group.add(group);

    const attachTarget = new THREE.Object3D();
    this.group.add(attachTarget);

    return {
      group,
      heatmapMesh,
      heatmapMaterial,
      texture,
      minOutline,
      maxOutline,
      outlineMaterial,
      attachTarget,
      lastOrientation: null,
      lastWidth: 0,
      lastHeight: 0,
      lastDimsA: 0,
      lastDimsB: 0,
    };
  }

  private updateEntry(
    entry: SectionEntry,
    section: Section,
    cellGrid: SectionCellGrid | null,
    masterVisible: boolean,
    stale: boolean,
    selected: boolean,
  ): void {
    const { collapseAxis, axisA, axisB } = axisMapping(section.orientation);
    // The heatmap plane spans the footprint (spec §13.2). When a run is retained,
    // use its grid-aligned selected-column extent (§13.3) so the plane matches the
    // drawn cells exactly; before any run, fall back to the raw footprint bounds.
    const extentA = cellGrid ? cellGrid.extentA : { min: section.minA, max: section.maxA };
    const extentB = cellGrid ? cellGrid.extentB : { min: section.minB, max: section.maxB };
    const width = extentA.max - extentA.min;
    const height = extentB.max - extentB.min;
    const centerA = (extentA.min + extentA.max) / 2;
    const centerB = (extentB.min + extentB.max) / 2;
    const mid = (section.min + section.max) / 2;

    // Rebuild geometry on orientation OR footprint-size change (spec §13.2): unlike
    // before, width/height are no longer constant (the whole workspace).
    if (
      entry.lastOrientation !== section.orientation ||
      entry.lastWidth !== width ||
      entry.lastHeight !== height
    ) {
      entry.heatmapMesh.geometry.dispose();
      entry.heatmapMesh.geometry = new THREE.PlaneGeometry(width, height);
      entry.minOutline.geometry.dispose();
      entry.minOutline.geometry = outlineGeometry(width, height);
      entry.maxOutline.geometry.dispose();
      entry.maxOutline.geometry = outlineGeometry(width, height);
      entry.group.rotation.set(...sectionPlaneRotation(section.orientation));
      entry.lastOrientation = section.orientation;
      entry.lastWidth = width;
      entry.lastHeight = height;
    }

    const pos: Vec3 = [0, 0, 0];
    pos[axisA] = centerA;
    pos[axisB] = centerB;
    pos[collapseAxis] = mid;
    entry.group.position.set(...pos);

    // Outlines sit at the slab bounds in the group's local space — always along
    // local Z, since the group rotation orients local Z along the world
    // collapse axis (spec §13.2). `collapseAxisNormalSign` corrects for
    // orientations whose rotation (chosen to keep the heatmap's in-plane axes
    // unmirrored, see `sectionPlaneRotation`) maps local +Z to the *negative*
    // collapse-axis direction — without it, min/max would land swapped.
    const halfThickness = (section.max - section.min) / 2;
    const normalSign = collapseAxisNormalSign(section.orientation);
    entry.minOutline.position.set(0, 0, -halfThickness * normalSign);
    entry.maxOutline.position.set(0, 0, halfThickness * normalSign);

    entry.attachTarget.position.set(...pos);

    // A disabled section draws nothing, except while selected — the one state in
    // which it must be visible, since TransformControls is attached to it and a
    // drag on an invisible box is a drag in the dark (spec §2.4.3, §13.8). What it
    // draws then is its **outlines only**: the outline is what the drag needs to
    // see, while the heatmap is measured data this section is excluded from
    // reporting.
    const outlinesOnly = !section.enabled && selected;
    const visible = masterVisible && (section.enabled || selected);
    entry.group.visible = visible;
    entry.attachTarget.visible = visible;
    if (!visible) return;
    entry.heatmapMesh.visible = !outlinesOnly;

    const opacity = stale ? STALE_OPACITY : NORMAL_OPACITY;
    entry.heatmapMaterial.opacity = opacity;
    // The selected-disabled tier is the full outline opacity (spec §2.4.3): the
    // box is the only thing drawn, so dimming it further would defeat the point.
    entry.outlineMaterial.opacity = !outlinesOnly && stale ? OUTLINE_OPACITY * 0.5 : OUTLINE_OPACITY;
    if (outlinesOnly) return;

    if (cellGrid) {
      const data = sectionHeatmapTextureData(cellGrid, section.aggregation);
      if (entry.lastDimsA !== cellGrid.dimsA || entry.lastDimsB !== cellGrid.dimsB) {
        entry.texture.dispose();
        entry.texture = new THREE.DataTexture(data, cellGrid.dimsA, cellGrid.dimsB, THREE.RGBAFormat);
        entry.texture.magFilter = THREE.NearestFilter;
        entry.texture.minFilter = THREE.NearestFilter;
        entry.texture.generateMipmaps = false;
        entry.heatmapMaterial.map = entry.texture;
        entry.lastDimsA = cellGrid.dimsA;
        entry.lastDimsB = cellGrid.dimsB;
      } else {
        (entry.texture.image.data as Uint8Array).set(data);
      }
      entry.texture.needsUpdate = true;
    }
  }

  protected disposeEntry(entry: SectionEntry): void {
    this.group.remove(entry.group);
    this.group.remove(entry.attachTarget);
    entry.heatmapMesh.geometry.dispose();
    entry.heatmapMaterial.dispose();
    entry.texture.dispose();
    entry.minOutline.geometry.dispose();
    entry.maxOutline.geometry.dispose();
    entry.outlineMaterial.dispose();
  }
}
