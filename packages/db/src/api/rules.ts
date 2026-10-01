import { AppError, planLimits, QuotaExceededError, type RuleKind } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { recordRankIntents } from '../ingest/rank-intents.js';
import { tenantOutbox } from '../outbox.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Ranking rules (spec 08 §8, spec 06 §3) in the caller's tenant transaction. Writes lock the user's
 * `users` row first (the quota lock of spec 08 §1.1), recheck the rule's reference (a subscribed
 * feed, a story the user can see), count the quota and record the full-rank intent (with its
 * `rank_revision` increment) in the same transaction. Expired rules are gone for the reader:
 * `house.expire-rules` deletes them hourly, and until then they are neither listed, counted nor
 * reused.
 */

export interface UserRule {
  id: string;
  kind: RuleKind;
  /** Keyword, cluster id, feed id, registrable domain or author name. */
  value: string;
  /** The feed's or story's title for id-valued rules, else the value itself. */
  displayValue: string;
  createdAt: Date;
  expiresAt: Date | null;
}

// A type alias (not an interface) so it satisfies the row constraint of `execute`.
type RuleSqlRow = {
  id: string;
  kind: RuleKind;
  value: string;
  display_value: string | null;
  created_at: RawTimestamp;
  expires_at: RawTimestamp | null;
};

const LIVE = sql`(r.expires_at IS NULL OR r.expires_at > now())`;

async function selectRules(tx: TenantTx, filter: SQL): Promise<UserRule[]> {
  const userId = tenantUserId(tx);
  // Feed and story names only through the user's own subscription or reading list.
  const result = await tx.execute<RuleSqlRow>(sql`
    SELECT r.id::text AS id, r.kind, r.value, r.created_at, r.expires_at,
           CASE
             WHEN r.kind IN ('block_feed', 'boost_feed') THEN
               (SELECT coalesce(s.title_override, f.title, f.url)
                  FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
                 WHERE s.user_id = r.user_id AND s.feed_id::text = r.value)
             WHEN r.kind = 'mute_story' THEN
               (SELECT a.title FROM story_clusters sc JOIN articles a ON a.id = sc.representative_article_id
                 WHERE sc.id::text = r.value
                   AND (EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s
                                  ON s.feed_id = fi.feed_id AND s.user_id = r.user_id
                                 WHERE fi.article_id = a.id)
                        OR EXISTS (SELECT 1 FROM user_article ua
                                    WHERE ua.user_id = r.user_id AND ua.article_id = a.id)))
           END AS display_value
      FROM user_rules r
     WHERE r.user_id = ${userId}::uuid AND ${LIVE} ${filter}
     ORDER BY r.created_at, r.id`);
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    value: row.value,
    displayValue: row.display_value ?? row.value,
    createdAt: toDate(row.created_at),
    expiresAt: toDateOrNull(row.expires_at),
  }));
}

/** `GET /rules`: the user's live rules, oldest first. */
export function listUserRules(tx: TenantTx): Promise<UserRule[]> {
  return selectRules(tx, sql``);
}

const notFound = (what: string) =>
  new AppError('NOT_FOUND', `${what} not found`, { details: { resource: what } });

