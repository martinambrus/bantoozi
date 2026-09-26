import type { Database, Transaction } from '../client.js';
import { sqlState } from '../errors.js';

/** SQLSTATEs of a short transaction that lost a race: unique conflict, serialization, deadlock. */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['23505', '40001', '40P01']);

export interface RetryOptions {
  /** Total attempts, the first included (spec 03 §7: retry up to 3 times). */
  attempts?: number;
  /** Upper bound of the random delay before a retry, in milliseconds. */
  maxJitterMs?: number;
  /** Test seam for the delay. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` in a fresh READ COMMITTED transaction, retrying the whole short transaction with jitter
 * when it fails with a unique conflict, serialization failure or deadlock (spec 03 §7
 * "Concurrency"). Identity code never uses "lookup then insert" without such a conflict path. Any
 * other error, or the last attempt's error, is rethrown unchanged.
 */
export async function retryTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const maxJitterMs = options.maxJitterMs ?? 50;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(fn);
    } catch (error) {
      const state = sqlState(error);
      if (attempt >= attempts || state === undefined || !RETRYABLE_SQLSTATES.has(state))
        throw error;
      await sleep(Math.floor(Math.random() * maxJitterMs));
    }
  }
}
