/**
 * The **Save scene as** dialog (spec §14.5, §14.7): an editor for the save
 * target pair `{ folder, filename }`. Nothing is written until its own commit.
 *
 * Naming a scene file is what lets a folder hold variants of one site —
 * `night-shift.json` beside `scene.json`, both reading the same
 * `assets/site.glb` (§14.2). That same-folder case writes one small JSON and
 * copies nothing; **Change…** retargets the folder and turns the save into a
 * cross-folder one, which copies the scene's referenced assets first (§14.5).
 *
 * The replace warning is inline and recomputed against whichever folder is
 * selected, so no modal confirmation ever stacks on this dialog.
 */
import { useEffect, useState } from 'react';
import { fileNamesIn, findExistingAssets } from '../scene/sceneIO.ts';
import {
  describeReplaceWarning,
  normalizeSceneFileName,
  type DestinationClashes,
  type SaveTarget,
} from '../scene/saveTarget.ts';
import { Modal, FolderLine, FOLDER_UNAVAILABLE, usePickedFolder } from './Modal.tsx';

export interface SaveSceneAsDialogProps {
  /** The folder to open on — the target's, or one just picked (§14.5). */
  folder: FileSystemDirectoryHandle;
  /** Pre-filled name: the target's file, or `scene.json` for a scene with no target. */
  initialName: string;
  /** The scene's referenced assets (`planAssetCopy`), for the cross-folder clash count. */
  assetSrcs: readonly string[];
  /** Whether `folder` is the target's own — decided by `isSameEntry` in `App.tsx` (§14.5). */
  isTargetFolder(folder: FileSystemDirectoryHandle): Promise<boolean>;
  error: string | null;
  busy: boolean;
  onPickFolder(): Promise<FileSystemDirectoryHandle | null>;
  /**
   * Commit. `clashes` is what this dialog already probed about the destination —
   * the caller routes it (write, or confirm the overwrite first, spec §14.5)
   * rather than probing the same folder again.
   */
  onSave(
    target: SaveTarget<FileSystemDirectoryHandle>,
    sameFolder: boolean,
    clashes: DestinationClashes,
  ): void;
  onCancel(): void;
}

/** What the selected folder already holds, for the inline warning (§14.5). */
interface Destination {
  names: Set<string>;
  assetClashes: number;
  sameFolder: boolean;
}

export function SaveSceneAsDialog({
  folder: initialFolder,
  initialName,
  assetSrcs,
  isTargetFolder,
  error,
  busy,
  onPickFolder,
  onSave,
  onCancel,
}: SaveSceneAsDialogProps) {
  const [folder, changeFolder] = usePickedFolder(initialFolder, onPickFolder);
  const [raw, setRaw] = useState(initialName);
  const [dest, setDest] = useState<Destination | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDest(null);
    setProbeError(null);
    // Probed once per folder, not per keystroke: a name collision is then a
    // lookup in this set as the user types (§14.5).
    (async () => {
      const sameFolder = await isTargetFolder(folder);
      const names = await fileNamesIn(folder);
      // Assets only follow a save into a folder that is not the target's; an
      // in-place save has the bytes already (§14.5).
      const assetClashes = sameFolder ? 0 : (await findExistingAssets(folder, assetSrcs)).length;
      return { names, assetClashes, sameFolder };
    })().then(
      (found) => {
        if (live) setDest(found);
      },
      () => {
        if (live) setProbeError(FOLDER_UNAVAILABLE);
      },
    );
    return () => {
      live = false;
    };
  }, [folder, assetSrcs, isTargetFolder]);

  const checked = normalizeSceneFileName(raw);
  // What this name would replace in this folder — the inline warning below and
  // the caller's overwrite routing read the same answer (§14.5).
  const clashes: DestinationClashes | null =
    checked.ok && dest != null
      ? { fileExists: dest.names.has(checked.name), assetClashes: dest.assetClashes }
      : null;
  const warning = checked.ok && clashes != null ? describeReplaceWarning(checked.name, clashes) : null;
  const ready = checked.ok && dest != null && !busy;
  const commit = () => {
    if (checked.ok && dest != null && clashes != null) onSave({ folder, name: checked.name }, dest.sameFolder, clashes);
  };

  return (
    <Modal
      title="Save scene as"
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!ready} onClick={commit}>
            {/* The label is the confirmation, which is why nothing stacks on top. */}
            {warning != null ? 'Replace' : 'Save'}
          </button>
          {busy && <span className="spinner" />}
        </>
      }
    >
      <FolderLine name={folder.name} onChange={changeFolder} disabled={busy} />

      <div className="row">
        <label htmlFor="scene-file-name">
          Name
        </label>
        <input
          id="scene-file-name"
          className="text-input"
          type="text"
          value={raw}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          onChange={(ev) => setRaw(ev.target.value)}
          onKeyDown={(ev) => {
            // Enter is a shortcut for the footer button, Replace label and all (§14.7).
            if (ev.key === 'Enter' && ready) commit();
          }}
        />
      </div>

      {!checked.ok && <p className="hint warn">{checked.error}</p>}
      {/* `.json` is appended rather than required, so say what will be written. */}
      {checked.ok && checked.name !== raw.trim() && <p className="hint">Will be saved as {checked.name}</p>}
      {dest == null && probeError == null && <p className="hint">Checking folder…</p>}
      {warning != null && <div className="warning-banner">{warning}</div>}
      {dest?.sameFolder === false && assetSrcs.length > 0 && (
        <p className="hint">
          {assetSrcs.length === 1 ? '1 asset' : `${assetSrcs.length} assets`} will be copied into this folder, so it
          holds a complete scene.
        </p>
      )}
      {probeError != null && <div className="error-banner">{probeError}</div>}
      {error != null && <div className="error-banner">{error}</div>}
    </Modal>
  );
}
