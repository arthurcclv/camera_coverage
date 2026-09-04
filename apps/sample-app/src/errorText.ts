/**
 * One error-to-message conversion, shared by the sessions that report failures
 * into the status area (`aim_optimization.md` §10, `camera_placement.md` §10).
 *
 * Both hooks catch `unknown` from an awaited engine call and need the same one
 * line to turn it into something a panel can print; it shipped twice, identical.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
