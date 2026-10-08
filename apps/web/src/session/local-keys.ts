import { isAccountId } from '../offline/names.js';

/**
 * The localStorage keys of an account all start with its id and a colon. They are dropped in one
 * place when the account leaves the device, and the stores that keep a copy of them in memory
 * (kept library updates, dismissed notices) listen here to drop theirs.
 */

const listeners = new Set<(accountId: string) => void>();

function tell(accountId: string) {
  for (const listener of [...listeners]) {
    try {
      listener(accountId);
    } catch (error) {
      console.error('An account keys listener failed', error);
    }
  }
}

/** Removes every localStorage key of the account, and the copies in memory with them. */
export function clearAccountKeys(accountId: string): void {
  if (!isAccountId(accountId)) return;
  try {
    const prefix = `${accountId}:`;
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage that cannot be read holds nothing that could be shown again.
  }
  tell(accountId);
}

/** Drops only this tab's copies in memory, because the tab that signed out cleared the storage. */
export function forgetAccountMemory(accountId: string): void {
  if (isAccountId(accountId)) tell(accountId);
}

/** Calls `listener` with the account whose keys were cleared or whose memory is to be dropped. */
export function onAccountKeysCleared(listener: (accountId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
