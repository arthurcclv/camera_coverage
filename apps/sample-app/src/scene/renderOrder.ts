/**
 * Single source of truth for the draw order of the scene's transparent layers
 * (spec.md §13.5; sampling_volumes.md §5).
 *
 * These layers are `transparent: true`. Without an explicit order, Three.js sorts
 * transparent objects by their bounding-sphere center distance to the camera —
 * which flips with viewpoint and lets the section heatmap plane over-paint the
 * layers beneath it. The section plane is the **only** one that writes depth
 * (`depthWrite: true`); the volume fill uses `depthWrite: false`/`depthTest: true`.
 * So the plane must draw **first** to lay its depth down, after which the fill
 * depth-tests against it and occlusion is resolved by the depth buffer per
 * viewpoint rather than by unstable transparency sorting.
 *
 * **The coverage fog is deliberately absent.** It renders in a pass of its own,
 * into its own target, depth-tested against the depth the main pass wrote
 * (`volumetric_rendering.md` §4, `fogCompositor.ts`), so a draw order on its mesh
 * would sequence it against nothing. Its occlusion comes from that shared depth
 * buffer instead — the section plane hides it, the depth-less volume fill does not
 * (spec.md §9).
 *
 * Objects not listed here keep Three.js's default render order of 0 (section
 * bound outlines, volume wireframe edges, camera/probe gizmos): they render before
 * the section plane, which is harmless since they are thin or sit elsewhere.
 */
export const RenderOrder = {
  /** Section heatmap plane — the depth writer, drawn first. */
  sectionPlane: 1,
  /** Sampling-volume translucent fill (`sampling_volumes.md` §5), drawn last. */
  volumeFill: 2,
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
  draftOverlay: 3,
} as const;
