import {
  analysisRatingReferences,
  analysisRequestAuthorized,
  claimAnalysisRequest,
  completeAnalysisRequest,
  isPrimaryAnswer,
  listTranslations,
  loadCardInputs,
  loadClassificationArticle,
  lockAnalysisRequest,
  lockArticleRevision,
  readCardAnswers,
  readFacets,
  readL2Answers,
  releaseAnalysisRequest,
  renewAnalysisLease,
  retryTransaction,
  saveAnalysisStages,
  storeTranslation,
  workerOutbox,
  writeCardAnswers,
  writeFacets,
  writeL2Answers,
  type AnalysisRequestRow,
  type CardAnswerInput,
  type L2AnswerInput,
  type Transaction,
  type TranslationInput,
} from '@bantoozi/db';
import type { EngineOutcome, EngineRequest } from '@bantoozi/engine';
import {
  PackOverflowError,
  buildArticleState,
  cardInputSha256,
  cardKey,
  l2Key,
  l2Question,
  packRequests,
  parseCardKey,
  parseL2Key,
  questionSetByVersion,
  stateSha256,
  type ArticleState,
  type ArticleStateInput,
  type ChoiceAnswer,
  type NoulQuestion,
  type PackItem,
  type StateVariant,
} from '@bantoozi/questions';
import {
  AnalysisInputSnapshotSchema,
  AnalysisResultSnapshotSchema,
  enqueueAnalysis,
  enqueueLearn,
  enqueueRank,
  type AnalysisInputSnapshot,
  type AnalysisResultSnapshot,
  type AnalysisTranslation,
  type InferenceAuthorization,
  type JsonObject,
} from '@bantoozi/shared';
import {
  articleTranslationSource,
  translationSourceSha256,
  type TranslationTexts,
} from '@bantoozi/translate';

import { builtCardQuestion } from '../classify/card-questions.js';
import { frozenTranslation } from '../classify/analysis-snapshot.js';
import {
  enrichQuestions,
  languageModeOf,
  loadClassificationConfig,
  type ClassificationConfig,
} from '../classify/config.js';
import { facetFeatures, l2Branches } from '../classify/features.js';
import { buildState, modelInput } from '../classify/model-input.js';
import { RECOVERY_INTERVAL_MS, failureDisposition } from '../classify/outcomes.js';
import { runTier1, runTier2, type TranslationDeps } from '../classify/translation.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/**
 * Results of finished stages under earlier leases (`analysis_requests.stage_results`, migration
 * 0013): a reclaimed request resumes from them instead of paying for a stage again. Every entry is
 * keyed by the frozen input it answers, so a stage result is reused only for exactly that input.
 */
interface StageResults {
  v: 1;
  /** Rows the request's own translation stage produced for the frozen source. */
  translation?: TranslationInput[];
  enrich?: { stateSha256: string; answers: Record<string, unknown> };
  cards?: Record<
    string,
    { stateSha256: string; cardInputSha256: string; p: number; answer: JsonObject }
  >;
  l2?: Record<string, { stateSha256: string; answer: JsonObject }>;
}

/** Why a request cannot run under its frozen context (terminal). */
type FrozenContextProblem = 'invalid_snapshot' | 'context_unavailable';

/** The frozen states of one request (deterministic from the snapshot and its translation). */
interface FrozenStates {
  translation: AnalysisTranslation | null;
  variant: StateVariant;
  enrich: { state: ArticleState; sha256: string };
  match: { state: ArticleState; sha256: string };
}

/** Thrown inside a run to end it; the request has already been released or completed. */
class RunEnded extends Error {
  constructor() {
    super('analysis run ended');
    this.name = 'RunEnded';
  }
}

