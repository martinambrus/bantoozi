import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/**
 * The shared, DB-backed rate limiter (spec 08 §11, spec 02 §6): one atomic `rate_limit_hit()` call
 * per (key, window). Limits therefore hold across API processes and restarts. Keys never contain a
 * plaintext email; callers hash personal subjects first.
 */
export async function rateLimitHit(
  db: Executor,
  input: { key: string; windowSeconds: number; max: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await db.execute<{ allowed: boolean; retry_after_s: number }>(sql`
    SELECT allowed, retry_after_s
      FROM rate_limit_hit(${input.key}, ${input.windowSeconds}::int, ${input.max}::int)`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('rate_limit_hit returned no row');
  return { allowed: row.allowed, retryAfterSeconds: row.retry_after_s };
}
