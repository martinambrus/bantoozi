import { enqueueRank, type JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/**
 * Rank intents for ingestion events (spec 06 §7 "Enqueued by", spec 03 §7). Incremental runs are
 * debounced per user and find new or changed items through their dirty set. A full run is a
 * user-specific rank invalidation: it increments `users.rank_revision` in the same transaction,
 * so partial or older runs are detected, and uses its own queue key, so a pending incremental job
 * can never swallow it.
 */
export async function recordRankIntents(
  tx: Transaction,
  sender: JobSender,
  userIds: readonly string[],
  options: { reason: string; full?: boolean },
): Promise<void> {
  const users = [...new Set(userIds)].sort();
  if (users.length === 0) return;
  if (options.full === true) {
    // Lock the user rows in UUID order (the documented lock order), then invalidate.
    await tx.execute(sql`
      UPDATE users u SET rank_revision = u.rank_revision + 1
        FROM (SELECT id FROM users WHERE id = ANY(${sql.param(users)}::uuid[])
               ORDER BY id FOR NO KEY UPDATE) l
       WHERE u.id = l.id AND u.deleted_at IS NULL`);
  }
  for (const userId of users) {
    await enqueueRank(sender, {
      userId,
      reason: options.reason,
      ...(options.full === true ? { full: true } : {}),
    });
  }
}
