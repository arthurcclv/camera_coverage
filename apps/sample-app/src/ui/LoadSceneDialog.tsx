/**
 * The **Load scene** dialog (spec §14.4, §14.7): a folder line, then that
 * folder's scene files, one row each with its summary.
 *
 * The folder is what grants access — a file handle from a native file dialog
 * exposes no parent, so a scene picked that way could never resolve its sibling
 * `assets/*.glb` (§14) — which is why the file is chosen from this list rather
 * than an OS dialog. Because the dialog opens on the folder already granted, and
 * every scene file in a folder shares its one `assets/` (§14.2), switching
 * between variants costs no OS dialog at all.
 *
 * Owns only its own transient state (the folder being browsed and its listing);
 * the commit is the caller's, so the all-or-nothing import stays in `App.tsx`.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { listSceneFiles } from '../scene/sceneIO.ts';
import { moveListSelection, nextListSelection, type SceneFileEntry } from '../scene/sceneFileList.ts';
import type { SaveTarget } from '../scene/saveTarget.ts';
import { Modal, FolderLine, FOLDER_UNAVAILABLE, usePickedFolder } from './Modal.tsx';

export interface LoadSceneDialogProps {
  /** The folder to open on — always granted before the dialog is shown (§14.4). */
  folder: FileSystemDirectoryHandle;
  /** The target's file name; `null` at boot. Marked only in the target's own folder. */
  currentName: string | null;
  /** Whether a folder is the target's own — `isSameEntry` in `App.tsx` (§14.7). */
  isTargetFolder(folder: FileSystemDirectoryHandle): Promise<boolean>;
  /** Unsaved-changes warning from `describeUnsavedWarning`, or `null` (§14.4). */
  unsavedWarning: string | null;
  /** Error from the commit attempt, shown in place so the next file can be tried (§14.8). */
  error: string | null;
  busy: boolean;
  /** Opens `showDirectoryPicker`; resolves `null` when cancelled (§14.8). */
  onPickFolder(): Promise<FileSystemDirectoryHandle | null>;
  onLoad(target: SaveTarget<FileSystemDirectoryHandle>): void;
  onCancel(): void;
}

export function LoadSceneDialog({
  folder: initialFolder,
  currentName,
  isTargetFolder,
  unsavedWarning,
  error,
  busy,
  onPickFolder,
  onLoad,
  onCancel,
}: LoadSceneDialogProps) {
  const [folder, changeFolder] = usePickedFolder(initialFolder, onPickFolder);
  const [entries, setEntries] = useState<SceneFileEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The badged file is the target's *file in the target's folder*: two folders
  // granted in one session can each hold a `scene.json`, and only one of them is
  // what Save writes to, so browsing away from the target marks nothing (§14.7).
  const [currentHere, setCurrentHere] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setListError(null);
    (async () => {
      const here = currentName != null && (await isTargetFolder(folder)) ? currentName : null;
      return { here, found: await listSceneFiles(folder) };
    })().then(
      ({ here, found }) => {
        if (!live) return;
        setCurrentHere(here);
        setEntries(found);
        setSelected(nextListSelection(found, here));
      },
      () => {
        if (!live) return;
        // Renamed, unmounted, permission lost — recoverable in place, so the
        // dialog stays open with Change… (§14.8).
        setCurrentHere(null);
        setEntries([]);
        setSelected(null);
        setListError(FOLDER_UNAVAILABLE);
      },
    );
    return () => {
      live = false;
    };
  }, [folder, currentName, isTargetFolder]);

  const loadableNames = useMemo(() => (entries ?? []).filter((e) => e.error == null).map((e) => e.name), [entries]);
  const commit = useCallback((name: string) => onLoad({ folder, name }), [folder, onLoad]);

  // Enter commits the selection and double-click commits its row — both
  // shortcuts for the footer button, warnings and all (§14.7).
  const onListKeyDown = useCallback(
    (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        if (selected != null) commit(selected);
        return;
      }
      const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      ev.preventDefault();
      const next = moveListSelection(loadableNames, selected, step);
      if (next != null) setSelected(next);
    },
    [selected, loadableNames, commit],
  );

  return (
    <Modal
      title="Load scene"
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || selected == null}
            onClick={() => selected != null && commit(selected)}
          >
            {unsavedWarning != null ? 'Load anyway' : 'Load'}
          </button>
          {busy && <span className="spinner" />}
        </>
      }
    >
      <FolderLine name={folder.name} onChange={changeFolder} disabled={busy} />

      {unsavedWarning != null && <div className="warning-banner">{unsavedWarning}</div>}

      {entries == null && <p className="hint">Reading folder…</p>}
      {listError != null && <div className="error-banner">{listError}</div>}
      {/* Nothing loadable — whether the folder is empty of `*.json` or holds only
          files that failed to parse — is the same dead end, and says so (§14.8).
          The invalid rows are still listed below, with their reasons. */}
      {entries != null && listError == null && loadableNames.length === 0 && (
        <p className="hint">No scene file in this folder can be loaded. Choose another.</p>
      )}

      {entries != null && entries.length > 0 && (
        <ul
          className="scene-file-list"
          role="listbox"
          aria-label="Scene files"
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {entries.map((entry) => (
            <SceneFileRow
              key={entry.name}
              entry={entry}
              selected={entry.name === selected}
              isCurrent={entry.name === currentHere}
              onSelect={() => setSelected(entry.name)}
              onCommit={() => commit(entry.name)}
            />
          ))}
        </ul>
      )}

      {error != null && <div className="error-banner">{error}</div>}
    </Modal>
  );
}

function SceneFileRow({
  entry,
  selected,
  isCurrent,
  onSelect,
  onCommit,
}: {
  entry: SceneFileEntry;
  selected: boolean;
  isCurrent: boolean;
  onSelect(): void;
  onCommit(): void;
}) {
  const invalid = entry.error != null;
  const summary = entry.error ?? entry.summary ?? 'not read — will validate on load';
  return (
    <li
      className={`scene-file-row${selected ? ' selected' : ''}${invalid ? ' invalid' : ''}`}
      role="option"
      aria-selected={selected}
      aria-disabled={invalid || undefined}
      onClick={invalid ? undefined : onSelect}
      onDoubleClick={invalid ? undefined : onCommit}
    >
      {/* Hover gives the full name, since a scene named for what distinguishes it
          outruns the row (§14.7). The label ellipsizes; the badge never does. */}
      <span className="scene-file-name" title={entry.name}>
        <span className="scene-file-label">{entry.name}</span>
        {/* Which file a plain Save would write to — the one the scene came from. */}
        {isCurrent && <span className="badge">current</span>}
      </span>
      {/* A file past the parse cap has neither summary nor error: it validates on
          selection instead (§14.4). A schema error can be long, so it hovers too. */}
      <span className="scene-file-summary" title={summary}>
        {summary}
      </span>
    </li>
  );
}
