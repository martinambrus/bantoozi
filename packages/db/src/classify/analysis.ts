import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { enqueueAnalysis } from '@bantoozi/shared';

import type { Database, Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { tenantOutbox } from '../outbox.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/** Failure attempts after which a selected request becomes `failed` (spec 03 §2.2 attempt ceiling). */
export const ANALYSIS_MAX_ATTEMPTS = 5;

/** One claimed `analysis_requests` row (spec 02 §4, spec 03 §2.2). */
export interface AnalysisRequestRow {
  id: string;
  userId: string;
  feedId: string;
  articleId: string;
  /** The frozen revision the request selected. */
  articleRevision: string;
  inferenceVersion: string;
  inputSnapshot: unknown;
  inputSha: string;
  /** Results of finished stages under earlier leases (resumable stages; migration 0013). */
  stageResults: unknown;
  attempts: number;
  createdAt: Date;
}

export type AnalysisClaim =
  | { status: 'missing' }
  /** Complete, failed or cancelled: a duplicate job is a no-op. */
  | { status: 'finished' }
  /** Another worker holds a live lease until `leaseUntil`. */
  | { status: 'busy'; leaseUntil: Date }
  /** Pending with a later due time: the delayed intent recorded at deferral will run it. */
  | { status: 'not_due'; nextAttemptAt: Date }
  /** Past its 180-day retention window: cancelled now as `retention_expired`. */
  | { status: 'expired' }
  | { status: 'claimed'; request: AnalysisRequestRow; leaseToken: string };

/**
 * Claim a due pending request, or reclaim an expired running lease (spec 03 §2.2), in a short
 * transaction of its own under the row lock: `status='running'` with a fresh lease token and expiry.
 * A request past its retention window is cancelled instead (`retention_expired`, spec 11 §5).
 * Commits before any external work.
 */
export async function claimAnalysisRequest(
  db: Database,
  id: string,
  options: { leaseMs: number },
): Promise<AnalysisClaim> {
  const leaseToken = randomUUID();
  return db.transaction(async (tx) => {
    const found = await tx.execute<{
      status: string;
      live_lease: boolean;
      lease_until: RawTimestamp | null;
      due: boolean;
      next_attempt_at: RawTimestamp;
      expired: boolean;
    }>(sql`
      SELECT status, (lease_until IS NOT NULL AND lease_until >= now()) AS live_lease, lease_until,
             next_attempt_at <= now() AS due, next_attempt_at,
             created_at <= now() - make_interval(days => ${SELECTION_WINDOW_DAYS}) AS expired
        FROM analysis_requests WHERE id = ${id}::uuid FOR UPDATE`);
    const row = found.rows[0];
    if (row === undefined) return { status: 'missing' };
    if (row.status === 'complete' || row.status === 'failed' || row.status === 'cancelled') {
      return { status: 'finished' };
    }
    if (row.status === 'running' && row.live_lease && row.lease_until !== null) {
      return { status: 'busy', leaseUntil: toDate(row.lease_until) };
    }
    if (row.expired) {
      await tx.execute(sql`
        UPDATE analysis_requests
           SET status = 'cancelled', last_error_code = 'retention_expired', lease_token = NULL,
               lease_until = NULL, completed_at = now()
         WHERE id = ${id}::uuid`);
      return { status: 'expired' };
    }
    if (row.status === 'pending' && !row.due) {
      return { status: 'not_due', nextAttemptAt: toDate(row.next_attempt_at) };
    }
    const claimed = await tx.execute<{
      id: string;
      user_id: string;
      feed_id: string;
      article_id: string;
      article_revision: string;
      inference_version: string;
      input_snapshot: unknown;
      input_sha: string;
      stage_results: unknown;
      attempts: number;
      created_at: RawTimestamp;
    }>(sql`
      UPDATE analysis_requests
         SET status = 'running', lease_token = ${leaseToken}::uuid,
             lease_until = now() + make_interval(secs => ${options.leaseMs / 1000}::double precision)
       WHERE id = ${id}::uuid
      RETURNING id::text AS id, user_id::text AS user_id, feed_id::text AS feed_id,
                article_id::text AS article_id, article_revision::text AS article_revision,
                inference_version::text AS inference_version, input_snapshot, input_sha,
                stage_results, attempts, created_at`);
    const request = claimed.rows[0];
    if (request === undefined) return { status: 'missing' };
    return {
      status: 'claimed',
      leaseToken,
      request: {
        id: request.id,
        userId: request.user_id,
        feedId: request.feed_id,
        articleId: request.article_id,
        articleRevision: request.article_revision,
        inferenceVersion: request.inference_version,
        inputSnapshot: request.input_snapshot,
        inputSha: request.input_sha,
        stageResults: request.stage_results,
        attempts: request.attempts,
        createdAt: toDate(request.created_at),
      },
    };
  });
}

/** Extend a live lease; false when the lease was lost (cancelled, reclaimed or finished). */
export async function renewAnalysisLease(
  db: Executor,
  id: string,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE analysis_requests
       SET lease_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision)
     WHERE id = ${id}::uuid AND status = 'running' AND lease_token = ${leaseToken}::uuid`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Persist the results of finished stages under the current lease (resumable bounded stages): a
 * reclaimed request resumes from them instead of paying for a stage again. False when the lease
 * was lost.
 */
export async function saveAnalysisStages(
  db: Executor,
  id: string,
  leaseToken: string,
  stageResults: unknown,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE analysis_requests SET stage_results = ${JSON.stringify(stageResults)}::jsonb
     WHERE id = ${id}::uuid AND status = 'running' AND lease_token = ${leaseToken}::uuid`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether the request still authorizes inference for its user (spec 05 §1.1, spec 04 §1.1): the
 * user is active, the subscription to its feed is still training/active at the request's inference
 * version, and the request is inside its retention window. The live article revision is NOT
 * required: a frozen request may complete its own result after the article advanced.
 */
export async function analysisRequestAuthorized(db: Executor, id: string): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM analysis_requests r
        JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
        JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                            AND s.inference_mode IN ('training', 'active')
                            AND s.inference_version = r.inference_version
       WHERE r.id = ${id}::uuid AND r.status IN ('pending', 'running')
         AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})) AS ok`);
  return result.rows[0]?.ok === true;
}

/**
 * Lock the request for a guarded publication and report whether this lease still owns it and its
 * authorization still holds (the completion fence of spec 03 §2.2).
 */
export async function lockAnalysisRequest(
  db: Executor,
  id: string,
  leaseToken: string,
): Promise<'owned' | 'lost' | 'revoked'> {
  const result = await db.execute<{ owned: boolean; authorized: boolean }>(sql`
    SELECT (r.status = 'running' AND r.lease_token = ${leaseToken}::uuid) AS owned,
           EXISTS (SELECT 1 FROM users u
                     JOIN subscriptions s ON s.user_id = u.id AND s.feed_id = r.feed_id
                                         AND s.inference_mode IN ('training', 'active')
                                         AND s.inference_version = r.inference_version
                    WHERE u.id = r.user_id AND u.deleted_at IS NULL)
             AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS}) AS authorized
      FROM analysis_requests r WHERE r.id = ${id}::uuid FOR UPDATE OF r`);
  const row = result.rows[0];
  if (row === undefined || !row.owned) return 'lost';
  return row.authorized ? 'owned' : 'revoked';
}

/**
 * Publish the immutable result (spec 05 §1.1): `complete`, `result_snapshot`, `result_sha` (the hex
 * SHA-256 of the stored jsonb text, D-4), completion time, lease cleared. Only this lease may
 * complete a running request; a finished request is final (its trigger enforces it too).
 */
export async function completeAnalysisRequest(
  db: Executor,
  id: string,
  leaseToken: string,
  resultSnapshot: unknown,
): Promise<string | null> {
  const json = JSON.stringify(resultSnapshot);
  const result = await db.execute<{ result_sha: string }>(sql`
    UPDATE analysis_requests
       SET status = 'complete', result_snapshot = ${json}::jsonb,
           result_sha = encode(sha256(convert_to((${json}::jsonb)::text, 'UTF8')), 'hex'),
           completed_at = now(), lease_token = NULL, lease_until = NULL, last_error_code = NULL
     WHERE id = ${id}::uuid AND status = 'running' AND lease_token = ${leaseToken}::uuid
    RETURNING result_sha`);
  return result.rows[0]?.result_sha ?? null;
}

/**
 * Leave `running` without a result (spec 03 §2.2): `defer` returns it to pending at a due time
 * without a failure attempt (budget, no key, open breaker); `retry` counts one failure attempt with
 * bounded backoff and fails the request at {@link ANALYSIS_MAX_ATTEMPTS}; `fail` is terminal
 * (persistent invalid input); `cancel` is a quiet revocation (`no_demand`, opt-out). Only the lease
 * holder may do this; returns the resulting status, or null when the lease was lost.
 */
export async function releaseAnalysisRequest(
  db: Executor,
  id: string,
  leaseToken: string,
  release:
    | { kind: 'defer'; nextAttemptAt: Date; errorCode: string }
    | { kind: 'retry'; errorCode: string }
    | { kind: 'fail'; errorCode: string }
    | { kind: 'cancel'; errorCode: string },
): Promise<{ status: 'pending' | 'failed' | 'cancelled'; nextAttemptAt: Date } | null> {
  const owned = sql`WHERE id = ${id}::uuid AND status = 'running' AND lease_token = ${leaseToken}::uuid`;
  let result;
  switch (release.kind) {
    case 'defer':
      result = await db.execute<{ status: 'pending'; next_attempt_at: RawTimestamp }>(sql`
        UPDATE analysis_requests
           SET status = 'pending', lease_token = NULL, lease_until = NULL,
               last_error_code = ${release.errorCode},
               next_attempt_at = greatest(now(), ${release.nextAttemptAt.toISOString()}::timestamptz)
        ${owned} RETURNING status, next_attempt_at`);
      break;
    case 'retry':
      result = await db.execute<{
        status: 'pending' | 'failed';
        next_attempt_at: RawTimestamp;
      }>(sql`
        UPDATE analysis_requests
           SET status = CASE WHEN attempts + 1 >= ${ANALYSIS_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
               completed_at = CASE WHEN attempts + 1 >= ${ANALYSIS_MAX_ATTEMPTS} THEN now() END,
               attempts = attempts + 1, lease_token = NULL, lease_until = NULL,
               last_error_code = ${release.errorCode},
               next_attempt_at = now() + make_interval(mins => power(2, least(attempts, 3))::int)
        ${owned} RETURNING status, next_attempt_at`);
      break;
    case 'fail':
    case 'cancel':
      result = await db.execute<{
        status: 'failed' | 'cancelled';
        next_attempt_at: RawTimestamp;
      }>(sql`
        UPDATE analysis_requests
           SET status = ${release.kind === 'fail' ? 'failed' : 'cancelled'},
               last_error_code = ${release.errorCode}, lease_token = NULL, lease_until = NULL,
               completed_at = now()
        ${owned} RETURNING status, next_attempt_at`);
      break;
  }
  const row = result.rows[0];
  return row === undefined
    ? null
    : { status: row.status, nextAttemptAt: toDate(row.next_attempt_at) };
}

/**
 * Whether a surviving rating of the request's user on its article references the request (spec 05
 * §1.1: completion then records `user.learn`, so an inaugural rating becomes learnable).
 */
export async function analysisRatingReferences(
  db: Executor,
  input: { requestId: string; userId: string; articleId: string },
): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM user_article ua
       WHERE ua.user_id = ${input.userId}::uuid AND ua.article_id = ${input.articleId}::bigint
         AND ua.rating IS NOT NULL
         AND EXISTS (SELECT 1 FROM feedback_events e
                      WHERE e.user_id = ua.user_id AND e.article_id = ua.article_id
                        AND e.kind IN ('rate', 'prompt_answer')
                        AND e.value ->> 'analysisRequestId' = ${input.requestId})) AS ok`);
  return result.rows[0]?.ok === true;
}

