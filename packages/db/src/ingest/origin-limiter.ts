import { randomUUID } from 'node:crypto';

import type { OriginLimiter, OriginReservation } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';

/** The `origin_fetch_state.leases` CHECK: at most two request leases per origin (spec 02 §3). */
const MAX_LEASES = 2;

/** Longest origin text accepted (`scheme://host:port`; a DNS name is at most 253 characters). */
const MAX_ORIGIN_LENGTH = 512;

export interface PgOriginLimiterOptions {
  /** Concurrent request leases per origin, 1 or 2 (default 2, spec 03 §8.2). */
  maxConcurrent?: number;
  /** Minimum time between two request starts at one origin (default 1,000 ms, spec 03 §8.2). */
  spacingMs?: number;
  /** Longest `wait` while both leases are held, before the caller polls again (default 250 ms). */
  fullPollMs?: number;
}

function assertOrigin(origin: string): void {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) {
    throw new TypeError('origin must be a non-empty scheme://host:port string');
  }
}

function assertMs(name: string, value: number, { allowZero }: { allowZero: boolean }): void {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(
      `${name} must be a finite ${allowZero ? 'non-negative' : 'positive'} number`,
    );
  }
}

type ReserveRow = {
  status: 'granted' | 'blocked' | 'full' | 'spacing';
  blocked_until_ms: number | null;
  next_start_ms: number;
  full_retry_ms: number;
};

/**
 * The PostgreSQL {@link OriginLimiter} on `origin_fetch_state` (spec 03 §8.2, spec 02 §3): one
 * shared per-origin throttle for every safe-fetch caller and process, at most `maxConcurrent`
 * concurrent requests and `spacingMs` between request starts, plus persisted 429/503 cooldowns.
 *
 * Every call is one short transaction that uses database time only (`clock_timestamp()` read while
 * the origin row is locked, so a lock wait never makes it stale) and is never held open across an
 * HTTP request: the caller holds a lease (`{token, expires_at}` in the row), not a transaction.
 * A crashed holder's lease is dropped by the next reservation once it expires, so `leaseMs` must
 * exceed the request's total deadline. Works for both `bantoozi_worker` and `bantoozi_app` (API
 * discovery), which may select, insert and update this table; it never deletes rows (idle rows are
 * purged by housekeeping, spec 11 §5).
 */
