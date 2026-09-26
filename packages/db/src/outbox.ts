import { randomUUID } from 'node:crypto';

import type { JobIntent, JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from './client.js';
import { tenantUserId, type TenantTx } from './tenant.js';

/**
 * Durable job intents (spec 02 §3.2). Producers write an intent in the same transaction as the state
 * change; the worker's relay (apps/worker) claims due rows under a lease, sends them to pg-boss, and
 * marks them delivered only with its own lease token. Crash after send means duplicate delivery, so
 * consumers are idempotent.
 */

async function insertIntent(tx: Executor, intent: JobIntent, requester: string | null) {
  // Identical pending work coalesces on job_outbox_dedupe_idx. The API role has no SELECT on
  // job_outbox, so neither RETURNING nor an inferred conflict target (it needs SELECT on the arbiter
  // columns) is possible; the only other unique index is the identity primary key.
  await tx.execute(sql`
    INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
    VALUES (${intent.queue}, ${JSON.stringify(intent.payload)}::jsonb, ${intent.dedupeKey}, ${requester})
    ON CONFLICT DO NOTHING`);
}

/** A worker intent that becomes due only at `availableAt` (the relay skips it until then). */
async function insertDelayedIntent(tx: Executor, intent: JobIntent, availableAt: Date) {
  await tx.execute(sql`
    INSERT INTO job_outbox (queue, payload, dedupe_key, user_id, available_at)
    VALUES (${intent.queue}, ${JSON.stringify(intent.payload)}::jsonb, ${intent.dedupeKey}, NULL,
            greatest(now(), ${availableAt.toISOString()}::timestamptz))
    ON CONFLICT DO NOTHING`);
}

/** The API's outbox writer: the requester is the transaction's tenant (RLS `job_outbox_requester`). */
export function tenantOutbox(tx: TenantTx): JobSender {
  const requester = tenantUserId(tx);
  return { enqueue: (intent) => insertIntent(tx, intent, requester) };
}

/**
 * A worker transaction's outbox writer (follow-on jobs; no requester). With `availableAt`, every
 * intent it writes is delayed until then: a job deferred by a publisher cooldown or a known retry
 * time records such an intent instead of sleeping inside a worker (spec 03 §8.2). An identical
 * pending intent still coalesces it (the earlier one wins).
 */
export function workerOutbox(tx: Transaction, options: { availableAt?: Date } = {}): JobSender {
  const { availableAt } = options;
  return {
    enqueue: (intent) =>
      availableAt === undefined
        ? insertIntent(tx, intent, null)
        : insertDelayedIntent(tx, intent, availableAt),
  };
}

export interface ClaimedIntent {
  id: string;
  queue: string;
  payload: unknown;
  dedupeKey: string | null;
  attempts: number;
  leaseToken: string;
}

export interface ClaimOptions {
  limit: number;
  leaseSeconds: number;
}

/**
 * Claim due, undelivered intents (including expired leases) in one short statement with
 * `FOR UPDATE SKIP LOCKED`, stamping a fresh token/expiry and counting the attempt.
 */
export async function claimOutboxIntents(
  db: Executor,
  options: ClaimOptions,
): Promise<ClaimedIntent[]> {
  const token = randomUUID();
  const result = await db.execute<{
    id: string;
    queue: string;
    payload: unknown;
    dedupe_key: string | null;
    attempts: number;
  }>(sql`
    UPDATE job_outbox o
       SET lease_token = ${token}::uuid,
           lease_until = now() + make_interval(secs => ${options.leaseSeconds}),
           attempts = o.attempts + 1
     WHERE o.id IN (
       SELECT c.id FROM job_outbox c
        WHERE c.delivered_at IS NULL AND c.available_at <= now()
          AND (c.lease_until IS NULL OR c.lease_until < now())
        ORDER BY c.available_at, c.id
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING o.id::text AS id, o.queue, o.payload, o.dedupe_key, o.attempts`);
  return result.rows
    .map((row) => ({
      id: row.id,
      queue: row.queue,
      payload: row.payload,
      dedupeKey: row.dedupe_key,
      attempts: row.attempts,
      leaseToken: token,
    }))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Mark delivered only while this lease is still ours; `false` means a newer claimant owns it. */
export async function completeOutboxIntent(
  db: Executor,
  intent: Pick<ClaimedIntent, 'id' | 'leaseToken'>,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE job_outbox SET delivered_at = now(), lease_token = NULL, lease_until = NULL, last_error = NULL
     WHERE id = ${intent.id}::bigint AND lease_token = ${intent.leaseToken}::uuid AND delivered_at IS NULL`);
  return result.rowCount === 1;
}

/** Keep a failed intent for a later attempt (never deleted); releases only our own lease. */
export async function failOutboxIntent(
  db: Executor,
  intent: Pick<ClaimedIntent, 'id' | 'leaseToken'>,
  failure: { error: string; retryInSeconds: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE job_outbox
       SET lease_token = NULL, lease_until = NULL, last_error = left(${failure.error}, 500),
           available_at = now() + make_interval(secs => ${failure.retryInSeconds})
     WHERE id = ${intent.id}::bigint AND lease_token = ${intent.leaseToken}::uuid AND delivered_at IS NULL`);
  return result.rowCount === 1;
}

/** Bounded exponential backoff for failed sends: 2^attempts seconds, capped at 15 minutes. */
export function outboxRetryDelaySeconds(attempts: number): number {
  return Math.min(900, 2 ** Math.max(0, Math.min(attempts, 10)));
}

/** Purge delivered intents after the retention window; undelivered work is never purged for age. */
export async function purgeDeliveredOutbox(db: Executor, olderThanDays = 7): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM job_outbox
     WHERE delivered_at IS NOT NULL AND delivered_at < now() - make_interval(days => ${olderThanDays})`);
  return result.rowCount ?? 0;
}

/**
 * Whether pg-boss already holds a not-yet-started job equivalent to an intent. A `null` send result
 * (a singleton/debounce conflict) counts as delivery only when this proves equivalent work is
 * pending (spec 02 §3.2, spec 03 §2.1): the same queue and key in state created/retry and, unless
 * `anyPayload` (debounced jobs re-read durable state), the identical payload.
 */
export async function hasPendingEquivalentJob(
  db: Executor,
  job: { queue: string; singletonKey: string; payload: unknown; anyPayload: boolean },
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM pgboss.job
     WHERE name = ${job.queue} AND singleton_key = ${job.singletonKey}
       AND state IN ('created', 'retry')
       AND (${job.anyPayload} OR data = ${JSON.stringify(job.payload)}::jsonb)
     LIMIT 1`);
  return result.rows.length > 0;
}

/** Age in seconds of the oldest undelivered intent (the relay alerts above 5 minutes). */
export async function oldestPendingOutboxAgeSeconds(db: Executor): Promise<number | null> {
  const result = await db.execute<{ age: number | null }>(sql`
    SELECT extract(epoch FROM now() - min(created_at))::float8 AS age
      FROM job_outbox WHERE delivered_at IS NULL`);
  return result.rows[0]?.age ?? null;
}
