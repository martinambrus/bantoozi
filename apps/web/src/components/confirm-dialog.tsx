import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './button.js';
import { errorMessage } from './error-message.js';
import { WarningIcon } from './icons.js';
import { Modal } from './modal.js';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Runs when confirmed; the dialog stays open and busy until a returned promise settles. */
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  danger?: boolean | undefined;
}

export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  return open ? <OpenConfirmDialog {...props} /> : null;
}

// Split from ConfirmDialog so the pending and error state starts fresh on every opening.
function OpenConfirmDialog({
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
}: Omit<ConfirmDialogProps, 'open'>) {
  const { t } = useTranslation('common');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setFailure({ error });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={body}
      showCloseButton={false}
      dismissible={!pending}
      surfaceClassName="m-auto w-full max-w-md rounded-xl"
    >
      {failure === null ? null : (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300"
        >
          <WarningIcon className="mt-0.5 size-4" />
          {errorMessage(t, failure.error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          {cancelLabel ?? t('actions.cancel')}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          loading={pending}
          onClick={() => void confirm()}
        >
          {confirmLabel ?? t('actions.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
