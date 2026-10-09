/** Names and limits of the offline store (spec 09 §1). */

export const OFFLINE_DB = 'bantoozi-offline';
export const OFFLINE_DB_VERSION = 1;

export const STORES = ['meta', 'items', 'views', 'details', 'queue'] as const;
export type StoreName = (typeof STORES)[number];

export const LIMITS = {
  maxItems: 200,
  maxBytes: 10 * 1024 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
} as const;

/** The account that last signed in on this device: `{ id, at }`. */
export const LAST_ACCOUNT_KEY = 'bantoozi:offline:last-account';
/** Set while a sign-out made without a connection still has to reach the server. */
export const PENDING_LOGOUT_KEY = 'bantoozi:offline:pending-logout';
/** The accounts whose stored rows could not be removed yet, as a JSON array of ids. */
export const PENDING_PURGE_KEY = 'bantoozi:offline:pending-purge';

const ENABLED_PREFIX = 'bantoozi:offline:enabled:';

/** Where a device remembers that the account chose to keep articles for offline reading. */
export function enabledKey(accountId: string): string {
  return `${ENABLED_PREFIX}${accountId}`;
}

/** Keys start with the account id and a colon; an id that could blur that boundary is not one. */
export function isAccountId(value: string): boolean {
  return value !== '' && !/[:;]/.test(value);
}

/** The key of one account's row; every private key starts with the account id. */
export function rowKey(accountId: string, name: string): string {
  return `${accountId}:${name}`;
}

/** Every key of the account and no other: `<id>:` up to, not including, `<id>;`. */
export function accountRange(accountId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${accountId}:`, `${accountId};`, false, true);
}