/**
 * `analysis.process {analysisRequestId}` (spec 03 §2.2, spec 05 §1.1). Claims a due pending request,
 * or reclaims an expired lease, in a committed transaction of its own; a busy or not-yet-due request
 * records a delayed intent for its lease expiry or due time instead. Then, only under the frozen
 * `input_snapshot` (never live article, card, question or translation inputs):
 * 1. verifies the snapshot, that this worker's code has its exact question sets and pinned model,
 *    and the request's authorization (a revoked request is cancelled);
 * 2. translates the frozen source when its language mode asks for a translation it did not freeze;
 * 3. asks Call A and the Call B packs (cards, labels and the selected level-2 branches) in `bulk`
 *    under the request's manual witness, reusing stage results of earlier leases and exact
 *    current primary cache entries, renewing the lease before every call and persisting each
 *    finished stage;
 * 4. publishes `result_snapshot` in one transaction guarded by the lease token and the live
 *    authorization, fills the shared current caches only when the live revision and every input
 *    manifest still match, and records the rank intent (still-current content) and `user.learn`
 *    (a surviving rating references the request).
 * Unavailability defers the request with a delayed intent, retry exhaustion counts an attempt
 * with backoff, and an invalid request or an unanswerable frozen context fails it. After
 * `jobBudgetMs` a run starts no further model call: it defers the request to now (`continued`, no
 * attempt) and the next job resumes from the saved stages, inside its queue expiration.
 */
export function createAnalysisProcessHandler(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  translation: TranslationDeps | undefined,
): QueueHandler<'analysis.process'> {
  return async ({ analysisRequestId }) => {
    const claim = await claimAnalysisRequest(deps.db, analysisRequestId, {
      leaseMs: classification.leaseMs,
    });
    switch (claim.status) {
      case 'missing':
      case 'finished':
      case 'expired':
        return;
      case 'busy':
        // Reclaim after the owner's lease if it never finishes (a crashed worker).
        await scheduleAt(deps, analysisRequestId, claim.leaseUntil);
        return;
      case 'not_due':
        await scheduleAt(deps, analysisRequestId, claim.nextAttemptAt);
        return;
      case 'claimed':
        break;
    }
    const run = new AnalysisRun(deps, classification, translation, claim.request, claim.leaseToken);
    try {
      await run.process();
    } catch (error) {
      if (!(error instanceof RunEnded)) throw error;
    }
  };
}

/** A delayed `analysis.process` intent (an identical pending intent coalesces it). */
async function scheduleAt(deps: WorkerDeps, id: string, at: Date): Promise<void> {
  await retryTransaction(deps.db, async (tx) => {
    await enqueueAnalysis(workerOutbox(tx, { availableAt: at }), { analysisRequestId: id });
  });
}

