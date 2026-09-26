import type { JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { upsertArticleBody, type ArticleBodyInput } from './bodies.js';
import { reconcileClusters } from './clusters.js';
import { automaticCardDemand, carrierSubscriberIds } from './demand.js';
import { dropStaleMatchQueue, upsertMatchQueue } from './match-queue.js';
import { recordRankIntents } from './rank-intents.js';

/** Pipeline states a reset can leave an article in (spec 05 §5.6 step 3). */
export type ResetNextState = 'ingested' | 'extracted' | 'translated';

export interface ResetOptions {
  /** Short machine label recorded as the rank reason, e.g. `source_changed`, `body_changed`. */
  reason: string;
  /**
   * `ingested` when extraction must run for the new revision, `extracted` when an installed body
   * is the next input (translate/enrich follow the demand gate), `translated` when an installed
   * translation is.
   */
  nextState: ResetNextState;
  /** An explicit reprocess may take a stale article out of `stale`; nothing else does. */
  explicitReprocess?: boolean;
  /** Install this body at the new revision in the same transaction (a changed extraction or feed body). */
  installBody?: ArticleBodyInput;
  /**
   * Keep the current body row as valid input at the new revision (e.g. a language correction of
   * the same text). Otherwise the old row stays readable at its old revision, ineligible as model
   * input, until a replacement is stored (spec 03 §8.1 step 8).
   */
  keepBody?: boolean;
  /** Abort (result `stale_revision`) unless the article is still at this revision. */
  expectedRevision?: string;
}

export type ResetResult =
  | { status: 'missing' }
  | { status: 'stale_revision'; revision: string }
  | {
      status: 'reset';
      previousRevision: string;
      revision: string;
      pipelineState: string;
      /** The article is and stays `stale`: no queue rows, no stage work (the stale-preserving form). */
      stale: boolean;
      /** The admitted automatic card union now queued at the new revision. */
      admittedCardIds: string[];
      /** Users whose incremental rank intent was recorded. */
      rankedUserIds: string[];
    };

/**
 * `resetArticleAnswers(articleId)` (spec 05 §5.6): the single invalidation contract used whenever
 * classification inputs change (publisher title/excerpt/author/category edits, a changed body or
 * language, an identity merge). In the caller's transaction:
 * 1. lock the article, increment `content_revision` and remove the current facets, card answers,
 *    level-2 topics and translations (they belong to the old input); install the triggering body at
 *    the new revision when given, so it is not immediately stale;
 * 2. queue the admitted automatic article/card union at the new revision, clearing old leases and
 *    attempts, and drop queued questions of older revisions;
 * 3. set `pipeline_state` to `nextState` and leave the story cluster (reconciling its size and
 *    representative);
 * 4. record incremental rank intents for the carriers' subscribers.
 * Next-stage work (extraction, or the demand gate towards translate/enrich) is **not** recorded
 * here: `apps/worker/src/pipeline.ts` is the only place that decides the next stage, and callers
 * invoke it after this returns. Matching waits for current facets even though queue rows exist.
 *
 * A `stale` article keeps `pipeline_state = 'stale'` unless `explicitReprocess`: the reset still
 * performs step 1 and the rank intents, but queues no match rows, and callers record no
 * extract/enrich work, so a publisher correction never starts automatic inference on an old article.
 */
export async function resetArticleAnswers(
  tx: Transaction,
  sender: JobSender,
  articleId: string,
  options: ResetOptions,
): Promise<ResetResult> {
  const current = await tx.execute<{
    revision: string;
    pipeline_state: string;
    story_cluster_id: string | null;
  }>(sql`
    SELECT content_revision::text AS revision, pipeline_state, story_cluster_id::text AS story_cluster_id
      FROM articles WHERE id = ${articleId}::bigint FOR UPDATE`);
  const article = current.rows[0];
  if (article === undefined) return { status: 'missing' };
  if (options.expectedRevision !== undefined && article.revision !== options.expectedRevision) {
    return { status: 'stale_revision', revision: article.revision };
  }
  const stale = article.pipeline_state === 'stale' && options.explicitReprocess !== true;
  const nextState = stale ? 'stale' : options.nextState;

  const updated = await tx.execute<{ revision: string }>(sql`
    UPDATE articles
       SET content_revision = content_revision + 1, pipeline_state = ${nextState},
           enrich_engine = NULL, story_cluster_id = NULL, cluster_set_id = NULL, updated_at = now()
     WHERE id = ${articleId}::bigint
    RETURNING content_revision::text AS revision`);
  const revision = updated.rows[0]?.revision ?? article.revision;

  await tx.execute(sql`DELETE FROM article_facets WHERE article_id = ${articleId}::bigint`);
  await tx.execute(sql`DELETE FROM card_answers WHERE article_id = ${articleId}::bigint`);
  await tx.execute(sql`DELETE FROM article_topics_l2 WHERE article_id = ${articleId}::bigint`);
  await tx.execute(sql`DELETE FROM article_translations WHERE article_id = ${articleId}::bigint`);

  if (options.installBody !== undefined) {
    await upsertArticleBody(tx, articleId, revision, options.installBody);
  } else if (options.keepBody === true) {
    await tx.execute(sql`
      UPDATE article_bodies SET article_revision = ${revision}::bigint
       WHERE article_id = ${articleId}::bigint AND article_revision = ${article.revision}::bigint`);
  }

  await reconcileClusters(tx, [article.story_cluster_id]);

  let admittedCardIds: string[] = [];
  if (!stale) {
    admittedCardIds = await automaticCardDemand(tx, articleId);
    await upsertMatchQueue(tx, { articleId, revision, cardIds: admittedCardIds });
  }
  await dropStaleMatchQueue(tx, articleId, revision);

  const rankedUserIds = await carrierSubscriberIds(tx, articleId);
  await recordRankIntents(tx, sender, rankedUserIds, { reason: options.reason });

  return {
    status: 'reset',
    previousRevision: article.revision,
    revision,
    pipelineState: nextState,
    stale,
    admittedCardIds,
    rankedUserIds,
  };
}
