import type { IdChange } from '@bantoozi/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { errorMessage, quotaDetails } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useCardCache } from '../interests/queries.js';

export type Side = 'yes' | 'no';

/** Where the cards the drawer lists went: stored id to the id of the card that took its place. */
type Moves = ReadonlyMap<string, string>;

function withMove(moves: Moves, { from, to }: IdChange): Moves {
  const next = new Map(moves);
  for (const [stored, current] of next) {
    if (current === from) next.set(stored, to);
  }
  next.set(from, to);
  return next;
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
  const [moves, setMoves] = useState<Moves>(new Map());

  const teach = useApiMutation(routes.cardExampleAdd, {
    onSuccess: ({ card, idChange }, variables) => {
      if (idChange !== null) setMoves((current) => withMove(current, idChange));
      cache.apply({ card, idChange });
      toast.show({
        message: t(variables.body.side === 'no' ? 'interests.learnedNot' : 'interests.learnedYes', {
          title: card.title,
        }),
        tone: 'success',
      });
    },
    onError: (error) => {
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
    },
  });

  const currentId = (storedId: string) => moves.get(storedId) ?? storedId;
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
