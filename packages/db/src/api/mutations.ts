import { sql } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/**
 * Idempotency receipts (`api_mutations`, spec 08 §1.1, §5.4). Each authenticated data mutation
 * reserves `(user_id, Idempotency-Key)` inside its state transaction, binds it to the request hash,
 * and saves its response (and, for undoable reader actions, the allowlisted prior fields) before
 * commit. Nothing is written when the transaction rolls back.
 */

/** Receipts are retained for 7 days (spec 08 §1.1; the table enforces at least that). */
export const MUTATION_RETENTION_DAYS = 7;

export interface StoredMutation {
  id: string;
  requestHash: string;
  route: string;
  status: number;
  response: unknown;
  undo: unknown;
  createdAt: Date;
  expiresAt: Date;
}

type MutationRow = {
  id: string;
  request_hash: string;
  route: string;
  status: number;
  response: unknown;
  undo: unknown;
  created_at: RawTimestamp;
  expires_at: RawTimestamp;
};

function storedMutation(row: MutationRow): StoredMutation {
  return {
    id: row.id,
    requestHash: row.request_hash,
    route: row.route,
    status: row.status,
    response: row.response,
    undo: row.undo,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

/**
 * Serialize concurrent requests with the same key: a transaction-scoped advisory lock on the
 * (user, key) pair. A duplicate waits until the first commits (and then sees its receipt) or rolls
 * back (and then runs itself).
 */
export async function lockMutationKey(tx: TenantTx, key: string): Promise<void> {
  const user = tenantUserId(tx);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`api_mutation:${user}:${key}`}, 0))`,
  );
}

/** The caller's receipt for a key, or `null`. Expired receipts are treated as absent. */
export async function readMutation(tx: TenantTx, key: string): Promise<StoredMutation | null> {
  const result = await tx.execute<MutationRow>(sql`
    SELECT id::text AS id, request_hash, route, status, response, undo, created_at, expires_at
      FROM api_mutations
     WHERE user_id = ${tenantUserId(tx)}::uuid AND id = ${key}::uuid AND expires_at > now()`);
  const row = result.rows[0];
  return row === undefined ? null : storedMutation(row);
}

export interface SaveMutationInput {
  key: string;
  requestHash: string;
  route: string;
  status: number;
  response: unknown;
  /** Allowlisted prior reader fields and resulting versions (spec 08 §5.4); `null` when not undoable. */
  undo?: unknown;
}

/**
 * Save the receipt. An expired receipt with the same key is replaced (the key may be reused once its
 * retention ended); a live one cannot exist here because the caller holds the key lock and read it.
 */
export async function saveMutation(tx: TenantTx, input: SaveMutationInput): Promise<void> {
  const user = tenantUserId(tx);
  await tx.execute(sql`
    DELETE FROM api_mutations
     WHERE user_id = ${user}::uuid AND id = ${input.key}::uuid AND expires_at <= now()`);
  await tx.execute(sql`
    INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, undo, expires_at)
    VALUES (${user}::uuid, ${input.key}::uuid, ${input.requestHash}, ${input.route}, ${input.status},
            ${JSON.stringify(input.response ?? null)}::jsonb,
            ${input.undo === undefined || input.undo === null ? null : JSON.stringify(input.undo)}::jsonb,
            now() + make_interval(days => ${MUTATION_RETENTION_DAYS}))`);
}

/** Replace a saved receipt's undo payload (e.g. to mark it undone, spec 08 §5.4). */
export async function updateMutationUndo(
  tx: TenantTx,
  key: string,
  undo: unknown,
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE api_mutations SET undo = ${undo === null ? null : JSON.stringify(undo)}::jsonb
     WHERE user_id = ${tenantUserId(tx)}::uuid AND id = ${key}::uuid AND expires_at > now()`);
  return result.rowCount === 1;
}

/** Lock and read a receipt for undo: `FOR UPDATE`, so two undos of one mutation serialize. */
export async function lockMutationForUndo(
  tx: TenantTx,
  key: string,
): Promise<StoredMutation | null> {
  const result = await tx.execute<MutationRow>(sql`
    SELECT id::text AS id, request_hash, route, status, response, undo, created_at, expires_at
      FROM api_mutations
     WHERE user_id = ${tenantUserId(tx)}::uuid AND id = ${key}::uuid AND expires_at > now()
     FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined ? null : storedMutation(row);
}
