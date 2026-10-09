const clears = new Map<string, number>();
const stores = new Map<string, number>();

/** How many times this page cleared the account's data, so a write begun before that can tell. */
export function clearsOf(accountId: string): number {
  return clears.get(accountId) ?? 0;
}

export function noteClear(accountId: string): void {
  clears.set(accountId, clearsOf(accountId) + 1);
}

/** A write of the account passed its last check and begins to store now. */
export function noteStore(accountId: string): void {
  stores.set(accountId, Date.now());
}

/** When this page last began to store rows of the account; 0 when it never did. */
export function lastStoreOf(accountId: string): number {
  return stores.get(accountId) ?? 0;
}
