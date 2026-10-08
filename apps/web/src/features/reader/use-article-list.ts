import type { ArticleListItem, ArticleListResponse, UserPreferences } from '@bantoozi/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { PAGE_SIZE, articleListKey, listFilter } from './queries.js';
import { viewKey, type ReaderView } from './view.js';

type Pages = InfiniteData<ArticleListResponse, string | undefined>;

/** A page after the first could not be asked for any more: the list has to start again. */
class CursorRefused extends Error {}

export function isCursorRefused(error: unknown): boolean {
  return error instanceof CursorRefused;
}

// 409 STALE_CURSOR, or the 400 of a cursor that expired (spec 08 §5.1).
function refusesCursor(error: unknown): boolean {
  return isApiError(error) && (error.code === 'STALE_CURSOR' || error.status === 400);
}

/**
 * The pages of a view (spec 09 §1, §3.1). A list the reader asks to start again, or whose next page
 * was refused, starts from page one, because a cursor belongs to the list it came from. Nothing
 * refetches it on focus, reconnect or mount: a list that moves while it is read is worse than one
 * that is a little old.
 */
export function useArticleList(
  view: ReaderView,
  settings: Pick<UserPreferences, 'defaultTier' | 'sort'>,
) {
  const api = useApi();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const filter = listFilter(view, settings);
  const which = viewKey(view);
  const { minTier, sort } = filter;
  const queryKey = useMemo(
    () => articleListKey(accountId, which, minTier, sort),
    [accountId, which, minTier, sort],
  );

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await api.call(
          routes.articleList,
          {
            query: {
              ...filter,
              limit: PAGE_SIZE,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
          { signal },
        );
      } catch (error) {
        if (pageParam !== undefined && refusesCursor(error))
          throw new CursorRefused('The list has to start again.', { cause: error });
        throw error;
      }
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A tier or a sort that changes keeps the rows until the new ones are there. A new view starts
    // empty, because the page below is remounted for each view.
    placeholderData: keepPreviousData,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data, fetchNextPage, hasNextPage, isFetching, isPlaceholderData } = query;

  const items = useMemo(() => {
    const seen = new Set<string>();
    const unique: ArticleListItem[] = [];
    for (const item of (data?.pages ?? []).flatMap((page) => page.items)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      unique.push(item);
    }
    return unique;
  }, [data]);

  const reload = useCallback(async () => {
    queryClient.setQueryData<Pages>(queryKey, (current) =>
      current === undefined
        ? undefined
        : { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) },
    );
    await queryClient.refetchQueries({ queryKey, exact: true });
  }, [queryClient, queryKey]);

  // Every page that is loaded, one after the other. If a cursor of the chain is refused the rows stay
  // as they are: only the reader's own request for more starts the list again.
  const poll = useCallback(
    () => queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false }),
    [queryClient, queryKey],
  );

  const canLoadMore = hasNextPage && !isPlaceholderData;
  const loadMore = useCallback(async () => {
    if (!canLoadMore || isFetching) return;
    const result = await fetchNextPage();
    if (result.isError && isCursorRefused(result.error)) await reload();
  }, [canLoadMore, isFetching, fetchNextPage, reload]);

  return {
    query,
    items,
    rankingPending: data?.pages.at(-1)?.rankingPending ?? false,
    canLoadMore,
    loadMore,
    reload,
    poll,
  };
}
