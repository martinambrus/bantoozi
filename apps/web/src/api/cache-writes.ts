import type { QueryClient, QueryKey, Updater } from '@tanstack/react-query';

/**
 * Asks again for a query whose fetch is on its way. The fetch may have read before a change the app
 * has just written into the cache, and writing the cache leaves it running, so its answer would put
 * the change back as it was; the new request reads the change.
 */
export function readAgainIfFetching(queryClient: QueryClient, queryKey: QueryKey): void {
  void queryClient.refetchQueries({ queryKey, exact: true, fetchStatus: 'fetching' });
}

/** `setQueryData` for a change the app has made, which a fetch made before it cannot undo. */
export function writeQueryData<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updater: Updater<T | undefined, T | undefined>,
): T | undefined {
  const written = queryClient.setQueryData<T>(queryKey, updater);
  readAgainIfFetching(queryClient, queryKey);
  return written;
}

/** `writeQueryData` for every query under `queryKey`, such as each filter's pages of a list. */
export function writeQueriesData<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updater: Updater<T | undefined, T | undefined>,
): void {
  queryClient.setQueriesData<T>({ queryKey }, updater);
  void queryClient.refetchQueries({ queryKey, fetchStatus: 'fetching' });
}
