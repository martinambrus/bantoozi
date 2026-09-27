import {
  MATCH_INTERACTIVE_MAX_PRIORITY,
  MATCH_MAX_ATTEMPTS,
  cardPairDemand,
  claimMatchRows,
  completeMatchRows,
  dropMatchRows,
  eligibleInferenceDemand,
  heldMatchRows,
  isPrimaryAnswer,
  listTranslations,
  loadCardInputs,
  loadClassificationArticle,
  lockArticleRevision,
  matchFailureDelayMs,
  mergeWitnesses,
  pairWitnesses,
  pendingMatchRows,
  readCardAnswers,
  readFacets,
  readL2Answers,
  releaseMatchRows,
  renewMatchLease,
  retryTransaction,
  transitionPipelineState,
  updateFacetFeatures,
  workerOutbox,
  writeCardAnswers,
  writeL2Answers,
  type CardAnswerInput,
  type CardInput,
  type ClaimedMatchRow,
  type ClassificationArticle,
  type FacetRow,
  type L2AnswerInput,
  type MatchRelease,
  type Transaction,
} from '@bantoozi/db';
import type { EngineOutcome } from '@bantoozi/engine';
import {
  PackOverflowError,
  cardKey,
  l2Key,
  l2Question,
  packRequests,
  parseCardKey,
  parseL2Key,
  type Pack,
  type PackItem,
  type Question,
} from '@bantoozi/questions';
import { enqueueMatch } from '@bantoozi/shared';

