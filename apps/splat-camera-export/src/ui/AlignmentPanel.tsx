/**
 * The alignment panel (spec §10.4): the §7.2 controls plus `alignment.json`
 * import/export and the persistence indicator.
 */
import { useRef } from 'react';
import type { Quat, Vec3 } from '@linkervision/camera-coverage-sdk';
import {
  eulerToQuat,
  flipZPreset,
  IDENTITY_ALIGNMENT,
  isFlippedZ,
  parseAlignment,
  quatToEuler,
  serializeAlignment,
  type Alignment,
} from '../align/alignment.ts';
import { NumberInput } from './NumberInput.tsx';

export interface AlignmentPanelProps {
  alignment: Alignment;
  onChange: (a: Alignment) => void;
  onFrameSplat: () => void;
  onError: (message: string) => void;
  /** True when this capture's alignment was restored from localStorage (§7.3). */
  restored: boolean;
  disabled: boolean;
}

export function AlignmentPanel({
  alignment,
  onChange,
  onFrameSplat,
  onError,
  restored,
  disabled,
}: AlignmentPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const euler = quatToEuler(alignment.rotation);

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const position = [...alignment.position] as Vec3;
    position[axis] = v;
    onChange({ ...alignment, position });
  };

  const setEuler = (axis: 'x' | 'y' | 'z', v: number) => {
    const next = { ...euler, [axis]: v };
    onChange({ ...alignment, rotation: eulerToQuat(next) as Quat });
  };

  const importAlignment = async (file: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      onError(`${file.name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const result = parseAlignment(parsed);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onChange(result.alignment);
  };

  const exportAlignment = () => {
    const blob = new Blob([serializeAlignment(alignment)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alignment.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Alignment</h2>
      <p className="hint">
        Registers the splat into the scene frame. A capture is reconstructed at an arbitrary
        origin, orientation, and scale, so this must be set before the exports mean anything.
      </p>

      <div className="field-row" role="group" aria-label="Splat position (metres)">
        <NumberInput label="X" value={alignment.position[0]} onCommit={(v) => setPosition(0, v)} disabled={disabled} digits={3} />
        <NumberInput label="Y" value={alignment.position[1]} onCommit={(v) => setPosition(1, v)} disabled={disabled} digits={3} />
        <NumberInput label="Z" value={alignment.position[2]} onCommit={(v) => setPosition(2, v)} disabled={disabled} digits={3} />
      </div>

      <div className="field-row" role="group" aria-label="Splat rotation (degrees)">
        <NumberInput label="Rx" value={euler.x} onCommit={(v) => setEuler('x', v)} disabled={disabled} digits={2} />
        <NumberInput label="Ry" value={euler.y} onCommit={(v) => setEuler('y', v)} disabled={disabled} digits={2} />
        <NumberInput label="Rz" value={euler.z} onCommit={(v) => setEuler('z', v)} disabled={disabled} digits={2} />
      </div>

      <div className="field-row">
        <NumberInput
          label="Scale"
          value={alignment.scale}
          onCommit={(v) => onChange({ ...alignment, scale: v })}
          min={1e-6}
          digits={4}
          disabled={disabled}
          title="Uniform scale — a non-uniform scale would shear the Gaussians"
        />
      </div>

      <div className="button-row">
        <button
          type="button"
          className={isFlippedZ(alignment) ? 'btn btn-active' : 'btn'}
          aria-pressed={isFlippedZ(alignment)}
          disabled={disabled}
          onClick={() => onChange(flipZPreset(alignment))}
          title="3DGS captures load Y-down relative to a Y-up viewer; this is the default correction"
        >
          Flip 180° Z
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={() => onChange(IDENTITY_ALIGNMENT)}>
          Reset
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={onFrameSplat}>
          Frame splat
        </button>
      </div>

      <div className="button-row">
        <button type="button" className="btn" disabled={disabled} onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={exportAlignment}>
          Export
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importAlignment(file);
            e.target.value = '';
          }}
        />
      </div>

      {restored && <p className="hint">Restored this capture's saved alignment.</p>}
    </section>
  );
}
