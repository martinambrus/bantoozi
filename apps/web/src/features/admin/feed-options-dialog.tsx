import { AdminFetchOptionsSchema, type AdminFeed, type AdminFetchOptions } from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Checkbox } from '../../components/checkbox.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { Alert } from './admin-ui.js';

export interface FeedOptionsDialogProps {
  feed: AdminFeed;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}

export function FeedOptionsDialog({ feed, name, onClose, onSaved }: FeedOptionsDialogProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const update = useApiMutation(routes.adminFeedUpdate);
  const initialAgent = feed.fetchOptions.userAgent ?? '';
  const initialStrong = feed.fetchOptions.translateStrong === true;
  const [userAgent, setUserAgent] = useState(initialAgent);
  const [strong, setStrong] = useState(initialStrong);
  const [agentError, setAgentError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);

  const dirty = userAgent.trim() !== initialAgent || strong !== initialStrong;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The options replace the stored ones as a whole, so only what is set is sent.
    const candidate: AdminFetchOptions = {
      ...(userAgent.trim() === '' ? {} : { userAgent: userAgent.trim() }),
      ...(strong ? { translateStrong: true } : {}),
    };
    const parsed = AdminFetchOptionsSchema.safeParse(candidate);
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((issue) => issue.code === 'too_big');
      setAgentError(t(tooLong ? 'feeds.options.agentTooLong' : 'feeds.options.agentAscii'));
      return;
    }
    setAgentError(undefined);
    setFailure(null);
    try {
      await update.mutateAsync({ params: { id: feed.id }, body: { fetchOptions: parsed.data } });
      toast.show({ message: t('feeds.options.saved'), tone: 'success' });
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!update.isPending}
      title={t('feeds.options.title', { name })}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <TextField
          label={t('feeds.options.agent')}
          hint={t('feeds.options.agentHint')}
          value={userAgent}
          onChange={(event) => setUserAgent(event.target.value)}
          error={agentError}
          autoComplete="off"
          spellCheck={false}
        />
        <Checkbox
          label={t('feeds.options.strong')}
          hint={t('feeds.options.strongHint')}
          checked={strong}
          onChange={(event) => setStrong(event.target.checked)}
        />
        {failure === null ? null : <Alert>{errorMessage(t, failure)}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={update.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            {t('feeds.options.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
