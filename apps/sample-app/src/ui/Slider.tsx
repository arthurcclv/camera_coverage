/**
 * A labeled range slider whose value readout is an **editable numeric text field**
 * (spec §5.2.1): the slider thumb and the field are two views of one value. The
 * field commits the exact typed value clamped to [min, max] (finer than the slider
 * step) on blur or Enter; `integer` sliders (octree levels) round to a whole number.
 * The field behavior lives in the shared `NumberInput`.
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
  onChange(value: number): void;
}

export function Slider({ label, value, min, max, step, digits = 2, disabled, integer, gradient, onChange }: SliderProps) {
  const id = useId();
  return (
    <div className="row">
      <label htmlFor={id}>{label}</label>
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
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <NumberInput
        className="slider-value"
        ariaLabel={label}
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
