import {
  ENRICHABLE_STATES,
  PRE_ENRICH_STATES,
  automaticCardDemand,
  eligibleInferenceDemand,
  isPrimaryAnswer,
  listTranslations,
  loadClassificationArticle,
  lockArticleRevision,
  readFacets,
  readL2Answers,
  retryTransaction,
  transitionPipelineState,
  upsertMatchQueue,
  workerOutbox,
  writeFacets,
  type ClassificationArticle,
  type FacetRow,
  type Transaction,
} from '@bantoozi/db';
import { enqueueEnrich } from '@bantoozi/shared';

import {
  enrichQuestions,
  loadClassificationConfig,
  requireSet,
  sameEnrichConfig,
  type ActiveQuestionSet,
  type ClassificationConfig,
} from '../classify/config.js';
import { currentL2Answers, facetFeatures, l2Branches } from '../classify/features.js';
import { buildState, modelInput, type ModelInput } from '../classify/model-input.js';
import { failureDisposition } from '../classify/outcomes.js';
import { after } from '../pipeline.js';
import { nowOf, pipelineContext, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/** Articles in these states already continued from a successful Call A of their revision. */
const ENRICHED_STATES: readonly string[] = ['enriched', 'matched'];

/**
 * `article.enrich {articleId, priority?}` (spec 05 §3, spec 03 §1). Recomputes live demand (no
 * witness: the article stops quietly at its local stage), builds the Call A state of the current
 * revision and asks the active enrich set through the router, unless a current primary answer for
 * that exact input already exists (an analysis cache fill, a duplicate job). The completion locks
 * the article, rejects a changed revision or configuration, writes the facets with the precedence
 * guard (a fallback never replaces a primary answer of the same input), moves the article to
 * `enriched` and continues through `pipeline.after`. An unavailable engine degrades an article
 * that has no facets yet, an invalid request fails it, and neither ever downgrades an article that
 * already has facets (a recovery retry of LLM answers leaves them in place). Every one of these
 * writes first rechecks the configuration: after a switch the job runs again instead (D-85). A
 * completion also reads the translation rows again under the article lock: a translation stored
 * during Call A changed the input, and the job runs again instead (D-94).
 *
 * Without `priority` the job is interactive, so the LLM fallback may serve new arrivals while Jev
 * is unavailable; recovery and re-enrichment send `bulk` (spec 04 §5).
 */
export function createArticleEnrichHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'article.enrich'> {
  return async (payload) => {
    const { articleId } = payload;
    const priority = payload.priority ?? 'interactive';
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const enrichSet = requireSet(config.enrich, 'enrich');

    const article = await loadClassificationArticle(deps.db, articleId);
    if (article === null || !ENRICHABLE_STATES.includes(article.pipelineState as never)) return;
    const witnesses = await eligibleInferenceDemand(deps.db, articleId);
    if (witnesses.length === 0) return;

    const input = modelInput(
      article,
      await listTranslations(deps.db, articleId, article.revision),
      config,
    );
    const enrichState = buildState(input, 'enrich');

    const stored = await readFacets(deps.db, articleId, enrichSet.id);
    if (
      stored !== null &&
      stored.articleRevision === article.revision &&
      stored.stateSha256 === enrichState.sha256 &&
      isPrimaryAnswer(stored, classification.primaryModel)
    ) {
      await continueFromCache(deps, config, article, stored, priority);
      return;
    }

    const outcome = await classification.router.ask({
      kind: 'enrich',
      state: enrichState.state,
      questions: enrichQuestions(enrichSet),
      questionSetId: enrichSet.id,
      questionSetSha: enrichSet.sha256,
      articleId,
      articleRevision: article.revision,
      stateSha256: enrichState.sha256,
      priority,
      authorization: {
        type: 'article',
        articleId,
        articleRevision: article.revision,
        witnesses,
      },
      deadlineMs: nowOf(deps).getTime() + classification.callDeadlineMs,
    });

    if (outcome.ok) {
      await retryTransaction(deps.db, async (tx) => {
        const locked = await lockArticleRevision(tx, articleId, 'update');
        // A reset replaced the input meanwhile: its own intents enrich the new revision.
        if (locked === null || locked.revision !== article.revision) return;
        const current = await configHolds(tx, deps, config, article, priority);
        if (current === null) return;
        if (!(await inputHolds(tx, deps, current, article, enrichState.sha256, priority))) return;
        await writeFacets(
          tx,
          {
            articleId,
            questionSetId: enrichSet.id,
            articleRevision: article.revision,
            stateSha256: enrichState.sha256,
            engine: outcome.engine,
            model: outcome.model,
            stateVariant: enrichState.variant,
            answers: outcome.answers,
            features: await features(tx, article, outcome.answers, current, input),
          },
          { primaryModel: classification.primaryModel },
        );
        // A concurrent primary answer for the same input outranks this one: record the winner.
        const winner = await readFacets(tx, articleId, enrichSet.id);
        await transitionPipelineState(tx, {
          articleId,
          revision: article.revision,
          to: 'enriched',
          from: ENRICHABLE_STATES,
          enrichEngine: winner?.engine ?? outcome.engine,
        });
        await queueAdmittedCards(tx, articleId, article.revision);
        await after(
          'enrich',
          articleId,
          { status: 'ok', revision: article.revision },
          pipelineContext(deps, tx, workerOutbox(tx)),
        );
      });
      return;
    }

    const disposition = failureDisposition(outcome, nowOf(deps));
    if (disposition.kind === 'no_demand') return;
    const invalid = disposition.kind === 'invalid';
    if (invalid) {
      deps.logger.error(
        {
          articleId,
          questionSetSha: enrichSet.sha256,
          reason: outcome.reason,
          detail: outcome.detail,
        },
        'enrich request rejected as invalid; the article is failed',
      );
    } else {
      deps.logger.warn(
        { articleId, reason: outcome.reason, detail: outcome.detail },
        'enrich engine unavailable; the article is degraded',
      );
    }
    await retryTransaction(deps.db, async (tx) => {
      const locked = await lockArticleRevision(tx, articleId, 'update');
      if (locked === null || locked.revision !== article.revision) return;
      // The failure answered the snapshot's request: under a changed configuration the job runs
      // again instead of failing or degrading the article.
      if ((await configHolds(tx, deps, config, article, priority)) === null) return;
      // Only an article without facets changes state; a degraded one is not ranked again, and an
      // enriched one (a recovery retry) keeps its answers.
      const changed = await transitionPipelineState(tx, {
        articleId,
        revision: article.revision,
        to: invalid ? 'failed' : 'degraded',
        from: invalid ? PRE_ENRICH_STATES : PRE_ENRICH_STATES.filter((s) => s !== 'degraded'),
      });
      if (!changed) return;
      await after(
        'enrich',
        articleId,
        { status: invalid ? 'invalid_request' : 'degraded', revision: article.revision },
        pipelineContext(deps, tx, workerOutbox(tx)),
      );
    });
  };
}

/**
 * A current primary Call A for this exact input exists (a selected request filled the cache, or the
 * job is a duplicate). No call: an article that has not continued yet continues now; one already
 * enriched or matched at this revision is a late duplicate. The input was judged current under the
 * job's configuration snapshot, so the continuation has the completion's fences (D-84, D-85, D-94):
 * a switch or a translation committed meanwhile re-enqueues the job instead.
 */
async function continueFromCache(
  deps: WorkerDeps,
  config: ClassificationConfig,
  article: ClassificationArticle,
  stored: FacetRow,
  priority: 'interactive' | 'bulk',
): Promise<void> {
  await retryTransaction(deps.db, async (tx) => {
    const locked = await lockArticleRevision(tx, article.id, 'update');
    if (locked === null || locked.revision !== article.revision) return;
    if (ENRICHED_STATES.includes(locked.pipelineState)) return;
    const current = await configHolds(tx, deps, config, article, priority);
    if (current === null) return;
    if (!(await inputHolds(tx, deps, current, article, stored.stateSha256, priority))) return;
    const changed = await transitionPipelineState(tx, {
      articleId: article.id,
      revision: article.revision,
      to: 'enriched',
      from: ENRICHABLE_STATES,
      enrichEngine: stored.engine,
    });
    if (!changed) return;
    await queueAdmittedCards(tx, article.id, article.revision);
    await after(
      'enrich',
      article.id,
      { status: 'ok', revision: article.revision },
      pipelineContext(deps, tx, workerOutbox(tx)),
    );
  });
}

/**
 * The configuration fence of every write derived from the job's snapshot (D-84, D-85): the compared
 * settings, re-read under share locks, must still be the snapshot's. Returns that locked current
 * configuration. Otherwise the job is enqueued again at the article's revision in the same
 * transaction, and the caller writes nothing (null).
 */
async function configHolds(
  tx: Transaction,
  deps: WorkerDeps,
  snapshot: ClassificationConfig,
  article: ClassificationArticle,
  priority: 'interactive' | 'bulk',
): Promise<ClassificationConfig | null> {
  const current = await loadClassificationConfig(tx, deps.settingsEnv, { lock: true });
  if (sameEnrichConfig(snapshot, current, article.lang)) return current;
  await enqueueEnrich(
    workerOutbox(tx),
    { articleId: article.id, priority },
    { revision: article.revision },
  );
  return null;
}

/**
 * The input fence of a write derived from the job's Call A state (D-94): a translation stored after
 * the job read its rows changes the model input without a new revision. The rows are read again
 * under the article lock, which every translation store takes too, so a store either commits first
 * and is seen here, or waits and then finds the new facets (spec 07 §3). A changed input enqueues
 * the job again at the article's revision in the same transaction, and the caller writes nothing
 * (false).
 */
async function inputHolds(
  tx: Transaction,
  deps: WorkerDeps,
  config: ClassificationConfig,
  article: ClassificationArticle,
  stateSha256: string,
  priority: 'interactive' | 'bulk',
): Promise<boolean> {
  const rows = await listTranslations(tx, article.id, article.revision);
  if (buildState(modelInput(article, rows, config), 'enrich').sha256 === stateSha256) return true;
  await enqueueEnrich(
    workerOutbox(tx),
    { articleId: article.id, priority },
    { revision: article.revision },
  );
  return false;
}

/**
 * Features of new Call A answers with the current L2 answers of the branches they select, under the
 * match set of the locked current configuration `current` (D-93). The fence compares only the
 * enrich set and the language mode, which fix the Call B state of `input`, so a match set switched
 * during Call A never combines the old set's L2 rows with the new facets, and L2 rows the new set
 * already has (an analysis cache fill) count at once.
 */
async function features(
  tx: Transaction,
  article: ClassificationArticle,
  answers: Readonly<Record<string, unknown>>,
  current: ClassificationConfig,
  input: ModelInput,
): Promise<Record<string, number>> {
  const match: ActiveQuestionSet | null = current.match;
  if (match === null) return facetFeatures(answers, {});
  const l2 = currentL2Answers(await readL2Answers(tx, article.id), l2Branches(answers), {
    articleRevision: article.revision,
    matchSetSha: match.sha256,
    stateSha256: buildState(input, 'match').sha256,
  });
  return facetFeatures(answers, l2);
}

/**
 * Queue the admitted automatic card union right after enrichment (spec 05 §5.3, priority 5): the
 * match stage drops pairs a current primary answer already satisfies. Selected-request cards run
 * in `analysis.process` from their frozen manifests.
 */
async function queueAdmittedCards(tx: Transaction, articleId: string, revision: string) {
  await upsertMatchQueue(tx, {
    articleId,
    revision,
    cardIds: await automaticCardDemand(tx, articleId),
  });
}
