import { sql, type SQL } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const assertFinite = (value: unknown, path: string): void => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`user_estimate_models: ${path} is not finite`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertFinite(item, `${path}[${i}]`));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) assertFinite(item, `${path}.${key}`);
  }
};

/**
 * `user_estimate_models` (visible-learning §4.4, migration 0034): the per-user word model of
 * `packages/ranker/src/estimate`. The db package may not import the ranker, so the JSON columns are
 * `unknown` here and the caller validates them; `spec` is the `ESTIMATE_SPEC` the model was trained
 * under (a model of another spec is never scored).
 */
export interface StoredEstimateModel {
  userId: string;
  version: number;
  spec: string;
  trainedAt: Date;
  n: number;
  nPos: number;
  nNeg: number;
  intercept: number;
  /** Feature name to weight, up to 20,000 entries (about 650 KB of JSON). */
  weights: unknown;
  /** `{a, b}`: the Platt calibration. */
  platt: unknown;
  /** The trainer's metrics plus `inputSha`, `options` and, after a refresh, `lastRun`. */
  metrics: Record<string, unknown>;
}

/** The newest model without its weights, platt and intercept: what the job and the API read. */
export type EstimateStateRow = Omit<
  StoredEstimateModel,
  'userId' | 'intercept' | 'weights' | 'platt'
> & {
  /** The full read would pass parseEstimateModel (metrics are normalized to an object). */
  parseable: boolean;
};

export interface NewEstimateModel {
  userId: string;
  spec: string;
  n: number;
  nPos: number;
  nNeg: number;
  intercept: number;
  weights: unknown;
  platt: unknown;
  metrics: unknown;
}

/**
 * Serializes the estimate steps of one user and fences them against deletion: takes
 * `pg_advisory_xact_lock(hashtextextended('estimate:' || userId, 0))`, then `FOR SHARE` on the live
 * user row (`deleted_at IS NULL`). Returns false for a missing or soft-deleted user.
 */
export async function lockEstimateUser(tx: Transaction, userId: string): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`estimate:${userId}`}, 0))`);
  const result = await tx.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR SHARE`,
  );
  return result.rows.length > 0;
}

/**
 * JSON numbers reach JS through JSON.parse. Its overflow boundary is 2^1024 - 2^970;
 * smaller magnitudes (including underflow to zero) are finite. Keep the check in SQL so
 * nightly staleness checks never transfer the weights object.
 */
const JSON_NUMBER_OVERFLOW = sql`(power(2::numeric, 1024) - power(2::numeric, 970))`;

function finiteJsonNumber(value: SQL): SQL {
  return sql`CASE WHEN jsonb_typeof(${value}) = 'number'
    THEN abs((${value})::text::numeric) < ${JSON_NUMBER_OVERFLOW}
    ELSE false END`;
}

/** The user's newest model without its weights, platt and intercept; null when none is stored. */
export async function loadEstimateState(
  db: Executor,
  userId: string,
): Promise<EstimateStateRow | null> {
  const result = await db.execute<{
    version: number;
    spec: string;
    trained_at: RawTimestamp;
    n: number;
    n_pos: number;
    n_neg: number;
    metrics: unknown;
    parseable: boolean;
  }>(sql`
    SELECT version, spec, trained_at, n, n_pos, n_neg, metrics,
           (intercept > '-Infinity'::float8 AND intercept < 'Infinity'::float8
            AND jsonb_typeof(weights) = 'object'
            AND NOT jsonb_path_exists(weights,
              '$.* ? (@.type() != "number" || @ >= $overflow || @ <= -$overflow)',
              jsonb_build_object('overflow', ${JSON_NUMBER_OVERFLOW}))
            AND jsonb_typeof(platt) = 'object'
            AND ${finiteJsonNumber(sql`platt->'a'`)}
            AND ${finiteJsonNumber(sql`platt->'b'`)}) AS parseable
      FROM user_estimate_models
     WHERE user_id = ${userId}::uuid ORDER BY version DESC LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    parseable: row.parseable,
    version: row.version,
    spec: row.spec,
    trainedAt: toDate(row.trained_at),
    n: row.n,
    nPos: row.n_pos,
    nNeg: row.n_neg,
    metrics: isRecord(row.metrics) ? row.metrics : {},
  };
}

/** The user's newest model with everything scoring needs; null when none is stored. */
export async function loadEstimateModel(
  db: Executor,
  userId: string,
): Promise<StoredEstimateModel | null> {
  const result = await db.execute<{
    version: number;
    spec: string;
    trained_at: RawTimestamp;
    n: number;
    n_pos: number;
    n_neg: number;
    intercept: number;
    weights: unknown;
    platt: unknown;
    metrics: unknown;
  }>(sql`
    SELECT version, spec, trained_at, n, n_pos, n_neg, intercept, weights, platt, metrics
      FROM user_estimate_models
     WHERE user_id = ${userId}::uuid ORDER BY version DESC LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    userId: userId,
    version: row.version,
    spec: row.spec,
    trainedAt: toDate(row.trained_at),
    n: row.n,
    nPos: row.n_pos,
    nNeg: row.n_neg,
    intercept: Number(row.intercept),
    weights: row.weights,
    platt: row.platt,
    metrics: isRecord(row.metrics) ? row.metrics : {},
  };
}

