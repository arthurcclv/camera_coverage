/**
 * Grouped numeric vector editor (spec §5.2.1): a group label (Position / Rotation
 * / Size) followed by three numeric text fields carrying dim axis letters. Each
 * field is a shared `NumberInput` seeded with the rounded display value (`seed:
 * 'display'`) — commits on blur or Enter, reverts on Escape, and while focused holds
 * the raw typed string so a concurrent gizmo drag or Euler round-trip never stomps
 * the caret. The commit/revert logic and the parse/clamp decision live in
 * `NumberInput` / `numberField.ts`.
 */
import { NumberInput } from './NumberInput.tsx';

export interface Vec3Column {
  /** Axis letter shown before the field (typically 'X' | 'Y' | 'Z'). */
  label: string;
  /** Live value from the scene (source of truth when the field is unfocused). */
  value: number;
  /** Lower clamp — omit to leave unbounded (free position/yaw/roll). */
  min?: number;
  /** Upper clamp — omit to leave unbounded. */
  max?: number;
  onCommit(value: number): void;
}

export interface Vec3FieldProps {
  /** Group label, e.g. "Position". */
  label: string;
  /** Unfocused display precision (decimals); matches the former sliders. */
  digits?: number;
  columns: [Vec3Column, Vec3Column, Vec3Column];
}

export function Vec3Field({ label, digits = 2, columns }: Vec3FieldProps) {
  return (
    <div className="row">
      <label className="vec-group-label">{label}</label>
      <div className="vec-fields">
        {columns.map((c, i) => (
          <label key={i} className="vec-field">
            <span className="vec-axis">{c.label}</span>
            <NumberInput
              value={c.value}
              min={c.min}
              max={c.max}
              digits={digits}
              seed="display"
              onCommit={c.onCommit}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
