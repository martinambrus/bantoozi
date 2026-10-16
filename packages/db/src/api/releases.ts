import { releaseWindow } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDateOrNull, type RawTimestamp } from '../timestamps.js';

export const SUBSCRIPTION_RELEASE_GRACE_S = 15 * 60;
const clocks = new WeakMap<object, Date>();
type ReleaseConfig = {
  timezone: string;
  release_interval_s: number | null;
  min_fetch_interval_s: number;
  label: string;
  label_sk: string | null;
};
const configs = new WeakMap<object, Promise<ReleaseConfig>>();

/** Bind the request's server clock, never client input. All access checks in its transaction agree. */
export function bindReaderClock(tx: TenantTx, now: Date): void {
  clocks.set(tx, new Date(now));
}

export interface ReaderReleaseClock {
  now: Date;
  asOf: Date;
  releasedAt: Date;
  nextReleaseAt: Date | null;
  intervalS: number | null;
  planIntervalS: number;
  timezone: string;
  label: string;
  labelSk: string | null;
}

/** The authoritative stored plan and time zone; future client cutoffs cannot advance this clock. */
export async function readerReleaseClock(
  tx: TenantTx,
  requestedAsOf?: Date,
): Promise<ReaderReleaseClock> {
  const now = clocks.get(tx) ?? new Date();
  const asOf = new Date(Math.min(now.getTime(), requestedAsOf?.getTime() ?? now.getTime()));
  let config = configs.get(tx);
  if (config === undefined) {
    config = tx
      .execute<ReleaseConfig>(
        sql`SELECT u.timezone, p.release_interval_s, p.min_fetch_interval_s, p.label, p.label_sk
      FROM users u JOIN plans p ON p.key = u.plan WHERE u.id = ${tenantUserId(tx)}::uuid`,
      )
      .then((result) => {
        const row = result.rows[0];
        if (row === undefined) throw new Error('reader plan is missing');
        return row;
      });
    configs.set(tx, config);
  }
  const row = await config;
  return {
    now,
    asOf,
    ...releaseWindow(asOf, row.timezone, row.release_interval_s),
    timezone: row.timezone,
    intervalS: row.release_interval_s,
    planIntervalS: row.min_fetch_interval_s,
    label: row.label,
    labelSk: row.label_sk,
  };
}

/**
 * The first fifteen minutes are immediately visible and stay visible when grace expires. Taking
 * max(release, grace end) prevents articles already read during grace from disappearing until the
 * next regular boundary. The request snapshot is still an upper bound.
 */
export function carrierReleaseAt(clock: ReaderReleaseClock, subscriptionCreatedAt: SQL): SQL {
  return sql`least(${clock.asOf.toISOString()}::timestamptz,
    greatest(${clock.releasedAt.toISOString()}::timestamptz,
      ${subscriptionCreatedAt} + interval '15 minutes'))`;
}

/** Same visibility predicate for lists, detail, actions, analysis selection and card inputs. */
export function releasedCarrier(
  clock: ReaderReleaseClock,
  subscriptionAlias = 's',
  itemAlias = 'fi',
): SQL {
  return sql`${sql.identifier(itemAlias)}.first_seen_at <= ${carrierReleaseAt(clock, sql`${sql.identifier(subscriptionAlias)}.created_at`)}`;
}

export function subscriptionReleasedThrough(clock: ReaderReleaseClock, createdAt: Date): Date {
  return new Date(
    Math.min(
      clock.asOf.getTime(),
      Math.max(
        clock.releasedAt.getTime(),
        createdAt.getTime() + SUBSCRIPTION_RELEASE_GRACE_S * 1000,
      ),
    ),
  );
}

/** Feed arrivals already waiting for this account's next release; one bounded batch for all feeds. */
export async function pendingFeedReleases(
  tx: TenantTx,
  feedIds: readonly string[],
  clock: ReaderReleaseClock,
): Promise<Set<string>> {
  if (feedIds.length === 0 || clock.nextReleaseAt === null) return new Set();
  const result = await tx.execute<{ feed_id: string }>(sql`
    SELECT s.feed_id::text AS feed_id FROM subscriptions s
    WHERE s.user_id = ${tenantUserId(tx)}::uuid
      AND s.feed_id = ANY(${sql.param([...feedIds])}::bigint[])
      AND EXISTS (SELECT 1 FROM feed_items fi WHERE fi.feed_id = s.feed_id
        AND fi.first_seen_at > ${carrierReleaseAt(clock, sql`s.created_at`)}
        AND fi.first_seen_at <= ${clock.now.toISOString()}::timestamptz)`);
  return new Set(result.rows.map((row) => row.feed_id));
}

/** Current per-origin limits for reader metadata, read in one batch for the subscription list. */
export async function readerSourcePolicies(
  tx: TenantTx,
  origins: readonly string[],
): Promise<Map<string, { intervalS: number; nextStartAt: Date | null }>> {
  if (origins.length === 0) return new Map();
  const result = await tx.execute<{
    origin: string;
    floor_s: number;
    next_start_at: RawTimestamp | null;
  }>(sql`SELECT o.origin,
    greatest(o.crawl_delay_s,
      o.learned_interval_s * power(0.8,
        floor(greatest(0, extract(epoch FROM (clock_timestamp() - o.learned_updated_at))) / 86400))) AS floor_s,
    greatest(o.next_start_at, o.blocked_until, o.feed_next_start_at) AS next_start_at
    FROM origin_fetch_state o WHERE o.origin = ANY(${sql.param([...new Set(origins)])}::text[])`);
  return new Map(
    result.rows.map((row) => [
      row.origin,
      { intervalS: Math.ceil(row.floor_s), nextStartAt: toDateOrNull(row.next_start_at) },
    ]),
  );
}
