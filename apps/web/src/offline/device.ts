import {
  LAST_ACCOUNT_KEY,
  PENDING_LOGOUT_KEY,
  PENDING_PURGE_KEY,
  enabledKey,
  isAccountId,
} from './names.js';

/**
 * What this device remembers outside the offline database, in localStorage: the account that last
 * signed in, whether a sign-out still has to reach the server, each account's choice to keep
 * articles for offline reading, and the accounts whose stored rows could not be removed yet. None
 * of it is a token or a cookie.
 */

export interface LastAccount {
  id: string;
  at: number;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing that cannot be removed can be relied on to be there.
  }
}

export function readLastAccount(): LastAccount | null {
  const raw = read(LAST_ACCOUNT_KEY);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      'at' in value &&
      typeof value.id === 'string' &&
      typeof value.at === 'number' &&
      isAccountId(value.id)
    ) {
      return { id: value.id, at: value.at };
    }
  } catch {
    // A marker that cannot be read counts as none.
  }
  return null;
}

export function writeLastAccount(id: string, at: number = Date.now()): void {
  if (isAccountId(id)) write(LAST_ACCOUNT_KEY, JSON.stringify({ id, at }));
}

export function clearLastAccount(): void {
  remove(LAST_ACCOUNT_KEY);
}

// A browser that refuses to store the marker still finishes the sign-out during this page load.
let pendingInMemory = false;

export function isLogoutPending(): boolean {
  return pendingInMemory || read(PENDING_LOGOUT_KEY) !== null;
}

export function markLogoutPending(): void {
  pendingInMemory = !write(PENDING_LOGOUT_KEY, String(Date.now()));
}

export function clearLogoutPending(): void {
  pendingInMemory = false;
  remove(PENDING_LOGOUT_KEY);
}

export function isOfflineEnabled(accountId: string): boolean {
  return isAccountId(accountId) && read(enabledKey(accountId)) === '1';
}

/** Whether the device is now in the state asked for. */
export function writeOfflineEnabled(accountId: string, on: boolean): boolean {
  if (!isAccountId(accountId)) return false;
  if (on) return write(enabledKey(accountId), '1');
  remove(enabledKey(accountId));
  return !isOfflineEnabled(accountId);
}

/**
 * The accounts whose stored rows could not be removed: they count as gone until a start or a
 * sign-in removes them.
 */
export function pendingPurges(): string[] {
  const raw = read(PENDING_PURGE_KEY);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      return value.filter((id): id is string => typeof id === 'string' && isAccountId(id));
    }
  } catch {
    // A list that cannot be read counts as empty.
  }
  return [];
}

export function isPurgePending(accountId: string): boolean {
  return pendingPurges().includes(accountId);
}

export function setPurgePending(accountId: string, pending: boolean): void {
  if (!isAccountId(accountId) || isPurgePending(accountId) === pending) return;
  const others = pendingPurges().filter((id) => id !== accountId);
  const next = pending ? [...others, accountId] : others;
  if (next.length === 0) remove(PENDING_PURGE_KEY);
  else write(PENDING_PURGE_KEY, JSON.stringify(next));
}
