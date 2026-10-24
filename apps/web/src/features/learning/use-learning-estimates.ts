import { useQuery } from '@tanstack/react-query';

import type { ApiClient } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';

export function learningEstimatesKey(accountId: string) {
  return accountKey(accountId, 'learning-estimates');
}

export function learningEstimatesQueryOptions(api: ApiClient, accountId: string) {
  return {
    queryKey: learningEstimatesKey(accountId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.call(routes.meLearningEstimates, undefined, { signal }),
    staleTime: 60_000,
  };
}

export function useLearningEstimates(enabled = true) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({ ...learningEstimatesQueryOptions(api, accountId), enabled });
}
