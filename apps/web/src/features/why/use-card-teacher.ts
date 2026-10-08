import type { CardDto } from '@bantoozi/shared';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { errorMessage, quotaDetails } from '../../components/error-message.js';
import { useToast, type ToastApi } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { currentCardId } from '../interests/card-moves.js';
import { useCardCache, type cardCache } from '../interests/queries.js';

export type Side = 'yes' | 'no';

/** `t` resolves the keys of the `why` namespace. */
export function announceTaught(
  toast: Pick<ToastApi, 'show'>,
  t: TFunction,
  card: CardDto,
  side: Side,
): void {
  toast.show({
    message: t(side === 'no' ? 'interests.learnedNot' : 'interests.learnedYes', {
      title: card.title,
    }),
    tone: 'success',
  });
}

/** A card that is gone has the cards read again; `t` resolves the keys of the `why` namespace. */
export function announceTeachFailure(
  toast: Pick<ToastApi, 'show'>,
  t: TFunction,
  cache: Pick<ReturnType<typeof cardCache>, 'refreshCards'>,
  error: unknown,
): void {
  if (isApiError(error) && error.status === 404) {
    cache.refreshCards();
    toast.show({ message: t('interests.gone'), tone: 'error' });
    return;
  }
  const quota = quotaDetails(error);
  toast.show({
    message:
      quota?.limit === 'maxForks'
        ? t('interests.forkLimit', { used: quota.used, max: quota.max })
        : errorMessage(t, error),
    tone: 'error',
  });
}

/**
 * "Not really about this" and "Yes, exactly this" (spec 09 §3.5). A card is immutable, so teaching
 * it moves the holding to a private copy with another id: the cards cache takes the new one, and
 * the drawer, which lists the ids the article was scored with, follows the move afterwards.
 */
export function useCardTeacher(articleId: string) {
  const { t } = useTranslation('why');
  const toast = useToast();
  const cache = useCardCache();
  const accountId = useAccountId();

  const teach = useApiMutation(routes.cardExampleAdd, {
    onSuccess: ({ card, idChange }, variables) => {
      cache.apply({ card, idChange });
      announceTaught(toast, t, card, variables.body.side);
    },
    onError: (error) => {
      announceTeachFailure(toast, t, cache, error);
    },
  });

  const currentId = (storedId: string) => currentCardId(accountId, storedId);
  return {
    /** The id the holding of a listed card goes by now. */
    currentId,
    /** An answer is on its way; another would race it. */
    pending: teach.isPending,
    teach: (storedId: string, side: Side) => {
      teach.mutate({ params: { id: currentId(storedId) }, body: { articleId, side } });
    },
  };
}