import {
  builtCardQuestion,
  isCurrentCardAnswer,
  type BuiltCardQuestion,
  type MatchFingerprint,
} from '../classify/card-questions.js';
import { classificationComplete } from '../classify/completeness.js';
import {
  loadClassificationConfig,
  requireSet,
  sameMatchConfig,
  type ActiveQuestionSet,
  type ClassificationConfig,
} from '../classify/config.js';
import {
  currentL2Answers,
  facetFeatures,
  isCurrentL2,
  l2Branches,
  topicL1Probabilities,
} from '../classify/features.js';
import { buildState, modelInput, type BuiltState } from '../classify/model-input.js';
import { failureDisposition, type FailureDisposition } from '../classify/outcomes.js';
import { after } from '../pipeline.js';
import { nowOf, pipelineContext, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/** Prefilter applies only above this many pending cards (spec 05 §5.5 step 3). */
export const PREFILTER_MIN_CARDS = 60;
/** A card is kept when one of its topics' L1 has at least this Call A probability. */
export const PREFILTER_MIN_T1 = 0.05;

/** One match job: the snapshot it asks under and the leased rows it still holds. */
interface MatchJob {
  deps: WorkerDeps;
  classification: ClassificationDeps;
  config: ClassificationConfig;
  enrichSet: ActiveQuestionSet;
  matchSet: ActiveQuestionSet;
  article: ClassificationArticle;
  state: BuiltState;
  fingerprint: MatchFingerprint;
  leaseToken: string;
  /** Failed level-2-only attempts of this input before this job (the retry intent's count). */
  l2Attempts: number;
  /**
   * Claimed rows still held by this job (removed once completed, dropped or released). Transactions
   * that change it run in {@link jobTransaction}, which undoes the changes of an attempt that rolls
   * back.
   */
  held: Map<string, ClaimedMatchRow>;
  /** The built question of every demanded claimed card. */
  questions: Map<string, BuiltCardQuestion>;
  /** Another worker reclaimed the lease: stop sending, never touch its rows. */
  lost: boolean;
  /** The compared configuration changed: current work was enqueued, so stop sending. */
  stale: boolean;
  /** The job budget ran out with packs left: a follow-up job asks them. */
  yielded: boolean;
}

/**
 * `article.match {articleId}` (spec 05 §5.5), the current shared article worker:
 * 1. claims up to 400 due rows under a fresh lease in a short committed transaction;
 * 2. drops pairs without live demand, and deletes pairs a current primary answer already satisfies;
 * 3. writes provisional prefilter markers when prefiltering is enabled (more than 60 cards);
 * 4. adds the selected level-2 branches without a current answer (also with zero card rows, then
 *    only under article demand), re-asking provisional fallback answers only in bulk packs;
 * 5. packs per owner partition and asks each pack, rechecking demand and renewing the lease first;
 * 6. applies an ok pack in a short transaction guarded by revision, configuration, demand and lease;
 *    every other write derived from the snapshot (steps 2, 3, 5, 7 and 8) has the same configuration
 *    fence, and a job that finds the configuration changed stops asking (D-85);
 * 7. releases failed rows as deferred, failed or exhausted without a hot loop; a failed level-2-only
 *    pack, which has no queue row, records a delayed retry job under the same rules instead;
 * 8. marks the article `matched` only when every demanded pair and selected branch is complete;
 * 9. records the affected users' rank intents in the transaction that writes answers (and again
 *    when the article state changes), and a follow-up job while due rows or unasked packs remain.
 * No transaction spans an HTTP call. After `jobBudgetMs` the job starts no further pack.
 */
export function createArticleMatchHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
): QueueHandler<'article.match'> {
  return async ({ articleId, l2Attempts }) => {
    const started = nowOf(deps).getTime();
    const config = await loadClassificationConfig(deps.db, deps.settingsEnv);
    const enrichSet = requireSet(config.enrich, 'enrich');
    const matchSet = requireSet(config.match, 'match');
    const claim = await claimMatchRows(deps.db, articleId, { leaseMs: classification.leaseMs });
    if (claim === null) return;
    const held = new Map(claim.rows.map((row) => [row.cardId, row]));

    const article = await loadClassificationArticle(deps.db, articleId);
    const facets =
      article === null || article.revision !== claim.revision
        ? null
        : await readFacets(deps.db, articleId, enrichSet.id);
    if (
      article === null ||
      facets === null ||
      facets.articleRevision !== article.revision ||
      (article.pipelineState !== 'enriched' && article.pipelineState !== 'matched')
    ) {
      // Matching waits for current facets of the claimed revision (spec 05 §5.6 step 4).
      await releaseRows(deps, articleId, claim.leaseToken, [...held.keys()], { kind: 'release' });
      return;
    }

    const input = modelInput(
      article,
      await listTranslations(deps.db, articleId, article.revision),
      config,
    );
    const state = buildState(input, 'match');
    const job: MatchJob = {
      deps,
      classification,
      config,
      enrichSet,
      matchSet,
      article,
      state,
      fingerprint: {
        articleRevision: article.revision,
        matchSetSha: matchSet.sha256,
        stateSha256: state.sha256,
      },
      leaseToken: claim.leaseToken,
      l2Attempts: l2Attempts ?? 0,
      held,
      questions: new Map(),
      lost: false,
      stale: false,
      yielded: false,
    };

    const cards = await prepareCards(job);
    if (!job.stale) await prefilter(job, facets, cards);
    const packs = job.stale ? [] : await buildPacks(job, facets, cards);
    for (const [index, pack] of packs.entries()) {
      if (job.lost || job.stale) break;
      if (index > 0 && nowOf(deps).getTime() - started >= classification.jobBudgetMs) {
        // Spec 03 §2.1: the rest runs in a follow-up job, inside its own queue expiration.
        job.yielded = true;
        break;
      }
      await askPack(job, pack);
    }
    if (!job.lost && job.held.size > 0) {
      await releaseRows(deps, articleId, job.leaseToken, [...job.held.keys()], { kind: 'release' });
      job.held.clear();
    }
    await finish(job);
  };
}

/**
 * Step 2: drop claimed pairs without live demand (retired, unheld, out of scope, revoked), build
 * the questions of the rest and delete rows a current primary answer already satisfies (fallback
 * and prefilter answers are provisional and never suppress a queued pair).
 */
