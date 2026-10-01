import { QuotaExceededError, type QuotaUsage } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';

/**
 * Quota usage (spec 08 §6): the resulting distinct holdings counted by each limit. Interest cards
 * include `never` cards; forks are private interest-card forks (label forks count toward labels,
 * not `maxForks`). Retired historical rows are not counted. M4-T10 adds enforcement helpers.
 */
export async function quotaUsage(tx: TenantTx): Promise<QuotaUsage> {
  const user = tenantUserId(tx);
  const result = await tx.execute<QuotaUsage>(sql`
    SELECT (SELECT count(*)::int FROM subscriptions WHERE user_id = ${user}::uuid) AS "maxFeeds",
           (SELECT count(*)::int FROM user_cards WHERE user_id = ${user}::uuid) AS "maxCards",
           (SELECT count(*)::int FROM user_labels WHERE user_id = ${user}::uuid) AS "maxLabels",
           (SELECT count(*)::int FROM user_cards uc
              JOIN interest_cards c ON c.id = uc.card_id AND c.kind = 'interest'
             WHERE uc.user_id = ${user}::uuid AND c.visibility = 'private') AS "maxForks",
           (SELECT count(*)::int FROM user_rules
             WHERE user_id = ${user}::uuid AND (expires_at IS NULL OR expires_at > now())) AS "maxRules"`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('quota usage query returned no row');
  return row;
}

/**
 * Enforce a counted limit before adding `adding` holdings (spec 08 §6): the caller holds its
 * `users` row lock (spec 08 §1.1), so the count cannot change before the insert. Throws
 * `409 QUOTA_EXCEEDED {limit, used, max}` when `used + adding` would exceed `max`; `used` is the
 * current count. Existing holdings are no-ops and must not be counted in `adding`.
 */
export async function assertQuotaRoom(
  tx: TenantTx,
  limit: keyof QuotaUsage,
  max: number,
  adding = 1,
): Promise<number> {
  const used = (await quotaUsage(tx))[limit];
  if (adding > 0 && used + adding > max) throw new QuotaExceededError(limit, used, max);
  return used;
}
