/**
 * The pool scatter (`camera_placement.md` §5.2, §13).
 *
 * Two properties carry this overlay, and both are the kind that fail silently:
 *
 * - It is drawn as an **instanced `Sprite`**, not `THREE.Points`. WebGPU's point
 *   primitives are fixed at one pixel — three's own `PointsNodeMaterial` says so
 *   — so as Points the scatter rendered, one pixel wide, and was invisible.
 * - Its dots are sized in **screen** space. The same overlay has to read on a 6 m
 *   demo room and on the real 440 × 201 × 1120 m site, and a world-space dot
 *   small enough for the first is sub-pixel in the second.
 *
 * Neither shows up as a crash or a wrong number, which is why both are pinned
 * here rather than left to constants nobody re-checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlacementOverlay, poolDotColor } from '../src/scene/constraintGizmos.ts';
import { RenderOrder } from '../src/scene/renderOrder.ts';
import { segmentPairs } from '../src/scene/polylineDraw.ts';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

function spriteNamed(overlay: PlacementOverlay, name: string): THREE.Sprite {
  const sprite = overlay.group.children.find(
    (c): c is THREE.Sprite => (c as THREE.Sprite).isSprite && c.name === name,
  );
  assert.ok(sprite, `expected an instanced Sprite named ${name}, not THREE.Points`);
  return sprite;
}

const scatterOf = (overlay: PlacementOverlay) => spriteNamed(overlay, 'placement-pool-dots');
const draftDotsOf = (overlay: PlacementOverlay) => spriteNamed(overlay, 'polyline-draft-vertices');

function positionsAt(...xs: number[]): { position: Vec3; count: number }[] {
  return xs.map((x, i) => ({ position: [x, 2, 0] as Vec3, count: i + 1 }));
}

test('the scatter is an instanced Sprite, because WebGPU points are 1 pixel', () => {
  const overlay = new PlacementOverlay();
  const sprite = scatterOf(overlay);
  assert.ok(!(sprite as unknown as THREE.Points).isPoints);
  // Each instance is placed by the material's `positionNode`, so the sprite's own
  // transform never leaves the origin — culling against it would drop the whole
  // scatter the moment the origin left the frustum.
  assert.equal(sprite.frustumCulled, false);
  overlay.dispose();
});

test('the dots are sized in screen space, so they read at any site scale', () => {
  const overlay = new PlacementOverlay();
  const material = scatterOf(overlay).material as THREE.Material & {
    size: number;
    sizeAttenuation: boolean;
  };
  assert.equal(material.sizeAttenuation, false, 'a world-space size vanishes on a 1120 m site');
  assert.ok(material.size >= 2 && material.size <= 8, `${material.size}px is not a small dot`);
  // The dots are a set: they must not occlude each other or the gizmos they sit
  // on. Depth *testing* stays on, so a position behind a wall is hidden.
  assert.equal(material.depthWrite, false);
  assert.notEqual(material.depthTest, false);
  overlay.dispose();
});

test('an empty pool hides the scatter and draws no instances', () => {
  const overlay = new PlacementOverlay();
  overlay.setPool([], new Set());
  assert.equal(scatterOf(overlay).visible, false);
  assert.equal(scatterOf(overlay).count, 0);
  overlay.setPool(positionsAt(0, 1, 2), new Set());
  assert.equal(scatterOf(overlay).visible, true);
  assert.equal(scatterOf(overlay).count, 3, 'one instance per candidate position');
  overlay.dispose();
});

test('a smaller pool draws fewer instances rather than leaving the old ones', () => {
  // The count slider re-sets the pool on every tick (§5.2). The buffers are
  // reused; `count` is what stops the stale tail being drawn.
  const overlay = new PlacementOverlay();
  overlay.setPool(positionsAt(0, 1, 2, 3), new Set());
  overlay.setPool(positionsAt(0, 1), new Set());
  assert.equal(scatterOf(overlay).count, 2);
  overlay.dispose();
});

test('the buffers grow for a bigger pool and are then reused', () => {
  const overlay = new PlacementOverlay();
  const material = () => scatterOf(overlay).material as THREE.Material & { positionNode: unknown };
  overlay.setPool(positionsAt(...Array.from({ length: 10 }, (_, i) => i)), new Set());
  const first = material().positionNode;
  // Still inside the same capacity: re-pointing the node would recompile the
  // shader, and this runs on every count-slider tick.
  overlay.setPool(positionsAt(...Array.from({ length: 200 }, (_, i) => i)), new Set());
  assert.equal(material().positionNode, first, 'a pool inside capacity must not rebuild the nodes');
  // Past it, the buffers grow.
  overlay.setPool(positionsAt(...Array.from({ length: 900 }, (_, i) => i)), new Set());
  assert.notEqual(material().positionNode, first);
  assert.equal(scatterOf(overlay).count, 900);
  overlay.dispose();
});

test('the draft draws a dot per committed vertex, and none for the cursor', () => {
  // The vertices have to be visible *as they are clicked* — before the second
  // one there is no segment to draw, and a first click that shows nothing reads
  // as a click that did not register (§6.2).
  const overlay = new PlacementOverlay();
  overlay.setDraftVertices([[0, 2, 0]]);
  assert.equal(draftDotsOf(overlay).visible, true, 'one clicked vertex must already show');
  assert.equal(draftDotsOf(overlay).count, 1);
  overlay.setDraftVertices([
    [0, 2, 0],
    [3, 2, 0],
    [6, 2, 0],
  ]);
  assert.equal(draftDotsOf(overlay).count, 3, 'one dot per vertex, and the cursor is not one');
  // A committed or cancelled draft leaves no dots behind.
  overlay.setDraftVertices([]);
  assert.equal(draftDotsOf(overlay).visible, false);
  overlay.dispose();
});

test('the draft draws above the scene, since its vertices sit on the surface', () => {
  // Every draft vertex is a point *on* a wall by construction, so a depth-tested
  // line through two of them is coplanar with that wall and z-fights away.
  const overlay = new PlacementOverlay();
  const line = draftOf(overlay);
  const lineMaterial = line.material as THREE.Material;
  assert.equal(lineMaterial.depthTest, false, 'a coplanar line needs no depth test');
  assert.equal(line.renderOrder, RenderOrder.draftOverlay);
  const dots = draftDotsOf(overlay);
  assert.equal((dots.material as THREE.Material).depthTest, false, 'dots and segments must agree');
  assert.equal(dots.renderOrder, RenderOrder.draftOverlay);
  // The pool keeps its depth test: a candidate position behind a wall being
  // hidden is information, not a defect.
  assert.notEqual((scatterOf(overlay).material as THREE.Material).depthTest, false);
  overlay.dispose();
});

function draftOf(overlay: PlacementOverlay): THREE.LineSegments {
  // Solid `LineSegments` over explicit pairs, rebuilt per update, over a geometry
  // that started with a `position` attribute — the last of those is what made the
  // line appear at all (see the vertex-buffer test above). A `LineDashedMaterial`
  // draft and one cut to length by `setDrawRange` were both invisible before it.
  const line = overlay.group.children.find(
    (c): c is THREE.LineSegments => c.name === 'polyline-draft-line',
  );
  assert.ok(line, 'the overlay draws the in-progress polyline as LineSegments');
  assert.ok((line as THREE.LineSegments).isLineSegments);
  return line;
}

function movesOf(overlay: PlacementOverlay): THREE.LineSegments {
  const line = overlay.group.children.find(
    (c): c is THREE.LineSegments => c.name === 'placement-moves',
  );
  assert.ok(line, 'the overlay draws the planned camera moves as LineSegments');
  return line;
}

/**
 * The endpoints the draft would actually draw, read back.
 *
 * The whole attribute, deliberately: it is sized to exactly what is drawn, with
 * no `drawRange` to trim it — a buffer longer than the line is the shape that
 * rendered nothing.
 */