class AnalysisRun {
  private stages: StageResults;
  private snapshot!: AnalysisInputSnapshot;
  private readonly started: number;
  private calls = 0;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly classification: ClassificationDeps,
    private readonly translation: TranslationDeps | undefined,
    private readonly request: AnalysisRequestRow,
    private readonly leaseToken: string,
  ) {
    this.stages = parseStages(request.stageResults);
    this.started = nowOf(deps).getTime();
  }

  async process(): Promise<void> {
    const parsed = AnalysisInputSnapshotSchema.safeParse(this.request.inputSnapshot);
    if (!parsed.success) return this.terminal('fail', 'invalid_snapshot');
    this.snapshot = parsed.data;
    const problem = this.frozenContextProblem();
    if (problem !== null) return this.terminal('fail', problem);
    if (!(await analysisRequestAuthorized(this.deps.db, this.request.id))) {
      return this.terminal('cancel', 'revoked');
    }

    const translation = await this.translationStage();
    const states = frozenStates(this.snapshot, translation);
    const enrichAnswers = await this.enrichStage(states);
    const { cards, l2 } = await this.matchStage(states, enrichAnswers);
    await this.complete(states, enrichAnswers, cards, l2);
  }

  /** The frozen sets and model must be exactly what this worker's code asks (spec 05 §2). */
  private frozenContextProblem(): FrozenContextProblem | null {
    const { snapshot, request } = this;
    if (
      snapshot.article.id !== request.articleId ||
      snapshot.article.revision !== request.articleRevision
    ) {
      return 'invalid_snapshot';
    }
    for (const card of snapshot.cards) {
      if (cardInputSha256(card.question as unknown as NoulQuestion) !== card.cardInputSha256) {
        return 'invalid_snapshot';
      }
    }
    const enrich = questionSetByVersion(snapshot.questionSets.enrich.version);
    const match = questionSetByVersion(snapshot.questionSets.match.version);
    if (
      enrich?.kind !== 'enrich' ||
      enrich.sha256 !== snapshot.questionSets.enrich.sha256 ||
      match?.kind !== 'match' ||
      match.sha256 !== snapshot.questionSets.match.sha256 ||
      snapshot.model.model !== this.classification.primaryModel
    ) {
      return 'context_unavailable';
    }
    return null;
  }

  private authorization(): InferenceAuthorization {
    return {
      type: 'article',
      articleId: this.request.articleId,
      articleRevision: this.request.articleRevision,
      witnesses: [{ kind: 'manual', analysisRequestId: this.request.id }],
    };
  }

  /**
   * The translation the frozen states use: the frozen one, or in translate mode without one, the
   * request's own translation of the frozen source (tier 1, then tier 2 when tier 1 fails), kept
   * in the stage results. Null means native text.
   */
  private async translationStage(): Promise<AnalysisTranslation | null> {
    const { snapshot } = this;
    if (snapshot.translation !== null) return snapshot.translation;
    const lang = snapshot.article.lang;
    if (
      snapshot.languageMode !== 'translate' ||
      lang === null ||
      lang === 'und' ||
      lang === 'en' ||
      this.translation === undefined
    ) {
      return null;
    }
    if (this.stages.translation === undefined) {
      const source = frozenSource(snapshot);
      const job = {
        articleId: this.request.articleId,
        articleRevision: this.request.articleRevision,
        sourceLang: lang,
        source,
        sourceSha256: translationSourceSha256(lang, source),
        authorization: this.authorization(),
        userId: this.request.userId,
      };
      const rows: TranslationInput[] = [];
      await this.renewLease();
      const tier1 = await runTier1(this.deps.db, this.classification.router, this.translation, job);
      if (tier1.kind === 'no_demand') return this.terminal('cancel', 'revoked');
      if (tier1.kind === 'transient') {
        return this.defer(tier1.retryAt ?? this.recoveryTime(), 'translate_unavailable');
      }
      if (tier1.kind === 'row') rows.push(tier1.row);
      // Tier 2 only when tier 1 failed; nothing to send (`none`) stays native.
      if (tier1.kind === 'row' && tier1.row.quality === 'fail') {
        await this.renewLease();
        const tier2 = await runTier2(
          this.deps.db,
          this.classification.router,
          this.translation,
          job,
          this.translation.modelFast,
        );
        if (tier2.kind === 'no_demand') return this.terminal('cancel', 'revoked');
        if (tier2.kind === 'transient') {
          return this.defer(tier2.retryAt ?? this.recoveryTime(), 'translate_unavailable');
        }
        if (tier2.kind === 'row') rows.push(tier2.row);
      }
      this.stages.translation = rows;
      await this.saveStages();
    }
    return bestProduced(this.stages.translation ?? []);
  }

  /** Call A of the frozen state: a stage result, an exact current primary cache entry, or a call. */
  private async enrichStage(states: FrozenStates): Promise<Record<string, unknown>> {
    const stored = this.stages.enrich;
    if (stored !== undefined && stored.stateSha256 === states.enrich.sha256) return stored.answers;
    const set = this.snapshot.questionSets.enrich;
    const cached = await readFacets(this.deps.db, this.request.articleId, set.id);
    if (
      cached !== null &&
      cached.articleRevision === this.request.articleRevision &&
      cached.stateSha256 === states.enrich.sha256 &&
      isPrimaryAnswer(cached, this.snapshot.model.model)
    ) {
      this.stages.enrich = { stateSha256: states.enrich.sha256, answers: cached.answers };
      await this.saveStages();
      return cached.answers;
    }
    const outcome = await this.ask({
      kind: 'enrich',
      state: states.enrich.state,
      questions: enrichQuestions(set),
      questionSetId: set.id,
      questionSetSha: set.sha256,
      stateSha256: states.enrich.sha256,
    });
    this.stages.enrich = { stateSha256: states.enrich.sha256, answers: outcome.answers };
    await this.saveStages();
    return outcome.answers;
  }

  /**
   * Call B of the frozen state: every frozen card and label, and the level-2 branches the frozen
   * Call A selects, from stage results, exact current primary cache entries, or packed bulk calls.
   */
  private async matchStage(
    states: FrozenStates,
    enrichAnswers: Record<string, unknown>,
  ): Promise<{
    cards: Map<string, { p: number; answer: JsonObject }>;
    l2: Map<string, JsonObject>;
  }> {
    const { snapshot, request } = this;
    const matchSha = snapshot.questionSets.match.sha256;
    const stateSha = states.match.sha256;
    const frozenCards = new Map(snapshot.cards.map((card) => [card.cardId, card]));
    const cards = new Map<string, { p: number; answer: JsonObject }>();
    const l2 = new Map<string, JsonObject>();
    for (const [cardId, stored] of Object.entries(this.stages.cards ?? {})) {
      const frozen = frozenCards.get(cardId);
      if (frozen?.cardInputSha256 === stored.cardInputSha256 && stored.stateSha256 === stateSha) {
        cards.set(cardId, { p: stored.p, answer: stored.answer });
      }
    }
    for (const [l1, stored] of Object.entries(this.stages.l2 ?? {})) {
      if (stored.stateSha256 === stateSha) l2.set(l1, stored.answer);
    }

    // Exact current primary cache entries answer the same frozen input without a call.
    const current = {
      articleRevision: request.articleRevision,
      questionSetSha: matchSha,
      stateSha256: stateSha,
    };
    const missingCards = snapshot.cards.filter((card) => !cards.has(card.cardId));
    if (missingCards.length > 0) {
      const stored = await readCardAnswers(
        this.deps.db,
        request.articleId,
        missingCards.map((card) => card.cardId),
      );
      for (const row of stored) {
        const frozen = frozenCards.get(row.cardId);
        if (
          frozen !== undefined &&
          row.articleRevision === current.articleRevision &&
          row.questionSetSha === current.questionSetSha &&
          row.stateSha256 === current.stateSha256 &&
          row.cardInputSha256 === frozen.cardInputSha256 &&
          isPrimaryAnswer(row, snapshot.model.model)
        ) {
          cards.set(row.cardId, { p: row.p, answer: { type: 'noul', p: row.p } });
        }
      }
    }
    const branches = l2Branches(enrichAnswers);
    if (branches.some((l1) => !l2.has(l1))) {
      for (const row of await readL2Answers(this.deps.db, request.articleId)) {
        if (
          branches.includes(row.l1Id) &&
          !l2.has(row.l1Id) &&
          row.articleRevision === current.articleRevision &&
          row.questionSetSha === current.questionSetSha &&
          row.stateSha256 === current.stateSha256 &&
          isPrimaryAnswer(row, snapshot.model.model)
        ) {
          l2.set(row.l1Id, row.answer as JsonObject);
        }
      }
    }

    const items: PackItem[] = [];
    for (const card of snapshot.cards) {
      if (cards.has(card.cardId)) continue;
      items.push({
        key: cardKey(card.cardId),
        question: card.question as unknown as NoulQuestion,
        // One tenant's own cards: they may share a context (spec 05 §5.2).
        owner: null,
        kind: card.kind === 'label' ? 'label' : 'card',
        interactive: false,
        queuedAt: 0,
        cardId: card.cardId,
      });
    }
    for (const l1 of branches) {
      if (l2.has(l1)) continue;
      items.push({
        key: l2Key(l1),
        question: l2Question(l1),
        owner: null,
        kind: 'l2',
        interactive: false,
        queuedAt: 0,
      });
    }
    for (const pack of this.pack(states.match.state, items)) {
      const packCards = pack.keys.flatMap((key) => {
        const id = parseCardKey(key);
        return id === null ? [] : [id];
      });
      const outcome = await this.ask({
        kind: 'match',
        state: states.match.state,
        questions: pack.questions,
        questionSetId: snapshot.questionSets.match.id,
        questionSetSha: matchSha,
        stateSha256: stateSha,
        ...(packCards.length === 0 ? {} : { cardIds: packCards }),
      });
      const stageCards = (this.stages.cards ??= {});
      const stageL2 = (this.stages.l2 ??= {});
      for (const key of pack.keys) {
        const answer = outcome.answers[key];
        const cardId = parseCardKey(key);
        if (cardId !== null) {
          const frozen = frozenCards.get(cardId);
          if (answer?.type !== 'noul' || frozen === undefined) continue;
          const stored = { p: answer.p, answer: answer as unknown as JsonObject };
          cards.set(cardId, stored);
          stageCards[cardId] = {
            ...stored,
            stateSha256: stateSha,
            cardInputSha256: frozen.cardInputSha256,
          };
          continue;
        }
        const l1 = parseL2Key(key);
        if (l1 !== null && answer?.type === 'choice') {
          l2.set(l1, answer as unknown as JsonObject);
          stageL2[l1] = { stateSha256: stateSha, answer: answer as unknown as JsonObject };
        }
      }
      await this.saveStages();
    }
    return { cards, l2 };
  }

  /** Packs of the missing items; a question that cannot fit even alone is left unanswered. */
  private pack(state: ArticleState, items: PackItem[]) {
    for (;;) {
      try {
        return packRequests(state, items);
      } catch (error) {
        if (!(error instanceof PackOverflowError)) throw error;
        this.deps.logger.error(
          {
            analysisRequestId: this.request.id,
            key: error.key,
            tokens: error.tokens,
            limit: error.limit,
          },
          'analysis question cannot fit a request; it stays unanswered',
        );
        if (error.key === null) return [];
        const index = items.findIndex((item) => item.key === error.key);
        if (index < 0) return [];
        items.splice(index, 1);
      }
    }
  }

  /** One bulk router call under the manual witness, after renewing the lease. */
  private async ask(
    request: Pick<
      EngineRequest,
      | 'kind'
      | 'state'
      | 'questions'
      | 'questionSetId'
      | 'questionSetSha'
      | 'stateSha256'
      | 'cardIds'
    >,
  ): Promise<Extract<EngineOutcome, { ok: true }>> {
    const now = nowOf(this.deps);
    if (this.calls > 0 && now.getTime() - this.started >= this.classification.jobBudgetMs) {
      // Spec 03 §2.1: the finished stages are saved; a follow-up job resumes from them.
      return this.defer(now, 'continued');
    }
    this.calls += 1;
    await this.renewLease();
    const outcome = await this.classification.router.ask({
      ...request,
      articleId: this.request.articleId,
      articleRevision: this.request.articleRevision,
      userId: this.request.userId,
      priority: 'bulk',
      authorization: this.authorization(),
      deadlineMs: nowOf(this.deps).getTime() + this.classification.callDeadlineMs,
    });
    if (outcome.ok) {
      // Bulk work is served by the pinned primary engine only (spec 04 §5); anything else is not
      // the frozen model context and is never recorded as its answer.
      if (outcome.engine !== 'typesafe' || outcome.model !== this.snapshot.model.model) {
        return this.retry('model_mismatch');
      }
      return outcome;
    }
    const disposition = failureDisposition(outcome, nowOf(this.deps));
    switch (disposition.kind) {
      case 'no_demand':
        return this.terminal('cancel', 'revoked');
      case 'invalid':
        this.deps.logger.error(
          { analysisRequestId: this.request.id, kind: request.kind, detail: outcome.detail },
          'analysis request rejected as invalid; the request fails',
        );
        return this.terminal('fail', 'invalid_request');
      case 'defer':
        return this.defer(disposition.nextAttemptAt, disposition.lastError);
      case 'fail':
        return this.retry(disposition.lastError);
    }
  }

  /**
   * Publish the immutable result, and the shared current caches only while every live input still
   * matches the frozen one (spec 03 §2.2, spec 05 §1.1).
   */
  private async complete(
    states: FrozenStates,
    enrichAnswers: Record<string, unknown>,
    cards: ReadonlyMap<string, { p: number; answer: JsonObject }>,
    l2: ReadonlyMap<string, JsonObject>,
  ): Promise<void> {
    const { snapshot, request, deps } = this;
    const l2Answers = Object.fromEntries(
      [...l2.entries()].map(([l1, answer]) => [l1, answer as unknown as ChoiceAnswer]),
    );
    const result: AnalysisResultSnapshot = AnalysisResultSnapshotSchema.parse({
      v: 1,
      requestId: request.id,
      inputSha: request.inputSha,
      processedAt: nowOf(deps).toISOString(),
      article: { id: request.articleId, revision: request.articleRevision },
      model: snapshot.model,
      translation: states.translation,
      enrich: {
        questionSetSha: snapshot.questionSets.enrich.sha256,
        stateSha256: states.enrich.sha256,
        stateVariant: states.variant,
        answers: enrichAnswers,
        features: facetFeatures(enrichAnswers, l2Answers),
      },
      match: {
        questionSetSha: snapshot.questionSets.match.sha256,
        stateSha256: states.match.sha256,
        stateVariant: states.variant,
        cards: snapshot.cards.flatMap((card) => {
          const answer = cards.get(card.cardId);
          return answer === undefined
            ? []
            : [
                {
                  cardId: card.cardId,
                  cardInputSha256: card.cardInputSha256,
                  p: answer.p,
                  answer: answer.answer,
                },
              ];
        }),
        l2: [...l2.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([l1Id, answer]) => ({ l1Id, answer })),
      },
    });

    const published = await retryTransaction(deps.db, async (tx) => {
      const lock = await lockAnalysisRequest(tx, request.id, this.leaseToken);
      if (lock === 'lost') return 'lost' as const;
      if (lock === 'revoked') {
        await releaseAnalysisRequest(tx, request.id, this.leaseToken, {
          kind: 'cancel',
          errorCode: 'revoked',
        });
        return 'revoked' as const;
      }
      const sha = await completeAnalysisRequest(tx, request.id, this.leaseToken, result);
      if (sha === null) return 'lost' as const;
      const sender = workerOutbox(tx);
      const live = await lockArticleRevision(tx, request.articleId, 'share');
      let cachesFilled = false;
      if (live !== null && live.revision === request.articleRevision) {
        cachesFilled = await this.fillCurrentCaches(tx, states, result);
        await enqueueRank(sender, { userId: request.userId, reason: 'analysis' });
      }
      if (
        await analysisRatingReferences(tx, {
          requestId: request.id,
          userId: request.userId,
          articleId: request.articleId,
        })
      ) {
        await enqueueLearn(sender, { userId: request.userId });
      }
      return cachesFilled ? ('published' as const) : ('complete' as const);
    });
    deps.logger.info(
      { analysisRequestId: request.id, outcome: published, cards: result.match.cards.length },
      'analysis request processed',
    );
  }

  /**
   * Fill the shared current caches (missing, incompatible or lower-precedence entries, never a newer
   * compatible answer: `fill` mode) with the result, only when the live article revision, question
   * sets, card text mode, language mode, pinned model and the live model states all equal the frozen
   * ones; each card also needs its live question hash. A result that no longer matches stays
   * request-specific (training only).
   */
  private async fillCurrentCaches(
    tx: Transaction,
    states: FrozenStates,
    result: AnalysisResultSnapshot,
  ): Promise<boolean> {
    const { snapshot, request, deps, classification } = this;
    const config = await loadClassificationConfig(tx, deps.settingsEnv, { lock: true });
    if (!sameFrozenConfig(snapshot, config, classification.primaryModel)) return false;
    const article = await loadClassificationArticle(tx, request.articleId);
    if (article === null || article.revision !== request.articleRevision) return false;

    // The request's own translation reaches the shared cache only for the live source.
    const produced = this.stages.translation ?? [];
    if (produced.length > 0 && article.lang !== null) {
      const liveSource = articleTranslationSource({
        title: article.title,
        excerpt: article.excerpt,
        body_lead: article.bodyLead,
      });
      for (const row of produced) {
        if (row.sourceSha256 === translationSourceSha256(article.lang, liveSource)) {
          await storeTranslation(tx, row);
        }
      }
    }
    const input = modelInput(
      article,
      await listTranslations(tx, article.id, article.revision),
      config,
    );
    if (
      buildState(input, 'enrich').sha256 !== states.enrich.sha256 ||
      buildState(input, 'match').sha256 !== states.match.sha256
    ) {
      return false;
    }
    const fill = { primaryModel: classification.primaryModel, mode: 'fill' } as const;
    const engine = { engine: result.model.engine, model: result.model.model };
    await writeFacets(
      tx,
      {
        articleId: request.articleId,
        questionSetId: snapshot.questionSets.enrich.id,
        articleRevision: request.articleRevision,
        stateSha256: states.enrich.sha256,
        ...engine,
        stateVariant: states.variant,
        answers: result.enrich.answers,
        features: result.enrich.features,
      },
      fill,
    );
    const l2Rows: L2AnswerInput[] = result.match.l2.map((row) => ({
      articleId: request.articleId,
      l1Id: row.l1Id,
      articleRevision: request.articleRevision,
      questionSetSha: result.match.questionSetSha,
      stateSha256: states.match.sha256,
      ...engine,
      stateVariant: states.variant,
      answer: row.answer,
    }));
    await writeL2Answers(tx, l2Rows, fill);

    const liveCards = await loadCardInputs(
      tx,
      result.match.cards.map((card) => card.cardId),
    );
    const cardRows: CardAnswerInput[] = [];
    for (const card of result.match.cards) {
      const live = liveCards.get(card.cardId);
      if (live === undefined) continue;
      if (builtCardQuestion(live, config.cardTextMode).sha256 !== card.cardInputSha256) continue;
      cardRows.push({
        articleId: request.articleId,
        cardId: card.cardId,
        p: card.p,
        engine: 'typesafe',
        model: result.model.model,
        questionSetSha: result.match.questionSetSha,
        articleRevision: request.articleRevision,
        stateSha256: states.match.sha256,
        cardInputSha256: card.cardInputSha256,
        stateVariant: states.variant,
      });
    }
    await writeCardAnswers(tx, cardRows, fill);
    return true;
  }

  private recoveryTime(): Date {
    return new Date(nowOf(this.deps).getTime() + RECOVERY_INTERVAL_MS);
  }

  private async renewLease(): Promise<void> {
    const renewed = await renewAnalysisLease(
      this.deps.db,
      this.request.id,
      this.leaseToken,
      this.classification.leaseMs,
    );
    if (!renewed) throw new RunEnded();
  }

  private async saveStages(): Promise<void> {
    const saved = await saveAnalysisStages(
      this.deps.db,
      this.request.id,
      this.leaseToken,
      this.stages,
    );
    if (!saved) throw new RunEnded();
  }

  /** Back to pending at `at` without a failure attempt, with the delayed intent that resumes it. */
  private async defer(at: Date, errorCode: string): Promise<never> {
    await this.release({ kind: 'defer', nextAttemptAt: at, errorCode });
    throw new RunEnded();
  }

  /** One failure attempt with bounded backoff; the request fails after the attempt ceiling. */
  private async retry(errorCode: string): Promise<never> {
    await this.release({ kind: 'retry', errorCode });
    throw new RunEnded();
  }

  /** A terminal end: `fail` (persistent invalid input) or `cancel` (revoked demand). */
  private async terminal(kind: 'fail' | 'cancel', errorCode: string): Promise<never> {
    await this.release({ kind, errorCode });
    throw new RunEnded();
  }

  private async release(release: Parameters<typeof releaseAnalysisRequest>[3]): Promise<void> {
    await retryTransaction(this.deps.db, async (tx) => {
      const released = await releaseAnalysisRequest(tx, this.request.id, this.leaseToken, release);
      if (released?.status === 'pending') {
        await enqueueAnalysis(workerOutbox(tx, { availableAt: released.nextAttemptAt }), {
          analysisRequestId: this.request.id,
        });
      }
    });
    if (release.kind !== 'defer') {
      this.deps.logger.info(
        { analysisRequestId: this.request.id, release: release.kind, errorCode: release.errorCode },
        'analysis request released',
      );
    }
  }
}

