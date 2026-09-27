import { isBigIntString, isUuid, type InferenceAuthorization } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';

/**
 * The live recheck of a server-produced {@link InferenceAuthorization} (spec 04 §1.1, spec 05
 * §1.1, spec 02 §3.4): the engine store runs it inside the spend reservation transaction (paid
 * admission verifies the witness and reserves in one transaction) and on its own for free/local
 * calls. The predicates are those of `eligibleInferenceDemand` (ingest/demand.ts), applied to the
 * witnesses the caller captured instead of rediscovering them:
 *
 * - automatic: the witness user's subscription to that feed is still `active` at the witnessed
 *   `inference_version`, the feed carries the article with `first_seen_at` at/after activation,
 *   the account is not deleted, and the article is not stale and still at the authorized revision;
 * - manual: the `analysis_requests` row is pending/running/complete for exactly this article and
 *   the **authorized (frozen) revision**, its subscription is still `training`/`active` at the
 *   request's inference version, the account is not deleted, and it was created within the 180-day
 *   selection window. The live article may have advanced: a frozen request completes its own result.
 *
 * One valid witness is enough for shared article work. `suggest` authorizations hold the
 * `user.suggest` lease (spec 05 §7): the user row is locked when `lock` is set, the lease token
 * must be live, and every candidate article must still be authorized for that user. Credential
 * probes need the candidate under their own live validation lease, whose token they carry (D-90);
 * eval runs are separately authorized.
 * Malformed ids never reach SQL: they simply do not authorize.
 */

/** Suggestion states hold at most five liked articles (spec 05 §7); leave room, stay bounded. */
const MAX_SUGGEST_ARTICLES = 50;
const MAX_WITNESSES = 1000;
const MAX_RUN_ID_LENGTH = 200;

const isPositiveId = (value: unknown): value is string =>
  typeof value === 'string' && isBigIntString(value) && BigInt(value) > 0n;
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && isBigIntString(value) && BigInt(value) >= 0n;
const uuid = (value: unknown): value is string => typeof value === 'string' && isUuid(value);

async function exists(db: Executor, query: SQL): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(query);
  return result.rows[0]?.ok === true;
}

export interface AuthorizationCheckOptions {
  /**
   * Take the row locks admission needs (the suggest user row `FOR NO KEY UPDATE`, the credential
   * row `FOR SHARE`); only inside a transaction.
   */
  lock?: boolean;
}

/** Whether `authorization` still grants inference now. */
export async function isInferenceAuthorized(
  db: Executor,
  authorization: InferenceAuthorization,
  options: AuthorizationCheckOptions = {},
): Promise<boolean> {
  switch (authorization.type) {
    case 'article':
      return articleAuthorized(db, authorization);
    case 'suggest':
      return suggestAuthorized(db, authorization, options.lock === true);
    case 'credential_probe':
      return probeAuthorized(db, authorization, options.lock === true);
    case 'eval':
      return (
        typeof authorization.runId === 'string' &&
        authorization.runId.trim().length > 0 &&
        authorization.runId.length <= MAX_RUN_ID_LENGTH
      );
    default:
      return false;
  }
}

async function articleAuthorized(
  db: Executor,
  authorization: Extract<InferenceAuthorization, { type: 'article' }>,
): Promise<boolean> {
  const { articleId, articleRevision } = authorization;
  const witnesses = Array.isArray(authorization.witnesses) ? authorization.witnesses : [];
  if (!isPositiveId(articleId) || !isPositiveId(articleRevision)) return false;
  if (witnesses.length === 0 || witnesses.length > MAX_WITNESSES) return false;

  const users: string[] = [];
  const feeds: string[] = [];
  const versions: string[] = [];
  const requests: string[] = [];
  for (const w of witnesses) {
    if (w.kind === 'automatic') {
      if (uuid(w.userId) && isPositiveId(w.feedId) && isRevision(w.inferenceVersion)) {
        users.push(w.userId);
        feeds.push(w.feedId);
        versions.push(w.inferenceVersion);
      }
    } else if (w.kind === 'manual' && uuid(w.analysisRequestId)) {
      requests.push(w.analysisRequestId);
    }
  }

  if (
    users.length > 0 &&
    (await exists(
      db,
      sql`
        SELECT EXISTS (
          SELECT 1
            FROM unnest(${sql.param(users)}::uuid[], ${sql.param(feeds)}::bigint[],
                        ${sql.param(versions)}::bigint[]) AS w(user_id, feed_id, inference_version)
            JOIN subscriptions s ON s.user_id = w.user_id AND s.feed_id = w.feed_id
                                AND s.inference_mode = 'active'
                                AND s.inference_version = w.inference_version
            JOIN feed_items fi ON fi.feed_id = s.feed_id AND fi.article_id = ${articleId}::bigint
                              AND fi.first_seen_at >= s.inference_activated_at
            JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
                           AND a.content_revision = ${articleRevision}::bigint
            JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL) AS ok`,
    ))
  ) {
    return true;
  }

  return (
    requests.length > 0 &&
    exists(
      db,
      sql`
        SELECT EXISTS (
          SELECT 1
            FROM analysis_requests r
            JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                AND s.inference_mode IN ('training', 'active')
                                AND s.inference_version = r.inference_version
            JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
           WHERE r.id = ANY(${sql.param(requests)}::uuid[])
             AND r.article_id = ${articleId}::bigint
             AND r.article_revision = ${articleRevision}::bigint
             AND r.status IN ('pending', 'running', 'complete')
             AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})) AS ok`,
    )
  );
}

