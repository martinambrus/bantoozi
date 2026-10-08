import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';

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
