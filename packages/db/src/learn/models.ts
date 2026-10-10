import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';

/** The `user_models` columns learning reads back (spec 02 `user_models`). */
export interface StoredModelRow {
  version: number;
  active: boolean;
  featureSpecSha: string;
  metrics: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lock the live user row for a learn step (spec 06 §8.4): `share` waits for in-flight reader
 * mutations (which hold `FOR NO KEY UPDATE`); `update` first takes the per-user learn advisory lock
 * so activation and deactivation are serialized. Returns false for a missing or deleted user.
 */
export async function lockLearnUser(
  tx: Transaction,
  userId: string,
  mode: 'share' | 'update',
): Promise<boolean> {
  if (mode === 'update') {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`learn:${userId}`}, 0))`);
  }
  const result = await tx.execute<{ id: string }>(
    mode === 'share'
      ? sql`SELECT id FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR SHARE`
      : sql`SELECT id FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR NO KEY UPDATE`,
  );
  return result.rows.length > 0;
}

/** The active `user_models` row with everything scoring needs (spec 06 §8.3). */
export interface ActiveModelRow {
  version: number;
  featureSpecSha: string;
  weights: unknown;
  intercept: number;
  scaler: unknown;
  calibration: unknown;
  metrics: Record<string, unknown>;
}

/** The user's active model row, or null (spec 06 §7 step 1, §8.1). */
export async function loadActiveUserModel(
  db: Executor,
  userId: string,
): Promise<ActiveModelRow | null> {
  const result = await db.execute<{
    version: number;
    feature_spec_sha: string;
    weights: unknown;
    intercept: number;
    scaler: unknown;
    calibration: unknown;
    metrics: unknown;
  }>(sql`
    SELECT version, feature_spec_sha, weights, intercept, scaler, calibration, metrics
      FROM user_models WHERE user_id = ${userId}::uuid AND active`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    version: row.version,
    featureSpecSha: row.feature_spec_sha,
    weights: row.weights,
    intercept: Number(row.intercept),
    scaler: row.scaler,
    calibration: row.calibration,
    metrics: isRecord(row.metrics) ? row.metrics : {},
  };
}

/**
 * The user's newest stored attempt, the newest terminal attempt (status `activated` or `rejected`;
 * a `superseded` attempt never counts) and the active model (spec 06 §8.3-8.4).
 */
export async function loadModelState(
  db: Executor,
  userId: string,
): Promise<{
  latest: StoredModelRow | null;
  latestTerminal: StoredModelRow | null;
  active: StoredModelRow | null;
}> {
  const result = await db.execute<{
    version: number;
    active: boolean;
    feature_spec_sha: string;
    metrics: unknown;
  }>(sql`
    SELECT version, active, feature_spec_sha, metrics FROM user_models
     WHERE user_id = ${userId}::uuid AND (active OR version = (
       SELECT max(version) FROM user_models WHERE user_id = ${userId}::uuid) OR version = (
       SELECT max(version) FROM user_models WHERE user_id = ${userId}::uuid
          AND coalesce(metrics->>'status', '') <> 'superseded'))
     ORDER BY version DESC`);
  const rows: StoredModelRow[] = result.rows.map((row) => ({
    version: row.version,
    active: row.active,
    featureSpecSha: row.feature_spec_sha,
    metrics: isRecord(row.metrics) ? row.metrics : {},
  }));
  return {
    latest: rows[0] ?? null,
    latestTerminal: rows.find((row) => row.metrics['status'] !== 'superseded') ?? null,
    active: rows.find((row) => row.active) ?? null,
  };
}

export interface NewUserModel {
  userId: string;
  active: boolean;
  featureSpecSha: string;
  nLabels: number;
  nPos: number;
  nNeg: number;
  weights: unknown;
  intercept: number;
  scaler: unknown;
  calibration: unknown;
  metrics: unknown;
}

/** Store a model or attempt as the user's next version (under the learn lock); returns the version. */
export async function insertUserModel(tx: Transaction, input: NewUserModel): Promise<number> {
  const json = (value: unknown) => JSON.stringify(value);
  const result = await tx.execute<{ version: number }>(sql`
    INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                             intercept, scaler, calibration, metrics, active)
    SELECT ${input.userId}::uuid, coalesce(max(version), 0) + 1, ${input.featureSpecSha},
           ${input.nLabels}, ${input.nPos}, ${input.nNeg}, ${json(input.weights)}::jsonb,
           ${input.intercept}, ${json(input.scaler)}::jsonb, ${json(input.calibration)}::jsonb,
           ${json(input.metrics)}::jsonb, ${input.active}
      FROM user_models WHERE user_id = ${input.userId}::uuid
    RETURNING version`);
  return result.rows[0]?.version ?? 0;
}

/** Deactivate the user's active model, if any; returns whether one was active. */
export async function deactivateUserModels(tx: Transaction, userId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`UPDATE user_models SET active = false WHERE user_id = ${userId}::uuid AND active`,
  );
  return (result.rowCount ?? 0) > 0;
}

/** Keep the active row plus the `keep` newest inactive ones (spec 06 §8.3 retention). */
export async function pruneUserModels(
  tx: Transaction,
  userId: string,
  keep: number,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM user_models
     WHERE user_id = ${userId}::uuid AND NOT active AND version NOT IN (
       SELECT version FROM user_models WHERE user_id = ${userId}::uuid AND NOT active
        ORDER BY version DESC LIMIT ${keep})`);
}

/**
 * A page of the nightly learn candidates (spec 11 §6): live users with feedback since `feedbackSince`
 * or any stored model, in id order after `after`, each flagged active since `activeSince`.
 */
export async function listNightlyLearnUsers(
  db: Executor,
  input: { after: string | null; limit: number; feedbackSince: Date; activeSince: Date },
): Promise<Array<{ userId: string; recentlyActive: boolean }>> {
  const result = await db.execute<{ id: string; recently_active: boolean }>(sql`
    SELECT u.id::text AS id,
           coalesce(u.last_active_at >= ${input.activeSince.toISOString()}::timestamptz, false)
             AS recently_active
      FROM users u
     WHERE u.deleted_at IS NULL
       AND (${input.after}::uuid IS NULL OR u.id > ${input.after}::uuid)
       AND (EXISTS (SELECT 1 FROM user_models m WHERE m.user_id = u.id)
         OR EXISTS (SELECT 1 FROM feedback_events f
                     WHERE f.user_id = u.id
                       AND f.created_at >= ${input.feedbackSince.toISOString()}::timestamptz))
     ORDER BY u.id LIMIT ${input.limit}`);
  return result.rows.map((row) => ({ userId: row.id, recentlyActive: row.recently_active }));
}

/** The user's behavioral-consent flags as stored in `users.preferences` (spec 06 §8.2). */
export async function loadLearnConsent(
  db: Executor,
  userId: string,
): Promise<{ implicitFeedback: boolean; implicitNegative: boolean }> {
  const result = await db.execute<{ preferences: unknown }>(
    sql`SELECT preferences FROM users WHERE id = ${userId}::uuid`,
  );
  const stored = result.rows[0]?.preferences;
  const flag = (name: string): boolean => isRecord(stored) && stored[name] === true;
  return { implicitFeedback: flag('implicitFeedback'), implicitNegative: flag('implicitNegative') };
}