/** Lock the caller's `users` row (first in the lock order) and read its plan's rule limit. */
async function lockRuleOwner(tx: TenantTx): Promise<{ userId: string; maxRules: number }> {
  const userId = tenantUserId(tx);
  const result = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`);
  const row = result.rows[0];
  if (row === undefined) throw new AppError('UNAUTHENTICATED', 'No active account');
  return { userId, maxRules: planLimits(row.plan).maxRules };
}

/**
 * The rule's reference must be the user's: a feed id of one of their subscriptions, or a story
 * cluster with a member article carried by one of their subscriptions or on their reading list.
 * Anything else is `404`, exactly like a missing id (spec 08 §1 "Authorization").
 */
async function requireReference(
  tx: TenantTx,
  userId: string,
  kind: RuleKind,
  value: string,
): Promise<void> {
  if (kind === 'block_feed' || kind === 'boost_feed') {
    const result = await tx.execute(sql`
      SELECT 1 FROM subscriptions
       WHERE user_id = ${userId}::uuid AND feed_id = ${value}::bigint FOR KEY SHARE`);
    if (result.rows.length === 0) throw notFound('feed');
  } else if (kind === 'mute_story') {
    const result = await tx.execute(sql`
      SELECT 1 FROM story_clusters sc
       WHERE sc.id = ${value}::bigint
         AND EXISTS (SELECT 1 FROM articles a
                      WHERE a.story_cluster_id = sc.id
                        AND (EXISTS (SELECT 1 FROM feed_items fi JOIN subscriptions s
                                       ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                                      WHERE fi.article_id = a.id)
                             OR EXISTS (SELECT 1 FROM user_article ua
                                         WHERE ua.user_id = ${userId}::uuid AND ua.article_id = a.id)))
       FOR KEY SHARE OF sc`);
    if (result.rows.length === 0) throw notFound('story');
  }
}

export interface CreateUserRuleInput {
  kind: RuleKind;
  /** Already normalized per kind by the caller (trimmed keyword, registrable domain, decimal id). */
  value: string;
  /** Days until the rule expires; `null` for a permanent rule (never for `mute_story`). */
  expiresInDays: number | null;
}

export interface CreatedUserRule {
  rule: UserRule;
  /** False when a live identical rule already existed (its expiry may have been extended). */
  created: boolean;
}

/**
 * `POST /rules` (and the API's mute-story action): create a live rule, or return the live rule of the
 * same kind and value. An existing rule keeps the later expiry of the two (`null` = never), so a
 * repeated mute extends it but never shortens it. Quota `maxRules` counts live rules; a returned
 * existing rule uses none. Any change records `user.rank {full: true}` (spec 06 §7).
 */
export async function createUserRule(
  tx: TenantTx,
  input: CreateUserRuleInput,
): Promise<CreatedUserRule> {
  if (input.kind === 'mute_story' && input.expiresInDays === null) {
    throw new AppError('VALIDATION_FAILED', 'A muted story needs an expiry', {
      details: { field: 'expiresInDays', reason: 'required' },
    });
  }
  const { userId, maxRules } = await lockRuleOwner(tx);
  await requireReference(tx, userId, input.kind, input.value);
  const expiresAt =
    input.expiresInDays === null
      ? sql`NULL::timestamptz`
      : sql`now() + make_interval(days => ${input.expiresInDays}::int)`;

  const existing = await tx.execute<{ id: string }>(sql`
    SELECT r.id::text AS id FROM user_rules r
     WHERE r.user_id = ${userId}::uuid AND r.kind = ${input.kind} AND r.value = ${input.value}
       AND ${LIVE}
     ORDER BY r.id LIMIT 1 FOR UPDATE`);
  const found = existing.rows[0];
  let id: string;
  let changed: boolean;
  if (found !== undefined) {
    const extended = await tx.execute(sql`
      UPDATE user_rules r
         SET expires_at = CASE WHEN r.kind = 'mute_story' THEN greatest(r.expires_at, ${expiresAt})
                               WHEN r.expires_at IS NULL OR ${expiresAt} IS NULL THEN NULL
                               ELSE greatest(r.expires_at, ${expiresAt}) END
       WHERE r.id = ${found.id}::bigint
         AND r.expires_at IS DISTINCT FROM
             (CASE WHEN r.kind = 'mute_story' THEN greatest(r.expires_at, ${expiresAt})
                   WHEN r.expires_at IS NULL OR ${expiresAt} IS NULL THEN NULL
                   ELSE greatest(r.expires_at, ${expiresAt}) END)`);
    id = found.id;
    changed = (extended.rowCount ?? 0) > 0;
  } else {
    const counted = await tx.execute<{ used: number }>(sql`
      SELECT count(*)::int AS used FROM user_rules r WHERE r.user_id = ${userId}::uuid AND ${LIVE}`);
    const used = counted.rows[0]?.used ?? 0;
    if (used + 1 > maxRules) throw new QuotaExceededError('maxRules', used, maxRules);
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO user_rules (user_id, kind, value, expires_at)
      VALUES (${userId}::uuid, ${input.kind}, ${input.value}, ${expiresAt})
      RETURNING id::text AS id`);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('rule insert returned no row');
    id = row.id;
    changed = true;
  }
  if (changed) {
    await recordRankIntents(tx, tenantOutbox(tx), [userId], { reason: 'rules', full: true });
  }
  const [rule] = await selectRules(tx, sql`AND r.id = ${id}::bigint`);
  if (rule === undefined) throw new Error('created rule is not readable');
  return { rule, created: found === undefined };
}

/**
 * `DELETE /rules/:id`: delete one of the user's live rules and record `user.rank {full: true}`.
 * Another user's, an expired or a missing rule is `404`.
 */
export async function deleteUserRule(tx: TenantTx, ruleId: string): Promise<void> {
  const { userId } = await lockRuleOwner(tx);
  const result = await tx.execute(sql`
    DELETE FROM user_rules r
     WHERE r.user_id = ${userId}::uuid AND r.id = ${ruleId}::bigint AND ${LIVE}`);
  if ((result.rowCount ?? 0) === 0) throw notFound('rule');
  await recordRankIntents(tx, tenantOutbox(tx), [userId], { reason: 'rules', full: true });
}
