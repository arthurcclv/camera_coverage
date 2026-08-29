/**
 * Probe model + the shape of a visibility answer (spec §12.1, §12.2).
 *
 * A probe is a user-placed point; its visibility is read from the **most recent
 * completed `compute()` run's per-voxel camera masks** — not a fresh ray cast
 * (the SDK exposes no arbitrary-point query).
 *
 * The lookup itself is **not** here: probes are the `probes` primitive of the
 * run's aggregation descriptor (spec §3.3, §12.2), resolved in the worker beside
 * the masks and returned as a few hundred bytes. `CoverageRun` decodes them
 * against the run's snapshotted camera list; this module owns the entity and the
 * result type both sides agree on.
 */
import type { Vec3 } from '@linkervision/camera-coverage-sdk';

/** A user-placed point in the scene (spec §12.1). */
export interface Probe {
  id: string;
  position: Vec3;
  /** User-editable display label (§12.1, §5.6); blank → falls back to `Probe N`. */
  name: string;
}

/** The default `Probe N` label derived from a `probe-N` id (§5.6). */
export function defaultProbeName(id: string): string {
  const m = /^probe-(\d+)$/.exec(id);
  return m ? `Probe ${m[1]}` : id;
}

/**
 * The label to display for a probe (§5.6): the trimmed `name`, or the default
 * `Probe N` when blank/all-whitespace. Never returns an empty string.
 */
export function probeLabel(probe: Probe): string {
  const trimmed = probe.name.trim();
  return trimmed.length > 0 ? trimmed : defaultProbeName(probe.id);
}

/** Visibility of a probe against the retained run's enabled cameras (spec §12.3). */
export interface ProbeVisibilityOk {
  status: 'ok';
  /** Enabled-camera ids in mask-bit order (bit n ⇒ cameraIds[n]). */
  cameraIds: string[];
  /** Parallel to `cameraIds`: whether that camera sees the probe. */
  visible: boolean[];
  /** popcount of the mask — enabled cameras that see the probe. */
  seenCount: number;
}

/**
 * Query outcome. `no-data` covers an invalid voxel, a point outside the workspace,
 * or no retained chunk covering it — never rendered as "0 of N" (spec §12.3). The
 * "no run yet" state is the caller's concern (there is simply no retained data).
 */
export type ProbeVisibilityResult = { status: 'no-data' } | ProbeVisibilityOk;
