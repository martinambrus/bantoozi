import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/** Priority of automatically admitted new-arrival work (spec 05 §5.3). */
export const MATCH_PRIORITY_AUTOMATIC = 5;

/**
 * Upsert pending (article, card) questions at `revision` (spec 05 §5.3–§5.4, spec 02 §3.3). On
 * conflict the priority is promoted to the minimum; a row already at this revision keeps its lease,
 * attempts and queue time, so another requester never resets live work; a row at an older revision
 * is moved to this one with its lease, attempts, error and due time cleared, and a row already at a
 * NEWER revision is left untouched (a late producer never moves queued work back). Cost attribution
 * stays with a single requester and becomes platform-shared (null) when requesters differ.
 */
export async function upsertMatchQueue(
  tx: Transaction,
  input: {
    articleId: string;
    revision: string;
    cardIds: readonly string[];
    priority?: number;
    userId?: string | null;
  },
): Promise<number> {
  if (input.cardIds.length === 0) return 0;
  const result = await tx.execute(sql`
    INSERT INTO match_queue AS q (article_id, card_id, article_revision, priority, user_id)
    SELECT ${input.articleId}::bigint, c.card_id, ${input.revision}::bigint,
           ${input.priority ?? MATCH_PRIORITY_AUTOMATIC}, ${input.userId ?? null}::uuid
      FROM unnest(${sql.param([...new Set(input.cardIds)])}::bigint[]) AS c(card_id)
    ON CONFLICT (article_id, card_id) DO UPDATE SET
      priority = least(q.priority, EXCLUDED.priority),
      user_id = CASE WHEN q.user_id IS NOT DISTINCT FROM EXCLUDED.user_id THEN q.user_id END,
      lease_token = CASE WHEN q.article_revision = EXCLUDED.article_revision THEN q.lease_token END,
      lease_until = CASE WHEN q.article_revision = EXCLUDED.article_revision THEN q.lease_until END,
      attempts = CASE WHEN q.article_revision = EXCLUDED.article_revision THEN q.attempts ELSE 0 END,
      last_error = CASE WHEN q.article_revision = EXCLUDED.article_revision THEN q.last_error END,
      next_attempt_at = CASE WHEN q.article_revision = EXCLUDED.article_revision
                             THEN q.next_attempt_at ELSE now() END,
      enqueued_at = CASE WHEN q.article_revision = EXCLUDED.article_revision
                         THEN q.enqueued_at ELSE now() END,
      article_revision = EXCLUDED.article_revision
    WHERE q.article_revision <= EXCLUDED.article_revision`);
  return result.rowCount ?? 0;
}

/** Remove queued questions of older revisions (a reset replaces them, spec 05 §5.6). */
export async function dropStaleMatchQueue(
  tx: Transaction,
  articleId: string,
  revision: string,
): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM match_queue
     WHERE article_id = ${articleId}::bigint AND article_revision <> ${revision}::bigint`);
  return result.rowCount ?? 0;
}
