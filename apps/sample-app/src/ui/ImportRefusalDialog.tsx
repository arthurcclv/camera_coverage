/**
 * Why a picked file could not be imported (`asset_import.md` §4, §11).
 *
 * The whole of this feature's UI on the refusal path. There is deliberately no
 * dialog on the clean path (§6.1) — a self-contained file that passes the sniff
 * is simply added — so every dialog it shows is a *consequence* of a pick rather
 * than a preamble to one.
 *
 * A **backdrop modal**, like every other dialog that settles a reference to a
 * file on disk (`spec.md` §14.7), and the smallest one: a filename, a reason,
 * and a way out. It carries no retry button because the retry is the menu entry
 * the user just used — and for the commonest refusal (a PLY picked in the wrong
 * entry) the remedy the reason names is the *other* entry, which is enabled and
 * one click away. That is the dead end the unified picker exists to remove
 * (§4.2).
 */
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.tsx';

export interface ImportRefusalDialogProps {
  /** The picked file's name, as the OS reported it. */
  fileName: string;
  /**
   * `routePickedFile`'s reason — the remedy, not the bare failure (§4) — already
   * resolved to display text by the caller, since the router returns a key.
   */
  reason: string;
  onDismiss(): void;
}

export function ImportRefusalDialog({ fileName, reason, onDismiss }: ImportRefusalDialogProps) {
  const { t } = useTranslation(['scene']);
  return (
    <Modal
      title={t('importRefusal.title')}
      onCancel={onDismiss}
      footer={
        <button type="button" className="btn" onClick={onDismiss}>
          {t('importRefusal.dismiss')}
        </button>
      }
    >
      <p className="hint">
        <code>{fileName}</code>
      </p>
      <div className="error-banner">{reason}</div>
    </Modal>
  );
}