async function prepareCards(job: MatchJob): Promise<Map<string, CardInput>> {
  const { deps, article } = job;
  const claimed = [...job.held.keys()];
  if (claimed.length === 0) return new Map();
  const demand = await cardPairDemand(deps.db, article.id, claimed);
  const cards = await loadCardInputs(
    deps.db,
    demand.map((d) => d.cardId),
  );
  await dropRows(
    job,
    claimed.filter((id) => !cards.has(id)),
  );
  for (const [id, card] of cards) {
    job.questions.set(id, builtCardQuestion(card, job.config.cardTextMode));
  }
  const satisfied = (await readCardAnswers(deps.db, article.id, [...job.held.keys()]))
    .filter((answer) => {
      const built = job.questions.get(answer.cardId);
      return (
        built !== undefined &&
        isCurrentCardAnswer(answer, job.fingerprint, built.sha256) &&
        isPrimaryAnswer(answer, job.classification.primaryModel)
      );
    })
    .map((answer) => answer.cardId);
  if (satisfied.length > 0) {
    await jobTransaction(job, async (tx) => {
      if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return;
      await completeRows(tx, job, satisfied);
    });
  }
  return cards;
}

/**
 * Step 3 (disabled until G1 validates recall): with more than 60 pending cards and current primary
 * facets, a card is kept when it is a label, has no topics, or one of its topics' L1 has
 * `t1 ≥ 0.05`; the others get a `prefilter` p = 0 marker, an unknown/provisional placeholder that
 * never counts as a measured negative (spec 06 applies the incomplete-answer rules).
 */
async function prefilter(
  job: MatchJob,
  facets: FacetRow,
  cards: ReadonlyMap<string, CardInput>,
): Promise<void> {
  const pending = [...job.held.keys()];
  if (
    !job.config.prefilterEnabled ||
    pending.length <= PREFILTER_MIN_CARDS ||
    !isPrimaryAnswer(facets, job.classification.primaryModel)
  ) {
    return;
  }
  const t1 = topicL1Probabilities(facets.answers);
  const skipped = pending.filter((id) => {
    const card = cards.get(id);
    if (card === undefined || card.kind === 'label' || card.topicIds.length === 0) return false;
    return !card.topicIds.some(
      (topic) => (t1[topic.split('.')[0] ?? topic] ?? 0) >= PREFILTER_MIN_T1,
    );
  });
  if (skipped.length === 0) return;
  await jobTransaction(job, async (tx) => {
    if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return;
    const held = await heldRows(tx, job, skipped);
    const rows = held.flatMap((id) => {
      const built = job.questions.get(id);
      return built === undefined ? [] : [cardAnswer(job, id, built, 0, 'prefilter', null)];
    });
    await writeCardAnswers(tx, rows, { primaryModel: job.classification.primaryModel });
    await completeRows(tx, job, held);
    if (rows.length > 0) await rankAffected(tx, job);
  });
}

/**
 * Steps 4–5: the pack items of the remaining cards plus the selected L2 branches (§4) and the packs
 * (§5.2). A question that cannot fit a request even alone is a permanent invalid request: its row is
 * exhausted and alerted, never silently omitted, unless the configuration changed meanwhile (then
 * the job stops and current work asks, D-85).
 */
