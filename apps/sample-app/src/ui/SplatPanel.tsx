/**
 * Selected-splat editor (`gaussian_splats.md` §7): the display name, the
 * read-only source plus its load state, and the **registration** — the position
 * / rotation / uniform scale that takes a capture's arbitrary reconstructed
 * frame into the room's metric Y-up frame. Plus the two presets: **Flip 180° Z**
 * and **Reset transform**.
 *
 * No edit here marks the coverage result stale (§1.1) — the one detail panel in
 * the app for which that is true of *every* field.
 *
 * **Scale is one number, not a `Vec3Field`.** A Gaussian's shape is a
 * covariance, so a per-axis scale shears every Gaussian in the capture into
 * visible smears (§2.1) — which is also why the viewport's Scale gizmo mode
 * stays volume-only and a splat keeps Move/Rotate (`spec.md` §2.4).
 *
 * **Source is not editable.** A splat's file is settled when it is added;
 * re-pointing a row at a different capture is Delete + Add, which is also what
 * keeps the decode cache's refcount honest (§3.3).
 */
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import {
  isFlippedZ,
  splatBadge,
  splatLabel,
  type SplatLoadState,
  type SplatObject,
} from '../scene/splats.ts';
import { NumberInput } from './NumberInput.tsx';
import { Vec3Field } from './Vec3Field.tsx';

export interface SplatPanelProps {
  splat: SplatObject | null;
  /** This row's load state (§6.2), or undefined before the layer has reported. */
  loadState: SplatLoadState | undefined;
  onRename(id: string, name: string): void;
  onChange(id: string, patch: Partial<SplatObject>): void;
  onPreset(id: string, preset: 'reset' | 'flipZ'): void;
}

/** Smallest registration scale the field accepts — a scale of 0 collapses the capture. */
const MIN_SPLAT_SCALE = 1e-3;

export function SplatPanel({ splat, loadState, onRename, onChange, onPreset }: SplatPanelProps) {
  if (!splat) return null;

  const euler = quatToEuler(splat.rotation);
  const badge = splatBadge(loadState);
  const failed = loadState?.status === 'error';
  const flipped = isFlippedZ(splat.rotation);

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const p = [...splat.position] as SplatObject['position'];
    p[axis] = v;
    onChange(splat.id, { position: p });
  };
  const setEuler = (patch: Partial<ReturnType<typeof quatToEuler>>) =>
    onChange(splat.id, { rotation: eulerToQuat({ ...euler, ...patch }) });

  return (
    <div className="panel">
      <p className="panel-title">
        Splat — {splatLabel(splat)}
        {badge && <span className={failed ? 'badge splat-error' : 'badge splat'}>{badge}</span>}
      </p>

      <div className="panel-body">
        <div className="row">
          <label htmlFor="splat-name">Name</label>
          <input
            id="splat-name"
            className="text-input"
            type="text"
            value={splat.name}
            // Blank falls back to the capture's filename, not `Splat N` (§2.3).
            placeholder={splatLabel({ name: '', src: splat.src })}
            onChange={(e) => onRename(splat.id, e.target.value)}
          />
        </div>

        {/* The file this row points at, read-only (§7). Hover gives the full
            path, since a nested `src` outruns the row. */}
        <div className="row">
          <label>Source</label>
          <span className="splat-source" title={splat.src}>
            {splat.src}
          </span>
        </div>

        <p className="hint">Registration</p>

        <Vec3Field
          label="Position"
          digits={2}
          columns={[
            { label: 'X', value: splat.position[0], onCommit: (v) => setPosition(0, v) },
            { label: 'Y', value: splat.position[1], onCommit: (v) => setPosition(1, v) },
            { label: 'Z', value: splat.position[2], onCommit: (v) => setPosition(2, v) },
          ]}
        />

        {/* Euler degrees over the stored quaternion, through the app's own
            shared pair (`cameras/math.ts`) rather than a hand-rolled one — the
            same reasoning `apps/splat-camera-export`'s `alignment.ts` records
            for delegating to PlayCanvas: a mismatched convention round-trips
            180° about X to 0°. Columns are axis-correct: X=pitch, Y=yaw, Z=roll.

            X is bounded to **±90°**, and that is the convention's own range
            rather than a restriction: `YXZ` puts X in the middle, so its
            decomposition is an `asin` and every rotation in SO(3) is reachable
            with |X| ≤ 90 — a typed 120° would simply read back as something
            else. ±90 is also exactly the canonical registration a Z-up capture
            needs to stand up in the Y-up scene, which is why the bound is 90
            and not the camera panel's 89 (§7). */}
        <Vec3Field
          label="Rotation"
          digits={2}
          columns={[
            { label: 'X', value: euler.pitch, min: -90, max: 90, onCommit: (v) => setEuler({ pitch: v }) },
            { label: 'Y', value: euler.yaw, onCommit: (v) => setEuler({ yaw: v }) },
            { label: 'Z', value: euler.roll, onCommit: (v) => setEuler({ roll: v }) },
          ]}
        />

        {/* One uniform number in an ungrouped field — deliberately *not* a
            grouped vector field (`spec.md` §5.2.1, §2.1). */}
        <div className="row">
          <label htmlFor="splat-scale">Scale</label>
          <NumberInput
            value={splat.scale}
            min={MIN_SPLAT_SCALE}
            digits={3}
            seed="full"
            ariaLabel="Splat scale"
            onCommit={(v) => onChange(splat.id, { scale: v })}
          />
        </div>

        <div className="row button-row">
          {/* The standard correction for a capture whose reconstructed frame is
              Z-down relative to the metric Y-up scene; ported from
              `alignment.ts`'s preset of the same name so the two apps agree.
              It *replaces* the rotation, so pressing it twice is idempotent. */}
          <button
            type="button"
            className={`btn secondary${flipped ? ' active' : ''}`}
            aria-pressed={flipped}
            title="Rotate the capture 180° about Z — the usual fix for a Z-down reconstruction"
            onClick={() => onPreset(splat.id, 'flipZ')}
          >
            Flip 180° Z
          </button>
          <button
            type="button"
            className="btn secondary"
            title="Back to position [0,0,0], no rotation, scale 1"
            onClick={() => onPreset(splat.id, 'reset')}
          >
            Reset transform
          </button>
        </div>
      </div>
    </div>
  );
}
