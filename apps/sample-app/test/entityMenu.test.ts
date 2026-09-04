import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteHandlers,
  duplicateHandlers,
  type DeletableKind,
  type EntityMenuHandlers,
} from '../src/ui/entityMenu.ts';

const KINDS: DeletableKind[] = ['camera', 'probe', 'section', 'zone', 'volume', 'constraintGroup', 'constraint'];

/** A handler bundle that records which callback fired, and with what id. */
function spies() {
  const calls: string[] = [];
  const spy = (name: string) => (id: string) => calls.push(`${name}:${id}`);
  const handlers: EntityMenuHandlers = {
    onDeleteCamera: spy('deleteCamera'),
    onDeleteProbe: spy('deleteProbe'),
    onDeleteSection: spy('deleteSection'),
    onDeleteZone: spy('deleteZone'),
    onDeleteVolume: spy('deleteVolume'),
    onDeleteConstraintGroup: spy('deleteConstraintGroup'),
    onDeleteConstraint: spy('deleteConstraint'),
    onDuplicateCamera: spy('duplicateCamera'),
    onDuplicateProbe: spy('duplicateProbe'),
    onDuplicateSection: spy('duplicateSection'),
    onDuplicateZone: spy('duplicateZone'),
    onDuplicateVolume: spy('duplicateVolume'),
    onDuplicateConstraintGroup: spy('duplicateConstraintGroup'),
    onDuplicateConstraint: spy('duplicateConstraint'),
  };
  return { handlers, calls };
}

test('deleteHandlers: a constraint reaches its own handler (`camera_placement.md` §7)', () => {
  // The bug: the menu's if/else chain ended in a bare `else` that assumed `volume`,
  // so Delete on a constraint called `onDeleteVolume('con-1')` — which filtered the
  // volume array for an id no volume had, and removed nothing. Silently.
  const { handlers, calls } = spies();
  deleteHandlers(handlers).constraint('con-1');
  assert.deepEqual(calls, ['deleteConstraint:con-1']);
});

test('deleteHandlers: a constraint group reaches its own handler (`camera_placement.md` §7)', () => {
  const { handlers, calls } = spies();
  deleteHandlers(handlers).constraintGroup('cg-1');
  assert.deepEqual(calls, ['deleteConstraintGroup:cg-1']);
});

test('deleteHandlers: every kind routes to exactly one handler, and it is its own', () => {
  // The regression net. `Record<DeletableKind, …>` makes a missing branch a compile
  // error; this makes a *wrong* branch a test failure.
  for (const kind of KINDS) {
    const { handlers, calls } = spies();
    deleteHandlers(handlers)[kind](`${kind}-1`);
    assert.deepEqual(calls, [`delete${kind[0].toUpperCase()}${kind.slice(1)}:${kind}-1`]);
  }
});

test('duplicateHandlers: every kind routes to exactly one handler, and it is its own', () => {
  // Duplicate carried the identical fallthrough, so it swallowed the same two kinds.
  for (const kind of KINDS) {
    const { handlers, calls } = spies();
    duplicateHandlers(handlers)[kind](`${kind}-1`);
    assert.deepEqual(calls, [`duplicate${kind[0].toUpperCase()}${kind.slice(1)}:${kind}-1`]);
  }
});
