import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId, useSession } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';

/**
 * Deletes a rule of the person's (`DELETE /rules/:id`). A rule changes the ranking, so the
 * articles are loaded again. An answer that comes after the sign-in that asked has ended shows
 * nothing and calls nothing back.
 */
export function useRuleRemoval() {
  const { t } = useTranslation('article');
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useSession();
  const accountId = useAccountId();

  const remove = useApiMutation(routes.ruleDelete, {
    onMutate: () => session.currentSignIn(),
    onSuccess: (_answer, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
      toast.show({ message: t('rules.removed'), tone: 'info' });
    },
    onError: (error, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  return {
    /** A deletion is on its way; another would race it. */
    pending: remove.isPending,
    remove: (ruleId: string, then?: () => void) => {
      remove.mutate(
        { params: { id: ruleId } },
        then === undefined
          ? undefined
          : {
              onSuccess: (_answer, _variables, signIn) => {
                if (session.currentSignIn() === signIn) then();
              },
            },
      );
    },
  };
}
