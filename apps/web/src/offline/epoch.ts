const clears = new Map<string, number>();

/** How many times this page cleared the account's data, so a write begun before that can tell. */
export function clearsOf(accountId: string): number {
  return clears.get(accountId) ?? 0;
}

export function noteClear(accountId: string): void {
  clears.set(accountId, clearsOf(accountId) + 1);
}
