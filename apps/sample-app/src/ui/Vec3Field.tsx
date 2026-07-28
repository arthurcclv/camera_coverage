/**
 * Grouped numeric vector editor (spec §5.2.1): a group label (Position / Rotation
 * / Size) followed by three numeric text fields carrying dim axis letters. Each
 * field commits on blur or Enter, reverts on Escape, and — while focused — holds
 * the raw typed string rather than the re-derived prop, so a concurrent gizmo drag
 * or an Euler round-trip never stomps the caret. The parse/clamp/revert decision
 * lives in the pure `commitNumberField` helper.
 */
import { useRef, useState } from 'react';
import { resolveFieldCommit } from './numberField.ts';

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
          <NumberInput
            key={i}
            axis={c.label}
            value={c.value}
            min={c.min}
            max={c.max}
            digits={digits}
            onCommit={c.onCommit}
          />
        ))}
      </div>
    </div>
  );
}

interface NumberInputProps {
  axis: string;
  value: number;
  min?: number;
  max?: number;
  digits: number;
  onCommit(value: number): void;
}

function NumberInput({ axis, value, min, max, digits, onCommit }: NumberInputProps) {
  // `draft` is non-null only while focused; then it is the source of truth for the
  // input's text, so incoming `value` prop changes don't overwrite the caret.
  const [draft, setDraft] = useState<string | null>(null);
  // Set by Escape so the ensuing blur reverts instead of committing (the blur
  // fires synchronously inside blur(), before the setDraft(null) re-render).
  const revert = useRef(false);

  const display = draft ?? value.toFixed(digits);

  return (
    <label className="vec-field">
      <span className="vec-axis">{axis}</span>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onFocus={() => setDraft(value.toFixed(digits))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const raw = draft;
          setDraft(null);
          if (revert.current) {
            revert.current = false;
            return;
          }
          if (raw === null) return;
          // resolveFieldCommit compares against the field's displayed value, so an
          // untouched focus/blur, invalid input, or a no-op re-type writes nothing
          // (and never marks the run stale, spec §5.2.1).
          const committed = resolveFieldCommit(raw, value, digits, { min, max });
          if (committed !== null) onCommit(committed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            revert.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
