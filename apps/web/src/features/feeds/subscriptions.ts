import type { Subscription } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId, useSignInLasts } from '../../session/context.js';

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

/**
 * Ways to keep the cached list in step with what a mutation just did; nothing changes once the
 * sign-in the screen was mounted in has ended.
 */
export function useSubscriptionsCache() {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const lasts = useSignInLasts();
  return useMemo(() => {
    const key = subscriptionsKey(accountId);
    return {
      known: () => queryClient.getQueryData<Subscription[]>(key),
      replace: (subscription: Subscription) => {
        if (!lasts()) return undefined;
        return writeQueryData<Subscription[]>(queryClient, key, (list) =>
          list?.map((item) => (item.feed.id === subscription.feed.id ? subscription : item)),
        );
      },
      /** Takes in only the classification fields of an answer: the rest can predate the list. */
      mergeInference: (subscription: Subscription) => {
        if (!lasts()) return undefined;
        return writeQueryData<Subscription[]>(queryClient, key, (list) =>
          list?.map((item) =>
            item.feed.id === subscription.feed.id
              ? {
                  ...item,
                  inferenceMode: subscription.inferenceMode,
                  inferenceVersion: subscription.inferenceVersion,
                  inferenceActivatedAt: subscription.inferenceActivatedAt,
                }
              : item,
          ),
        );
      },
      remove: (feedId: string) => {
        if (!lasts()) return undefined;
        return writeQueryData<Subscription[]>(queryClient, key, (list) =>
          list?.filter((item) => item.feed.id !== feedId),
        );
      },
      refresh: () => {
        if (!lasts()) return Promise.resolve();
        return queryClient.invalidateQueries({ queryKey: key });
      },
    };
  }, [queryClient, accountId, lasts]);
}
