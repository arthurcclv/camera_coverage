/**
 * App shell (spec §10): owns all canonical state and wires the panels to the
 * viewport. The PlayCanvas side is entered once, through `<Viewport>`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  alignmentStorageKey,
  defaultAlignment,
  IDENTITY_ALIGNMENT,
  parseAlignment,
  serializeAlignment,
  type Alignment,
} from './align/alignment.ts';
import { cameraLabel } from './cameras/label.ts';
import { readSceneCameras, type PreviewCamera } from './cameras/sceneCameras.ts';
import { formatBytes, SIZE_WARN_BYTES } from './export/zip.ts';
import type { ExportProgress, ExportRunResult, ExportRunSettings } from './export/runExport.ts';
import { imageSizeFor } from './render/imageSize.ts';
import { AlignmentPanel } from './ui/AlignmentPanel.tsx';
import { CameraList } from './ui/CameraList.tsx';
import { RenderSettingsPanel, type RenderSettingsState } from './ui/RenderSettingsPanel.tsx';
import { SourcePanel } from './ui/SourcePanel.tsx';
import {
  Viewport,
  type BackendPreference,
  type ExportRequest,
  type ViewMode,
} from './viewport/Viewport.tsx';
import type { LoadProgress } from './viewport/splatAsset.ts';

interface Notice {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

const DEFAULT_SETTINGS: RenderSettingsState = {
  resolution: { kind: 'derive', baseHeight: 1080 },
  format: 'png',
  quality: 0.92,
  samples: 4,
  settleFrames: 2,
  background: [0.08, 0.09, 0.11, 1],
  transparentBackground: false,
  farOverride: 1000,
  includeDisabled: false,
};

/** Conservative until the device reports; only used for the §9.1 clamp readout. */
const ASSUMED_MAX_TEXTURE = 8192;

