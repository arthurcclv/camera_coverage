export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits?: number;
  disabled?: boolean;
  onChange(value: number): void;
}

export function Slider({ label, value, min, max, step, digits = 2, disabled, onChange }: SliderProps) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="value-chip">{value.toFixed(digits)}</span>
    </div>
  );
}
