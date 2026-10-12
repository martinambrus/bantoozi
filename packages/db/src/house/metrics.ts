import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

/** One explicit-rating event (`rate`, `prompt_answer`, `unrate` or the undo of a rating) of the metrics window. */
export interface MetricsRatingEvent {
  userId: string;
  articleId: string;
  kind: 'rate' | 'prompt_answer' | 'unrate' | 'undo';
  rating: number | null;
  /** The `before.lane` of the feedback snapshot (spec 06 §8.2), `null` when it holds none. */
  lane: string | null;
  /** The `before.scoreSource` (`cards`, `model`, `degraded`), `null` for a legacy snapshot or no score. */
  source: string | null;
  /** The article's language, `null` when unknown. */
  lang: string | null;
  /** Given in answer to a prompt or in the calibration round, not volunteered. */
  prompted: boolean;
  at: Date;
}

/**
 * The rating events with `from <= created_at < to`, grouped by user and article and in event order,
 * for the effective-rating replay of `house.metrics` (spec 10 §7). The undo of a `rating` or of a
 * `prompt_answer` restores the state before it. Callers must not retain the ids.
 */
export async function metricsRatingEvents(
  db: Executor,
  from: Date,
  to: Date,
): Promise<MetricsRatingEvent[]> {
  const result = await db.execute<{
    user_id: string;
    article_id: string;
    kind: MetricsRatingEvent['kind'];
    rating: string | null;
    lane: string | null;
    source: string | null;
    lang: string | null;
    prompted: boolean;
    at: number;
  }>(sql`
    SELECT e.user_id::text AS user_id, e.article_id::text AS article_id, e.kind,
           e.value->>'rating' AS rating, e.value->'before'->>'lane' AS lane,
           e.value->'before'->>'scoreSource' AS source, a.lang AS lang,
           (e.kind = 'prompt_answer' OR e.value->'selection'->>'method' = 'calibration') AS prompted,
           (extract(epoch FROM e.created_at) * 1000)::float8 AS at
      FROM feedback_events e
      LEFT JOIN articles a ON a.id = e.article_id
     WHERE e.created_at >= ${from.toISOString()}::timestamptz
       AND e.created_at < ${to.toISOString()}::timestamptz
       AND (e.kind IN ('rate', 'prompt_answer', 'unrate')
            OR (e.kind = 'undo' AND e.value->>'action' IN ('rating', 'prompt_answer')))
     ORDER BY e.user_id, e.article_id, e.id`);
  return result.rows.map((row) => ({
    userId: row.user_id,
    articleId: row.article_id,
    kind: row.kind,
    rating: row.rating === null ? null : Number(row.rating),
    lane: row.lane,
    source: row.source,
    lang: row.lang,
    prompted: row.prompted,
    at: new Date(row.at),
  }));
}

/**
 * Observed recovery from Everything/Hidden over `from <= created_at < to` (spec 10 §7): distinct
 * user/article pairs opened, bookmarked or liked from a downranked pre-action lane, against the
 * eligible pairs, those with feedback from a downranked lane in the window and those downranked now.
 */
export async function metricsRecovery(
  db: Executor,
  from: Date,
  to: Date,
): Promise<{ numerator: number; denominator: number }> {
  const start = from.toISOString();
  const end = to.toISOString();
  const result = await db.execute<{ numerator: number; denominator: number }>(sql`
    WITH downranked AS (
      SELECT user_id, article_id,
             (kind IN ('open', 'bookmark') OR (kind IN ('rate', 'prompt_answer') AND value->>'rating' = '1')) AS recovered
        FROM feedback_events
       WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
         AND value->'before'->>'lane' IN ('everything', 'hidden')
    ), eligible AS (
      SELECT user_id, article_id FROM downranked
      UNION
      SELECT user_id, article_id FROM user_article WHERE lane IN ('everything', 'hidden')
    )
    SELECT (SELECT count(*) FROM (SELECT DISTINCT user_id, article_id FROM downranked WHERE recovered) r)::int
             AS numerator,
           (SELECT count(*) FROM eligible)::int AS denominator`);
  return {
    numerator: result.rows[0]?.numerator ?? 0,
    denominator: result.rows[0]?.denominator ?? 0,
  };
}