export function createPgOriginLimiter(
  db: Database,
  options: PgOriginLimiterOptions = {},
): OriginLimiter {
  const maxConcurrent = options.maxConcurrent ?? MAX_LEASES;
  const spacingMs = options.spacingMs ?? 1_000;
  const fullPollMs = options.fullPollMs ?? 250;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_LEASES) {
    throw new TypeError(`maxConcurrent must be an integer from 1 to ${MAX_LEASES}`);
  }
  assertMs('spacingMs', spacingMs, { allowZero: true });
  assertMs('fullPollMs', fullPollMs, { allowZero: false });

  return {
    /**
     * Upsert and lock the origin row, drop expired leases, then: an active cooldown → `blocked`;
     * `maxConcurrent` live leases → `wait` until the earliest expiry or the next poll, whichever
     * is sooner; a later start slot → `wait` until `next_start_at`; otherwise grant a fresh token
     * with `expires_at = now + leaseMs` and move `next_start_at` to `now + spacingMs`. Returned
     * times are rounded up to the next millisecond, so retrying at them is never early.
     */
    async reserve(origin, { leaseMs }): Promise<OriginReservation> {
      assertOrigin(origin);
      assertMs('leaseMs', leaseMs, { allowZero: false });
      const token = randomUUID();
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO origin_fetch_state (origin) VALUES (${origin})
          ON CONFLICT (origin) DO NOTHING`);
        await tx.execute(sql`SELECT 1 FROM origin_fetch_state WHERE origin = ${origin} FOR UPDATE`);
        // The row is locked: this statement never waits, so its clock is the decision time.
        const result = await tx.execute<ReserveRow>(sql`
          WITH clock AS MATERIALIZED (
            SELECT clock_timestamp() AS t,
                   ${leaseMs}::double precision * interval '1 millisecond' AS lease,
                   ${spacingMs}::double precision * interval '1 millisecond' AS spacing,
                   ${fullPollMs}::double precision * interval '1 millisecond' AS poll),
          cur AS MATERIALIZED (
            SELECT s.origin, s.next_start_at, s.blocked_until, c.*,
                   coalesce((SELECT jsonb_agg(l.value ORDER BY l.ord)
                               FROM jsonb_array_elements(s.leases) WITH ORDINALITY AS l(value, ord)
                              WHERE (l.value ->> 'expires_at')::timestamptz > c.t),
                            '[]'::jsonb) AS live
              FROM origin_fetch_state s CROSS JOIN clock c
             WHERE s.origin = ${origin}),
          d AS MATERIALIZED (
            SELECT cur.*,
                   CASE WHEN cur.blocked_until > cur.t THEN 'blocked'
                        WHEN jsonb_array_length(cur.live) >= ${maxConcurrent}::int THEN 'full'
                        WHEN cur.next_start_at > cur.t THEN 'spacing'
                        ELSE 'granted' END AS status
              FROM cur)
          UPDATE origin_fetch_state s
             SET leases = CASE WHEN d.status <> 'granted' THEN d.live
                               ELSE d.live || jsonb_build_array(jsonb_build_object(
                                      'token', ${token}::text,
                                      'expires_at', to_char((d.t + d.lease) AT TIME ZONE 'UTC',
                                                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) END,
                 next_start_at = CASE WHEN d.status = 'granted' THEN d.t + d.spacing
                                      ELSE s.next_start_at END,
                 last_used_at = CASE WHEN d.status = 'granted' THEN d.t ELSE s.last_used_at END
            FROM d
           WHERE s.origin = d.origin
          RETURNING d.status,
                    ceil(extract(epoch FROM d.blocked_until) * 1000)::float8 AS blocked_until_ms,
                    ceil(extract(epoch FROM d.next_start_at) * 1000)::float8 AS next_start_ms,
                    ceil(extract(epoch FROM least(
                      (SELECT min((l ->> 'expires_at')::timestamptz)
                         FROM jsonb_array_elements(d.live) AS l),
                      d.t + d.poll)) * 1000)::float8 AS full_retry_ms`);
        return result.rows[0];
      });
      if (row === undefined) throw new Error('origin_fetch_state row missing after upsert');
      switch (row.status) {
        case 'granted':
          return { status: 'granted', token };
        case 'blocked':
          // `blocked` implies a non-null blocked_until later than the decision time.
          return { status: 'blocked', until: new Date(row.blocked_until_ms ?? Number.NaN) };
        case 'full':
          return { status: 'wait', retryAt: new Date(row.full_retry_ms) };
        case 'spacing':
          return { status: 'wait', retryAt: new Date(row.next_start_ms) };
      }
    },

    /**
     * Remove exactly this token's lease in one statement (it waits for the row lock of a
     * concurrent reservation, then re-evaluates). An unknown, expired, already released or other
     * origin's token changes nothing, so release is idempotent.
     */
    async release(origin, token): Promise<void> {
      assertOrigin(origin);
      await db.execute(sql`
        UPDATE origin_fetch_state s
           SET leases = coalesce((SELECT jsonb_agg(l.value ORDER BY l.ord)
                                    FROM jsonb_array_elements(s.leases) WITH ORDINALITY AS l(value, ord)
                                   WHERE (l.value ->> 'token') IS DISTINCT FROM ${token}::text),
                                 '[]'::jsonb)
         WHERE s.origin = ${origin}
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.leases) AS l
                        WHERE (l ->> 'token') = ${token}::text)`);
    },

    /**
     * Persist a cooldown (a 429/503 `Retry-After`, spec 03 §8.2) in one statement:
     * `blocked_until = greatest(existing, least(until, now + 24 h))`, so it survives restarts,
     * is shared by every process and never shortens a longer existing cooldown.
     */
    async block(origin, until): Promise<void> {
      assertOrigin(origin);
      if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
        throw new TypeError('until must be a valid Date');
      }
      await db.execute(sql`
        INSERT INTO origin_fetch_state AS s (origin, blocked_until)
        VALUES (${origin}, least(${until}::timestamptz, clock_timestamp() + interval '24 hours'))
        ON CONFLICT (origin) DO UPDATE
          SET blocked_until = greatest(s.blocked_until, EXCLUDED.blocked_until)`);
    },
  };
}
