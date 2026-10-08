import type { Subscription } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';

/** The cache entry of `GET /subscriptions`, shared by every screen that lists the feeds. */
export function subscriptionsKey(accountId: string) {
  return accountKey(accountId, 'subscriptions');
}

export function useSubscriptions() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: subscriptionsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.subscriptionsList, undefined, { signal }),
  });
}

/** Ways to keep the cached list in step with what a mutation just did. */
export function useSubscriptionsCache() {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  return useMemo(() => {
    const key = subscriptionsKey(accountId);
    return {
      known: () => queryClient.getQueryData<Subscription[]>(key),
      replace: (subscription: Subscription) =>
        queryClient.setQueryData<Subscription[]>(key, (list) =>
          list?.map((item) => (item.feed.id === subscription.feed.id ? subscription : item)),
        ),
      remove: (feedId: string) =>
        queryClient.setQueryData<Subscription[]>(key, (list) =>
          list?.filter((item) => item.feed.id !== feedId),
        ),
      refresh: () => queryClient.invalidateQueries({ queryKey: key }),
    };
  }, [queryClient, accountId]);
}
