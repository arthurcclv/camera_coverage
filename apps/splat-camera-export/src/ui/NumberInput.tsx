/**
 * A numeric text field with parse → clamp → revert-on-invalid discipline
 * (spec §7.2), mirroring the coverage app's field behavior.
 *
 * The field keeps its own draft string while focused and only commits on blur or
 * Enter, so typing an intermediate value like `-` or `1.` is not punished.
 */
import { useEffect, useState } from 'react';

export interface NumberInputProps {
  label?: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  /** Decimals shown when not focused. */
  digits?: number;
  step?: number;
  disabled?: boolean;
  title?: string;
}

/** Formats for display: trims trailing zeros so `1.00` reads as `1`. */
function display(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

export function NumberInput({
  label,
  value,
  onCommit,
  min,
  max,
  digits = 3,
  step,
  disabled,
  title,
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  // An external change (preset, reset, import) must be reflected while unfocused.
  useEffect(() => {
    setDraft(null);
  }, [value]);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.trim());
    // Unparseable or out-of-range reverts rather than committing garbage (§7.2).
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(null);
      return;
    }
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(null);
    if (next !== value) onCommit(next);
  };

  return (
    <label className="field" title={title}>
      {label !== undefined && <span className="field-label">{label}</span>}
      <input
        type="text"
        inputMode="decimal"
        className="field-input"
        disabled={disabled}
        step={step}
        value={draft ?? display(value, digits)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(display(value, digits))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
