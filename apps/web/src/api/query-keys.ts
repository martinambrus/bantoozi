/**
 * Every account-scoped query key starts with the account id (spec 09 §1), so the cache of one
 * account can never answer for another. Features build their keys with `accountKey`:
 *
 *     accountKey(accountId, 'articles', 'list', filters)
 *
 * A key that does not begin with an account id belongs to the few things that exist before one is
 * known; they are listed in this file.
 */
export function accountKey<const Parts extends readonly unknown[]>(
  accountId: string,
  ...parts: Parts
): readonly [accountId: string, ...Parts] {
  return [accountId, ...parts];
}

/** The signed-in account (`Me`, or `null` when signed out): the one key without an account id. */
export function meKey() {
  return ['session', 'me'] as const;
}
