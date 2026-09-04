/**
 * The viewport's fixed light rig (spec §2.3.1).
 *
 * Four lights, no shadow maps, no environment map, no user controls. The goal is
 * legibility rather than realism: the user orbits freely to judge coverage, so a
 * face that renders black cannot be judged at all. The key light establishes
 * form, the fill light sits roughly opposite and below it so surfaces facing away
 * from the key are shaded rather than black, and the hemisphere + ambient pair
 * sets the floor brightness no surface falls below.
 *
 * Kept out of `viewport.ts` so the rig's invariants are testable without a
 * `WebGPURenderer` (which needs a real GPU adapter). Unit-tested in
 * `test/sceneLighting.test.ts`, which asserts the §2.3.1 table exactly.
 */
import * as THREE from 'three';

/**
 * Bounce-light color for downward-facing surfaces — a mid grey, deliberately
 * *not* the near-black `#30323a` of the UI panel palette (`ai/VISUAL_DESIGN.md`).
 * This is light, not chrome: a dark ground color is exactly what makes
 * downward-facing faces read as unlit holes.
 */
const HEMI_GROUND = 0x6a6f7a;

/** Sky/ground bounce — the widest, softest term. */
const HEMI_INTENSITY = 1.1;

/** The key light: brightest by a clear margin, so it alone establishes form. */
const KEY_INTENSITY = 1.4;
const KEY_POSITION = [15, 25, 10] as const;

/**
 * The fill light. Roughly opposite the key and lower, so the shaded side keeps
 * its shape instead of flattening the way a bare ambient lift would — this pair
 * of numbers is the balance the whole rig hangs on. Well under `KEY_INTENSITY`:
 * a fill that rivals the key erases the shading it exists to preserve.
 */
const FILL_INTENSITY = 0.5;
const FILL_POSITION = [-15, 8, -10] as const;

/** The brightness floor no surface falls below, whatever its normal. */
const AMBIENT_INTENSITY = 0.5;

/**
 * The rig, addressed by role. A record rather than an array so neither the
 * caller nor the tests depend on the order the lights are added in — the roles
 * are what the spec table and the rationale are written about.
 */
export type SceneLights = {
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
};

export function createSceneLights(): SceneLights {
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  key.position.set(...KEY_POSITION);

  const fill = new THREE.DirectionalLight(0xffffff, FILL_INTENSITY);
  fill.position.set(...FILL_POSITION);

  return {
    hemi: new THREE.HemisphereLight(0xffffff, HEMI_GROUND, HEMI_INTENSITY),
    key,
    fill,
    ambient: new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY),
  };
}
