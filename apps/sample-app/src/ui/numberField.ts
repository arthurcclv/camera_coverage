/**
 * The pure parse → clamp → revert decision behind every numeric text field
 * (spec §5.2.1). Kept React-independent so it can be unit-tested directly; the
 * `Vec3Field` component and the panels are thin wrappers over it.
 */

export interface NumberFieldBounds {
  /** Lower clamp — omit to leave the value unbounded below (free position/yaw/roll). */
  min?: number;
  /** Upper clamp — omit to leave the value unbounded above. */
  max?: number;
  /** Last committed (already-valid) value, returned verbatim on invalid input. */
  fallback: number;
}

/**
 * Resolve a raw field string to the number to commit:
 * - empty / whitespace-only / non-finite input reverts to `fallback` (never NaN);
 * - a finite value is clamped to any provided `min`/`max` (clamp meaningful,
 *   free the rest — arbitrary bounds are simply omitted by the caller).
 */
export function commitNumberField(raw: string, { min, max, fallback }: NumberFieldBounds): number {
  const trimmed = raw.trim();
  // Number('') and Number('   ') are 0, not NaN — reject empty explicitly so a
  // blank field reverts rather than committing a spurious 0.
  if (trimmed === '') return fallback;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;

  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

/**
 * Full-precision seed string for a slider value field on focus (spec §5.2.1). A
 * slider value field seeds with the stored value rather than the rounded readout,
 * so re-editing a value that carries precision beyond the display (a typed 42.37 in
 * a 0-decimal FOV field) is lossless. Trimmed to at most 6 decimal places with
 * trailing zeros (and any bare decimal point) removed, which also hides float noise
 * from a viewport drag: 0.30000000000000004 → "0.3", 42.37 → "42.37", 2 → "2".
 * (Grouped vector fields seed the rounded display instead — see `Vec3Field`.)
 */
export function seedFieldValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Decide whether a focused field's raw string should write a new value, and what
 * that value is (spec §5.2.1) — the whole "commit or not" decision, so it can be
 * tested without a DOM harness. Returns `null` when nothing should be written:
 *
 * - the field is **unchanged** — the raw string still equals the current value at
 *   display precision (e.g. focus-then-blur with no edit, where the seeded draft is
 *   the rounded display and `current` carries extra precision from a quat round-trip
 *   or gizmo drag). Comparing against the raw prop here would spuriously commit and
 *   mark the run stale;
 * - the input is **invalid/empty** (reverts to `current`), or
 * - the parsed+clamped result **equals** the current value (no real change, e.g.
 *   typing a value that clamps back to where it already was).
 *
 * Otherwise returns the clamped value to commit.
 */
export function resolveFieldCommit(
  raw: string,
  current: number,
  digits: number,
  bounds: { min?: number; max?: number },
): number | null {
  if (raw === current.toFixed(digits)) return null;
  const committed = commitNumberField(raw, { ...bounds, fallback: current });
  return committed === current ? null : committed;
}
