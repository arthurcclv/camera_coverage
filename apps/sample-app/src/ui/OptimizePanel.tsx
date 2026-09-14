/**
 * The aim optimizer's UI (`aim_optimization.md` §5, §6).
 *
 * Lives in the **right sidebar**, below the sampling-zone tool — this is a tool,
 * not a selection inspector: the whole-scene entry point has no selection, and
 * the per-camera one *reads* the selection rather than editing it (§5).
 *
 * Two surfaces sharing one session: a per-camera preview with a score heatmap,
 * and a whole-scene summary. The heatmap is the visible payoff of §2 — scoring
 * an orientation is a panorama lookup, so an image of 16,200 of them costs one
 * pass over the pyramid and the user can read the whole search space rather than
 * being handed a number.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Quat } from '@linkervision/camera-coverage-sdk';

import { cameraLabel, type SceneCamera } from '../cameras/camera.ts';
import { eulerToQuat, quatToEuler } from '../cameras/math.ts';
import { MAX_PITCH_DEG } from '../cameras/aim.ts';
import type { AimOptimizer } from '../optimize/useAimOptimizer.ts';
import { scoreOrientation } from '../optimize/search.ts';
import { MIN_GAIN } from '../optimize/greedy.ts';
import type { OptimizeComparison, ZoneDelta } from '../optimize/comparison.ts';

/** Heatmap grid — 2° per pixel, drawn at 2× scale (§5). */
const HEAT_W = 180;
const HEAT_H = 90;

export interface OptimizePanelProps {
  optimizer: AimOptimizer;
  /** The selected camera, when the per-camera entry point applies (§5). */
  camera: SceneCamera | null;
  cameras: readonly SceneCamera[];
  /** Preview an orientation without committing it — drives the ghost gizmo. */
  onHover(rotation: Quat | null): void;
  /**
   * Measured per-zone before/after from the run that reconciled the last apply
   * (§6.3), or null before one has landed.
   */
  comparison: OptimizeComparison | null;
}

export function OptimizePanel({ optimizer, camera, cameras, onHover, comparison }: OptimizePanelProps) {
  const { t } = useTranslation(['optimize', 'common']);
  const { panorama, preview, result, running, progress, blocker } = optimizer;
  // A comparison describes a *past* apply, so it is hidden while a new session is
  // open: showing last run's outcome beside this run's proposal invites reading
  // one as the other.
  const showComparison = comparison && !panorama && !result && !running;

  return (
    <div className="panel">
      <p className="panel-title">{t('optimize:optimizePanel.title')}</p>
      <div className="panel-body">
        {blocker && <p className="hint">{blocker}</p>}

        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn"
            disabled={running || !camera || camera.aimLocked === true || !camera.enabled}
            onClick={() => camera && void optimizer.openFor(camera)}
          >
            {camera
              ? t('optimize:optimizePanel.optimizeCameraButton', { name: cameraLabel(camera) })
              : t('optimize:optimizePanel.optimizeAimButton')}
          </button>
          <button className="btn secondary" disabled={running} onClick={() => void optimizer.runAll()}>
            {t('optimize:optimizePanel.optimizeAllButton')}
          </button>
        </div>

        {/* The per-camera button reads the selection, so say why it is disabled
            rather than leaving a dead control (§5). */}
        {!running && !panorama && !result && <p className="hint">{perCameraHint(camera, t)}</p>}

        {running && (
          <p className="hint">
            {progress
              ? t('optimize:optimizePanel.roundProgress', {
                  round: progress.round,
                  index: progress.index + 1,
                  total: progress.total,
                  name: label(cameras, progress.cameraId),
                })
              : t('optimize:optimizePanel.capturingHint')}
            {' '}
            <button className="btn secondary" onClick={optimizer.cancel} style={{ marginLeft: 8 }}>
              {t('common:cancel')}
            </button>
          </p>
        )}

        {panorama && preview && camera && (
          <Preview optimizer={optimizer} camera={camera} onHover={onHover} />
        )}

        {result && <Summary optimizer={optimizer} cameras={cameras} />}

        {showComparison && <Comparison comparison={comparison} />}
      </div>
    </div>
  );
}

/** Why the per-camera button is unavailable, or what it will do. */
function perCameraHint(camera: SceneCamera | null, t: TFunction): string {
  if (!camera) return t('optimize:optimizePanel.selectCameraHint');
  if (!camera.enabled) return t('optimize:optimizePanel.cameraDisabledHint', { name: cameraLabel(camera) });
  if (camera.aimLocked) return t('optimize:optimizePanel.aimLockedHint', { name: cameraLabel(camera) });
  return t('optimize:optimizePanel.optimizeOneHint');
}

function label(cameras: readonly SceneCamera[], id: string): string {
  const c = cameras.find((x) => x.id === id);
  return c ? cameraLabel(c) : id;
}

