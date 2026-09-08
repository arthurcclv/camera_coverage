/**
 * Load… / Save / Save As… scene file (spec §14.7), in the left side panel. Hidden
 * entirely where the File System Access API is unavailable (non-Chromium
 * browsers) — reloading the page is the only way back to the boot state there.
 *
 * Load… and Save As… open modal dialogs (`LoadSceneDialog`,
 * `SaveSceneAsDialog`); this panel is just the three actions and the status line.
 * That line names the **file** a plain Save writes to (§14.5): a silent save
 * closes no dialog, so the destination and the acknowledgement both have to be
 * visible here. Text comes from `scene/saveTarget.ts` (pure, tested).
 */
export interface SceneFileControlsProps {
  fileSystemAccessAvailable: boolean;
  busy: boolean;
  error: string | null;
  /** Save-target status line (§14.7), from `describeSceneFileStatus`. */
  status: string;
  onLoad(): void;
  onSave(): void;
  onSaveAs(): void;
}

export function SceneFileControls({
  fileSystemAccessAvailable,
  busy,
  error,
  status,
  onLoad,
  onSave,
  onSaveAs,
}: SceneFileControlsProps) {
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
        <button className="btn secondary" disabled={busy} onClick={onLoad}>
          Load…
        </button>
        <button className="btn secondary" disabled={busy} onClick={onSave}>
          Save
        </button>
        <button className="btn secondary" disabled={busy} onClick={onSaveAs}>
          Save As…
        </button>
        {busy && <span className="spinner" />}
      </div>
      <div className="hint">{status}</div>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}
