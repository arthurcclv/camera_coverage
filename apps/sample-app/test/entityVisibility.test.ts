import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawableGroupIds, visibleZoneIds } from '../src/scene/entityVisibility.ts';
import { defaultConstraintGroup } from '../src/placement/region.ts';
import type { ConstraintGroup } from '../src/placement/region.ts';
import type { Zone } from '../src/scene/samplingVolumes.ts';

function group(id: string, enabled: boolean, zoneIds: string[] = []): ConstraintGroup {
  return { ...defaultConstraintGroup(id), enabled, zoneIds };
}

function zone(id: string, enabled: boolean): Zone {
  return { id, name: id, enabled };
}

test('drawableGroupIds: the enabled groups, plus the one placement mode is open on (§2.4.3)', () => {
  const groups = [group('cg-1', true), group('cg-2', false), group('cg-3', false)];

  assert.deepEqual([...drawableGroupIds(groups, null)], ['cg-1']);
  // Nothing stops the mode being entered on a disabled group, and its constraints
  // must stay drawn or Build scatters a pool over rails that are not there (§5.1).
  assert.deepEqual([...drawableGroupIds(groups, 'cg-2')].sort(), ['cg-1', 'cg-2']);
  // An enabled group that is *also* the open one is not counted twice.
  assert.deepEqual([...drawableGroupIds(groups, 'cg-1')], ['cg-1']);
});

test('visibleZoneIds: the enabled zones union every drawable group\'s targets (§2.4.3)', () => {
  const zones = [zone('zone-1', true), zone('zone-2', false), zone('zone-3', false)];
  const groups = [group('cg-1', true, ['zone-2']), group('cg-2', false, ['zone-3'])];
  const drawable = drawableGroupIds(groups, null);

  const visible = visibleZoneIds(zones, groups, drawable);
  // zone-2 is globally disabled yet targeted by an enabled group: it is the region
  // that group's pool is built into, so its box has to stay on screen (§3.1.2).
  assert.deepEqual([...visible].sort(), ['zone-1', 'zone-2']);
  // zone-3's group is disabled, so its target does not rescue it.
  assert.equal(visible.has('zone-3'), false);
});

test('visibleZoneIds: a disabled group in placement mode does rescue its targets', () => {
  const zones = [zone('zone-1', false)];
  const groups = [group('cg-1', false, ['zone-1'])];

  assert.equal(visibleZoneIds(zones, groups, drawableGroupIds(groups, null)).has('zone-1'), false);
  assert.equal(visibleZoneIds(zones, groups, drawableGroupIds(groups, 'cg-1')).has('zone-1'), true);
});

test('visibleZoneIds: no groups is just the enabled zones', () => {
  const zones = [zone('zone-1', true), zone('zone-2', false)];
  assert.deepEqual([...visibleZoneIds(zones, [], new Set())], ['zone-1']);
});