async function buildPacks(
  job: MatchJob,
  facets: FacetRow,
  cards: ReadonlyMap<string, CardInput>,
): Promise<Pack[]> {
  const items: PackItem[] = [];
  for (const [id, row] of job.held) {
    const card = cards.get(id);
    const built = job.questions.get(id);
    if (card === undefined || built === undefined) continue;
    items.push({
      key: cardKey(id),
      question: built.question,
      owner: card.visibility === 'private' ? card.ownerUserId : null,
      kind: card.kind === 'label' ? 'label' : 'card',
      interactive: row.priority <= MATCH_INTERACTIVE_MAX_PRIORITY,
      queuedAt: row.enqueuedAt.getTime(),
      cardId: id,
    });
  }

  const branches = l2Branches(facets.answers);
  if (branches.length > 0) {
    const stored = await readL2Answers(job.deps.db, job.article.id);
    // A provisional fallback answer is re-asked only in bulk work, which Jev alone serves.
    const bulkShared = !items.some((item) => item.owner === null && item.interactive);
    const asked = branches.filter((l1) => {
      const row = stored.find((r) => r.l1Id === l1 && isCurrentL2(r, job.fingerprint));
      if (row === undefined) return true;
      return bulkShared && !isPrimaryAnswer(row, job.classification.primaryModel);
    });
    // Level-2 work needs article demand of its own when no card question carries it (§4).
    if (
      asked.length > 0 &&
      (await eligibleInferenceDemand(job.deps.db, job.article.id)).length > 0
    ) {
      for (const l1 of asked) {
        items.push({
          key: l2Key(l1),
          question: l2Question(l1),
          owner: null,
          kind: 'l2',
          interactive: false,
          queuedAt: 0,
        });
      }
    }
  }

  for (;;) {
    try {
      return packRequests(job.state.state, items);
    } catch (error) {
      if (!(error instanceof PackOverflowError)) throw error;
      const overflowing =
        error.key === null
          ? items.splice(0)
          : items.splice(
              items.findIndex((i) => i.key === error.key),
              1,
            );
      job.deps.logger.error(
        { articleId: job.article.id, key: error.key, tokens: error.tokens, limit: error.limit },
        'match question cannot fit a request; its pair is exhausted as invalid',
      );
      const cardIds = overflowing.flatMap((item) =>
        item.cardId === undefined ? [] : [item.cardId],
      );
      if (cardIds.length > 0) {
        await jobTransaction(job, async (tx) => {
          // The overflow measured the snapshot's questions: under a changed configuration the rows
          // go to current work instead of being exhausted by it (D-85).
          if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return;
          await releaseHeld(tx, job, cardIds, { kind: 'exhaust', lastError: 'invalid_request' });
        });
      }
      if (job.stale || items.length === 0) return [];
    }
  }
}

/** Steps 5–7 for one pack: recheck demand and the lease, ask, then apply or release. */
async function askPack(job: MatchJob, pack: Pack): Promise<void> {
  const { deps, classification, article } = job;
  if (job.held.size > 0) {
    const renewed = await renewMatchLease(
      deps.db,
      article.id,
      job.leaseToken,
      classification.leaseMs,
    );
    if (!renewed) {
      job.lost = true;
      return;
    }
  }
  const packCards = pack.keys.flatMap((key) => {
    const id = parseCardKey(key);
    return id !== null && job.held.has(id) ? [id] : [];
  });
  const packL2 = pack.keys.flatMap((key) => {
    const l1 = parseL2Key(key);
    return l1 === null ? [] : [l1];
  });

  // Recheck §1.1 admission right before the pack leaves (spec 05 §5.5 step 2).
  const demand = packCards.length === 0 ? [] : await cardPairDemand(deps.db, article.id, packCards);
  const demanded = new Set(demand.map((d) => d.cardId));
  await dropRows(
    job,
    packCards.filter((id) => !demanded.has(id)),
  );
  const askCards = packCards.filter((id) => demanded.has(id));
  const articleWitnesses =
    packL2.length === 0 ? [] : await eligibleInferenceDemand(deps.db, article.id);
  const askL2 = articleWitnesses.length === 0 ? [] : packL2;
  if (askCards.length === 0 && askL2.length === 0) return;

  const questions: Record<string, Question> = {};
  for (const id of askCards) questions[cardKey(id)] = pack.questions[cardKey(id)] as Question;
  for (const l1 of askL2) questions[l2Key(l1)] = pack.questions[l2Key(l1)] as Question;
  const rows = askCards.map((id) => job.held.get(id) as ClaimedMatchRow);
  const requesters = new Set(rows.map((row) => row.userId));
  const single = requesters.size === 1 ? [...requesters][0] : null;
  // Only one owner's private work, or one requester's shared cards, is attributed to a user.
  const userId = pack.owner ?? (askL2.length === 0 && single !== null ? single : undefined);

  const outcome = await classification.router.ask({
    kind: 'match',
    state: job.state.state,
    questions,
    questionSetId: job.matchSet.id,
    questionSetSha: job.matchSet.sha256,
    articleId: article.id,
    articleRevision: article.revision,
    stateSha256: job.state.sha256,
    cardIds: askCards,
    ...(userId === undefined || userId === null ? {} : { userId }),
    priority: rows.some((row) => row.priority <= MATCH_INTERACTIVE_MAX_PRIORITY)
      ? 'interactive'
      : 'bulk',
    authorization: {
      type: 'article',
      articleId: article.id,
      articleRevision: article.revision,
      witnesses: mergeWitnesses(
        pairWitnesses(demand.filter((d) => demanded.has(d.cardId))),
        articleWitnesses,
      ),
    },
    deadlineMs: nowOf(deps).getTime() + classification.callDeadlineMs,
  });
  if (outcome.ok) {
    const unanswered = await applyPack(job, askCards, askL2, outcome);
    // An ok outcome always answers every key; a level-2-only pack missing one failed for it.
    if (askCards.length === 0 && unanswered.length > 0) {
      await retryL2(job, { kind: 'fail', lastError: 'error' });
    }
  } else {
    await failPack(job, askCards, askL2, outcome);
  }
}

