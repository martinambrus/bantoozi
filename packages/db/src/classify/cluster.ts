import type { JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { recordRankIntents } from '../ingest/rank-intents.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/** One clustering candidate row of spec 05 §6 step 1. */
export interface ClusterCandidateRow {
  id: string;
  revision: string;
  title: string;
  excerpt: string | null;
  firstSeenAt: Date;
  publishedAt: Date | null;
  feedId: string;
  feedTitle: string | null;
  similarity: number;
}

/** Trigram similarity threshold of the candidate query (spec 05 §6 step 1). */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.35;
/** Candidates read before the per-feed rule (spec 05 §6 step 1). */
export const CLUSTER_CANDIDATE_LIMIT = 20;

/**
 * The candidate query of spec 05 §6 step 1, verbatim in its predicates: similar titles first seen
 * within 72 hours before to 1 hour after the article, classified by the active enrich set at their
 * current revision (an eligibility witness, not a cache read), and authorized through an active
 * carrier for that arrival or a current selected request inside its 180-day window. Both witnesses
 * run before the limit, so off or unselected articles never take candidate slots, and the feed title
 * is always an authorized carrier's. Runs in the caller's transaction (`SET LOCAL`).
 */
export async function clusterCandidates(
  tx: Transaction,
  input: { articleId: string; firstSeenAt: Date; titleNorm: string; enrichSetId: string },
): Promise<ClusterCandidateRow[]> {
  await tx.execute(
    sql.raw(`SET LOCAL pg_trgm.similarity_threshold = ${CLUSTER_SIMILARITY_THRESHOLD}`),
  );
  const result = await tx.execute<{
    id: string;
    revision: string;
    title: string;
    excerpt: string | null;
    first_seen_at: RawTimestamp;
    published_at: RawTimestamp | null;
    feed_id: string;
    feed: string | null;
    sim: number;
  }>(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (a.id) a.id::text AS id, a.content_revision::text AS revision, a.title,
             a.excerpt, a.first_seen_at, a.published_at, f.id::text AS feed_id, f.title AS feed,
             similarity(a.title_norm, ${input.titleNorm}::text) AS sim
        FROM articles a
        JOIN feed_items fi ON fi.article_id = a.id
        JOIN feeds f ON f.id = fi.feed_id
        JOIN article_facets af ON af.article_id = a.id AND af.question_set_id = ${input.enrichSetId}::bigint
                              AND af.article_revision = a.content_revision
       WHERE a.id <> ${input.articleId}::bigint
         AND a.title_norm % ${input.titleNorm}::text
         AND a.first_seen_at BETWEEN ${input.firstSeenAt.toISOString()}::timestamptz - interval '72 hours'
                                 AND ${input.firstSeenAt.toISOString()}::timestamptz + interval '1 hour'
         AND (EXISTS (SELECT 1 FROM subscriptions s
                        JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
                       WHERE s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                         AND s.inference_activated_at <= fi.first_seen_at)
              OR EXISTS (SELECT 1 FROM analysis_requests r
                           JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                               AND s.inference_mode IN ('training','active')
                                               AND s.inference_version = r.inference_version
                           JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
                          WHERE r.article_id = a.id AND r.feed_id = fi.feed_id
                            AND r.article_revision = a.content_revision
                            AND r.created_at > now() - interval '180 days'
                            AND r.status IN ('pending','running','complete')))
       ORDER BY a.id, fi.first_seen_at, f.id
    ) c
    ORDER BY sim DESC, id
    LIMIT ${CLUSTER_CANDIDATE_LIMIT}`);
  return result.rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    title: row.title,
    excerpt: row.excerpt,
    firstSeenAt: toDate(row.first_seen_at),
    publishedAt: toDateOrNull(row.published_at),
    feedId: row.feed_id,
    feedTitle: row.feed,
    similarity: Number(row.sim),
  }));
}

/**
 * The feed the cluster state names for the new article (spec 05 §6 step 3): its oldest authorized
 * carrier (an active subscription's carrier that arrived at/after activation, or the feed of a
 * current selected request at the current revision), then the lowest feed id, so the title sent is
 * never an off or unselected feed's. Null when no carrier authorizes the article.
 */
export async function authorizedCarrierFeed(
  db: Executor,
  articleId: string,
): Promise<{ feedId: string; title: string | null } | null> {
  const result = await db.execute<{ feed_id: string; title: string | null }>(sql`
    SELECT f.id::text AS feed_id, f.title
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id
      JOIN feeds f ON f.id = fi.feed_id
     WHERE fi.article_id = ${articleId}::bigint
       AND ((a.pipeline_state <> 'stale'
             AND EXISTS (SELECT 1 FROM subscriptions s
                           JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
                          WHERE s.feed_id = fi.feed_id AND s.inference_mode = 'active'
                            AND s.inference_activated_at <= fi.first_seen_at))
            OR EXISTS (SELECT 1 FROM analysis_requests r
                         JOIN subscriptions s ON s.user_id = r.user_id AND s.feed_id = r.feed_id
                                             AND s.inference_mode IN ('training','active')
                                             AND s.inference_version = r.inference_version
                         JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
                        WHERE r.article_id = a.id AND r.feed_id = fi.feed_id
                          AND r.article_revision = a.content_revision
                          AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
                          AND r.status IN ('pending','running','complete')))
     ORDER BY fi.first_seen_at, fi.feed_id
     LIMIT 1`);
  const row = result.rows[0];
  return row === undefined ? null : { feedId: row.feed_id, title: row.title };
}

export type ClusterFoldResult =
  /** An article is gone or no longer at the revision the decision was made for. */
  | { status: 'stale' }
  /** Both articles already share a story (repeated delivery). */
  | { status: 'unchanged'; clusterId: string }
  | {
      status: 'created' | 'joined' | 'merged';
      clusterId: string;
      /** The losing cluster of a merge (now empty). */
      mergedClusterId?: string;
      /** Users whose `mute_story` rules named either merged cluster (full rank recorded). */
      mutedUserIds: string[];
    };

const compareIds = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Apply a positive fold decision (spec 05 §6 step 5) in the caller's short transaction: lock both
 * articles and then their clusters in ascending id order, reread both memberships and reject stale
 * revisions; then
 * - neither has a story: create one with both, the older article as representative;
 * - one has a story: the other joins it;
 * - both have different stories: merge them into the older (lower id) cluster, reassign every
 *   member, remap `mute_story` rules from the losing cluster to the survivor (a user who muted both
 *   keeps the later expiry) and record `user.rank {full}` for those users.
 * Every article this decision places records `cluster_set_id`; `size` is recomputed from members and
 * the oldest `(first_seen_at, id)` member is the representative, so a repeated delivery changes
 * nothing.
 */
export async function applyClusterFold(
  tx: Transaction,
  sender: JobSender,
  input: {
    articleId: string;
    articleRevision: string;
    targetArticleId: string;
    targetRevision: string;
    clusterSetId: string;
  },
): Promise<ClusterFoldResult> {
  const ids = [input.articleId, input.targetArticleId].sort(compareIds);
  const locked = await tx.execute<{ id: string; revision: string; cluster_id: string | null }>(sql`
    SELECT id::text AS id, content_revision::text AS revision,
           story_cluster_id::text AS cluster_id
      FROM articles WHERE id = ANY(${sql.param(ids)}::bigint[])
     ORDER BY id FOR UPDATE`);
  const byId = new Map(locked.rows.map((row) => [row.id, row]));
  const article = byId.get(input.articleId);
  const target = byId.get(input.targetArticleId);
  if (
    article === undefined ||
    target === undefined ||
    article.revision !== input.articleRevision ||
    target.revision !== input.targetRevision
  ) {
    return { status: 'stale' };
  }
  if (article.cluster_id !== null && article.cluster_id === target.cluster_id) {
    return { status: 'unchanged', clusterId: article.cluster_id };
  }

  const clusterIds = [article.cluster_id, target.cluster_id]
    .filter((id): id is string => id !== null)
    .sort(compareIds);
  if (clusterIds.length > 0) {
    await tx.execute(sql`
      SELECT id FROM story_clusters WHERE id = ANY(${sql.param(clusterIds)}::bigint[])
       ORDER BY id FOR NO KEY UPDATE`);
  }

  const place = async (articleIds: readonly string[], clusterId: string): Promise<void> => {
    await tx.execute(sql`
      UPDATE articles SET story_cluster_id = ${clusterId}::bigint,
                          cluster_set_id = ${input.clusterSetId}::bigint, updated_at = now()
       WHERE id = ANY(${sql.param([...articleIds])}::bigint[])`);
  };

  let status: 'created' | 'joined' | 'merged';
  let clusterId: string;
  let mergedClusterId: string | undefined;
  let mutedUserIds: string[] = [];
  if (article.cluster_id === null && target.cluster_id === null) {
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO story_clusters (representative_article_id, size)
      SELECT id, 2 FROM articles WHERE id = ANY(${sql.param(ids)}::bigint[])
       ORDER BY first_seen_at, id LIMIT 1
      RETURNING id::text AS id`);
    clusterId = created.rows[0]?.id ?? '';
    await place(ids, clusterId);
    status = 'created';
  } else if (article.cluster_id === null || target.cluster_id === null) {
    clusterId = (article.cluster_id ?? target.cluster_id) as string;
    await place([article.cluster_id === null ? article.id : target.id], clusterId);
    status = 'joined';
  } else {
    const [survivor, loser] = [article.cluster_id, target.cluster_id].sort(compareIds) as [
      string,
      string,
    ];
    clusterId = survivor;
    mergedClusterId = loser;
    await tx.execute(sql`
      UPDATE articles SET story_cluster_id = ${survivor}::bigint,
                          cluster_set_id = ${input.clusterSetId}::bigint, updated_at = now()
       WHERE story_cluster_id = ${loser}::bigint`);
    mutedUserIds = await remapMuteStoryRules(tx, loser, survivor);
    status = 'merged';
  }

  await refreshClusters(tx, [
    clusterId,
    ...(mergedClusterId === undefined ? [] : [mergedClusterId]),
  ]);
  if (mutedUserIds.length > 0) {
    await recordRankIntents(tx, sender, mutedUserIds, { reason: 'cluster_merge', full: true });
  }
  return {
    status,
    clusterId,
    ...(mergedClusterId === undefined ? {} : { mergedClusterId }),
    mutedUserIds,
  };
}

