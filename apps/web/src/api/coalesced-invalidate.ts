import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

interface KeyState {
  /** Another invalidation arrived while this key's refetch ran. */
  again: boolean;
}

const running = new WeakMap<QueryClient, Map<string, KeyState>>();

/**
 * Invalidates `queryKey` with at most one of these refetches running per key: an invalidation that
 * arrives while one runs is folded into a single refetch after it. A plain invalidation cancels the
 * running fetch and starts another, but the server still finishes the cancelled request, so a burst
 * of reader actions would pile up identical count and learning queries in the API (D-259).
 */
export function invalidateCoalesced(queryClient: QueryClient, queryKey: QueryKey): void {
  let keys = running.get(queryClient);
  if (keys === undefined) {
    keys = new Map();
    running.set(queryClient, keys);
  }
  const hash = hashKey(queryKey);
  const current = keys.get(hash);
  if (current !== undefined) {
    current.again = true;
    return;
  }
  const state: KeyState = { again: false };
  keys.set(hash, state);
  void queryClient
    .invalidateQueries({ queryKey })
    .catch(() => undefined)
    .finally(() => {
      keys.delete(hash);
      if (state.again) invalidateCoalesced(queryClient, queryKey);
    });
}