/** The frozen source fields a request translates (spec 07 §3 step 1: its exact frozen text). */
function frozenSource(snapshot: AnalysisInputSnapshot): TranslationTexts {
  return articleTranslationSource({
    title: snapshot.article.title,
    excerpt: snapshot.article.excerpt,
    body_lead: snapshot.article.bodyLead,
  });
}

/** The best usable row among the request's own translations (spec 07 §3 step 4), frozen. */
function bestProduced(rows: readonly TranslationInput[]): AnalysisTranslation | null {
  const rank = { fail: 0, weak: 1, ok: 2 } as const;
  let best: TranslationInput | null = null;
  for (const row of rows) {
    if (row.quality === 'fail' || row.title === null || row.title.trim() === '') continue;
    if (
      best === null ||
      rank[row.quality] > rank[best.quality] ||
      (rank[row.quality] === rank[best.quality] && row.engine === 'ollama')
    ) {
      best = row;
    }
  }
  return best === null ? null : frozenTranslation({ ...best, createdAt: new Date(0) });
}

/** The frozen Call A and Call B states (spec 05 §3.1) of the snapshot and its translation. */
function frozenStates(
  snapshot: AnalysisInputSnapshot,
  translation: AnalysisTranslation | null,
): FrozenStates {
  const { article } = snapshot;
  const input: ArticleStateInput = {
    title: article.title,
    author: article.author,
    categories: article.categories,
    excerpt: article.excerpt,
    bodyLead: article.bodyLead,
    wordCount: article.wordCount,
    lang: article.lang,
    feed: article.feed,
    ...(translation === null
      ? {}
      : {
          translation: {
            title: translation.title,
            excerpt: translation.excerpt,
            bodyLead: translation.bodyLead,
          },
        }),
  };
  const variant: StateVariant = translation === null ? 'native' : 'translated';
  const build = (call: 'enrich' | 'match') => {
    const state = buildArticleState(input, variant, { call });
    return { state, sha256: stateSha256(state) };
  };
  return { translation, variant, enrich: build('enrich'), match: build('match') };
}

/** Whether the live configuration still is the frozen one (sets, modes and the pinned model). */
function sameFrozenConfig(
  snapshot: AnalysisInputSnapshot,
  config: ClassificationConfig,
  primaryModel: string,
): boolean {
  const { enrich, match } = snapshot.questionSets;
  return (
    config.enrich?.id === enrich.id &&
    config.enrich.sha256 === enrich.sha256 &&
    config.match?.id === match.id &&
    config.match.sha256 === match.sha256 &&
    config.cardTextMode === snapshot.cardTextMode &&
    languageModeOf(config, snapshot.article.lang) === snapshot.languageMode &&
    primaryModel === snapshot.model.model
  );
}

/** Stage results written by earlier leases; anything malformed starts the stages afresh. */
function parseStages(value: unknown): StageResults {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { v: 1 };
  const record = value as Partial<StageResults>;
  return record.v === 1 ? (record as StageResults) : { v: 1 };
}
