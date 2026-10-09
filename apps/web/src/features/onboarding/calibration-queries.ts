import type { ArticleListItem } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { POLL_MS } from './batch.js';

const LIST_SIZE = 50;

function titles(response: { items: ArticleListItem[] }): ArticleListItem[] {
  return response.items;
}

/**
 * The newest articles a feed already has, with their analysis status. It is asked for again every
 * few seconds for as long as `keepAsking` says so of the articles it last received; without that it
 * is read again only when the articles are invalidated.
 */
export function useFeedArticles(
  feedId: string | null,
  keepAsking?: (items: ArticleListItem[]) => boolean,
) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: [...articleKeys.all(accountId), 'training', 'list', feedId],
    queryFn: ({ signal }) =>
      api.call(
        routes.articleList,
        {
          query: {
            lane: 'all',
            feedId: feedId ?? undefined,
            status: 'all',
            minTier: 1,
            sort: 'date',
            limit: LIST_SIZE,
          },
        },
        { signal },
      ),
    enabled: feedId !== null,
    select: titles,
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      return items !== undefined && keepAsking?.(items) === true ? POLL_MS : false;
    },
  });
}

/** How many of a feed's articles are scored and how many there are (spec 09 §4 step 4). */
export function useFeedCounts(feedId: string | null, polling: boolean) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: [...articleKeys.counts(accountId), 'training', feedId],
    queryFn: ({ signal }) =>
      api.call(
        routes.articleCounts,
        { query: { feedId: feedId ?? undefined, minTier: 1, status: 'all' } },
        { signal },
      ),
    enabled: feedId !== null,
    refetchInterval: polling ? POLL_MS : false,
  });
}

/**
 * The articles offered for rating once enough have been analyzed. They are read once when the round
 * opens and kept as they were, so a rating never reshuffles the list under the person's hand.
 */
export function useCalibrationRound(open: boolean) {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: accountKey(accountId, 'calibration'),
    queryFn: ({ signal }) => api.call(routes.articleCalibration, undefined, { signal }),
    enabled: open,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}
