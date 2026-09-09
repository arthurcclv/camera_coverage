/**
 * Tests for the viewport's fixed light rig (spec §2.3.1).
 *
 * Two layers, because either alone lets a regression through. First the §2.3.1
 * table is asserted exactly — it is a worked example in a spec, and the rig's
 * whole rationale is written about those numbers, so silently editing one is
 * spec drift. Then the *property* the numbers exist for: no direction is left
 * unlit, and the fill still opposes the key. `viewport.ts` itself cannot be
 * exercised here (it needs a real GPU context),
 * which is why the rig is its own pure module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSceneLights, type SceneLights } from '../src/scene/sceneLighting.ts';

/** The panel *surface* token the old rig wrongly reused as a hemisphere ground. */
const UI_PANEL_SURFACE = 0x30323a;

/** Diffuse irradiance a Lambertian surface with normal `n` receives from one directional light. */
function diffuse(light: THREE.DirectionalLight, normal: THREE.Vector3): number {
  // Directional lights point at the origin from their position.
  const toLight = light.position.clone().normalize();
  return Math.max(0, normal.dot(toLight)) * light.intensity;
}

/** Diffuse irradiance a Lambertian surface with normal `n` receives from the whole rig. */
function irradianceAt(n: THREE.Vector3): number {
  const rig = createSceneLights();
  const normal = n.clone().normalize();

  // Keyed on `SceneLights` so a fifth light cannot be added to the rig without
  // this failing to typecheck — a light that silently contributed 0 here would
  // leave the "nothing is unlit" test passing for the wrong reason.
  const contribution: Record<keyof SceneLights, () => number> = {
    hemi: () => {
      // Three's hemisphere term blends sky/ground by the normal's Y, and both
      // colors here are greys, so the luminance is the blend of their levels.
      const t = normal.y * 0.5 + 0.5;
      const sky = rig.hemi.color.r;
      const ground = rig.hemi.groundColor.r;
      return (ground + (sky - ground) * t) * rig.hemi.intensity;
    },
    key: () => diffuse(rig.key, normal),
    fill: () => diffuse(rig.fill, normal),
    ambient: () => rig.ambient.intensity,
  };

  let total = 0;
  for (const term of Object.values(contribution)) total += term();
  return total;
}

test('the rig is exactly the four lights of the §2.3.1 table', () => {
  const { hemi, key, fill, ambient } = createSceneLights();
  assert.equal(Object.keys(createSceneLights()).length, 4);

  assert.ok(hemi instanceof THREE.HemisphereLight);
  assert.equal(hemi.color.getHex(), 0xffffff);
  assert.equal(hemi.groundColor.getHex(), 0x6a6f7a);
  assert.equal(hemi.intensity, 1.1);

  assert.ok(key instanceof THREE.DirectionalLight);
  assert.equal(key.color.getHex(), 0xffffff);
  assert.equal(key.intensity, 1.4);
  assert.deepEqual(key.position.toArray(), [15, 25, 10]);

  assert.ok(fill instanceof THREE.DirectionalLight);
  assert.equal(fill.color.getHex(), 0xffffff);
  assert.equal(fill.intensity, 0.5);
  assert.deepEqual(fill.position.toArray(), [-15, 8, -10]);

  assert.ok(ambient instanceof THREE.AmbientLight);
  assert.equal(ambient.color.getHex(), 0xffffff);
  assert.equal(ambient.intensity, 0.5);
});

test('the hemisphere ground color is bounce light, not the dark UI surface token', () => {
  const { hemi } = createSceneLights();
  // The old rig reused `#30323a` (the panel surface) here, which is what made
  // downward-facing faces read as unlit holes. Compared as a Color rather than
  // against a raw channel threshold, so the assertion says "materially brighter
  // than the dark UI token" in whatever working space three is configured for
  // (the ratio is ~2.2 in sRGB, ~4.9 linear — either way, clear of 2×).
  const panel = new THREE.Color(UI_PANEL_SURFACE);
  assert.notEqual(hemi.groundColor.getHex(), UI_PANEL_SURFACE);
  assert.ok(
    hemi.groundColor.r > panel.r * 2,
    `ground color too dark for bounce light: #${hemi.groundColor.getHexString()}`,
  );
});

test('no surface direction is left unlit', () => {
  // The 6 axis directions plus the 8 diagonals — every face of a box-ish scene,
  // however it is oriented. The old rig bottomed out near 0.25 here; this one
  // bottoms out at ~0.67 straight down, so the 0.6 floor has modest headroom —
  // lowering the ambient or the hemisphere ground is what will trip it.
  const dirs: THREE.Vector3[] = [];
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const) {
    dirs.push(new THREE.Vector3(...axis), new THREE.Vector3(...axis).negate());
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    dirs.push(new THREE.Vector3(x, y, z));
  }

  for (const dir of dirs) {
    const lit = irradianceAt(dir);
    assert.ok(
      lit >= 0.6,
      `direction (${dir.x}, ${dir.y}, ${dir.z}) receives only ${lit.toFixed(3)} — reads as black`,
    );
  }
});

test('the fill light opposes the key, so shading survives the brightness lift', () => {
  const { key, fill } = createSceneLights();

  // Opposite hemisphere: a same-side fill would add brightness without recovering
  // the shaded side, and a bare ambient lift would flatten the geometry instead.
  assert.ok(key.position.dot(fill.position) < 0, 'fill must sit opposite the key');
  assert.ok(fill.intensity < key.intensity, 'fill must not rival the key');

  // Contrast is preserved: the key-facing side stays clearly brighter than the
  // side the fill serves. Without this the scene reads as flat paper.
  const keyFacing = irradianceAt(key.position);
  const fillFacing = irradianceAt(fill.position);
  assert.ok(
    keyFacing > fillFacing * 1.3,
    `too flat: key side ${keyFacing.toFixed(3)} vs fill side ${fillFacing.toFixed(3)}`,
  );
});
