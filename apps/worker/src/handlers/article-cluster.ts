import {
  applyClusterFold,
  authorizedCarrierFeed,
  clusterCandidates,
  eligibleInferenceDemand,
  loadClassificationArticle,
  retryTransaction,
  workerOutbox,
} from '@bantoozi/db';
import {
  buildClusterState,
  clusterFoldDecision,
  clusterQuestions,
  selectClusterCandidates,
  stateSha256,
} from '@bantoozi/questions';
import { enqueueCluster } from '@bantoozi/shared';

import { loadClassificationConfig, requireSet, sameClusterConfig } from '../classify/config.js';
import { after } from '../pipeline.js';
import { nowOf, pipelineContext, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/**
 * `article.cluster {articleId}` (spec 05 §6). Best-effort story clustering after a demanded Call A:
 * no current article demand, an article already placed at this revision, or no authorized
 * candidate means no call. Candidates come from the spec's SQL (authorized carriers or current
 * selections, classified at their current revision) and the per-feed rule in code; the state names
 * only authorized carriers' feed titles. A positive fold decision is applied under stable-order locks
 * with stale revisions rejected (`applyClusterFold`, which also remaps `mute_story` rules on a merge),
 * and a changed membership re-ranks the story's readers through `pipeline.after('cluster')`. A
 * decision is applied only while the enrich and cluster sets it was made with are still active;
 * otherwise it is discarded and the article is queued again for the new sets. An engine that is not
 * ok leaves the article unclustered.
 */
export function createArticleClusterHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'article.cluster'> {
  return async ({ articleId }) => {
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const enrichSet = requireSet(config.enrich, 'enrich');
    const clusterSet = requireSet(config.cluster, 'cluster');
    const article = await loadClassificationArticle(deps.db, articleId);
    if (article === null) return;
    if (article.pipelineState !== 'enriched' && article.pipelineState !== 'matched') return;
    // A reset clears membership, so a placed article is a duplicate delivery of this revision.
    if (article.storyClusterId !== null) return;
    const witnesses = await eligibleInferenceDemand(deps.db, articleId);
    if (witnesses.length === 0) return;

    const rows = await deps.db.transaction((tx) =>
      clusterCandidates(tx, {
        articleId,
        firstSeenAt: article.firstSeenAt,
        titleNorm: article.titleNorm,
        enrichSetId: enrichSet.id,
      }),
    );
    const candidates = selectClusterCandidates(rows);
    if (candidates.length === 0) return;
    const carrier = await authorizedCarrierFeed(deps.db, articleId);
    const { state, keys } = buildClusterState(
      {
        title: article.title,
        excerpt: article.excerpt,
        feed: carrier?.title ?? null,
        at: article.firstSeenAt,
      },
      candidates.map((c) => ({
        title: c.title,
        excerpt: c.excerpt,
        feed: c.feedTitle,
        at: c.firstSeenAt,
      })),
    );

    const outcome = await classification.router.ask({
      kind: 'cluster',
      state,
      questions: clusterQuestions(keys.length),
      questionSetId: clusterSet.id,
      questionSetSha: clusterSet.sha256,
      articleId,
      articleRevision: article.revision,
      stateSha256: stateSha256(state),
      priority: 'bulk',
      authorization: { type: 'article', articleId, articleRevision: article.revision, witnesses },
      deadlineMs: nowOf(deps).getTime() + classification.callDeadlineMs,
    });
    if (!outcome.ok) {
      if (outcome.reason !== 'no_demand') {
        deps.logger.info(
          { articleId, reason: outcome.reason, metric: 'cluster_skipped' },
          'clustering skipped: engine unavailable',
        );
      }
      return;
    }
    const decision = clusterFoldDecision(outcome.answers, keys);
    if (!decision.fold) return;
    const target = candidates[keys.indexOf(decision.key)];
    if (target === undefined) return;

    await retryTransaction(deps.db, async (tx) => {
      const sender = workerOutbox(tx);
      // Under share locks: a switch committing meanwhile waits for this fold or is seen here.
      const current = await loadClassificationConfig(tx, deps.settingsEnv, { lock: true });
      if (!sameClusterConfig(config, current)) {
        // A set switched during the call: the decision used questions or candidates no longer
        // active, so the new sets decide on the next delivery.
        await enqueueCluster(sender, { articleId }, { revision: article.revision });
        return;
      }
      const result = await applyClusterFold(tx, sender, {
        articleId,
        articleRevision: article.revision,
        targetArticleId: target.id,
        targetRevision: target.revision,
        clusterSetId: clusterSet.id,
      });
      if (result.status === 'stale' || result.status === 'unchanged') return;
      await after(
        'cluster',
        articleId,
        { status: 'ok', revision: article.revision, clusterChanged: true },
        pipelineContext(deps, tx, sender),
      );
    });
  };
}