async function suggestAuthorized(
  db: Executor,
  authorization: Extract<InferenceAuthorization, { type: 'suggest' }>,
  lock: boolean,
): Promise<boolean> {
  const { userId, leaseToken } = authorization;
  const articleIds = Array.isArray(authorization.eligibleArticleIds)
    ? authorization.eligibleArticleIds
    : [];
  if (!uuid(userId) || !uuid(leaseToken)) return false;
  if (articleIds.length === 0 || articleIds.length > MAX_SUGGEST_ARTICLES) return false;
  if (!articleIds.every(isPositiveId)) return false;

  const lease = await db.execute<{ live: boolean }>(sql`
    SELECT (u.deleted_at IS NULL AND u.suggest_lease_token = ${leaseToken}::uuid
            AND u.suggest_lease_until > now()) AS live
      FROM users u
     WHERE u.id = ${userId}::uuid
     ${lock ? sql`FOR NO KEY UPDATE` : sql.empty()}`);
  if (lease.rows[0]?.live !== true) return false;

  // Every candidate must still be authorized for this user: an automatic carrier arrival of one of
  // the user's active subscriptions, or a live selected request at the current revision.
  return exists(
    db,
    sql`
      WITH c AS (SELECT DISTINCT unnest(${sql.param(articleIds)}::bigint[]) AS article_id)
      SELECT NOT EXISTS (
        SELECT 1 FROM c
         WHERE NOT EXISTS (
                 SELECT 1
                   FROM feed_items fi
                   JOIN articles a ON a.id = fi.article_id AND a.pipeline_state <> 'stale'
                   JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ${userId}::uuid
                                       AND s.inference_mode = 'active'
                                       AND fi.first_seen_at >= s.inference_activated_at
                  WHERE fi.article_id = c.article_id)
           AND NOT EXISTS (
                 SELECT 1
                   FROM analysis_requests r
                   JOIN articles a ON a.id = r.article_id AND a.content_revision = r.article_revision
                   JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                       AND s.inference_mode IN ('training', 'active')
                                       AND s.inference_version = r.inference_version
                  WHERE r.user_id = ${userId}::uuid AND r.article_id = c.article_id
                    AND r.status IN ('pending', 'running', 'complete')
                    AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS}))
      ) AS ok`,
  );
}

async function probeAuthorized(
  db: Executor,
  authorization: Extract<InferenceAuthorization, { type: 'credential_probe' }>,
  lock: boolean,
): Promise<boolean> {
  const { provider, candidateVersion, validationToken } = authorization;
  if (provider !== 'typesafe' && provider !== 'ollama') return false;
  if (!isPositiveId(candidateVersion) || !uuid(validationToken)) return false;
  // The probe's own lease: a validator whose lease was reclaimed admits nothing under the new one.
  const result = await db.execute<{ ok: boolean }>(sql`
    SELECT true AS ok
      FROM provider_credentials c
     WHERE c.provider = ${provider}
       AND c.candidate_version = ${candidateVersion}::bigint
       AND c.candidate_status = 'validating'
       AND c.validation_token = ${validationToken}::uuid
       AND c.validation_until > now()
     ${lock ? sql`FOR SHARE` : sql.empty()}`);
  return result.rows[0]?.ok === true;
}
