import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';

/** Everything cached for the rules of the signed-in account. */
export function useRulesKey() {
  return accountKey(useAccountId(), 'rules');
}

export function useRules() {
  const api = useApi();
  const key = useRulesKey();
  return useQuery({
    queryKey: [...key, 'list'],
    queryFn: ({ signal }) => api.call(routes.ruleList, undefined, { signal }),
  });
}

/**
 * After a rule is added or deleted: the rules load again, and so does every article view, since a
 * rule changes what the reader shows and in which order.
 */
export function useRefreshAfterRuleChange(): () => void {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: accountKey(accountId, 'rules') });
    void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
  }, [queryClient, accountId]);
}