/**
 * Move `mute_story` rules from `loser` to `survivor` (spec 05 §6 step 5): a user with rules on both
 * keeps one survivor rule with the later expiry. Returns every user whose rules named either story.
 */
async function remapMuteStoryRules(
  tx: Transaction,
  loser: string,
  survivor: string,
): Promise<string[]> {
  const users = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT user_id::text AS user_id FROM user_rules
     WHERE kind = 'mute_story' AND value IN (${loser}, ${survivor})
     ORDER BY 1`);
  await tx.execute(sql`
    UPDATE user_rules s
       SET expires_at = greatest(s.expires_at, l.max_expires)
      FROM (SELECT user_id, max(expires_at) AS max_expires FROM user_rules
             WHERE kind = 'mute_story' AND value = ${loser} GROUP BY user_id) l
     WHERE s.kind = 'mute_story' AND s.value = ${survivor} AND s.user_id = l.user_id`);
  await tx.execute(sql`
    DELETE FROM user_rules l
     WHERE l.kind = 'mute_story' AND l.value = ${loser}
       AND EXISTS (SELECT 1 FROM user_rules s
                    WHERE s.user_id = l.user_id AND s.kind = 'mute_story' AND s.value = ${survivor})`);
  await tx.execute(sql`
    UPDATE user_rules SET value = ${survivor} WHERE kind = 'mute_story' AND value = ${loser}`);
  return users.rows.map((row) => row.user_id);
}

/** Recompute `size` from members and the oldest `(first_seen_at, id)` member as representative. */
async function refreshClusters(tx: Transaction, clusterIds: readonly string[]): Promise<void> {
  await tx.execute(sql`
    UPDATE story_clusters c
       SET size = m.n, representative_article_id = m.oldest, updated_at = now()
      FROM (SELECT sc.id, count(a.id)::int AS n,
                   (array_agg(a.id ORDER BY a.first_seen_at, a.id)
                      FILTER (WHERE a.id IS NOT NULL))[1] AS oldest
              FROM story_clusters sc
              LEFT JOIN articles a ON a.story_cluster_id = sc.id
             WHERE sc.id = ANY(${sql.param([...clusterIds])}::bigint[])
             GROUP BY sc.id) m
     WHERE c.id = m.id`);
}
