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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('scene');
  if (!fileSystemAccessAvailable) {
    return (
      <div className="panel">
        <p className="panel-title">{t('sceneFileControls.title')}</p>
        <div className="hint">{t('sceneFileControls.unavailableHint')}</div>
      </div>
    );
  }
  return (
    <div className="panel">
      <p className="panel-title">{t('sceneFileControls.title')}</p>
      <div className="status-line">
        <button className="btn secondary" disabled={busy} onClick={onLoad}>
          {t('sceneFileControls.loadButton')}
        </button>
        <button className="btn secondary" disabled={busy} onClick={onSave}>
          {t('sceneFileControls.saveButton')}
        </button>
        <button className="btn secondary" disabled={busy} onClick={onSaveAs}>
          {t('sceneFileControls.saveAsButton')}
        </button>
        {busy && <span className="spinner" />}
      </div>
      <div className="hint">{status}</div>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}
