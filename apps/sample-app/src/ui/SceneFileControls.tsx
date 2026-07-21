/**
 * Load / Save scene file (spec §14.7), in the left side panel. Hidden entirely
 * where the File System Access API is unavailable (non-Chromium browsers) —
 * reloading the page is the only way back to the boot state there.
 */
export interface SceneFileControlsProps {
  fileSystemAccessAvailable: boolean;
  busy: boolean;
  error: string | null;
  onImport(): void;
  onExport(): void;
}

export function SceneFileControls({ fileSystemAccessAvailable, busy, error, onImport, onExport }: SceneFileControlsProps) {
  if (!fileSystemAccessAvailable) {
    return (
      <div className="panel">
        <p className="panel-title">Scene</p>
        <div className="hint">Load/Save need a Chromium-based browser (File System Access API).</div>
      </div>
    );
  }
  return (
    <div className="panel">
      <p className="panel-title">Scene</p>
      <div className="status-line">
        <button className="btn secondary" disabled={busy} onClick={onImport}>
          Load
        </button>
        <button className="btn secondary" disabled={busy} onClick={onExport}>
          Save
        </button>
        {busy && <span className="spinner" />}
      </div>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}