/** Deletes the `metrics.daily.<date>` rows of days before `oldestKept` (`YYYY-MM-DD`); returns the count. */
export async function deleteMetricsSnapshotsBefore(
  db: Executor,
  oldestKept: string,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM settings
     WHERE key ~ '^metrics\\.daily\\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND key < ${`metrics.daily.${oldestKept}`}`);
  return result.rowCount ?? 0;
}

/** Hides by reason (a rating with `hide`) and unhides over `from <= created_at < to` (spec 10 §7). */
export async function metricsHides(
  db: Executor,
  from: Date,
  to: Date,
): Promise<{ byReason: Record<string, number>; unhides: number }> {
  const start = from.toISOString();
  const end = to.toISOString();
  const result = await db.execute<{ reason: string | null; n: number }>(sql`
    SELECT CASE WHEN kind = 'unhide' THEN NULL
                WHEN coalesce(value->>'reason', '') ~ '^[a-z_]{1,32}$' THEN value->>'reason'
                WHEN coalesce(value->>'reason', '') = '' THEN 'none'
                ELSE 'other' END AS reason,
           count(*)::int AS n
      FROM feedback_events
     WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
       AND (kind = 'unhide' OR (kind IN ('rate', 'prompt_answer') AND value->>'hide' = 'true'))
     GROUP BY 1`);
  const byReason: Record<string, number> = {};
  let unhides = 0;
  for (const row of result.rows) {
    if (row.reason === null) unhides += row.n;
    else byReason[row.reason] = row.n;
  }
  return { byReason, unhides };
}

/** Personal-model aggregates of a window (spec 10 §7 "Personal models"); no user id leaves this function. */
export interface MetricsModels {
  activation: { attempts: number; activated: number; rate: number | null };
  samples: { explicit: number };
  skipped: Record<string, number>;
  /** Terminal attempts with a validation and a baseline AUC / logloss. */
  paired: number;
  pairedLogloss: number;
  medianDeltaAuc: number | null;
  medianDeltaLogloss: number | null;
  invalidation: { invalidated: number; rate: number | null };
  cardsOnly: { hours: number; users: number };
}

/**
 * Terminal training attempts (`activated` or `rejected`, by `trained_at`) of the window, the models
 * invalidated in it (`metrics.deactivatedAt`, never a replacement; their rate is over the models in
 * service at any point of the window, not only those activated in it) and the time those users spent on
 * cards-only ranking until their next activated model, or `now`.
 */
