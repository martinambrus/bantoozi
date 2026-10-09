import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { useSubscriptionsCache } from './subscriptions.js';

/**
 * Ends the subscription and takes the feed out of the cached list; a failure is thrown. An answer
 * that comes after the sign-in that asked has ended is not announced to whoever is signed in now.
 */
function useUnsubscribe(): (feedId: string, title: string) => Promise<void> {
  const { t } = useTranslation('feeds');
  const toast = useToast();
  const session = useSession();
  const cache = useSubscriptionsCache();
  const { mutateAsync } = useApiMutation(routes.subscriptionsDelete);
  return useCallback(
    async (feedId, title) => {
      const signIn = session.currentSignIn();
      await mutateAsync({ params: { feedId } });
      cache.remove(feedId);
      void cache.refresh();
      if (session.currentSignIn() === signIn) {
        toast.show({ message: t('unsubscribe.done', { title }), tone: 'success' });
      }
    },
    [mutateAsync, cache, session, toast, t],
  );
}

export interface UnsubscribeDialogProps {
  open: boolean;
  onClose: () => void;
  feedId: string;
  /** The title the feed is shown with. */
  title: string;
  /** Runs once the subscription is gone, before the question closes. */
  onUnsubscribed?: (() => void) | undefined;
}

export function UnsubscribeDialog({
  open,
  onClose,
  feedId,
  title,
  onUnsubscribed,
}: UnsubscribeDialogProps) {
  const { t } = useTranslation('feeds');
  const unsubscribe = useUnsubscribe();
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      danger
      title={t('unsubscribe.title', { title })}
      body={t('unsubscribe.body')}
      confirmLabel={t('unsubscribe.confirm')}
      onConfirm={async () => {
        await unsubscribe(feedId, title);
        onUnsubscribed?.();
      }}
    />
  );
}
