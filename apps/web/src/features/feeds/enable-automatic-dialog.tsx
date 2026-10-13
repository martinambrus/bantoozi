import type { LearningFeedAgreement, Subscription } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useAccountId } from '../../session/context.js';
import { useAgreementText } from '../learning/agreement-text.js';
import { learningKey } from '../learning/use-learning.js';
import { displayTitle } from './folders.js';
import { useSubscriptionsCache } from './subscriptions.js';

export interface EnableAutomaticDialogProps {
  open: boolean;
  onClose: () => void;
  subscription: Subscription;
  agreement: LearningFeedAgreement;
}

/** The confirmation before a training feed becomes active: nothing switches without it. */
export function EnableAutomaticDialog({
  open,
  onClose,
  subscription,
  agreement,
}: EnableAutomaticDialogProps) {
  const { t } = useTranslation('feeds');
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const cache = useSubscriptionsCache();
  const evidence = useAgreementText(agreement, true);
  const { mutateAsync } = useApiMutation(routes.subscriptionsSetInference);
  const title = displayTitle(subscription);
  const weekly = agreement.articlesPerWeek;

  async function enable() {
    try {
      const { subscription: updated } = await mutateAsync({
        params: { feedId: subscription.feed.id },
        body: { mode: 'active', expectedVersion: subscription.inferenceVersion },
      });
      cache.mergeInference(updated);
      void queryClient.invalidateQueries({ queryKey: learningKey(accountId) });
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_STATE') void cache.refresh();
      throw error;
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={enable}
      title={t('enableAutomatic.title', { title })}
      body={
        <>
          <span>{evidence}</span>{' '}
          <span>
            {weekly === null
              ? t('enableAutomatic.noCount')
              : t('enableAutomatic.weekly', { count: weekly })}
          </span>
        </>
      }
      confirmLabel={t('classification.enable')}
    />
  );
}