/**
 * Steps 6 and 9: apply an ok pack in a short transaction. A changed revision discards everything
 * (the reset re-queued current work); a changed configuration discards and re-enqueues
 * ({@link configHolds}); pairs whose demand disappeared are dropped unanswered; answers are written
 * only for rows this lease still holds, with the precedence guard; features are rebuilt from the
 * current L2 rows, and the affected users' rank intents are recorded with the answers. Returns the
 * asked branches left unanswered.
 */
async function applyPack(
  job: MatchJob,
  askCards: readonly string[],
  askL2: readonly string[],
  outcome: Extract<EngineOutcome, { ok: true }>,
): Promise<string[]> {
  const { article, classification } = job;
  return jobTransaction(job, async (tx) => {
    if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return [];
    // Level-2 answers rebuild the facet features below. The facet row is locked before any answer
    // is written, as the analysis cache fill does, so a replacement of its answers either commits
    // first and is read here, or waits for this transaction.
    const facets =
      askL2.length === 0
        ? null
        : await readFacets(tx, article.id, job.enrichSet.id, { lock: true });
    const held = await heldRows(tx, job, askCards);
    const demanded = new Set((await cardPairDemand(tx, article.id, held)).map((d) => d.cardId));
    await dropHeld(
      tx,
      job,
      held.filter((id) => !demanded.has(id)),
    );

    const answered: string[] = [];
    const rows: CardAnswerInput[] = [];
    for (const id of held) {
      const answer = outcome.answers[cardKey(id)];
      const built = job.questions.get(id);
      if (!demanded.has(id) || built === undefined || answer?.type !== 'noul') continue;
      rows.push(cardAnswer(job, id, built, answer.p, outcome.engine, outcome.model));
      answered.push(id);
    }
    await writeCardAnswers(tx, rows, { primaryModel: classification.primaryModel });
    await completeRows(tx, job, answered);
    // A held row the engine left unanswered is a failed logical pack for that pair.
    await releaseHeld(
      tx,
      job,
      held.filter((id) => demanded.has(id) && !answered.includes(id)),
      { kind: 'fail', lastError: 'error' },
    );

    const l2Rows: L2AnswerInput[] = [];
    let unanswered: string[] = [];
    if (askL2.length > 0 && (await eligibleInferenceDemand(tx, article.id)).length > 0) {
      unanswered = askL2.filter((l1) => outcome.answers[l2Key(l1)]?.type !== 'choice');
      for (const l1 of askL2) {
        const answer = outcome.answers[l2Key(l1)];
        if (answer?.type !== 'choice') continue;
        l2Rows.push({
          articleId: article.id,
          l1Id: l1,
          articleRevision: article.revision,
          questionSetSha: job.matchSet.sha256,
          stateSha256: job.state.sha256,
          engine: outcome.engine,
          model: outcome.model,
          stateVariant: job.state.variant,
          answer: answer as unknown as Record<string, unknown>,
        });
      }
      await writeL2Answers(tx, l2Rows, { primaryModel: classification.primaryModel });
    }
    if (l2Rows.length > 0 && facets !== null) await refreshFeatures(tx, job, facets);
    if (rows.length > 0 || l2Rows.length > 0) await rankAffected(tx, job);
    return unanswered;
  });
}

