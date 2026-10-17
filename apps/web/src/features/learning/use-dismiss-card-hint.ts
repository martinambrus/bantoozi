import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { learningKey } from './use-learning.js';

/**
 * "Not now" on a feed's card hint (D-265): the server stops counting the ratings so far toward it,
 * then the learning status is read again, so the hint goes away until newer ratings call for it.
 */
export function useDismissCardHint(): (
  feedId: string,
  kind: 'interest' | 'never',
) => Promise<void> {
  const api = useApi();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  return useCallback(
    async (feedId, kind) => {
      await api.call(routes.subscriptionCardHintDismiss, { params: { feedId }, body: { kind } });
      await queryClient.invalidateQueries({ queryKey: learningKey(accountId) });
    },
    [api, queryClient, accountId],
  );
}