function drawnDraft(overlay: PlacementOverlay): number[][] {
  const position = draftOf(overlay).geometry.getAttribute('position');
  return Array.from({ length: position.count }, (_, i) => [
    position.getX(i),
    position.getY(i),
    position.getZ(i),
  ]);
}

test('every segment of the draft is drawn, however many clicks it took', () => {
  // Three regressions in one place. `BufferGeometry.setFromPoints` writes into an
  // existing position buffer and *refuses to grow it*, so the first draft fixed
  // the buffer at its size and everything clicked afterwards was dropped with a
  // console warning — the draw mode looked like it had stopped accepting clicks.
  // Then a grown buffer trimmed by `setDrawRange` drew nothing at all under this
  // app's WebGPU backend. Both are ruled out by an attribute sized to exactly the
  // endpoints drawn, rebuilt per update (`camera_placement.md` §6.2).
  const overlay = new PlacementOverlay();
  const points: Vec3[] = [];
  for (let i = 0; i < 20; i++) {
    points.push([i, 2, 0]);
    if (points.length < 2) continue;
    overlay.setDraft(points);
    assert.deepEqual(
      drawnDraft(overlay),
      segmentPairs(points).map((p) => [...p]),
      `a ${points.length}-vertex draft must draw all ${points.length - 1} of its segments`,
    );
    assert.equal(
      draftOf(overlay).geometry.getAttribute('position').count,
      (points.length - 1) * 2,
      'the buffer must be exactly as long as the line — a longer one rendered nothing',
    );
  }
  overlay.dispose();
});

