import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';

const DAY_MS = 24 * 60 * 60_000;
const RATE_LIMIT_RETENTION_DAYS = 8;

const at = (now: Date, days: number): string =>
  new Date(now.getTime() - days * DAY_MS).toISOString();

interface PurgeRule {
  table: string;
  keys: string;
  where: (now: Date) => SQL;
}

/** The retention rules of `house.purge-auth` (spec 11 §5), each deleting rows that expired by `now`. */
export const PURGE_AUTH_RULES = {
  loginCodes: {
    table: 'login_codes',
    keys: 'ctid',
    where: (now) => sql`expires_at <= ${at(now, 1)}::timestamptz`,
  },
  sessions: {
    table: 'sessions',
    keys: 'ctid',
    where: (now) =>
      sql`(expires_at <= ${at(now, 30)}::timestamptz OR revoked_at <= ${at(now, 30)}::timestamptz)`,
  },
  rateLimitBuckets: {
    table: 'rate_limit_buckets',
    keys: 'ctid',
    where: (now) => sql`window_start <= ${at(now, RATE_LIMIT_RETENTION_DAYS)}::timestamptz`,
  },
  originFetchState: {
    table: 'origin_fetch_state',
    keys: 'ctid',
    where: (now) => sql`last_used_at <= ${at(now, 7)}::timestamptz
      AND next_start_at <= ${now.toISOString()}::timestamptz
      AND feed_next_start_at <= ${now.toISOString()}::timestamptz
      AND crawl_delay_s = 0
      AND learned_interval_s * power(0.8, floor(greatest(0, extract(epoch FROM (
        ${now.toISOString()}::timestamptz - learned_updated_at))) / 86400)) < 1
      AND (blocked_until IS NULL OR blocked_until <= ${now.toISOString()}::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(leases) l
                       WHERE (l ->> 'expires_at')::timestamptz > ${now.toISOString()}::timestamptz)`,
  },
  unusedInvites: {
    table: 'invites',
    keys: 'ctid',
    where: (now) => sql`used_at IS NULL AND expires_at <= ${at(now, 30)}::timestamptz`,
  },
  usedInvites: {
    table: 'invites',
    keys: 'ctid',
    where: () => sql`used_at IS NOT NULL AND created_by IS NULL AND used_by IS NULL`,
  },
  waitlist: {
    table: 'waitlist',
    keys: 'ctid',
    where: (now) => sql`created_at <= ${at(now, 365)}::timestamptz`,
  },
  apiMutations: {
    table: 'api_mutations',
    keys: 'ctid',
    where: (now) => sql`expires_at <= ${now.toISOString()}::timestamptz`,
  },
  feedAutoAdmissions: {
    table: 'feed_auto_admissions',
    keys: 'ctid',
    where: (now) => sql`day <= (${at(now, 7)}::timestamptz AT TIME ZONE 'UTC')::date`,
  },
} as const satisfies Record<string, PurgeRule>;

export type PurgeAuthRule = keyof typeof PURGE_AUTH_RULES;

/**
 * Deletes up to `limit` rows of one `house.purge-auth` rule that qualify at `now` (spec 11 §5),
 * skipping rows another transaction holds, and returns how many were deleted.
 */
export async function purgeAuthBatch(
  tx: Transaction,
  input: { rule: PurgeAuthRule; now: Date; limit: number },
): Promise<number> {
  const rule: PurgeRule = PURGE_AUTH_RULES[input.rule];
  const table = sql.raw(rule.table);
  const result = await tx.execute(sql`
    DELETE FROM ${table} WHERE ctid IN (
      SELECT ctid FROM ${table} WHERE ${rule.where(input.now)}
       LIMIT ${input.limit} FOR UPDATE SKIP LOCKED)`);
  return result.rowCount ?? 0;
}