/**
 * Step 7: release the pack's rows as its failure demands. A level-2-only pack has no rows: its
 * branches get a delayed retry job instead ({@link retryL2}); mixed packs retry with their rows.
 */
async function failPack(
  job: MatchJob,
  askCards: readonly string[],
  askL2: readonly string[],
  outcome: Extract<EngineOutcome, { ok: false }>,
): Promise<void> {
  const { deps, article } = job;
  const disposition = failureDisposition(outcome, nowOf(deps));
  let release: MatchRelease | 'drop';
  switch (disposition.kind) {
    case 'no_demand':
      release = 'drop';
      break;
    case 'invalid':
      deps.logger.error(
        { articleId: article.id, questionSetSha: job.matchSet.sha256, detail: outcome.detail },
        'match request rejected as invalid; its pairs are exhausted',
      );
      release = { kind: 'exhaust', lastError: disposition.lastError };
      break;
    case 'defer':
      release = {
        kind: 'defer',
        nextAttemptAt: disposition.nextAttemptAt,
        lastError: disposition.lastError,
      };
      break;
    case 'fail':
      deps.logger.warn(
        { articleId: article.id, reason: outcome.reason, detail: outcome.detail },
        'match pack failed after the router retries',
      );
      release = { kind: 'fail', lastError: disposition.lastError };
      break;
  }
  if (askCards.length === 0) {
    if (askL2.length > 0) await retryL2(job, disposition);
    return;
  }
  await jobTransaction(job, async (tx) => {
    // The failure answered the snapshot's questions: under a changed configuration the rows go to
    // current work unanswered instead of counting it, or being exhausted by it (D-85).
    if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return;
    if (release === 'drop') {
      // Revoked demand: drop only the pairs that no longer have it, quietly.
      const demanded = new Set(
        (await cardPairDemand(tx, article.id, askCards)).map((d) => d.cardId),
      );
      await dropHeld(
        tx,
        job,
        askCards.filter((id) => !demanded.has(id)),
      );
      await releaseHeld(
        tx,
        job,
        askCards.filter((id) => demanded.has(id)),
        { kind: 'release' },
      );
      return;
    }
    await releaseHeld(tx, job, askCards, release);
  });
}

/**
 * Steps 8–9: in one transaction, mark the article `matched` when its classification is complete
 * (or back to `enriched` when new demand arrived), rank the affected users when the state changed,
 * and enqueue a follow-up job while due rows remain or the job budget left packs unasked. Under a
 * changed configuration the current job enqueued instead decides the state.
 */
