import type { FeedInfo } from '@bantoozi/shared';
import { useSyncExternalStore } from 'react';

import { onAccountKeysCleared } from '../../session/local-keys.js';

type DismissedFeed = Pick<FeedInfo, 'id' | 'lastErrorAt'>;

const MARK = 'feeds:dead-feed-dismissed';

const listeners = new Set<() => void>();
/** Dismissals of this page load, so a browser that refuses to store them still hides the notice. */
const remembered = new Set<string>();

function guarded<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function storedKeys(): string[] {
  return guarded(
    () =>
      Array.from({ length: localStorage.length }, (_unused, index) =>
        localStorage.key(index),
      ).filter((key): key is string => key !== null),
    [],
  );
}

function feedPrefix(accountId: string, feedId: string): string {
  return `${accountId}:${MARK}:${feedId}:`;
}

/** Account first, so one account's choices never apply to another; the failure time last. */
function dismissalKey(accountId: string, feed: DismissedFeed): string {
  return `${feedPrefix(accountId, feed.id)}${feed.lastErrorAt ?? ''}`;
}

function isDismissed(key: string): boolean {
  return remembered.has(key) || guarded(() => localStorage.getItem(key) !== null, false);
}

/** Hides the notice for this failure; an older dismissal of the same feed is dropped. */
export function dismissNotice(accountId: string, feed: DismissedFeed): void {
  const key = dismissalKey(accountId, feed);
  const prefix = feedPrefix(accountId, feed.id);
  for (const older of [...remembered]) if (older.startsWith(prefix)) remembered.delete(older);
  remembered.add(key);
  guarded(() => {
    for (const stored of storedKeys()) {
      if (stored.startsWith(prefix) && stored !== key) localStorage.removeItem(stored);
    }
    localStorage.setItem(key, '1');
  }, undefined);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** Whether the reader dismissed the notice for this failure of the feed. */
export function useNoticeDismissed(accountId: string, feed: DismissedFeed): boolean {
  const key = dismissalKey(accountId, feed);
  return useSyncExternalStore(
    subscribe,
    () => isDismissed(key),
    () => false,
  );
}

// The keys go with the account's other local keys; the copies in this tab go with them.
onAccountKeysCleared((accountId) => {
  const prefix = `${accountId}:`;
  for (const key of [...remembered]) if (key.startsWith(prefix)) remembered.delete(key);
  notify();
});
