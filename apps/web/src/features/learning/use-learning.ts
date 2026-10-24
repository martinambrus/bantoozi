import { useQuery } from '@tanstack/react-query';

import type { ApiClient } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';

const LEARNING_STALE_MS = 60_000;

/** The cache entry of `GET /me/learning`: the personal model's progress and the feeds' agreement. */
export function learningKey(accountId: string) {
  return accountKey(accountId, 'learning');
}

export function learningQueryOptions(api: ApiClient, accountId: string) {
  return {
    queryKey: learningKey(accountId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.call(routes.meLearning, undefined, { signal }),
    staleTime: LEARNING_STALE_MS,
  };
}

export function useLearning(enabled = true) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({ ...learningQueryOptions(api, accountId), enabled });
}
