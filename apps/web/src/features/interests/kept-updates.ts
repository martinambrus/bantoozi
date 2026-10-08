import { useCallback, useSyncExternalStore } from 'react';

import { useAccountId } from '../../session/context.js';
import { onAccountKeysCleared } from '../../session/local-keys.js';
import type { UpdateOffer } from './queries.js';

/**
 * "Keep my current version" has no API: the library keeps offering the update, so the choice lives
 * in this browser. It is stored under the account id, for the held card and the offered version,
 * so a newer version of the same card is offered again. A browser that refuses to store it keeps
 * the choice in memory for the session.
 */
const MARKER = ':interests:keep:';

const remembered = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function changed() {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

function keyOf(accountId: string, offer: Pick<UpdateOffer, 'currentCardId' | 'toVersion'>) {
  return `${accountId}${MARKER}${offer.currentCardId}:${offer.toVersion}`;
}

function isStored(key: string): boolean {
  if (remembered.has(key)) return true;
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function store(key: string) {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    remembered.add(key);
  }
  changed();
}

// The keys go with the account's other local keys; the copies in this tab go with them.
onAccountKeysCleared((accountId) => {
  for (const key of [...remembered]) if (key.startsWith(`${accountId}:`)) remembered.delete(key);
  changed();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab keeping an offer changes the storage under this one.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useKeptOffers() {
  const accountId = useAccountId();
  // Re-render whenever a choice is made, forgotten or made in another tab.
  useSyncExternalStore(subscribe, () => revision);
  const isKept = useCallback(
    (offer: UpdateOffer) => isStored(keyOf(accountId, offer)),
    [accountId],
  );
  const keep = useCallback((offer: UpdateOffer) => store(keyOf(accountId, offer)), [accountId]);
  return { isKept, keep };
}
