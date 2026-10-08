import { normalizeEmail } from '@bantoozi/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { countRecords } from '../../offline/queue.js';
import { useMe, useSession } from '../../session/context.js';
import { Alert, Hint, SettingsSection } from './section.js';

function DeleteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings');
  const me = useMe();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useApiMutation(routes.meDelete, { networkMode: 'always' });
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const busy = remove.isPending || signingOut;
  const confirmed = normalizeEmail(typed) === normalizeEmail(me.email);

  useEffect(() => {
    let current = true;
    void countRecords(me.id).then((count) => {
      if (current) setUnsent(count);
    });
    return () => {
      current = false;
    };
  }, [me.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || busy) return;
    setFailure(null);
    try {
      await remove.mutateAsync();
    } catch (error) {
      setFailure(error);
      return;
    }
    setSigningOut(true);
    await session.resetAccountState();
    toast.show({
      id: 'account-deleted',
      message: t('delete.done'),
      tone: 'info',
      durationMs: null,
    });
    await navigate({ to: '/login', replace: true });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('delete.dialog.title')}
      description={t('delete.dialog.body')}
      showCloseButton={false}
      dismissible={!busy}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {unsent === 0 ? null : (
          <p role="status" className="text-sm font-medium">
            {t('delete.dialog.unsent', { count: unsent })}
          </p>
        )}
        <TextField
          label={t('delete.dialog.confirmLabel', { email: me.email })}
          value={typed}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
        {failure === null ? null : (
          <Alert>{t('delete.dialog.failed', { reason: errorMessage(t, failure) })}</Alert>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!confirmed}>
            {t('delete.dialog.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteAccountSection() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title={t('delete.title')} tone="danger">
      <Hint>{t('delete.explain')}</Hint>
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          {t('delete.open')}
        </Button>
      </div>
      {open ? <DeleteDialog onClose={() => setOpen(false)} /> : null}
    </SettingsSection>
  );
}