export default function App() {
  const [splatFiles, setSplatFiles] = useState<File[] | null>(null);
  const [splatSource, setSplatSource] = useState<{ filename: string; byteSize: number } | null>(null);
  const [splatProgress, setSplatProgress] = useState<LoadProgress | null>(null);

  const [cameras, setCameras] = useState<PreviewCamera[]>([]);
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());

  const [alignment, setAlignment] = useState<Alignment>(IDENTITY_ALIGNMENT);
  const [alignmentRestored, setAlignmentRestored] = useState(false);
  /**
   * Whether the user has adjusted this capture's alignment. Gates persistence (§7.4) so
   * an auto-applied default is never mistaken for a deliberate choice on the next load.
   */
  const alignmentEdited = useRef(false);

  const [settings, setSettings] = useState<RenderSettingsState>(DEFAULT_SETTINGS);
  const [viewMode, setViewMode] = useState<ViewMode>('orbit');
  const [showMarkers, setShowMarkers] = useState(true);
  const [backend, setBackend] = useState<BackendPreference>('auto');
  const [backendName, setBackendName] = useState<string | null>(null);

  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);

  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const cancelled = useRef(false);
  const requestId = useRef(0);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    setNotices((prev) => [...prev, { id: noticeId.current++, kind, text }]);
  }, []);

  /**
   * Every user-initiated alignment change (§7.4) — including Reset, which is how an
   * already-upright capture opts out of the default. Only these are persisted.
   */
  const editAlignment = useCallback((next: Alignment) => {
    alignmentEdited.current = true;
    setAlignment(next);
  }, []);
  const onError = useCallback((text: string) => notify('error', text), [notify]);

  // --- alignment persistence (§7.3) ---------------------------------------

  useEffect(() => {
    if (!splatSource) return;

    // A capture the user has adjusted before restores that; one they haven't follows
    // the current default (§7.4).
    alignmentEdited.current = false;
    const key = alignmentStorageKey(splatSource.filename, splatSource.byteSize);
    const raw = window.localStorage.getItem(key);
    if (raw) {
      try {
        const result = parseAlignment(JSON.parse(raw));
        if (result.ok) {
          setAlignment(result.alignment);
          setAlignmentRestored(true);
          return;
        }
      } catch {
        // A corrupt entry is not worth surfacing; fall through to the default.
      }
    }

    setAlignment(defaultAlignment());
    setAlignmentRestored(false);
    // Never transform the user's data silently (§7.3).
    notify(
      'info',
      'Applied a 180° Z rotation, the usual correction for a 3DGS capture (they load ' +
        'Y-down). If this one was already upright, press Reset in Alignment.',
    );
  }, [splatSource, notify]);

  // Persist only what the user actually chose (§7.4). Writing the auto-applied default
  // here would make it indistinguishable from a deliberate choice on the next load —
  // which is exactly how a previous build froze every already-opened capture at whatever
  // default was in force the first time, rendering later default changes inert.
  useEffect(() => {
    if (!splatSource || !alignmentEdited.current) return;
    const key = alignmentStorageKey(splatSource.filename, splatSource.byteSize);
    window.localStorage.setItem(key, serializeAlignment(alignment));
  }, [alignment, splatSource]);

  // --- import (§5) --------------------------------------------------------

  const importScene = useCallback(
    async (file: File) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch (err) {
        onError(`${file.name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const result = readSceneCameras(parsed);
      if (!result.ok) {
        onError(`${file.name}: ${result.error}`);
        return;
      }
      // Import fully replaces; it never merges (§5.3).
      setCameras(result.cameras);
      setSceneName(file.name);
      setSelectedId(result.cameras[0]?.id ?? null);
      // Coverage-disabled cameras are listed but unchecked by default (§5.3).
      setIncluded(new Set(result.cameras.filter((c) => c.enabled).map((c) => c.id)));
      for (const notice of result.notices) notify('info', notice);
    },
    [notify, onError],
  );

  // Toggling "include disabled" re-seeds the run set.
  useEffect(() => {
    if (cameras.length === 0) return;
    setIncluded(new Set(cameras.filter((c) => settings.includeDisabled || c.enabled).map((c) => c.id)));
  }, [settings.includeDisabled, cameras]);

  // --- export (§9) --------------------------------------------------------

  const runCameras = useMemo(
    () => cameras.filter((c) => included.has(c.id)),
    [cameras, included],
  );

  const selected = useMemo(() => cameras.find((c) => c.id === selectedId) ?? null, [cameras, selectedId]);

  const estimatedBytes = useMemo(() => {
    // A rough per-pixel figure for the pre-run estimate; the run reports actuals.
    const perPixel = settings.format === 'jpeg' ? 0.35 : 1.6;
    return runCameras.reduce((sum, c) => {
      const size = imageSizeFor(c.aspect, settings.resolution, ASSUMED_MAX_TEXTURE);
      return sum + size.width * size.height * perPixel;
    }, 0);
  }, [runCameras, settings.resolution, settings.format]);

  const startExport = () => {
    if (!splatSource) {
      onError('Load a splat before exporting.');
      return;
    }
    if (runCameras.length === 0) {
      onError('Select at least one camera to export.');
      return;
    }
    cancelled.current = false;
    setProgress({ done: 0, total: runCameras.length, current: cameraLabel(runCameras[0]), bytes: 0 });

    const runSettings: ExportRunSettings = {
      resolution: settings.resolution,
      format: settings.format,
      quality: settings.quality,
      samples: settings.samples,
      settleFrames: settings.settleFrames,
      background: settings.background,
      transparentBackground: settings.transparentBackground,
      farOverride: settings.farOverride,
    };
    setExportRequest({
      id: requestId.current++,
      cameras: runCameras,
      settings: runSettings,
      sourceScene: sceneName ?? 'scene.json',
    });
  };

  const onExportDone = useCallback(
    (result: ExportRunResult) => {
      setProgress(null);
      setExportRequest(null);
      if (result.status === 'done') {
        notify('info', `Exported ${result.filename} (${formatBytes(result.bytes)}).`);
      } else if (result.status === 'cancelled') {
        notify('info', 'Export cancelled — nothing was downloaded.');
      } else {
        onError(result.error);
      }
    },
    [notify, onError],
  );

  const running = progress !== null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="app-header">
          <h1>Splat Camera Export</h1>
          <p className="hint">Render each planned camera against a 3D Gaussian Splat capture.</p>
        </header>

        <SourcePanel
          splatName={splatSource?.filename ?? null}
          splatBytes={splatSource?.byteSize ?? null}
          splatProgress={splatProgress}
          sceneName={sceneName}
          cameraCount={cameras.length}
          onPickSplat={setSplatFiles}
          onPickScene={(file) => void importScene(file)}
        />

        <section className="panel">
          <h2 className="panel-title">View</h2>
          <div className="field-row" role="radiogroup" aria-label="View mode">
            <button
              type="button"
              className={viewMode === 'orbit' ? 'btn btn-active' : 'btn'}
              role="radio"
              aria-checked={viewMode === 'orbit'}
              onClick={() => setViewMode('orbit')}
            >
              Orbit
            </button>
            <button
              type="button"
              className={viewMode === 'through' ? 'btn btn-active' : 'btn'}
              role="radio"
              aria-checked={viewMode === 'through'}
              disabled={selected === null}
              onClick={() => setViewMode('through')}
            >
              Through camera
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
            <span>Show camera markers</span>
          </label>
          {viewMode === 'through' && selected && (
            <p className="hint">Framing {cameraLabel(selected)} — this is what export writes.</p>
          )}
        </section>

        <AlignmentPanel
          alignment={alignment}
          onChange={editAlignment}
          onFrameSplat={() => notify('info', 'Use orbit drag/zoom to frame the splat.')}
          onError={onError}
          restored={alignmentRestored}
          disabled={splatSource === null}
        />

        <CameraList
          cameras={cameras}
          selectedId={selectedId}
          included={included}
          onSelect={setSelectedId}
          onToggle={(id) =>
            setIncluded((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSetAll={(all) => setIncluded(all ? new Set(cameras.map((c) => c.id)) : new Set())}
        />

        <RenderSettingsPanel
          settings={settings}
          onChange={setSettings}
          previewAspect={selected?.aspect ?? null}
          maxTextureSize={ASSUMED_MAX_TEXTURE}
          backend={backend}
          backendName={backendName}
          onBackendChange={setBackend}
        />

        <section className="panel">
          <h2 className="panel-title">Export</h2>
          {running ? (
            <>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <div className="progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
              <p className="hint">
                {progress.done} / {progress.total} — {progress.current} · {formatBytes(progress.bytes)}
              </p>
              <button type="button" className="btn" onClick={() => { cancelled.current = true; }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={splatSource === null || runCameras.length === 0}
                onClick={startExport}
              >
                Export {runCameras.length} image{runCameras.length === 1 ? '' : 's'}
              </button>
              <p className="hint">
                {splatSource === null
                  ? 'Load a splat first.'
                  : runCameras.length === 0
                    ? 'Select at least one camera.'
                    : `≈ ${formatBytes(estimatedBytes)} before zipping.`}
              </p>
              {estimatedBytes > SIZE_WARN_BYTES && (
                <p className="hint hint-warn">
                  This batch is large; the whole zip is held in memory before download.
                </p>
              )}
            </>
          )}
        </section>

        {notices.length > 0 && (
          <section className="panel">
            {notices.map((notice) => (
              <div key={notice.id} className={notice.kind === 'error' ? 'notice notice-error' : 'notice'}>
                <span>{notice.text}</span>
                <button
                  type="button"
                  className="notice-close"
                  aria-label="Dismiss"
                  onClick={() => setNotices((prev) => prev.filter((n) => n.id !== notice.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </section>
        )}
      </aside>

      <Viewport
        backend={backend}
        onBackendReady={setBackendName}
        splatFiles={splatFiles}
        cameras={cameras}
        selectedId={selectedId}
        viewMode={viewMode}
        showMarkers={showMarkers}
        alignment={alignment}
        background={settings.background}
        exportRequest={exportRequest}
        onSplatLoaded={setSplatSource}
        onSplatProgress={setSplatProgress}
        onError={onError}
        onExportProgress={setProgress}
        onExportDone={onExportDone}
        isExportCancelled={() => cancelled.current}
        onSelect={setSelectedId}
      />
    </div>
  );
}