export async function metricsModels(
  db: Executor,
  from: Date,
  to: Date,
  now: Date,
): Promise<MetricsModels> {
  const start = from.toISOString();
  const end = to.toISOString();
  const num = (key: string) => sql.raw(`(m.metrics->>'${key}')::float8`);
  const totals = await db.execute<{
    attempts: number;
    activated: number;
    explicit: number;
    paired: number;
    paired_logloss: number;
    d_auc: number | null;
    d_logloss: number | null;
  }>(sql`
    SELECT count(*)::int AS attempts,
           (count(*) FILTER (WHERE m.metrics->>'status' = 'activated'))::int AS activated,
           coalesce(sum(CASE WHEN m.metrics->>'nExplicit' ~ '^[0-9]+$'
                             THEN (m.metrics->>'nExplicit')::int ELSE 0 END), 0)::int AS explicit,
           (count(*) FILTER (WHERE ${num('cvAuc')} IS NOT NULL AND ${num('baselineAuc')} IS NOT NULL))::int
             AS paired,
           (count(*) FILTER (WHERE ${num('cvLogloss')} IS NOT NULL AND ${num('baselineLogloss')} IS NOT NULL))::int
             AS paired_logloss,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${num('cvAuc')} - ${num('baselineAuc')})
             AS d_auc,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${num('cvLogloss')} - ${num('baselineLogloss')})
             AS d_logloss
      FROM user_models m
     WHERE m.trained_at >= ${start}::timestamptz AND m.trained_at < ${end}::timestamptz
       AND m.metrics->>'status' IN ('activated', 'rejected')`);
  const skipped = await db.execute<{ reason: string; n: number }>(sql`
    SELECT s.key AS reason, sum(s.value::int)::int AS n
      FROM user_models m,
           jsonb_each_text(CASE WHEN jsonb_typeof(m.metrics->'skipped') = 'object'
                                THEN m.metrics->'skipped' ELSE '{}'::jsonb END) s
     WHERE m.trained_at >= ${start}::timestamptz AND m.trained_at < ${end}::timestamptz
       AND m.metrics->>'status' IN ('activated', 'rejected')
       AND s.key ~ '^[A-Za-z0-9_.-]{1,40}$' AND s.value ~ '^[0-9]{1,9}$'
     GROUP BY s.key ORDER BY n DESC, s.key LIMIT 20`);
  const invalidated = await db.execute<{ invalidated: number; hours: number; users: number }>(sql`
    WITH inv AS (
      SELECT m.user_id, (m.metrics->>'deactivatedAt')::timestamptz AS off_at
        FROM user_models m
       WHERE m.metrics->>'deactivatedAt' IS NOT NULL
         AND (m.metrics->>'deactivatedAt')::timestamptz >= ${start}::timestamptz
         AND (m.metrics->>'deactivatedAt')::timestamptz < ${end}::timestamptz
    )
    SELECT count(*)::int AS invalidated,
           coalesce(sum(extract(epoch FROM
             least(coalesce(back.at, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)
             - inv.off_at)) / 3600.0, 0)::float8 AS hours,
           count(DISTINCT inv.user_id)::int AS users
      FROM inv
      LEFT JOIN LATERAL (
        SELECT min(n.trained_at) AS at FROM user_models n
         WHERE n.user_id = inv.user_id AND n.metrics->>'status' = 'activated'
           AND n.trained_at >= inv.off_at) back ON true`);
  // Models in service at any point of the window: activated before its end and neither
  // invalidated nor replaced by a newer activated model before its start.
  const inService = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM user_models m
     WHERE m.metrics->>'status' = 'activated' AND m.trained_at < ${end}::timestamptz
       AND coalesce(
             least(
               (m.metrics->>'deactivatedAt')::timestamptz,
               (SELECT min(n.trained_at) FROM user_models n
                 WHERE n.user_id = m.user_id AND n.metrics->>'status' = 'activated'
                   AND n.trained_at > m.trained_at)),
             'infinity'::timestamptz) >= ${start}::timestamptz`);
  const row = totals.rows[0];
  const attempts = row?.attempts ?? 0;
  const activated = row?.activated ?? 0;
  const inv = invalidated.rows[0];
  const active = inService.rows[0]?.n ?? 0;
  return {
    activation: { attempts, activated, rate: attempts === 0 ? null : activated / attempts },
    samples: { explicit: row?.explicit ?? 0 },
    skipped: Object.fromEntries(skipped.rows.map((r) => [r.reason, r.n])),
    paired: row?.paired ?? 0,
    pairedLogloss: row?.paired_logloss ?? 0,
    medianDeltaAuc: row?.d_auc ?? null,
    medianDeltaLogloss: row?.d_logloss ?? null,
    invalidation: {
      invalidated: inv?.invalidated ?? 0,
      rate: active === 0 ? null : Math.min(1, (inv?.invalidated ?? 0) / active),
    },
    cardsOnly: { hours: inv?.hours ?? 0, users: inv?.users ?? 0 },
  };
}

/** Engine aggregates of a window (spec 10 §7 "Engine"). */
export interface MetricsEngine {
  /** Live calls: everything but evaluation, credential probes and LibreTranslate. */
  calls: number;
  errors: number;
  coverage: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  articles: { firstSeen: number; degraded: number };
  degradedShare: number | null;
  billedUsdPerDay: number;
  usd: { active: number; training: number; other: number };
  /** Live calls on articles no active arrival and no selected request authorizes (off feeds). */
  offFeedCalls: number;
  cache: { requests: number; hits: number; savedUsd: number };
}

const LIVE = sql`c.kind NOT IN ('eval', 'credential_probe') AND c.engine <> 'libretranslate'`;

/**
 * Engine calls, cost and the shared-cache effect of the window `from <= created_at < to`, over `days`
 * days. An article is *active* when an active subscription's arrival at/after its activation carries
 * it, *training* when only a selected analysis request covers it, and a call on neither counts as
 * `other` (an off feed's article: the off-feed counter must stay zero).
 */
export async function metricsEngine(
  db: Executor,
  from: Date,
  to: Date,
  days: number,
): Promise<MetricsEngine> {
  const start = from.toISOString();
  const end = to.toISOString();
  const calls = await db.execute<{
    calls: number;
    errors: number;
    ok: number;
    p50: number | null;
    p95: number | null;
    active: number;
    training: number;
    other: number;
    off: number;
  }>(sql`
    WITH w AS (
      SELECT c.*,
             -- The basis recorded when the call was made decides (migration 0022). Only a row
             -- without one (written before it, or an article call from a path that records none) is
             -- attributed from the subscriptions and requests that exist now.
             CASE WHEN c.demand_basis IS NOT NULL THEN c.demand_basis = 'active'
                  ELSE EXISTS (SELECT 1 FROM feed_items fi
                       JOIN subscriptions s ON s.feed_id = fi.feed_id
                      WHERE fi.article_id = c.article_id AND s.inference_mode = 'active'
                        AND (s.inference_activated_at IS NULL
                             OR fi.first_seen_at >= s.inference_activated_at)) END AS by_active,
             CASE WHEN c.demand_basis IS NOT NULL THEN c.demand_basis = 'training'
                  ELSE EXISTS (SELECT 1 FROM analysis_requests r
                      WHERE r.article_id = c.article_id
                        AND r.status IN ('pending', 'running', 'complete')) END AS by_request
        FROM engine_calls c
       WHERE c.created_at >= ${start}::timestamptz AND c.created_at < ${end}::timestamptz)
    SELECT (count(*) FILTER (WHERE ${LIVE}))::int AS calls,
           (count(*) FILTER (WHERE ${LIVE} AND c.status <> 'ok'))::int AS errors,
           (count(*) FILTER (WHERE ${LIVE} AND c.status = 'ok'))::int AS ok,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY c.latency_ms)
             FILTER (WHERE ${LIVE} AND c.status = 'ok' AND c.latency_ms IS NOT NULL) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY c.latency_ms)
             FILTER (WHERE ${LIVE} AND c.status = 'ok' AND c.latency_ms IS NOT NULL) AS p95,
           coalesce(sum(c.cost_usd) FILTER (WHERE c.by_active), 0)::float8 AS active,
           coalesce(sum(c.cost_usd) FILTER (WHERE NOT c.by_active AND c.by_request), 0)::float8 AS training,
           coalesce(sum(c.cost_usd) FILTER (WHERE NOT c.by_active AND NOT c.by_request), 0)::float8 AS other,
           (count(*) FILTER (WHERE ${LIVE} AND c.article_id IS NOT NULL
                               AND NOT c.by_active AND NOT c.by_request))::int AS off
      FROM w c`);
  const articles = await db.execute<{ first_seen: number; degraded: number }>(sql`
    SELECT count(*)::int AS first_seen,
           (count(*) FILTER (WHERE pipeline_state = 'degraded'))::int AS degraded
      FROM articles
     WHERE first_seen_at >= ${start}::timestamptz AND first_seen_at < ${end}::timestamptz`);
  const cache = await db.execute<{ requests: number; hits: number; saved: number }>(sql`
    SELECT count(*)::int AS requests,
           (count(*) FILTER (WHERE paid.n > 0))::int AS hits,
           coalesce(sum(paid.usd) FILTER (WHERE paid.n > 0), 0)::float8 AS saved
      FROM analysis_requests r
      LEFT JOIN LATERAL (
        SELECT count(*) AS n, coalesce(sum(c.cost_usd), 0) AS usd
          FROM engine_calls c
         WHERE c.article_id = r.article_id AND ${LIVE} AND c.status = 'ok'
           AND c.created_at <= r.created_at) paid ON true
     WHERE r.status IN ('pending', 'running', 'complete')
       AND r.created_at >= ${start}::timestamptz AND r.created_at < ${end}::timestamptz`);
  const c = calls.rows[0];
  const a = articles.rows[0];
  const k = cache.rows[0];
  const total = (c?.calls ?? 0) === 0 ? null : (c?.ok ?? 0) / (c?.calls ?? 1);
  const round = (value: number | null | undefined) => (value == null ? null : Math.round(value));
  const usd = {
    active: c?.active ?? 0,
    training: c?.training ?? 0,
    other: c?.other ?? 0,
  };
  const firstSeen = a?.first_seen ?? 0;
  return {
    calls: c?.calls ?? 0,
    errors: c?.errors ?? 0,
    coverage: total,
    latencyMs: { p50: round(c?.p50), p95: round(c?.p95) },
    articles: { firstSeen, degraded: a?.degraded ?? 0 },
    degradedShare: firstSeen === 0 ? null : (a?.degraded ?? 0) / firstSeen,
    billedUsdPerDay: (usd.active + usd.training + usd.other) / days,
    usd,
    offFeedCalls: c?.off ?? 0,
    cache: { requests: k?.requests ?? 0, hits: k?.hits ?? 0, savedUsd: k?.saved ?? 0 },
  };
}

/** Classification queues whose due jobs are the classifying backlog. */
export const CLASSIFYING_QUEUES = [
  'article.enrich',
  'article.match',
  'article.translate',
  'article.cluster',
  'analysis.process',
] as const;

/** Due waiting jobs (`created`/`retry`, `start_after <= now`) of the classification queues. */
export async function metricsClassifyingBacklog(db: Executor, now: Date): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pgboss.job
     WHERE name = ANY(${sql.param([...CLASSIFYING_QUEUES])}::text[])
       AND state IN ('created', 'retry') AND start_after <= ${now.toISOString()}::timestamptz`);
  return result.rows[0]?.n ?? 0;
}