/**
 * Create a selected-article request as its tenant (spec 03 §2.2, spec 08 `POST
 * /subscriptions/:feedId/analyze`): the immutable input snapshot with `input_sha` computed over the
 * stored jsonb text (the insert trigger verifies it, D-4), plus its `analysis.process` intent in the
 * same transaction. The insert trigger also requires a training/active subscription at
 * `inferenceVersion`, a carrier of the article in that feed and the article at `articleRevision`.
 */
export async function createAnalysisRequest(
  tx: TenantTx,
  input: {
    feedId: string;
    articleId: string;
    articleRevision: string;
    inferenceVersion: string;
    inputSnapshot: unknown;
  },
): Promise<{ id: string; inputSha: string }> {
  const id = randomUUID();
  const json = JSON.stringify(input.inputSnapshot);
  const result = await tx.execute<{ input_sha: string }>(sql`
    INSERT INTO analysis_requests
           (id, user_id, feed_id, article_id, article_revision, inference_version, input_snapshot,
            input_sha)
    VALUES (${id}::uuid, ${tenantUserId(tx)}::uuid, ${input.feedId}::bigint,
            ${input.articleId}::bigint, ${input.articleRevision}::bigint,
            ${input.inferenceVersion}::bigint, ${json}::jsonb,
            encode(sha256(convert_to((${json}::jsonb)::text, 'UTF8')), 'hex'))
    RETURNING input_sha`);
  await enqueueAnalysis(tenantOutbox(tx), { analysisRequestId: id });
  return { id, inputSha: result.rows[0]?.input_sha ?? '' };
}

