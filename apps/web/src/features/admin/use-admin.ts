import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { isApiError } from '../../api/errors.js';
import { accountKey } from '../../api/query-keys.js';
import { useAccountId } from '../../session/context.js';

/** Query keys of the admin screens, all under the signed-in account (spec 09 §1). */
export function useAdminKey() {
  const accountId = useAccountId();
  return useCallback(
    <const Parts extends readonly unknown[]>(...parts: Parts) =>
      accountKey(accountId, 'admin', ...parts),
    [accountId],
  );
}

/** Marks everything cached under one admin screen as stale and loads what is on screen again. */
export function useRefresh() {
  const queryClient = useQueryClient();
  const adminKey = useAdminKey();
  return useCallback(
    (...parts: readonly unknown[]) =>
      queryClient.invalidateQueries({ queryKey: adminKey(...parts) }),
    [queryClient, adminKey],
  );
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** A cursor-paged admin list: the rows loaded so far, in the shape `QueryState` reads. */
export function useAdminPages<T>(
  key: readonly unknown[],
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Paged<T>>,
) {
  const adminKey = useAdminKey();
  const query = useInfiniteQuery({
    queryKey: adminKey(...key),
    queryFn: ({ pageParam, signal }) => load(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items), [query.data]);
  return {
    rows,
    source: { data: rows, error: query.error, status: query.status, refetch: query.refetch },
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
  };
}

/** The `details.reason` of a 409 answer, if that is what the call failed with. */
export function conflictReason(error: unknown): string | undefined {
  return isApiError(error) && error.status === 409 ? error.reason : undefined;
}

export function isStatus(error: unknown, status: number): boolean {
  return isApiError(error) && error.status === status;
}
