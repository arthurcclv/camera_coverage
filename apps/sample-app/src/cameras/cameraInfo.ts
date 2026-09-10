/**
 * The camera info sidecar file (spec §15) — everything about it that is a
 * *decision* rather than a ray cast.
 *
 * The cast itself does not live here: it runs in a worker, over the merged
 * collision `SceneMesh` (`./centerRay.ts`, spec §15.3) — never against the
 * Three.js scene graph — which is why this module takes the hits as an argument. What is left is the whole of §15.2 — which label a camera
 * carries, the Euler conversion, the rounding, `null` for a miss, the ordering,
 * the double encoding, the filename — and it is pure, so that is where the tests
 * are (`ai/CONVENTIONS.md`, `test/cameraInfo.test.ts`).
 *
 * **The format is externally owned.** `info` is a JSON document inside a JSON
 * string, deliberately (§15.2), and `rot` is `[x, y, z]` degrees in rotation
 * order **`XYZ`** — *not* the yaw/pitch/roll `YXZ` the camera panel edits
 * (`./math.ts`). Both are correct for their consumer and neither may be changed
 * to match the other. Do not "tidy" either.
 */
import { Euler, Quaternion } from 'three';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';

import { describeError } from '../errorText.ts';
import { cameraLabel, type SceneCamera } from './camera.ts';

/** One row of the exported array (spec §15.2). */
export interface CameraInfoEntry {
  /** The camera's hierarchy label — deliberately not made unique (§15.2). */
  name: string;
  /** A compact JSON object as a **string**: `{"pos":…,"rot":…,"hit":…}` (§15.2). */
  info: string;
}

/** Decimals every exported number is rounded to (spec §15.2). */
const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;
const RAD2DEG = 180 / Math.PI;

/**
 * Round to 6 decimals (spec §15.2), which is what suppresses the float noise a
 * dragged gizmo or a quaternion→Euler conversion leaves behind
 * (`-3.4000000000000004`, `29.999999999999996`) in a string a human reads.
 *
 * `+ 0` normalizes a rounded-away negative to `0`: `Math.round` yields `-0` for a
 * tiny negative, and while `JSON.stringify(-0)` already writes `0`, the value is
 * also compared in tests and `-0 !== 0` reads as a failure nobody wants to debug.
 */
function round(n: number): number {
  return Math.round(n * SCALE) / SCALE + 0;
}

function roundVec(v: Vec3): [number, number, number] {
  return [round(v[0]), round(v[1]), round(v[2])];
}

/**
 * The camera's orientation as the export states it: Euler **`[x, y, z]` in
 * degrees, rotation order `XYZ`** (spec §15.2).
 *
 * Independent of `quatToEuler` in `./math.ts`, which answers the same question in
 * the panel's yaw/pitch/roll `YXZ` — so for a camera with both pitch and roll the
 * two return different triples for one quaternion. That is intended: this one
 * serves an external contract, that one serves the UI.
 */
export function exportEuler(rotation: Quat): [number, number, number] {
  const e = new Euler().setFromQuaternion(
    new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
    'XYZ',
  );
  return [round(e.x * RAD2DEG), round(e.y * RAD2DEG), round(e.z * RAD2DEG)];
}

/**
 * Build the file's rows from the cameras and their center-ray hits (spec §15.2).
 *
 * `hits` is **parallel to `cameras`** — one entry each, `null` for a ray that hit
 * nothing (§15.3). A shorter array (or an absent entry) reads as a miss rather
 * than throwing: a hit is derived data, and a missing one is exactly the "nothing
 * there" `null` already means.
 */
export function buildCameraInfo(
  cameras: readonly SceneCamera[],
  hits: readonly (Vec3 | null)[],
): CameraInfoEntry[] {
  return cameras.map((camera, i) => {
    const hit = hits[i] ?? null;
    // Key order is `pos`, `rot`, `hit` — insertion order, which `JSON.stringify`
    // preserves, and part of the external shape (§15.2).
    const info = {
      pos: roundVec(camera.position),
      rot: exportEuler(camera.rotation),
      hit: hit === null ? null : roundVec(hit),
    };
    return { name: cameraLabel(camera), info: JSON.stringify(info) };
  });
}

/**
 * The file's bytes: the rows as a 2-space-indented JSON array (spec §15.2), the
 * same shape §14.5 writes `scene.json` with. The nested `info` stays compact —
 * it is a string, so the indent never reaches inside it.
 */
export function cameraInfoJson(entries: readonly CameraInfoEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/**
 * The download's filename (spec §15.2): `<scene>-cameras.json`, from the save
 * target's filename minus its `.json` — the filename **is** the scene's name
 * (§14.2), so the export is traceable to the layout it describes.
 *
 * With **no save target** — the boot scene (§14.1) — it is `cameras.json`. No
 * timestamp: while iterating, a re-export should shadow the previous one.
 */
export function cameraInfoFileName(sceneFileName: string | null): string {
  const base = (sceneFileName ?? '').trim().replace(/\.json$/i, '');
  return base.length > 0 ? `${base}-cameras.json` : 'cameras.json';
}

/**
 * The one line a failed export prints into the Scene panel's error banner
 * (spec §15.3, §14.7).
 *
 * Every way the cast can fail says the same thing to the person who clicked —
 * a worker that never starts, a mesh that will not clone, a worker that throws
 * mid-cast — because all three have the same consequence: **no file was
 * written**, which is the fact worth stating. The fallback covers the case the
 * platform hands over nothing to quote: `ErrorEvent.message` is routinely `''`
 * for a worker that failed to load, and a banner reading `Couldn't cast the
 * camera rays:` with nothing after the colon looks like a bug in the banner.
 */
export function cameraInfoErrorText(reason: unknown): string {
  const detail = reason == null ? '' : describeError(reason).trim();
  return `Couldn't cast the camera rays: ${detail || 'the export worker failed'}`;
}
