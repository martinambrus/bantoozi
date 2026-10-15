import { autoAdmissionAllowance } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/**
 * The per-feed daily cap on automatic analysis (D-251, spec 05 §1.1). A feed admits at most
 * `floor(cap * (h + 1) / 24)` new arrivals to automatic analysis by the end of UTC hour `h`; the
 * rest of the day's arrivals keep `feed_items.over_cap_limit = cap` and stay unanalysed (a selection
 * or a rating still analyses them). `null` is unlimited.
 */

/** Pipeline states of an article another feed already analysed: a new carrier takes no slot. */
const ANALYSED_STATES = ['enriched', 'matched'];

/**
 * Take one slot of the feed's allowance for today (UTC day of `now`): the claim is one atomic
 * counter update (`claim_auto_admission`, migration 0027), so concurrent arrivals and ratings never
 * exceed it and a rolled-back transaction gives its slot back. `true` when a slot was taken.
 */
export async function claimAutoAdmission(
  db: Executor,
  feedId: string,
  cap: number | null,
  now: Date,
): Promise<boolean> {
  if (cap === null) return true;
  const allowance = autoAdmissionAllowance(cap, now.getUTCHours());
  if (allowance <= 0) return false;
  const result = await db.execute<{ claimed: boolean }>(sql`
    SELECT claim_auto_admission(${feedId}::bigint, ${now.toISOString().slice(0, 10)}::date,
                                ${allowance}::int) AS claimed`);
  return result.rows[0]?.claimed === true;
}

/**
 * Decide the automatic analysis of a newly inserted association (feedId, articleId): when an
 * active subscription admits it (activated at/before it, live account) for a non-stale article
 * that no other feed has analysed yet, it claims a slot; with none left it is marked over cap.
 */
export async function admitArrival(
  db: Executor,
  feedId: string,
  articleId: string,
  cap: number | null,
  now: Date,
): Promise<void> {
  if (cap === null) return;
  const head = await db.execute<{ pipeline_state: string; activated: boolean }>(sql`
    SELECT a.pipeline_state,
           EXISTS (SELECT 1
                     FROM subscriptions s
                     JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
                    WHERE s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                      AND s.inference_activated_at <= fi.first_seen_at
                      AND fi.over_cap_limit IS NULL) AS activated
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${feedId}::bigint AND fi.article_id = ${articleId}::bigint`);
  const row = head.rows[0];
  if (row === undefined || !row.activated) return;
  if (row.pipeline_state === 'stale' || ANALYSED_STATES.includes(row.pipeline_state)) return;
  if (await claimAutoAdmission(db, feedId, cap, now)) return;
  await db.execute(sql`
    UPDATE feed_items SET over_cap_limit = ${cap}::int
     WHERE feed_id = ${feedId}::bigint AND article_id = ${articleId}::bigint`);
}