/** A held card or label of the request's user that applies to its feed (spec 05 §1.1). */
export interface AnalysisHeldCard {
  cardId: string;
  kind: 'interest' | 'label';
  /** The holder's strength; null for a label. */
  strength: 'must' | 'love' | 'like' | 'never' | null;
}

/**
 * What a selected-article capture reads besides the model-state inputs (spec 05 §1.1, spec 06
 * §8.1): the request feed's arrival, source timestamps, media and story-group context, and the
 * user's held interest cards whose scope includes the feed plus their labels. Null when the feed
 * does not carry the article.
 */
export interface AnalysisCaptureContext {
  firstSeenAt: Date;
  publishedAt: Date | null;
  hasImage: boolean;
  hasVideo: boolean | null;
  bodyImageCount: number | null;
  storyClusterId: string | null;
  clusterSize: number;
  cards: AnalysisHeldCard[];
}

export async function loadAnalysisCaptureContext(
  db: Executor,
  input: { userId: string; feedId: string; articleId: string },
): Promise<AnalysisCaptureContext | null> {
  const article = await db.execute<{
    first_seen_at: RawTimestamp;
    published_at: RawTimestamp | null;
    has_image: boolean;
    has_video: boolean | null;
    body_image_count: number | null;
    story_cluster_id: string | null;
    cluster_size: number | null;
  }>(sql`
    SELECT fi.first_seen_at, a.published_at, a.image_url IS NOT NULL AS has_image, a.has_video,
           a.body_image_count, a.story_cluster_id::text AS story_cluster_id, sc.size AS cluster_size
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id
      LEFT JOIN story_clusters sc ON sc.id = a.story_cluster_id
     WHERE fi.feed_id = ${input.feedId}::bigint AND fi.article_id = ${input.articleId}::bigint`);
  const row = article.rows[0];
  if (row === undefined) return null;
  const cards = await db.execute<{
    card_id: string;
    kind: 'interest' | 'label';
    strength: AnalysisHeldCard['strength'];
  }>(sql`
    SELECT uc.card_id::text AS card_id, 'interest' AS kind, uc.strength
      FROM user_cards uc
     WHERE uc.user_id = ${input.userId}::uuid
       AND (uc.scope_feed_id IS NULL OR uc.scope_feed_id = ${input.feedId}::bigint)
    UNION ALL
    SELECT ul.card_id::text, 'label', NULL
      FROM user_labels ul
     WHERE ul.user_id = ${input.userId}::uuid
     ORDER BY 1`);
  return {
    firstSeenAt: toDate(row.first_seen_at),
    publishedAt: toDateOrNull(row.published_at),
    hasImage: row.has_image,
    hasVideo: row.has_video,
    bodyImageCount: row.body_image_count,
    storyClusterId: row.story_cluster_id,
    clusterSize: Math.max(1, row.cluster_size ?? 1),
    cards: cards.rows.map((card) => ({
      cardId: card.card_id,
      kind: card.kind,
      strength: card.strength,
    })),
  };
}