/**
 * Stores a model as the user's next version (`coalesce(max(version), 0) + 1`, under
 * {@link lockEstimateUser}) and returns the version. Refuses a non-finite number.
 */
export async function insertEstimateModel(
  tx: Transaction,
  input: NewEstimateModel,
): Promise<number> {
  assertFinite(input.intercept, 'intercept');
  assertFinite(input.weights, 'weights');
  assertFinite(input.platt, 'platt');
  const json = (value: unknown) => JSON.stringify(value);
  const result = await tx.execute<{ version: number }>(sql`
    INSERT INTO user_estimate_models (user_id, version, spec, n, n_pos, n_neg, intercept, weights,
                                      platt, metrics)
    SELECT ${input.userId}::uuid, coalesce(max(version), 0) + 1, ${input.spec}, ${input.n},
           ${input.nPos}, ${input.nNeg}, ${input.intercept}, ${json(input.weights)}::jsonb,
           ${json(input.platt)}::jsonb, ${json(input.metrics)}::jsonb
      FROM user_estimate_models WHERE user_id = ${input.userId}::uuid
    RETURNING version`);
  return result.rows[0]?.version ?? 0;
}

/** Keeps the user's newest `keep` versions (the design keeps 2) and deletes the rest. */
export async function pruneEstimateModels(
  tx: Transaction,
  userId: string,
  keep: number,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM user_estimate_models
     WHERE user_id = ${userId}::uuid AND version < (
       SELECT max(version) - ${keep} + 1 FROM user_estimate_models
        WHERE user_id = ${userId}::uuid)`);
}

/** Deletes every model of the user (the gate closed again); returns how many rows went. */
export async function deleteEstimateModels(tx: Transaction, userId: string): Promise<number> {
  const result = await tx.execute(
    sql`DELETE FROM user_estimate_models WHERE user_id = ${userId}::uuid`,
  );
  return result.rowCount ?? 0;
}

/**
 * Counts the explicit ratings `loadEstimateRatings(db, userId, since)` would return, by class: the
 * cheap gate check of the rank handler (`rating IN (1, -1) AND rated_at >= since`).
 */
export async function countEstimateRatings(
  db: Executor,
  userId: string,
  since: Date,
): Promise<{ n: number; nPos: number; nNeg: number }> {
  const result = await db.execute<{ n_pos: number | string; n_neg: number | string }>(sql`
    SELECT count(*) FILTER (WHERE rating = 1) AS n_pos,
           count(*) FILTER (WHERE rating = -1) AS n_neg
      FROM user_article
     WHERE user_id = ${userId}::uuid AND rating IN (1, -1)
       AND rated_at >= ${since.toISOString()}::timestamptz`);
  const nPos = Number(result.rows[0]?.n_pos ?? 0);
  const nNeg = Number(result.rows[0]?.n_neg ?? 0);
  return { n: nPos + nNeg, nPos, nNeg };
}

/**
 * Stores the outcome of the latest estimate refresh in the metrics of the model version it scored
 * with (`metrics.lastRun`, other keys kept): `movedUp` and `movedDown` count the unread rows whose
 * tier rose or fell. True when the version still exists.
 */
export async function recordEstimateLastRun(
  db: Executor,
  userId: string,
  version: number,
  lastRun: { at: string; movedUp: number; movedDown: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE user_estimate_models
       SET metrics = metrics || jsonb_build_object('lastRun', ${JSON.stringify(lastRun)}::jsonb)
     WHERE user_id = ${userId}::uuid AND version = ${version}`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * A page of the nightly estimate sweep candidates: live users in id order after `after` who hold a
 * stored estimate model, or who have at least `minRatings` explicit ratings since `since` (counted
 * with an inner LIMIT, so a heavy rater costs `minRatings` index rows, not all of them).
 */
export async function listEstimateSweepUsers(
  db: Executor,
  input: { after: string | null; limit: number; since: Date; minRatings: number },
): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT u.id::text AS id
      FROM users u
     WHERE u.deleted_at IS NULL
       AND (${input.after}::uuid IS NULL OR u.id > ${input.after}::uuid)
       AND (EXISTS (SELECT 1 FROM user_estimate_models m WHERE m.user_id = u.id)
         OR (SELECT count(*) FROM (
               SELECT 1 FROM user_article ua
                WHERE ua.user_id = u.id AND ua.rating IN (1, -1)
                  AND ua.rated_at >= ${input.since.toISOString()}::timestamptz
                LIMIT ${input.minRatings}) r) >= ${input.minRatings})
     ORDER BY u.id LIMIT ${input.limit}`);
  return result.rows.map((row) => row.id);
}
