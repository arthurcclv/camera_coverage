/**
 * The **Overwrite scene file?** confirmation (spec §14.5, §14.7) — the gate in
 * front of every write that would replace an existing file, whether it came from
 * a plain **Save** or a **Save scene as** commit. One dialog for both, so the two
 * paths cannot drift into asking different questions about the same act.
 *
 * It is the only surface in this app that sits over another modal, and it does
 * not dim a second time (`stacked`). Cancelling is always the safe half: nothing
 * written, and the Save-as dialog underneath is left open with its typed name.
 *
 * Its **Overwrite** click is also the user activation the lazy write-permission
 * request runs from (§14.5), which is why it commits straight to the caller's
 * write rather than routing through anything else first.
 */
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.tsx';

export interface ConfirmOverwriteDialogProps {
  /** `describeOverwriteConfirm` output: what would be replaced, a line each. */
  lines: readonly string[];
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmOverwriteDialog({ lines, busy, onConfirm, onCancel }: ConfirmOverwriteDialogProps) {
  const { t } = useTranslation(['scene', 'common']);
  return (
    <Modal
      title={t('confirmOverwriteDialog.title')}
      stacked
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onCancel}>
            {t('common:cancel')}
          </button>
          {/* Named for what it does, like the commit labels it follows (§14.7). */}
          <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
            {t('confirmOverwriteDialog.overwriteButton')}
          </button>
          {busy && <span className="spinner" />}
        </>
      }
    >
      {lines.map((line) => (
        <p className="confirm-line" key={line}>
          {line}
        </p>
      ))}
    </Modal>
  );
}
