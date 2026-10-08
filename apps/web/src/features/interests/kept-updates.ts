import { useCallback, useSyncExternalStore } from 'react';

import { onAccountReset } from '../../session/reset.js';
import { useAccountId } from '../../session/context.js';
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

function forgetAll() {
  remembered.clear();
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.includes(MARKER)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage that cannot be read holds nothing that could be shown again.
  }
  changed();
}

// Whatever the reason, the choices of an account do not outlive its state on this device.
onAccountReset(() => {
  forgetAll();
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