async function finish(job: MatchJob): Promise<void> {
  const { article } = job;
  if (job.stale) return;
  await jobTransaction(job, async (tx) => {
    const locked = await lockArticleRevision(tx, article.id, 'update');
    if (locked === null || locked.revision !== article.revision) return;
    if (!(await configHolds(tx, job))) return;
    if (locked.pipelineState === 'enriched' || locked.pipelineState === 'matched') {
      const complete = await classificationComplete(tx, {
        articleId: article.id,
        enrichSetId: job.enrichSet.id,
        fingerprint: job.fingerprint,
        cardTextMode: job.config.cardTextMode,
      });
      const to = complete ? 'matched' : 'enriched';
      if (
        to !== locked.pipelineState &&
        (await transitionPipelineState(tx, {
          articleId: article.id,
          revision: article.revision,
          to,
          from: [locked.pipelineState as 'enriched' | 'matched'],
        }))
      ) {
        await rankAffected(tx, job);
      }
    }
    if (job.lost) return;
    const due = (await pendingMatchRows(tx, article.id, article.revision)).some(
      (row) => row.due && !row.leased && row.attempts < MATCH_MAX_ATTEMPTS,
    );
    if (due || job.yielded) {
      await enqueueMatch(
        workerOutbox(tx),
        { articleId: article.id },
        { revision: article.revision },
      );
    }
  });
}

/** Step 9: the affected users' incremental rank intents, in the transaction that changed them. */
async function rankAffected(tx: Transaction, job: MatchJob): Promise<void> {
  await after(
    'match',
    job.article.id,
    { status: 'ok', revision: job.article.revision },
    pipelineContext(job.deps, tx, workerOutbox(tx)),
  );
}

/**
 * Step 7 for level-2-only work (spec 05 §4), which has no `match_queue` row: a delayed
 * `article.match` carrying the failed-attempt count stands in for one. Unavailability retries at its
 * due time without an attempt; retry exhaustion counts one with the rows' backoff (1, 2, 4, 8
 * minutes) and gives up after the fifth, alerted like an exhausted row; an invalid request gives up
 * at once. A new revision or state starts afresh, and a later job for card work asks the branches
 * again with its rows.
 */
async function retryL2(job: MatchJob, disposition: FailureDisposition): Promise<void> {
  const { deps, article } = job;
  let attempts = job.l2Attempts;
  let at: Date;
  switch (disposition.kind) {
    case 'no_demand':
      return;
    case 'invalid':
      return;
    case 'defer':
      at = disposition.nextAttemptAt;
      break;
    case 'fail':
      attempts += 1;
      if (attempts >= MATCH_MAX_ATTEMPTS) {
        deps.logger.error(
          { articleId: article.id, questionSetSha: job.matchSet.sha256, attempts },
          'level-2 match work exhausted after repeated failures',
        );
        return;
      }
      at = new Date(nowOf(deps).getTime() + matchFailureDelayMs(attempts));
      break;
  }
  await jobTransaction(job, async (tx) => {
    if (!(await revisionHolds(tx, job)) || !(await configHolds(tx, job))) return;
    await enqueueMatch(
      workerOutbox(tx, { availableAt: at }),
      { articleId: article.id, l2Attempts: attempts },
      { revision: article.revision },
    );
  });
}

/**
 * Rebuild the features of the current facets, locked by the caller, from the current L2 rows (spec
 * 05 §3.4).
 */
async function refreshFeatures(tx: Transaction, job: MatchJob, facets: FacetRow): Promise<void> {
  if (facets.articleRevision !== job.article.revision) return;
  const l2 = currentL2Answers(
    await readL2Answers(tx, job.article.id),
    l2Branches(facets.answers),
    job.fingerprint,
  );
  await updateFacetFeatures(tx, { ...facets, features: facetFeatures(facets.answers, l2) });
}

function cardAnswer(
  job: MatchJob,
  cardId: string,
  built: BuiltCardQuestion,
  p: number,
  engine: CardAnswerInput['engine'],
  model: string | null,
): CardAnswerInput {
  return {
    articleId: job.article.id,
    cardId,
    p,
    engine,
    model,
    questionSetSha: job.matchSet.sha256,
    articleRevision: job.article.revision,
    stateSha256: job.state.sha256,
    cardInputSha256: built.sha256,
    stateVariant: job.state.variant,
  };
}

/** Lock the article for a guarded write; false when its revision moved on (discard the result). */
async function revisionHolds(tx: Transaction, job: MatchJob): Promise<boolean> {
  const locked = await lockArticleRevision(tx, job.article.id, 'share');
  return locked !== null && locked.revision === job.article.revision;
}