function Preview({
  optimizer,
  camera,
  onHover,
}: {
  optimizer: AimOptimizer;
  camera: SceneCamera;
  onHover(rotation: Quat | null): void;
}) {
  const { t } = useTranslation(['optimize', 'common']);
  const { panorama, preview, picked } = optimizer;
  const pickedEuler = picked ? quatToEuler(picked) : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ yaw: number; pitch: number; score: number } | null>(null);

  const lens = useMemo(
    () => ({ fov: camera.fov, aspect: camera.aspect ?? 16 / 9, roll: quatToEuler(camera.rotation).roll }),
    [camera.fov, camera.aspect, camera.rotation],
  );

  // One pass over the pyramid per pixel, once per panorama. At 2° this is 16,200
  // scores — well under a frame, and it never repeats while the panorama stands.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !panorama) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scores = new Float64Array(HEAT_W * HEAT_H);
    let max = 0;
    for (let py = 0; py < HEAT_H; py++) {
      const pitch = MAX_PITCH_DEG - (py / (HEAT_H - 1)) * 2 * MAX_PITCH_DEG;
      for (let px = 0; px < HEAT_W; px++) {
        const yaw = -180 + (px / HEAT_W) * 360;
        const s = scoreOrientation(panorama, eulerToQuat({ yaw, pitch, roll: lens.roll }), lens).score;
        scores[py * HEAT_W + px] = s;
        if (s > max) max = s;
      }
    }

    const img = ctx.createImageData(HEAT_W, HEAT_H);
    for (let i = 0; i < scores.length; i++) {
      const frac = max > 0 ? scores[i] / max : 0;
      const [r, g, b] = ramp(frac);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [panorama, lens]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>): { yaw: number; pitch: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const yaw = -180 + ((e.clientX - rect.left) / rect.width) * 360;
    const pitch = MAX_PITCH_DEG - ((e.clientY - rect.top) / rect.height) * 2 * MAX_PITCH_DEG;
    return { yaw, pitch };
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width={HEAT_W}
        height={HEAT_H}
        className="aim-heatmap"
        onMouseMove={(e) => {
          const { yaw, pitch } = pick(e);
          const rotation = eulerToQuat({ yaw, pitch, roll: lens.roll });
          const p = optimizer.scoreAt(rotation);
          setHover({ yaw, pitch, score: p?.current.score ?? 0 });
          onHover(rotation);
        }}
        onMouseLeave={() => {
          setHover(null);
          onHover(null);
        }}
        // Clicking adopts that orientation, so Apply writes what the user chose
        // rather than only what the optimizer proposed (§5.1).
        onClick={(e) => {
          const { yaw, pitch } = pick(e);
          optimizer.pick(eulerToQuat({ yaw, pitch, roll: lens.roll }));
        }}
      />
      <p className="hint">{t('optimize:optimizePanel.yawPitchHint')}</p>

      <dl className="aim-stats">
        <dt>{t('optimize:optimizePanel.currentLabel')}</dt>
        <dd>
          {fmtAngle(preview!.current.yaw)} / {fmtAngle(preview!.current.pitch)} · {preview!.current.score.toFixed(0)}
        </dd>
        <dt>{t('optimize:optimizePanel.proposedLabel')}</dt>
        <dd>
          {fmtAngle(preview!.best.yaw)} / {fmtAngle(preview!.best.pitch)} · {preview!.best.score.toFixed(0)}
          {preview!.moved ? <span className="badge stale" style={{ marginLeft: 8 }}>{fmtGain(preview!.gain, t)}</span> : null}
        </dd>
        {picked && (
          <>
            <dt>{t('optimize:optimizePanel.pickedLabel')}</dt>
            <dd>
              {fmtAngle(pickedEuler!.yaw)} / {fmtAngle(pickedEuler!.pitch)} ·{' '}
              {optimizer.scoreAt(picked)?.current.score.toFixed(0) ?? '—'}
              <button
                className="btn secondary"
                style={{ marginLeft: 8, padding: '1px 6px', fontSize: 11 }}
                onClick={() => optimizer.pick(null)}
              >
                {t('optimize:optimizePanel.clearButton')}
              </button>
            </dd>
          </>
        )}
        {hover && (
          <>
            <dt>{t('optimize:optimizePanel.hoveredLabel')}</dt>
            <dd>
              {fmtAngle(hover.yaw)} / {fmtAngle(hover.pitch)} · {hover.score.toFixed(0)}
            </dd>
          </>
        )}
      </dl>

      {!preview!.moved && !picked && (
        <p className="hint">{t('optimize:optimizePanel.noImprovementHint')}</p>
      )}

      <div className="row" style={{ gap: 8 }}>
        {/* Gated on what Apply actually writes, not on a derived count (§6.2). */}
        <button className="btn" disabled={!optimizer.hasProposals} onClick={optimizer.applyAll}>
          {t('common:apply')}
        </button>
        <button className="btn secondary" onClick={optimizer.discard}>
          {t('optimize:optimizePanel.discardButton')}
        </button>
      </div>
    </>
  );
}

