import type { Me } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';

export type DemotionFlag = keyof Me['preferences']['demote'];

/** The demotions the drawer offers to switch on; depth has no meter of its own. */
export type NeverShowFlag = Exclude<DemotionFlag, 'shallow'>;

/**
 * The quality demotions of the ranking (spec 06 §5): "on" always ranks that kind of article lower,
 * "auto" leaves it to the ranker. They change the ranking, so the articles are loaded again.
 */
export function useDemotions() {
  const { t } = useTranslation('why');
  const toast = useToast();
  const queryClient = useQueryClient();
  const accountId = useAccountId();

  const update = useApiMutation(routes.meUpdate, {
    onSuccess: (me) => {
      queryClient.setQueryData<Me | null>(meKey(), me);
      void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
    onError: (error) => {
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  const send = (flag: DemotionFlag, value: 'on' | 'auto', then: () => void) => {
    update.mutate({ body: { preferences: { demote: { [flag]: value } } } }, { onSuccess: then });
  };

  function reset(flag: DemotionFlag, then: () => void = () => {}) {
    send(flag, 'auto', () => {
      toast.show({ message: t('demote.reset'), tone: 'info' });
      then();
    });
  }

  return {
    /** A change is on its way; another would race it. */
    pending: update.isPending,
    neverShow: (flag: NeverShowFlag) => {
      send(flag, 'on', () => {
        toast.show({
          message: t(`demote.on.${flag}`),
          tone: 'success',
          action: { label: t('common:actions.undo'), onAction: () => reset(flag) },
        });
      });
    },
    reset,
  };
}
