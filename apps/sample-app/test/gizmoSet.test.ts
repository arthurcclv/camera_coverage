import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PickableGizmoSet } from '../src/scene/gizmoSet.ts';

interface Entry {
  obj: THREE.Mesh;
}
interface Item {
  id: string;
  x: number;
}

/**
 * A minimal concrete set exercising the shared spine directly, decoupled from any
 * real gizmo: one unit-cube body per item, positioned at `item.x`, both the attach
 * and pick target. Counters expose how often the base created/disposed entries.
 */
class TestSet extends PickableGizmoSet<Entry> {
  created = 0;
  disposed = 0;

  sync(items: Item[]): void {
    this.reconcile(items, (entry, item) => {
      entry.obj.position.x = item.x;
    });
  }

  size(): number {
    return this.entries.size;
  }

  protected createEntry(id: string): Entry {
    this.created++;
    const obj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    obj.name = id;
    this.group.add(obj);
    return { obj };
  }

  protected disposeEntry(entry: Entry): void {
    this.disposed++;
    this.group.remove(entry.obj);
    entry.obj.geometry.dispose();
    (entry.obj.material as THREE.Material).dispose();
  }

  protected attachTargetOf(entry: Entry): THREE.Object3D {
    return entry.obj;
  }

  protected pickTargetOf(entry: Entry): THREE.Object3D {
    return entry.obj;
  }
}

test('reconcile creates on first sight, updates in place, sweeps removed ids', () => {
  const s = new TestSet();

  s.sync([{ id: 'a', x: 1 }, { id: 'b', x: 2 }]);
  assert.equal(s.size(), 2);
  assert.equal(s.created, 2);
  const aTarget = s.getAttachTarget('a')!;
  assert.equal(aTarget.position.x, 1);

  // Same ids again: no new entries, existing objects mutated in place.
  s.sync([{ id: 'a', x: 5 }, { id: 'b', x: 2 }]);
  assert.equal(s.created, 2, 'no re-creation for already-present ids');
  assert.equal(s.getAttachTarget('a'), aTarget, 'entry object is reused, not rebuilt');
  assert.equal(aTarget.position.x, 5);

  // Drop 'b': it is disposed and gone.
  s.sync([{ id: 'a', x: 5 }]);
  assert.equal(s.size(), 1);
  assert.equal(s.disposed, 1);
  assert.equal(s.getAttachTarget('b'), undefined);
});

test('getAttachTarget returns the entry target, undefined for unknown ids', () => {
  const s = new TestSet();
  s.sync([{ id: 'a', x: 0 }]);
  assert.ok(s.getAttachTarget('a') instanceof THREE.Object3D);
  assert.equal(s.getAttachTarget('missing'), undefined);
});

test('dispose tears down every entry and clears the group', () => {
  const s = new TestSet();
  s.sync([{ id: 'a', x: 0 }, { id: 'b', x: 0 }]);
  assert.equal(s.group.children.length, 2);

  s.dispose();
  assert.equal(s.size(), 0);
  assert.equal(s.disposed, 2);
  assert.equal(s.group.children.length, 0);
});

test('pickHit returns the nearest hit and null on a miss (spec §5.2)', () => {
  const s = new TestSet();
  s.sync([{ id: 'far', x: 5 }, { id: 'near', x: 1 }]);
  s.group.updateMatrixWorld(true);

  // Ray along +X through both unit cubes: it enters the x=1 box before the x=5 one.
  const through = new THREE.Raycaster(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(1, 0, 0));
  assert.equal(s.pickHit(through)?.id, 'near');

  // Ray well above both boxes hits nothing.
  const above = new THREE.Raycaster(new THREE.Vector3(-10, 50, 0), new THREE.Vector3(1, 0, 0));
  assert.equal(s.pickHit(above), null);
});

// --- Hidden is unpickable (spec §2.4.3) -------------------------------------
//
// Three.js's raycaster does *not* skip invisible objects, so without the guard in
// `pickHit` a hidden gizmo would still swallow the click that was meant for the
// geometry behind it. The two tests below are the two ways a gizmo goes hidden:
// its own flag (a disabled entity) and an ancestor's (a whole layer switched off).

test('pickHit skips an entry hidden by its own flag (spec §2.4.3)', () => {
  const s = new TestSet();
  s.sync([{ id: 'far', x: 5 }, { id: 'near', x: 1 }]);
  s.group.updateMatrixWorld(true);
  const ray = () => new THREE.Raycaster(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(1, 0, 0));

  assert.equal(s.pickHit(ray())?.id, 'near');

  // Hiding the nearer body hands the pick to the one behind it, rather than
  // returning an invisible hit or nothing at all.
  s.group.getObjectByName('near')!.visible = false;
  assert.equal(s.pickHit(ray())?.id, 'far');

  s.group.getObjectByName('far')!.visible = false;
  assert.equal(s.pickHit(ray()), null);
});

test('pickHit skips an entry hidden by an ancestor — the layer toggles (spec §2.4)', () => {
  const s = new TestSet();
  s.sync([{ id: 'a', x: 1 }]);
  s.group.updateMatrixWorld(true);
  const ray = () => new THREE.Raycaster(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(1, 0, 0));

  assert.equal(s.pickHit(ray())?.id, 'a');

  // This is exactly what a layer checkbox does — and what lets SceneView drop its
  // own per-layer guard: the body's own `visible` is still true here.
  s.group.visible = false;
  assert.equal(s.group.getObjectByName('a')!.visible, true);
  assert.equal(s.pickHit(ray()), null);

  s.group.visible = true;
  assert.equal(s.pickHit(ray())?.id, 'a');
});
