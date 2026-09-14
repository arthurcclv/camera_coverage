/**
 * The **Add 3DGS** dialog (`gaussian_splats.md` §3.2, `spec.md` §14.7): the
 * capture files **already sitting** in the scene folder's `assets/`, one row
 * each with its byte size, and a commit that adds a splat row referencing the
 * chosen one at an identity transform.
 *
 * The app never writes into `assets/` — the user drops the file there, which is
 * what keeps `spec.md` §14.9's no-file-management rule intact and what lets one
 * multi-hundred-megabyte capture serve every scene file in the folder.
 *
 * It is a **backdrop modal** rather than a popover hanging off the "+" menu
 * because it settles the same question the Load and Save-as dialogs do — which
 * file on disk something points at (`spec.md` §14.7).
 *
 * Owns only its own transient state (the listing); the commit is the caller's,
 * so the scene edit stays in `App.tsx`.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { listSplatAssets } from '../scene/sceneIO.ts';
import { moveListSelection } from '../scene/sceneFileList.ts';
import {
  firstSelectableAsset,
  formatByteSize,
  type SplatAssetFile,
} from '../scene/splatAssets.ts';
import { SPLAT_ASSET_DIR, SPLAT_EXTENSIONS } from '../scene/splats.ts';
import { Modal, FOLDER_UNAVAILABLE } from './Modal.tsx';

export interface AddSplatDialogProps {
  /** The save target's folder — the dialog is unreachable without one (§3.2). */
  folder: FileSystemDirectoryHandle;
  /** Commits `assets/<name>` as a new splat row's `src`. */
  onAdd(src: string): void;
  onCancel(): void;
}

export function AddSplatDialog({ folder, onAdd, onCancel }: AddSplatDialogProps) {
  const { t } = useTranslation(['scene', 'common']);
  const [listing, setListing] = useState<{ hasAssetDir: boolean; files: SplatAssetFile[] } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setListing(null);
    setListError(null);
    listSplatAssets(folder).then(
      (found) => {
        if (!live) return;
        setListing(found);
        setSelected(firstSelectableAsset(found.files));
      },
      () => {
        if (!live) return;
        // Renamed, unmounted, permission lost — the same recoverable dead end
        // the other dialogs report (`spec.md` §14.8).
        setListing({ hasAssetDir: false, files: [] });
        setSelected(null);
        setListError(FOLDER_UNAVAILABLE());
      },
    );
    return () => {
      live = false;
    };
  }, [folder]);

  const selectableNames = useMemo(
    () => (listing?.files ?? []).filter((f) => f.error == null).map((f) => f.name),
    [listing],
  );
  const commit = useCallback((name: string) => onAdd(`${SPLAT_ASSET_DIR}/${name}`), [onAdd]);

  // Arrow keys walk the **selectable** rows only and clamp at both ends; Enter
  // commits the selection (`gaussian_splats.md` §3.2). The move itself is
  // `sceneFileList.moveListSelection` — the Load dialog's own, shared rather
  // than re-derived here, because a keyboard shortcut inside a dialog is still
  // `(rows, selected) → selected` and belongs in a tested pure module
  // (`ai/CONVENTIONS.md`).
  const onListKeyDown = useCallback(
    (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        if (selected != null) commit(selected);
        return;
      }
      const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      ev.preventDefault();
      const next = moveListSelection(selectableNames, selected, step);
      if (next != null) setSelected(next);
    },
    [selected, selectableNames, commit],
  );

  const files = listing?.files ?? [];

  return (
    <Modal
      title={t('addSplatDialog.title')}
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onCancel}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={selected == null}
            onClick={() => selected != null && commit(selected)}
          >
            {t('common:add')}
          </button>
        </>
      }
    >
      <p className="hint">
        {t('addSplatDialog.captureFilesPrefix')} <code>{folder.name}/{SPLAT_ASSET_DIR}/</code>.{' '}
        {t('addSplatDialog.captureFilesSuffix', { extensions: SPLAT_EXTENSIONS.join(' / ') })}
      </p>

      {listing == null && <p className="hint">{t('addSplatDialog.readingFolder')}</p>}
      {listError != null && <div className="error-banner">{listError}</div>}

      {/* Two different dead ends, said differently: no `assets/` at all versus an
          `assets/` holding nothing this app can decode (§3.2, §9). Neither
          creates the folder, and neither offers a commit. */}
      {listing != null && listError == null && !listing.hasAssetDir && (
        <p className="hint">
          {t('addSplatDialog.noAssetDirPrefix')} <code>{SPLAT_ASSET_DIR}/</code>{' '}
          {t('addSplatDialog.noAssetDirSuffix')}
        </p>
      )}
      {listing != null && listError == null && listing.hasAssetDir && selectableNames.length === 0 && (
        <p className="hint">
          {t('addSplatDialog.noneAddablePrefix')} <code>{SPLAT_ASSET_DIR}/</code>{' '}
          {t('addSplatDialog.noneAddableSuffix')}
        </p>
      )}

      {files.length > 0 && (
        <ul
          className="scene-file-list"
          role="listbox"
          aria-label={t('addSplatDialog.listAriaLabel')}
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {files.map((file) => (
            <SplatAssetRow
              key={file.name}
              file={file}
              selected={file.name === selected}
              onSelect={() => setSelected(file.name)}
              onCommit={() => commit(file.name)}
            />
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * One listed capture. A file this scene **already references** is still listed
 * and still selectable — two rows on one capture is how two registrations are
 * compared, and §3.3's per-`src` sharing makes it cheap.
 */
function SplatAssetRow({
  file,
  selected,
  onSelect,
  onCommit,
}: {
  file: SplatAssetFile;
  selected: boolean;
  onSelect(): void;
  onCommit(): void;
}) {
  const invalid = file.error != null;
  return (
    <li
      className={`scene-file-row${selected ? ' selected' : ''}${invalid ? ' invalid' : ''}`}
      role="option"
      aria-selected={selected}
      aria-disabled={invalid || undefined}
      onClick={invalid ? undefined : onSelect}
      onDoubleClick={invalid ? undefined : onCommit}
    >
      <span className="scene-file-name" title={file.name}>
        <span className="scene-file-label">{file.name}</span>
      </span>
      {/* The reason a row cannot be added, or its size — metadata only; no file
          is read or decoded to build this list (§3.2). */}
      <span className="scene-file-summary" title={file.error ?? undefined}>
        {file.error ?? formatByteSize(file.size)}
      </span>
    </li>
  );
}