function Summary({ optimizer, cameras }: { optimizer: AimOptimizer; cameras: readonly SceneCamera[] }) {
  const { t } = useTranslation(['optimize', 'common']);
  const result = optimizer.result!;
  const moved = result.proposals.filter((p) => p.moved);
  return (
    <>
      <p className="hint">
        {t('optimize:optimizePanel.summaryHint', {
          count: result.rounds,
          rounds: result.rounds,
          moved: moved.length,
          total: result.proposals.length,
          delta: result.deltaPhi.toFixed(0),
        })}
      </p>
      {moved.length === 0 ? (
        <p className="hint">
          {t('optimize:optimizePanel.noCameraImprovedHint', { percent: (MIN_GAIN * 100).toFixed(0) })}
        </p>
      ) : (
        <table className="aim-summary">
          <tbody>
            {moved.map((p) => (
              <tr key={p.cameraId}>
                <td>{label(cameras, p.cameraId)}</td>
                <td>
                  {fmtAngle(p.current.yaw)} → {fmtAngle(p.best.yaw)}
                </td>
                <td>
                  {fmtAngle(p.current.pitch)} → {fmtAngle(p.best.pitch)}
                </td>
                <td>{fmtGain(p.gain, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ gap: 8 }}>
        {/* Gated on the session's accepted rotations, not on the row count: the
            two used to disagree whenever the loop converged (§6.2). */}
        <button className="btn" disabled={!optimizer.hasProposals} onClick={optimizer.applyAll}>
          {t('optimize:optimizePanel.applyAllButton')}
        </button>
        <button className="btn secondary" onClick={optimizer.discard}>
          {t('optimize:optimizePanel.discardButton')}
        </button>
      </div>
    </>
  );
}

/**
 * The measured outcome of the last apply, per zone (§6.3).
 *
 * The optimizer's own figure is ΔΦ over the whole counted set, which cannot say
 * whether one zone paid for another. This can, and it leads with the answer: a
 * regression banner when any zone lost coverage, because that is the finding the
 * user has to act on and a list of wins would bury it.
 */
function Comparison({ comparison }: { comparison: OptimizeComparison }) {
  const { t } = useTranslation('optimize');
  const { union, zones, regressedCount } = comparison;
  return (
    <>
      <p className="panel-title subhead">{t('optimizePanel.lastOptimizationTitle')}</p>
      {regressedCount > 0 ? (
        <div className="warning-banner">
          {t('optimizePanel.regressedWarning', { count: regressedCount })}
        </div>
      ) : null}
      <table className="aim-summary aim-compare">
        <thead>
          <tr>
            <th>{t('optimizePanel.zoneHeader')}</th>
            <th>{t('optimizePanel.coverageHeader')}</th>
            <th>{t('optimizePanel.blindHeader')}</th>
          </tr>
        </thead>
        <tbody>
          <ZoneRow delta={union} emphasis />
          {zones.map((z) => (
            <ZoneRow key={z.zoneId} delta={z} />
          ))}
        </tbody>
      </table>
      {zones.length === 0 && <p className="hint">{t('optimizePanel.noZonesHint')}</p>}
    </>
  );
}

function ZoneRow({ delta, emphasis = false }: { delta: ZoneDelta; emphasis?: boolean }) {
  const cls = delta.regressed ? 'regressed' : delta.rateDelta > 0 ? 'improved' : '';
  return (
    <tr className={emphasis ? 'union' : undefined}>
      <td>{delta.label}</td>
      <td>
        {fmtRate(delta.before.coverageRate)} → {fmtRate(delta.after.coverageRate)}{' '}
        <span className={cls}>{fmtRateDelta(delta.rateDelta)}</span>
      </td>
      <td>
        {delta.before.blindVoxels.toLocaleString()} → {delta.after.blindVoxels.toLocaleString()}
      </td>
    </tr>
  );
}

function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtRateDelta(d: number): string {
  if (Math.abs(d) < 0.0005) return '±0.0';
  return `${d > 0 ? '+' : '−'}${(Math.abs(d) * 100).toFixed(1)}`;
}

function fmtAngle(deg: number): string {
  return `${deg.toFixed(1)}°`;
}

function fmtGain(gain: number, t: TFunction): string {
  return Number.isFinite(gain) ? `+${(gain * 100).toFixed(0)}%` : t('optimize:optimizePanel.newGainLabel');
}

/**
 * Dark-blue → amber ramp, matching the coverage legend's direction (low is cold,
 * high is hot) without reusing its palette — this is a different quantity and
 * sharing colors would invite reading one as the other.
 */
function ramp(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  return [Math.round(20 + 235 * c ** 0.8), Math.round(30 + 150 * c ** 1.4), Math.round(70 + 40 * (1 - c))];
}
