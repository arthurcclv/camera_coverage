/**
 * The single numeric text input behind both field kinds in the panels (spec
 * §5.2.1): the grouped vector fields (`Vec3Field`) and the editable value readout
 * on every `Slider`. It commits on blur or Enter, reverts on Escape, and — while
 * focused — holds the raw typed string rather than the re-derived prop, so a
 * concurrent gizmo drag, an Euler round-trip, or a slider drag never stomps the
 * caret. The parse/clamp/revert decision lives in the pure `numberField.ts` helpers.
 *
 * The one behavioral axis the two kinds differ on is the focus seed (`seed`):
 * `'display'` seeds the rounded readout (vector fields); `'full'` seeds the full
 * stored value (slider fields), so extra precision is editable rather than lost.
 * `integer` rounds the committed value to a whole number (octree-level sliders).
 */
import { useRef, useState } from 'react';
import { resolveFieldCommit, seedFieldValue } from './numberField.ts';

export interface NumberInputProps {
  /** Live value from the scene (source of truth when the field is unfocused). */
  value: number;
  /** Lower clamp — omit to leave unbounded (free position/yaw/roll). */
  min?: number;
  /** Upper clamp — omit to leave unbounded. */
  max?: number;
  /** Unfocused display precision (decimals). */
  digits: number;
  /** Focus seed: rounded display value vs full stored precision (§5.2.1). */
  seed: 'display' | 'full';
  /** Round the committed value to the nearest integer (integer sliders, §5.2.1). */
  integer?: boolean;
  disabled?: boolean;
  /** Applied to the input element (styling hook; vector fields rely on `.vec-field input`). */
  className?: string;
  /** Accessible name when there is no associated visible <label> (slider value fields). */
  ariaLabel?: string;
  onCommit(value: number): void;
}

export function NumberInput({
  value,
  min,
  max,
  digits,
  seed,
  integer,
  disabled,
  className,
  ariaLabel,
  onCommit,
}: NumberInputProps) {
  // `draft` is non-null only while focused; then it is the source of truth for the
  // input's text, so incoming `value` prop changes don't overwrite the caret.
  const [draft, setDraft] = useState<string | null>(null);
  // Set by Escape so the ensuing blur reverts instead of committing (the blur
  // fires synchronously inside blur(), before the setDraft(null) re-render).
  const revert = useRef(false);

  const display = draft ?? value.toFixed(digits);

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      aria-label={ariaLabel}
      value={display}
      disabled={disabled}
      onFocus={() => setDraft(seed === 'full' ? seedFieldValue(value) : value.toFixed(digits))}
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
        // untouched focus/blur, invalid input, or a no-op re-type writes nothing.
        const committed = resolveFieldCommit(raw, value, digits, { min, max });
        if (committed === null) return;
        // Integer sliders round after clamping; re-check for a no-op so rounding
        // a fractional entry back onto the current level marks nothing stale.
        const final = integer ? Math.round(committed) : committed;
        if (final === value) return;
        onCommit(final);
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
  );
}