/** Pending or running selected analysis requests and the age of the oldest at `now`. */
export async function metricsTrainingQueue(
  db: Executor,
  now: Date,
): Promise<{ pending: number; oldestAgeSeconds: number | null }> {
  const result = await db.execute<{ n: number; age: number | null }>(sql`
    SELECT count(*)::int AS n,
           extract(epoch FROM ${now.toISOString()}::timestamptz - min(created_at))::float8 AS age
      FROM analysis_requests WHERE status IN ('pending', 'running')`);
  const row = result.rows[0];
  return { pending: row?.n ?? 0, oldestAgeSeconds: row?.age == null ? null : Math.round(row.age) };
}

/** Users with a subscription and their stored preferences, in id order after `after`, for the reader-policy counts. */
export async function metricsReaderUsers(
  db: Executor,
  after: string | null,
  limit: number,
): Promise<Array<{ userId: string; preferences: unknown }>> {
  const result = await db.execute<{ id: string; preferences: unknown }>(sql`
    SELECT u.id::text AS id, u.preferences
      FROM users u
     WHERE u.deleted_at IS NULL
       AND (${after}::uuid IS NULL OR u.id > ${after}::uuid)
       AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)
     ORDER BY u.id LIMIT ${limit}`);
  return result.rows.map((row) => ({ userId: row.id, preferences: row.preferences }));
}
