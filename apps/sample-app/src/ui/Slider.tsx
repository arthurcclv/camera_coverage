/**
 * A labeled range slider whose value readout is an **editable numeric text field**
 * (spec §5.2.1): the slider thumb and the field are two views of one value. The
 * field commits the exact typed value clamped to [min, max] (finer than the slider
 * step) on blur or Enter; `integer` sliders (octree levels) round to a whole number.
 * The field behavior lives in the shared `NumberInput`.
 *
 * `title` is for a label whose *unit* needs spelling out — `Knee (pp)`
 * (`camera_placement.md` §5.2) is the case it was added for. It rides on the
 * label and on the field's `aria-label`, so the explanation reaches a hover and
 * a screen reader by the same string.
 */
import { useId } from 'react';
import { NumberInput } from './NumberInput.tsx';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  disabled?: boolean;
  /** Round the editable value to the nearest integer (octree-level sliders, §5.2.1). */
  integer?: boolean;
  /** CSS background for the track (e.g. a rainbow gradient); renders as a spectrum bar. */
  gradient?: string;
  /** Hover text spelling the field out, and the field's `aria-label` when given. */
  title?: string;
  onChange(value: number): void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  digits = 2,
  disabled,
  integer,
  gradient,
  title,
  onChange,
}: SliderProps) {
  const id = useId();
  return (
    <div className="row">
      <label htmlFor={id} title={title}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        className={gradient ? 'spectrum' : undefined}
        style={gradient ? { background: gradient } : undefined}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumberInput
        className="slider-value"
        ariaLabel={title ?? label}
        value={value}
        min={min}
        max={max}
        digits={digits}
        seed="full"
        integer={integer}
        disabled={disabled}
        onCommit={onChange}
      />
    </div>
  );
}
