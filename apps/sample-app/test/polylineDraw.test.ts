/**
 * The polyline draw mode's pure half (`camera_placement.md` §6.2).
 *
 * The draft is data and every transition is a function of it, so the rules that
 * decide what a click does and what a commit creates are pinned here rather than
 * left to a viewport nobody can drive from a test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  EMPTY_DRAFT,
  appendVertex,
  commitDraft,
  draftAfterDoubleClick,
  draftPolyline,
  drawClickAction,
  effectiveVertex,
  extendEnd,
  extendInsertAt,
  insertMidpoint,
  moveCursor,
  removeLastVertex,
  segmentPairs,
} from '../src/scene/polylineDraw.ts';

const at = (x: number): Vec3 => [x, 2, 0];

test('each click appends a vertex, and the draft is never mutated in place', () => {
  const one = appendVertex(EMPTY_DRAFT, at(0));
  const two = appendVertex(one, at(1));
  assert.deepEqual(two.points, [at(0), at(1)]);
  assert.deepEqual(one.points, [at(0)], 'the earlier draft still holds one vertex');
  assert.deepEqual(EMPTY_DRAFT.points, []);
  // The point is copied, so the caller's array (a reused scratch, in the
  // viewport) cannot rewrite a committed vertex later.
  const scratch: Vec3 = [9, 9, 9];
  const copied = appendVertex(EMPTY_DRAFT, scratch);
  scratch[0] = 0;
  assert.equal(copied.points[0][0], 9);
});

test('Backspace drops the last vertex and stops at empty', () => {
  const two = appendVertex(appendVertex(EMPTY_DRAFT, at(0)), at(1));
  assert.deepEqual(removeLastVertex(two).points, [at(0)]);
  const empty = removeLastVertex(removeLastVertex(two));
  assert.deepEqual(empty.points, []);
  assert.equal(removeLastVertex(empty), empty, 'a no-op returns the same draft');
});

test('the rubber band is the cursor, and only once there is a vertex to band from', () => {
  const hovering = moveCursor(EMPTY_DRAFT, at(5));
  assert.deepEqual(draftPolyline(hovering), [], 'no vertex yet: nothing to draw');
  const drawn = moveCursor(appendVertex(EMPTY_DRAFT, at(0)), at(5));
  assert.deepEqual(draftPolyline(drawn), [at(0), at(5)]);
  // A miss clears the band rather than leaving it at the last hit.
  assert.deepEqual(draftPolyline(moveCursor(drawn, null)), [at(0)]);
});

test('one vertex commits as a point constraint, two or more as a polyline', () => {
  assert.equal(commitDraft(EMPTY_DRAFT), null, 'nothing drawn commits to nothing');
  // The cursor is not a vertex: it must not become one on commit.
  const one = moveCursor(appendVertex(EMPTY_DRAFT, at(0)), at(5));
  assert.deepEqual(commitDraft(one), { kind: 'point', points: [at(0)] });
  const two = appendVertex(one, at(1));
  assert.deepEqual(commitDraft(two), { kind: 'polyline', points: [at(0), at(1)] });
});

test('a double-click contributes no vertex of its own', () => {
  // Three single clicks, then a double-click to finish: its first click appends a
  // fourth vertex like any other click, and ending the line takes that vertex
  // back out. The polyline ends at the last *single*-clicked vertex (§6.2).
  let draft = EMPTY_DRAFT;
  for (const x of [0, 3, 7]) draft = appendVertex(draft, at(x));
  const withDoubleClick = appendVertex(draft, at(9));
  assert.deepEqual(commitDraft(draftAfterDoubleClick(withDoubleClick)), {
    kind: 'polyline',
    points: [at(0), at(3), at(7)],
  });
  // Enter has no click to take back, so it commits what is drawn — including a
  // vertex the user single-clicked at the same place.
  assert.deepEqual(commitDraft(withDoubleClick), {
    kind: 'polyline',
    points: [at(0), at(3), at(7), at(9)],
  });
});

test('a double-click that leaves one vertex commits a point, and none commits nothing', () => {
  // One single click then a double-click: the pair's vertex is dropped, and one
  // vertex is a point constraint — that is what the user drew (§6.2).
  const one = appendVertex(appendVertex(EMPTY_DRAFT, at(0)), at(4));
  assert.deepEqual(commitDraft(draftAfterDoubleClick(one)), { kind: 'point', points: [at(0)] });
  // A double-click as the very first interaction draws nothing at all.
  const none = appendVertex(EMPTY_DRAFT, at(0));
  assert.equal(commitDraft(draftAfterDoubleClick(none)), null);
  // And it stops at empty rather than throwing.
  assert.equal(commitDraft(draftAfterDoubleClick(EMPTY_DRAFT)), null);
});

test("a double-click's second click commits instead of appending a duplicate", () => {
  const still = { x: 100, y: 100 };
  assert.equal(drawClickAction(1, still, still), 'append');
  assert.equal(drawClickAction(2, still, still), 'commit');
  // A longer streak commits too — by then the draft is empty, so it is a no-op,
  // which beats appending a stray vertex to the polyline just finished.
  assert.equal(drawClickAction(3, still, still), 'commit');
  // The click at the end of an orbit drag does neither (spec §5.2's threshold).
  const dragged = { x: 140, y: 100 };
  assert.equal(drawClickAction(1, still, dragged), 'ignore');
  assert.equal(drawClickAction(2, still, dragged), 'ignore');
});

// --- the committed polyline's vertex rules (§6.1, §6.2) ---------------------

test('a polyline always has one vertex selected, and it defaults to the last', () => {
  // Unset, out of range, and negative all resolve to the last vertex, which is
  // the end a freshly drawn polyline was left at (§6.1).
  assert.equal(effectiveVertex(4, null), 3);
  assert.equal(effectiveVertex(4, 9), 3);
  assert.equal(effectiveVertex(4, -1), 3);
  assert.equal(effectiveVertex(4, 1), 1, 'a valid sub-selection is kept');
  assert.equal(effectiveVertex(0, null), null, 'nothing to select in an empty set');
});

test('deleting a vertex needs no follow-up write — the clamp is the rule', () => {
  // Delete v2 of 4: the held index now names the vertex that took its place.
  assert.equal(effectiveVertex(3, 1), 1);
  // Delete the last of 4: the held index is past the end, so it lands on the
  // new last vertex (§6.2's delete row).
  assert.equal(effectiveVertex(3, 3), 2);
});

test('Insert splits toward the next vertex, and is unavailable on the last', () => {
  const points: Vec3[] = [at(0), at(2), at(6)];
  assert.deepEqual(insertMidpoint(points, 0), { at: 1, position: [1, 2, 0] });
  assert.deepEqual(insertMidpoint(points, 1), { at: 2, position: [4, 2, 0] });
  // The last vertex has no next one — that is Extend's job, and null is what
  // disables the button rather than it quietly meaning something else.
  assert.equal(insertMidpoint(points, 2), null);
  assert.equal(insertMidpoint(points, 7), null);
});

test('Extend grows the start from vertex 1 and the end from any other', () => {
  assert.equal(extendEnd(0), 'start');
  assert.equal(extendEnd(1), 'end');
  assert.equal(extendEnd(5), 'end');
});

test("an Extend click's index is also the new vertex's own index", () => {
  // Which is what makes selecting it the whole rule: a run of clicks keeps
  // growing the same end (§6.2).
  assert.equal(extendInsertAt('start', 4), 0);
  assert.equal(extendInsertAt('end', 4), 4);
  // Growing the start keeps naming vertex 1, so the next click prepends again.
  assert.equal(extendEnd(extendInsertAt('start', 5)), 'start');
  // Growing the end names the new last vertex, so the next click appends again.
  assert.equal(extendEnd(extendInsertAt('end', 5)), 'end');
});

// --- the draft's segments, built as geometry (§6.2) ------------------------

test('the draft draws one endpoint pair per segment', () => {
  // Explicit pairs, and a buffer sized to exactly them: a `LineDashedMaterial`
  // draft was invisible under this app's WebGPU backend, and so was a dashed one
  // written into an over-allocated buffer trimmed by `setDrawRange`. Nothing was
  // wrong with the data either time, so the count is what has to be right.
  const pairs = segmentPairs([at(0), at(4), at(10)]);
  assert.deepEqual(pairs, [at(0), at(4), at(4), at(10)], 'two segments, sharing their joint');
  assert.equal(pairs.length, 2 * 2);
});

test('the pairs are copies, so a later edit cannot rewrite a drawn segment', () => {
  const scratch: Vec3 = [9, 9, 9];
  const pairs = segmentPairs([scratch, at(0)]);
  scratch[0] = 0;
  assert.equal(pairs[0][0], 9);
});

test('a zero-length segment contributes nothing', () => {
  // A click landing exactly on the previous vertex, or a cursor that has not
  // moved off it, would otherwise emit a segment of length zero.
  assert.deepEqual(segmentPairs([at(3), at(3)]), []);
  assert.deepEqual(segmentPairs([at(0)]), [], 'one vertex is not a segment');
  assert.deepEqual(segmentPairs([]), []);
  // The live segments around a degenerate one still draw.
  assert.deepEqual(segmentPairs([at(0), at(0), at(5)]), [at(0), at(5)]);
});
