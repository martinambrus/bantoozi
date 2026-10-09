import type { ArticleViewLane, UserPreferences } from '@bantoozi/shared';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import type { ApiClient } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { subscriptionsKey } from '../feeds/subscriptions.js';
import { scopeOf, usesSort, usesTier, type ReaderView, type ViewScope } from './view.js';

export const PAGE_SIZE = 30;

/** The parameters of `GET /articles` that tell one list from another (spec 08 §5.1). */
export interface ListFilter extends ViewScope {
  lane: ArticleViewLane;
  minTier?: number;
  sort?: 'score' | 'date';
}

type Settings = Pick<UserPreferences, 'defaultTier' | 'sort'>;

/** Spec 09 §3.1: the tier filters the lanes that have tiers, the sort only For you. */
export function listFilter(view: ReaderView, settings: Settings): ListFilter {
  return {
    lane: view.lane,
    ...scopeOf(view),
    ...(usesTier(view.lane) ? { minTier: settings.defaultTier } : {}),
    ...(usesSort(view.lane) ? { sort: settings.sort } : {}),
  };
}

/** The cache key of the pages of the view `which` (see `viewKey`) at a tier and a sort. */
export function articleListKey(
  accountId: string,
  which: string,
  minTier: number | undefined,
  sort: ListFilter['sort'],
) {
  return [...articleKeys.all(accountId), 'list', which, { minTier, sort }] as const;
}

/** What says how much is unread: the counts of the lanes, and each feed's in `GET /subscriptions`. */
export function unreadKeys(accountId: string) {
  return [articleKeys.counts(accountId), subscriptionsKey(accountId)] as const;
}

export function countsQueryOptions(
  api: ApiClient,
  accountId: string,
  scope: ViewScope,
  minTier: number,
) {
  return queryOptions({
    queryKey: [...articleKeys.counts(accountId), { ...scope, minTier }] as const,
    queryFn: ({ signal }) =>
      api.call(routes.articleCounts, { query: { ...scope, minTier } }, { signal }),
  });
}

/**
 * The unread counts of a scope; the empty scope is the whole account. A new tier keeps the numbers
 * of the old one until the new ones are there. The scope of a component never changes.
 */
export function useCounts(scope: ViewScope, minTier: number) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    ...countsQueryOptions(api, accountId, scope, minTier),
    placeholderData: keepPreviousData,
  });
}
