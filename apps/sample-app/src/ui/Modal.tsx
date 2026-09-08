/**
 * The app's only blocking surface (`ai/VISUAL_DESIGN.md`), used by the two
 * scene-file dialogs (spec §14.7). A dimmed backdrop over the whole viewport
 * centres a `.panel`-surfaced card: title, scrolling body, pinned footer, so a
 * long file list scrolls while Cancel and the commit button stay put.
 *
 * Everything else in this app is a panel, a popover, or an anchored guard — a
 * modal is for a choice that genuinely blocks *and* is not about judging the
 * viewport behind it. These two settle which file on disk the scene is, and one
 * of them can discard unsaved work, so dimming the scene is honest.
 *
 * Escape cancels, and cancelling is always the safe half: nothing written, no
 * scene replaced. Focus moves into the card on open and returns to whatever
 * opened it on close.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The open modals, outermost first (spec §14.7). Only the **overwrite
 * confirmation** ever stacks, and only over the Save-as dialog it was committed
 * from, but Escape has to know which card it is closing: both dialogs listen on
 * `window` in the capture phase, and `stopPropagation` does not stop a sibling
 * listener on the same target — so without this, one Escape would cancel the
 * confirmation *and* the dialog underneath, losing the typed name.
 */
const openModals: symbol[] = [];

export interface ModalProps {
  title: string;
  /** Escape and the backdrop's Cancel both route here (§14.8: a no-op). */
  onCancel(): void;
  children: ReactNode;
  /** The `.row.button-row` footer — Cancel plus the commit button. */
  footer: ReactNode;
  /**
   * Sitting over another modal (spec §14.7): the backdrop beneath already dims
   * the scene, so this one does not dim a second time. Only the overwrite
   * confirmation sets it.
   */
  stacked?: boolean;
}

export function Modal({ title, stacked = false, onCancel, children, footer }: ModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Identity in the open-modal stack; a symbol so two modals can never collide.
  const idRef = useRef<symbol | null>(null);
  if (idRef.current == null) idRef.current = Symbol('modal');

  useEffect(() => {
    const id = idRef.current!;
    openModals.push(id);
    return () => {
      const at = openModals.indexOf(id);
      if (at >= 0) openModals.splice(at, 1);
    };
  }, []);

  useEffect(() => {
    // Restore focus to the button that opened the dialog, so a cancelled Load…
    // leaves the keyboard exactly where it was.
    const opener = document.activeElement as HTMLElement | null;
    // Prefer the first field/row over the card, so typing a name or arrowing the
    // file list works without a Tab first.
    const focusable = cardRef.current?.querySelector<HTMLElement>(
      'input, [role="listbox"], button:not(:disabled)',
    );
    (focusable ?? cardRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Topmost only: a stacked confirmation cancels itself and leaves the dialog
      // it was committed from open, with its typed name (spec §14.7).
      if (openModals[openModals.length - 1] !== idRef.current) return;
      ev.stopPropagation();
      onCancel();
    };
    // Capture, so Escape closes the dialog rather than reaching the viewport
    // tools and selection handlers underneath it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div className={stacked ? 'modal-backdrop stacked' : 'modal-backdrop'}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label={title} ref={cardRef} tabIndex={-1}>
        <p className="panel-title">{title}</p>
        <div className="panel-body">{children}</div>
        <div className="row button-row">{footer}</div>
      </div>
    </div>
  );
}

/**
 * What a folder that cannot be enumerated or probed says (spec §14.8) — renamed,
 * unmounted, or permission lost. Shared, because either dialog can hit it and
 * both recover the same way: stay open, offer **Change…**.
 */
export const FOLDER_UNAVAILABLE = 'This folder is no longer available. Choose another.';

/**
 * The folder a dialog is currently pointed at, and the **Change…** that
 * re-points it (spec §14.5, §14.7). Shared because both dialogs open on an
 * already-granted folder and both let the picker replace *only* that, leaving
 * everything else they hold (a typed name, a selection) alone.
 */
export function usePickedFolder(
  initial: FileSystemDirectoryHandle,
  onPickFolder: () => Promise<FileSystemDirectoryHandle | null>,
): [FileSystemDirectoryHandle, () => void] {
  const [folder, setFolder] = useState(initial);
  const change = useCallback(() => {
    // Cancelling the picker is a no-op: the dialog stays on this folder (§14.8).
    void onPickFolder().then((picked) => {
      if (picked != null) setFolder(picked);
    });
  }, [onPickFolder]);
  return [folder, change];
}

/**
 * The folder line both dialogs open with (spec §14.7): the granted folder's leaf
 * name — never a full path, which the File System Access API does not expose —
 * and the button that re-picks it.
 */
export function FolderLine({ name, onChange, disabled }: { name: string; onChange(): void; disabled: boolean }) {
  return (
    <div className="modal-folder">
      <span className="modal-folder-name" title={name}>
        {name}/
      </span>
      <button type="button" className="btn secondary" disabled={disabled} onClick={onChange}>
        Change…
      </button>
    </div>
  );
}