test('a draft shorter than a segment is hidden, and a later one still draws', () => {
  const overlay = new PlacementOverlay();
  overlay.setDraft([]);
  assert.equal(draftOf(overlay).visible, false, 'nothing drawn, nothing to see');
  // One committed vertex with no cursor is still only a point (§6.2).
  overlay.setDraft([[0, 2, 0]]);
  assert.equal(draftOf(overlay).visible, false);
  overlay.setDraft([
    [0, 2, 0],
    [3, 2, 0],
  ]);
  assert.equal(draftOf(overlay).visible, true);
  assert.equal(drawnDraft(overlay).length, 2, 'one segment is one endpoint pair');
  // A segment of zero length draws nothing — a click that landed exactly on the
  // previous vertex.
  overlay.setDraft([
    [0, 2, 0],
    [0, 2, 0],
  ]);
  assert.equal(draftOf(overlay).visible, false);
  // Escape empties the draft: the line hides rather than keeping the last shape.
  overlay.setDraft([]);
  assert.equal(draftOf(overlay).visible, false);
  overlay.dispose();
});

test('every line starts with a position attribute, or it never draws again', () => {
  // The bug that made the draft invisible three attempts running. The overlay is
  // built once and lives in the scene while its lines are filled in later, so the
  // render loop draws them at least once while empty. On that frame three's WebGPU
  // path caches the object's vertex buffers from `geometry.attributes` — an empty
  // list, plus an empty `attributesId` map — and `needsGeometryUpdate` afterwards
  // re-checks only what is in that map, so a `position` added later is never seen:
  // the object keeps a pipeline with no vertex buffer and draws nothing, with no
  // error and correct data. A placeholder attribute at construction is what puts
  // `position` in the map, and every other line in the app is attributes-first.
  const overlay = new PlacementOverlay();
  for (const line of [draftOf(overlay), movesOf(overlay)]) {
    const position = line.geometry.getAttribute('position');
    assert.ok(position, `${line.name} must reach the scene with a position attribute`);
    assert.ok(position.count >= 2, 'at least one (degenerate) segment, so the buffer is real');
    // And hidden until it has something to draw, so the placeholder is never seen.
    assert.equal(line.visible, false, `${line.name} must start hidden`);
  }
  overlay.dispose();
});

test('filling a line in replaces its attribute, which is the change three sees', () => {
  // A write *into* the placeholder buffer would leave the attribute's id — the only
  // thing `needsGeometryUpdate` compares — untouched, and the line would keep
  // drawing the placeholder. Each update must hand over a new attribute.
  const overlay = new PlacementOverlay();
  const placeholder = draftOf(overlay).geometry.getAttribute('position');
  overlay.setDraft([
    [0, 2, 0],
    [3, 2, 0],
  ]);
  const filled = draftOf(overlay).geometry.getAttribute('position');
  assert.notEqual(filled, placeholder, 'a new BufferAttribute, not a write into the old one');
  assert.notEqual((filled as THREE.BufferAttribute).id, (placeholder as THREE.BufferAttribute).id);

  const movesPlaceholder = movesOf(overlay).geometry.getAttribute('position');
  overlay.setMoves([{ from: [0, 2, 0], to: [3, 2, 0] }]);
  assert.notEqual(movesOf(overlay).geometry.getAttribute('position'), movesPlaceholder);
  assert.equal(movesOf(overlay).visible, true);
  overlay.dispose();
});

test('dots shade by their own reachable count, and the chosen layout stands out', () => {
  const c = new THREE.Color();
  const lum = (col: THREE.Color) => col.r + col.g + col.b;
  const low = lum(poolDotColor(c, 1, 10, false));
  const high = lum(poolDotColor(c, 10, 10, false));
  assert.ok(high > low, 'a higher-count position is brighter than a lower one');

  // A chosen position takes the selection colour outright, not a bright point on
  // the ramp — so it stays distinguishable from a merely high-scoring neighbour.
  const chosen = poolDotColor(c, 1, 10, true).getHex();
  assert.notEqual(chosen, poolDotColor(c, 10, 10, false).getHex());
  assert.equal(chosen, poolDotColor(c, 10, 10, true).getHex(), 'chosen does not ramp');

  // An unbuilt pool has `top = 0`; the ramp must not divide by it.
  assert.ok(Number.isFinite(lum(poolDotColor(c, 0, 0, false))));
});
