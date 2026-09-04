/**
 * Single source of truth for the draw order of the scene's transparent layers
 * (spec.md §13.5, §9; volumetric_rendering.md §4; sampling_volumes.md §5).
 *
 * All three of these layers are `transparent: true`. Without an explicit order,
 * Three.js sorts transparent objects by their bounding-sphere center distance to
 * the camera — which flips with viewpoint and lets the section heatmap plane
 * over-paint the coverage fog in some views. The section plane is the **only** one
 * of the three that writes depth (`depthWrite: true`); the fog and the volume fill
 * use `depthWrite: false`/`depthTest: true`. So the plane must draw **first** to
 * lay its depth down, after which the fog and fill depth-test against it and
 * occlusion is resolved by the depth buffer per viewpoint rather than by unstable
 * transparency sorting. Fog before fill so an overlapping fill tints over the fog.
 *
 * Objects not listed here keep Three.js's default render order of 0 (section
 * bound outlines, volume wireframe edges, camera/probe gizmos): they render before
 * the section plane, which is harmless since they are thin or sit elsewhere.
 */
export const RenderOrder = {
  /** Section heatmap plane — the depth writer, drawn first. */
  sectionPlane: 1,
  /** Coverage voxel fog (§9). */
  coverageFog: 2,
  /** Sampling-volume translucent fill — drawn last, tints over the fog. */
  volumeFill: 3,
  /**
   * The armed draw mode's draft: its vertices and its segments
   * (`camera_placement.md` §6.2). Above everything, and paired with
   * `depthTest: false` on those materials.
   *
   * Every draft vertex is a point **on** a surface by construction — the hit test
   * puts it there — so a depth-tested line through them is coplanar with the wall
   * being drawn on and z-fights it away. The draft is what the user is doing right
   * now; it has to be visible even where it is buried.
   */
  draftOverlay: 4,
} as const;