/**
 * The configuration fence of every write derived from the job's snapshot (step 6, D-84, D-85): the
 * compared settings, re-read under share locks, must still be the snapshot's. Otherwise the rows
 * this job still holds are released unanswered, current work is enqueued in the same transaction,
 * the job stops sending (`stale`) and the caller writes nothing.
 */
async function configHolds(tx: Transaction, job: MatchJob): Promise<boolean> {
  const current = await loadClassificationConfig(tx, job.deps.settingsEnv, { lock: true });
  if (sameMatchConfig(job.config, current, job.article.lang)) return true;
  await releaseHeld(tx, job, [...job.held.keys()], { kind: 'release' });
  await enqueueMatch(
    workerOutbox(tx),
    { articleId: job.article.id },
    { revision: job.article.revision },
  );
  job.stale = true;
  return false;
}

/** The given claimed rows this lease still holds, locked (another worker's rows are never touched). */
async function heldRows(
  tx: Transaction,
  job: MatchJob,
  cardIds: readonly string[],
): Promise<string[]> {
  const wanted = cardIds.filter((id) => job.held.has(id));
  if (wanted.length === 0) return [];
  if (!(await renewMatchLease(tx, job.article.id, job.leaseToken, job.classification.leaseMs))) {
    job.lost = true;
    return [];
  }
  return heldMatchRows(tx, {
    articleId: job.article.id,
    revision: job.article.revision,
    leaseToken: job.leaseToken,
    cardIds: wanted,
  });
}

async function completeRows(tx: Transaction, job: MatchJob, cardIds: readonly string[]) {
  const done = await completeMatchRows(tx, {
    articleId: job.article.id,
    revision: job.article.revision,
    leaseToken: job.leaseToken,
    cardIds,
  });
  for (const id of done) job.held.delete(id);
}

async function dropHeld(tx: Transaction, job: MatchJob, cardIds: readonly string[]) {
  if (cardIds.length === 0) return;
  await dropMatchRows(tx, { articleId: job.article.id, cardIds, leaseToken: job.leaseToken });
  for (const id of cardIds) job.held.delete(id);
}

async function releaseHeld(
  tx: Transaction,
  job: MatchJob,
  cardIds: readonly string[],
  release: MatchRelease,
) {
  if (cardIds.length === 0) return;
  await releaseMatchRows(tx, {
    articleId: job.article.id,
    leaseToken: job.leaseToken,
    cardIds,
    release,
  });
  for (const id of cardIds) job.held.delete(id);
}

async function dropRows(job: MatchJob, cardIds: readonly string[]) {
  if (cardIds.length === 0) return;
  await jobTransaction(job, (tx) => dropHeld(tx, job, cardIds));
}

/**
 * A retried transaction that may change the job's in-memory state (the held rows, `stale`, `lost`).
 * Every attempt starts from the state before the transaction, and a failed transaction leaves it
 * there: an attempt rolled back for a retryable error (a deadlock, a unique conflict) leaves no
 * trace, so its replay still holds, answers and completes the rows the database kept leased.
 */
async function jobTransaction<T>(job: MatchJob, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const before = { held: new Map(job.held), stale: job.stale, lost: job.lost };
  const restore = () => {
    job.held = new Map(before.held);
    job.stale = before.stale;
    job.lost = before.lost;
  };
  try {
    return await retryTransaction(job.deps.db, async (tx) => {
      restore();
      return fn(tx);
    });
  } catch (error) {
    restore();
    throw error;
  }
}

async function releaseRows(
  deps: WorkerDeps,
  articleId: string,
  leaseToken: string,
  cardIds: readonly string[],
  release: MatchRelease,
) {
  if (cardIds.length === 0) return;
  await retryTransaction(deps.db, (tx) =>
    releaseMatchRows(tx, { articleId, leaseToken, cardIds, release }),
  );
}
