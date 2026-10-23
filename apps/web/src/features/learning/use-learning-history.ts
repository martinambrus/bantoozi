import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { learningKey } from './use-learning.js';

/** Nested under `learningKey`, so whatever marks the learning status stale marks the curve too. */
export function learningHistoryKey(accountId: string) {
  return accountKey(...learningKey(accountId), 'history');
}

/** The updates that trained the word estimates and the personal model, oldest first. */
export function useLearningHistory() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: learningHistoryKey(accountId),
    queryFn: ({ signal }) => api.call(routes.meLearningHistory, undefined, { signal }),
  });
}
