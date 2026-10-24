import { enqueueEstimate, enqueueEstimateMany, type JobSender } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/**
 * Records `user.estimate` (visible-learning §4.4) when a reader action changed an explicit rating or
 * its time: rate, un-rate, prompt answer, bulk rate and the undo of any of them, but not a hide of an
 * unrated article. `changes` are the rank-relevant changes of the action (`ReaderRankChange`); the
 * intent is debounced per user and the job trains only when its inputs changed, so no threshold
 * applies.
 */
export async function recordEstimateIntent(
  outbox: JobSender,
  userId: string,
  changes: readonly { ratingValueChanged?: boolean }[],
): Promise<void> {
  if (changes.some((change) => change.ratingValueChanged === true)) {
    await enqueueEstimate(outbox, { userId });
  }
}

/** Wake explicit raters of changed article inputs, including ratings a merge is about to remove. */
export async function recordArticleEstimateIntents(
  tx: Transaction,
  outbox: JobSender,
  articleIds: readonly string[],
): Promise<void> {
  if (articleIds.length === 0) return;
  await recordRaterEstimateIntents(
    tx,
    outbox,
    sql`ua.article_id = ANY(${sql.param([...articleIds])}::bigint[])`,
  );
}

/** Bound carrier changes to explicit raters of the feeds' articles and the affected readers. */
export async function recordFeedEstimateIntents(
  tx: Transaction,
  outbox: JobSender,
  feedIds: readonly string[],
  userIds: readonly string[],
): Promise<void> {
  if (feedIds.length === 0 || userIds.length === 0) return;
  await recordRaterEstimateIntents(
    tx,
    outbox,
    sql`ua.user_id = ANY(${sql.param([...userIds])}::uuid[])
        AND EXISTS (SELECT 1 FROM feed_items fi WHERE fi.article_id = ua.article_id
                     AND fi.feed_id = ANY(${sql.param([...feedIds])}::bigint[]))`,
  );
}

async function recordRaterEstimateIntents(
  tx: Transaction,
  outbox: JobSender,
  affected: SQL,
): Promise<void> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT ua.user_id::text AS user_id FROM user_article ua
      JOIN users u ON u.id = ua.user_id AND u.deleted_at IS NULL
     WHERE ua.rating IN (1, -1) AND ${affected}
     ORDER BY user_id`);
  await enqueueEstimateMany(
    outbox,
    result.rows.map((row) => row.user_id),
  );
}
