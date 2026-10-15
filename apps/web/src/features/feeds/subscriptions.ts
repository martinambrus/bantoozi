import type { AnalyzeResponse, Subscription } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { writeQueryData } from '../../api/cache-writes.js';
import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId, useSignInLasts } from '../../session/context.js';

/** The cache entry of `GET /subscriptions`, shared by every screen that lists the feeds. */
export function subscriptionsKey(accountId: string) {
  return accountKey(accountId, 'subscriptions');
}

/** How often the list is read again while a feed's first fetch is awaited. */
export const FIRST_FETCH_POLL_MS = 3_000;
/** How long a feed is awaited after the list first showed it without a result; a dead worker ends it. */
export const FIRST_FETCH_GIVE_UP_MS = 180_000;

/**
 * When each account's list first showed a feed without a fetch result, keyed by account and feed
 * (feeds are shared between accounts). An entry ends when the feed leaves that account's list, so a
 * new subscription starts a new wait.
 */
const firstSeen = new Map<string, number>();
const seenKey = (accountId: string, feedId: string) => `${accountId}\u0000${feedId}`;

/** Forgets the waits of feeds that are no longer in the account's list. */
function forgetMissing(accountId: string, list: readonly Subscription[]): void {
  const present = new Set(list.map((subscription) => seenKey(accountId, subscription.feed.id)));
  const prefix = seenKey(accountId, '');
  for (const key of firstSeen.keys()) {
    if (key.startsWith(prefix) && !present.has(key)) firstSeen.delete(key);
  }
}

/**
 * True while the first fetch of the feed is queued or running: it has neither succeeded nor failed
 * yet, and the account's list first showed it so within the give-up time (the list has no creation
 * time).
 */
export function isFirstFetchPending(
  subscription: Subscription,
  accountId: string,
  now: number = Date.now(),
): boolean {
  const { feed } = subscription;
  if (feed.status !== 'active' || feed.lastSuccessAt !== null || feed.lastErrorAt !== null) {
    return false;
  }
  const key = seenKey(accountId, feed.id);
  const since = firstSeen.get(key) ?? now;
  firstSeen.set(key, since);
  return now - since < FIRST_FETCH_GIVE_UP_MS;
}

export function useSubscriptions() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: subscriptionsKey(accountId),
    queryFn: async ({ signal }) => {
      const list = await api.call(routes.subscriptionsList, undefined, { signal });
      forgetMissing(accountId, list);
      return list;
    },
    refetchInterval: (query) =>
      query.state.data?.some((subscription) => isFirstFetchPending(subscription, accountId)) ===
      true
        ? FIRST_FETCH_POLL_MS
        : false,
  });
}

/** Whether the feed still awaits its first fetch; re-evaluated when the give-up time passes. */
export function useFirstFetchPending(subscription: Subscription): boolean {
  const accountId = useAccountId();
  const [, setTick] = useState(0);
  const pending = isFirstFetchPending(subscription, accountId);
  const key = seenKey(accountId, subscription.feed.id);
  useEffect(() => {
    if (!pending) return undefined;
    const left = FIRST_FETCH_GIVE_UP_MS - (Date.now() - (firstSeen.get(key) ?? Date.now()));
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(left, 0) + 50);
    return () => clearTimeout(timer);
  }, [pending, key]);
  return pending;
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
      /**
       * Takes in the mode and version an answer reports for one feed, unless the feed has moved past
       * them meanwhile: a late answer must not put back an older version.
       */
      setInference: (feedId: string, inference: AnalyzeResponse['inference']) => {
        if (!lasts()) return undefined;
        return writeQueryData<Subscription[]>(queryClient, key, (list) =>
          list?.map((item) =>
            item.feed.id === feedId && BigInt(inference.version) >= BigInt(item.inferenceVersion)
              ? { ...item, inferenceMode: inference.mode, inferenceVersion: inference.version }
              : item,
          ),
        );
      },
      remove: (feedId: string) => {
        if (!lasts()) return undefined;
        firstSeen.delete(seenKey(accountId, feedId));
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
