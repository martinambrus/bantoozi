import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createAnalysisRequest,
  createDatabase,
  isInferenceAuthorized,
  listTranslations,
  loadAnalysisCaptureContext,
  loadCardInputs,
  loadClassificationArticle,
  runMigrations,
  withTenant,
  writeCardAnswers,
  writeFacets,
  writeL2Answers,
  type Database,
  type InferenceWitness,
} from '@bantoozi/db';
import type {
  EngineOutcome,
  EngineRequest,
  EngineRouter,
  Priority,
  RouterStatus,
} from '@bantoozi/engine';
import { createMemoryOriginLimiter } from '@bantoozi/feeds';
import {
  l2Question,
  parseCardKey,
  parseL2Key,
  type Answer,
  type ChoiceAnswer,
  type Question,
} from '@bantoozi/questions';
import {
  parseJobPayload,
  type AnalysisInputSnapshot,
  type ExternalCall,
  type JobPayloadInput,
  type LanguageModes,
  type QueueName,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';

import { captureAnalysisSnapshot } from '../../src/classify/analysis-snapshot.js';
import { builtCardQuestion } from '../../src/classify/card-questions.js';
import {
  enrichQuestions,
  loadClassificationConfig,
  requireSet,
} from '../../src/classify/config.js';
import { facetFeatures } from '../../src/classify/features.js';
import { buildState, modelInput } from '../../src/classify/model-input.js';
import type { TranslationDeps } from '../../src/classify/translation.js';
import { createWorkerDeps, type WorkerDeps } from '../../src/handlers/deps.js';
import {
  createHandlers,
  dispatch,
  type HandlerMap,
  type JobContext,
} from '../../src/handlers/index.js';
import { defaultSeedHooks, runSeed } from '../../src/seed.js';

/**
 * Shared harness of the M2-T9 classification handler tests (spec 05, spec 03 §2.2, spec 07): a
 * migrated and seeded database (topics, question sets activated), the real handlers with a scripted
 * {@link ScriptedRouter}, fixtures in plain SQL, and outbox helpers that deliver durable intents
 * through the real handlers. No test ever reaches a live provider.
 */

export const PRIMARY_MODEL = 'jev-test-1';
export const LLM_MODEL = 'glm-5.3-flash';
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ago = (ms: number): Date => new Date(Date.now() - ms);

/** Call A `topic_l1` probabilities of the scripted router: two L2 branches by default. */
export const DEFAULT_TOPICS: Readonly<Record<string, number>> = { technology: 0.6, science: 0.3 };
/** Topic probabilities that select no level-2 branch (`other` dominates). */
export const NO_BRANCH_TOPICS: Readonly<Record<string, number>> = { other: 0.92 };

// ── Scripted router ─────────────────────────────────────────────────────────────────────────────

/** One router call as a test sees it. */
export interface AskRecord {
  request: EngineRequest;
  kind: EngineRequest['kind'];
  /** Question keys in request order. */
  keys: string[];
  /** Card ids asked (`c<id>` keys). */
  cards: string[];
  /** Level-2 branches asked (`t2_<l1>` keys). */
  l2: string[];
  articleId: string | undefined;
  articleRevision: string | undefined;
  userId: string | undefined;
  priority: Priority;
  witnesses: InferenceWitness[];
  /**
   * Whether the request's authorization still held when it reached the router. An unauthorized
   * request never reaches a provider: the router answers `no_demand` (spec 04 §1.1).
   */
  authorized: boolean;
}

export interface AnswerScript {
  topics: Readonly<Record<string, number>>;
  cardP: (cardId: string) => number;
  clusterChoice: string;
  followupP: number;
}

function choiceAnswer(
  options: readonly string[],
  weights: Readonly<Record<string, number>>,
): ChoiceAnswer {
  const known = options.filter((option) => weights[option] !== undefined);
  const knownSum = known.reduce((sum, option) => sum + (weights[option] ?? 0), 0);
  const rest = options.length - known.length;
  const share = rest === 0 ? 0 : Math.max(0, 1 - knownSum) / rest;
  const probabilities = Object.fromEntries(options.map((o) => [o, weights[o] ?? share]));
  let choice = options[0] ?? '';
  for (const option of options) {
    if ((probabilities[option] ?? 0) > (probabilities[choice] ?? 0)) choice = option;
  }
  return { type: 'choice', choice, probabilities, confidence: probabilities[choice] ?? 0 };
}

/** Deterministic, well-formed answers for every question (the fake provider). */
export function scriptedAnswers(
  questions: Readonly<Record<string, Question>>,
  script: AnswerScript,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const [key, question] of Object.entries(questions)) {
    switch (question.type) {
      case 'noul': {
        const cardId = parseCardKey(key);
        const p =
          cardId !== null ? script.cardP(cardId) : key === 'is_followup' ? script.followupP : 0.2;
        answers[key] = { type: 'noul', p };
        break;
      }
      case 'choice': {
        const options = Object.keys(question.criteria);
        if (key === 'topic_l1') {
          answers[key] = choiceAnswer(options, script.topics);
        } else if (key === 'same_story') {
          answers[key] = choiceAnswer(options, { [script.clusterChoice]: 0.9 });
        } else {
          answers[key] = choiceAnswer(options, { [options[0] ?? '']: 0.7 });
        }
        break;
      }
      case 'score': {
        const levels = question.criteria.length;
        const middle = Math.floor((levels - 1) / 2);
        const probabilities = Array.from({ length: levels }, (_, i) =>
          i === middle ? 0.6 : 0.4 / (levels - 1),
        );
        answers[key] = { type: 'score', score: middle, probabilities, confidence: 0.6, levels };
        break;
      }
    }
  }
  return answers;
}

export type AskResponder = (
  ask: AskRecord,
) => EngineOutcome | undefined | Promise<EngineOutcome | undefined>;

/**
 * A scripted {@link EngineRouter}: it rechecks every request's authorization against the live
 * database first, like the real router's admission (an unauthorized request is `no_demand` and
 * never reaches a provider), records every call, then runs the test's `respond` hook (which may
 * change the database while the "provider" is working, or return a failure) and otherwise answers
 * every question deterministically.
 */
export class ScriptedRouter implements EngineRouter {
  readonly asks: AskRecord[] = [];
  readonly external: Array<{ call: ExternalCall; reservationId: string | undefined }> = [];
  readonly reservations: Array<{
    input: Parameters<EngineRouter['reserveExternalCall']>[0];
    id: string | null;
  }> = [];
  topics: Readonly<Record<string, number>> = DEFAULT_TOPICS;
  cardP: (cardId: string) => number = () => 0.8;
  clusterChoice = 'none';
  followupP = 0.1;
  engine: 'typesafe' | 'llm' | 'laya' = 'typesafe';
  model: string;
  /** Keys left out of an ok outcome (the provider answered only part of a pack). */
  omit: (key: string, ask: AskRecord) => boolean = () => false;
  /** Runs after the authorization check; a returned outcome replaces the default ok outcome. */
  respond: AskResponder | undefined;
  credential: RouterStatus['credentials']['typesafe'] = { source: 'env', enabled: true };
  spendable = true;
  reservation: () => string | null;
  private reservationCount = 0;

  constructor(
    private readonly db: Database,
    readonly primaryModel: string,
  ) {
    this.model = primaryModel;
    this.reservation = () => `reservation-${(this.reservationCount += 1)}`;
  }

  reset(): void {
    this.asks.length = 0;
    this.external.length = 0;
    this.reservations.length = 0;
    this.topics = DEFAULT_TOPICS;
    this.cardP = () => 0.8;
    this.clusterChoice = 'none';
    this.followupP = 0.1;
    this.engine = 'typesafe';
    this.model = this.primaryModel;
    this.omit = () => false;
    this.respond = undefined;
    this.credential = { source: 'env', enabled: true };
    this.spendable = true;
    this.reservation = () => `reservation-${(this.reservationCount += 1)}`;
  }

  /** The calls that reached the provider (authorized). */
  get provider(): AskRecord[] {
    return this.asks.filter((ask) => ask.authorized);
  }

  asksFor(articleId: string, kind?: EngineRequest['kind']): AskRecord[] {
    return this.asks.filter(
      (ask) => ask.articleId === articleId && (kind === undefined || ask.kind === kind),
    );
  }

  script(): AnswerScript {
    return {
      topics: this.topics,
      cardP: this.cardP,
      clusterChoice: this.clusterChoice,
      followupP: this.followupP,
    };
  }

  async ask(request: EngineRequest): Promise<EngineOutcome> {
    const authorized = await isInferenceAuthorized(this.db, request.authorization);
    const keys = Object.keys(request.questions);
    const record: AskRecord = {
      request,
      kind: request.kind,
      keys,
      cards: keys.flatMap((key) => {
        const id = parseCardKey(key);
        return id === null ? [] : [id];
      }),
      l2: keys.flatMap((key) => {
        const l1 = parseL2Key(key);
        return l1 === null ? [] : [l1];
      }),
      articleId: request.articleId,
      articleRevision: request.articleRevision,
      userId: request.userId,
      priority: request.priority,
      witnesses:
        request.authorization.type === 'article' ? [...request.authorization.witnesses] : [],
      authorized,
    };
    this.asks.push(record);
    if (!authorized) return { ok: false, reason: 'no_demand' };
    const scripted = await this.respond?.(record);
    if (scripted !== undefined) return scripted;
    return this.okOutcome(record);
  }

  okOutcome(record: AskRecord): Extract<EngineOutcome, { ok: true }> {
    const answers = scriptedAnswers(record.request.questions, this.script());
    for (const key of Object.keys(answers)) {
      if (this.omit(key, record)) delete answers[key];
    }
    return {
      ok: true,
      engine: this.engine,
      model: this.model,
      answers,
      usage: { inputTokens: 100, outputTokens: 10 },
      costUsd: 0.001,
      latencyMs: 5,
    };
  }

  async status(): Promise<RouterStatus> {
    return {
      credentials: {
        typesafe: this.credential,
        ollama: { source: 'env', enabled: true },
      },
      breakers: {
        typesafe: { state: 'closed', reopenCount: 0 },
        llm: { state: 'closed', reopenCount: 0 },
      },
      spendTodayUsd: 0,
      budgetUsd: 2,
      llmCallsToday: 0,
    };
  }

  async canSpend(): Promise<boolean> {
    return this.spendable;
  }

  async reserveExternalCall(
    input: Parameters<EngineRouter['reserveExternalCall']>[0],
  ): Promise<string | null> {
    const id = this.reservation();
    this.reservations.push({ input, id });
    return id;
  }

  async recordExternalCall(call: ExternalCall, reservationId?: string): Promise<void> {
    this.external.push({ call, reservationId });
  }
}

/** A failed outcome for `respond` hooks. */
export const failure = (
  reason: Extract<EngineOutcome, { ok: false }>['reason'],
  retryAt?: Date,
): Extract<EngineOutcome, { ok: false }> =>
  retryAt === undefined ? { ok: false, reason } : { ok: false, reason, retryAt };

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────

export interface Intent {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  availableAt: Date;
  deliveredAt: Date | null;
}

export interface QueueRow {
  cardId: string;
  revision: string;
  priority: number;
  userId: string | null;
  attempts: number;
  lastError: string | null;
  leaseToken: string | null;
  leased: boolean;
  due: boolean;
  nextAttemptAt: Date;
}

export interface ArticleRow {
  revision: string;
  state: string;
  enrichEngine: string | null;
  clusterId: string | null;
  clusterSetId: string | null;
}

export interface AnalysisRow {
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  resultSnapshot: Record<string, unknown> | null;
  resultSha: string | null;
  stageResults: Record<string, unknown> | null;
  completedAt: Date | null;
  /** `result_sha` recomputed from the stored jsonb text (D-4). */
  computedSha: string | null;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

export interface HarnessOptions {
  translation?: TranslationDeps;
  languageModes?: LanguageModes;
}

export class ClassifyHarness {
  readonly router: ScriptedRouter;
  readonly deps: WorkerDeps;
  readonly handlers: HandlerMap;

  private constructor(
    readonly testDb: TestDatabase,
    readonly owner: pg.Pool,
    readonly worker: pg.Pool,
    private readonly lockPool: pg.Pool,
    readonly db: Database,
    readonly ownerDb: Database,
    readonly settingsEnv: SettingEnvDefaults,
    readonly sets: { enrich: string; match: string; cluster: string },
    options: HarnessOptions,
  ) {
    this.router = new ScriptedRouter(db, PRIMARY_MODEL);
    this.deps = createWorkerDeps({
      db,
      lockPool,
      fetch: {
        userAgent: 'BantooziBot/1.0 (+https://bantoozi.test/bot)',
        timeoutMs: 10_000,
        maxBytes: 5 * 1024 * 1024,
        allowPrivate: true,
      },
      ingestMaxAgeDays: 14,
      settingsEnv,
      limiter: createMemoryOriginLimiter({ spacingMs: 0 }),
      logger: silent,
      classification: {
        router: this.router,
        primaryModel: PRIMARY_MODEL,
        leaseMs: 600_000,
        callDeadlineMs: 300_000,
        jobBudgetMs: 600_000,
        ...(options.translation === undefined ? {} : { translation: options.translation }),
      },
    });
    this.handlers = createHandlers(this.deps);
  }

  /** A migrated test database seeded with the taxonomy and the activated question sets. */
  static async start(options: HarnessOptions = {}): Promise<ClassifyHarness> {
    const testDb = await setupTestDatabase({
      pkg: 'worker',
      migrationsDir: MIGRATIONS_FOLDER,
      pgBossVersion: PG_BOSS_VERSION,
      migrate: async (url) => {
        await runMigrations({ databaseUrl: url });
      },
    });
    const owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 4 });
    const worker = new pg.Pool({ connectionString: testDb.urls.worker, max: 10 });
    const lockPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
    const db = createDatabase(worker);
    const settingsEnv: SettingEnvDefaults = {
      dailyBudgetUsd: 2,
      languageModes: options.languageModes ?? { en: 'native', sk: 'native', cs: 'native' },
      signupMode: 'invite',
    };
    const hooks = defaultSeedHooks();
    await runSeed(db, settingsEnv, { taxonomy: hooks.taxonomy, questionSets: hooks.questionSets });
    const active = await owner.query<{ value: Record<string, string> }>(
      "SELECT value FROM settings WHERE key = 'question_sets.active'",
    );
    const value = active.rows[0]?.value ?? {};
    const sets = {
      enrich: value['enrich'] ?? '',
      match: value['match'] ?? '',
      cluster: value['cluster'] ?? '',
    };
    return new ClassifyHarness(
      testDb,
      owner,
      worker,
      lockPool,
      db,
      createDatabase(owner),
      settingsEnv,
      sets,
      options,
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.owner.end(), this.worker.end(), this.lockPool.end()]);
    await dropCreatedTestDatabases();
  }

  /** Handlers over other dependencies (another clock, other translators). */
  handlersWith(overrides: Partial<WorkerDeps>): HandlerMap {
    return createHandlers({ ...this.deps, ...overrides });
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

  async user(plan = 'beta'): Promise<string> {
    return (await createUser(this.owner, { plan })).id;
  }

  async feed(title?: string): Promise<string> {
    return (await createFeed(this.owner, title === undefined ? {} : { title })).id;
  }

  /** A subscription as the API leaves it (active ones activated a week ago by default). */
  async subscribe(
    userId: string,
    feedId: string,
    mode: 'off' | 'training' | 'active',
    activatedAt: Date = ago(7 * DAY),
  ): Promise<void> {
    await createSubscription(this.owner, {
      userId,
      feedId,
      mode,
      ...(mode === 'active' ? { activatedAt } : {}),
    });
  }

  /** An explicit mode change: the version advances, activation is now (spec 02 §3.4). */
  async setMode(
    userId: string,
    feedId: string,
    mode: 'off' | 'training' | 'active',
  ): Promise<void> {
    const result = await this.owner.query(
      `UPDATE subscriptions
          SET inference_mode = $3, inference_version = inference_version + 1,
              inference_activated_at = CASE WHEN $3 = 'active' THEN now() END
        WHERE user_id = $1 AND feed_id = $2 AND inference_mode <> $3`,
      [userId, feedId, mode],
    );
    if (result.rowCount !== 1) throw new Error('mode change did not apply');
  }

  async card(
    options: {
      kind?: 'interest' | 'label';
      visibility?: 'public' | 'shared' | 'private';
      ownerUserId?: string;
      topicIds?: readonly string[];
      interest?: string;
      title?: string;
    } = {},
  ): Promise<string> {
    return (await createCard(this.owner, options)).id;
  }

  /** Hold an interest card (spec 02 `user_cards`). */
  async hold(
    userId: string,
    cardId: string,
    options: { strength?: 'must' | 'love' | 'like' | 'never'; scopeFeedId?: string } = {},
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $2, $3, $4)`,
      [userId, cardId, options.strength ?? 'like', options.scopeFeedId ?? null],
    );
  }

  /** A shared interest card held by `userId`. */
  async heldCard(
    userId: string,
    options: Parameters<ClassifyHarness['card']>[0] & { scopeFeedId?: string } = {},
  ): Promise<string> {
    const { scopeFeedId, ...card } = options;
    const id = await this.card(card);
    await this.hold(userId, id, scopeFeedId === undefined ? {} : { scopeFeedId });
    return id;
  }

  /** A shared label card assigned to `userId` (`user_labels`). */
  async heldLabel(
    userId: string,
    options: { title?: string; topicIds?: readonly string[] } = {},
  ): Promise<string> {
    const id = await this.card({ kind: 'label', ...options });
    await this.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)`, [
      userId,
      id,
      `label ${id}`,
    ]);
    return id;
  }

  /**
   * An article carried by `feedIds` in `state`, with a body lead stored at its revision (the
   * extraction's output), first seen an hour ago by default.
   */
  async article(options: {
    feedIds: readonly string[];
    state?: string;
    lang?: string | null;
    title?: string;
    excerpt?: string;
    bodyLead?: string | null;
    firstSeenAt?: Date;
    wordCount?: number;
  }): Promise<string> {
    const firstSeenAt = options.firstSeenAt ?? ago(HOUR);
    const article = await createArticle(this.owner, {
      feedIds: options.feedIds,
      firstSeenAt,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.excerpt === undefined ? {} : { excerpt: options.excerpt }),
    });
    await this.owner.query(
      `UPDATE articles SET pipeline_state = $2, lang = $3, word_count = $4 WHERE id = $1`,
      [
        article.id,
        options.state ?? 'extracted',
        options.lang === undefined ? 'en' : options.lang,
        options.wordCount ?? 420,
      ],
    );
    const bodyLead =
      options.bodyLead === undefined
        ? `${options.title ?? 'The article'} explains what happened and why it matters to readers.`
        : options.bodyLead;
    if (bodyLead !== null) {
      await this.owner.query(
        `INSERT INTO article_bodies (article_id, article_revision, status, body_text, body_lead,
                                     completeness, extractor_version)
         VALUES ($1, 1, 'ok', $2, $2, 'complete', 'test')`,
        [article.id, bodyLead],
      );
    }
    return article.id;
  }

  /** Another carrier of an article (`feed_items`). */
  async carry(feedId: string, articleId: string, firstSeenAt: Date = ago(HOUR)): Promise<void> {
    await this.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)`,
      [feedId, articleId, `guid-${feedId}-${articleId}`, firstSeenAt],
    );
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.owner.query('DELETE FROM settings WHERE key = $1', [key]);
  }

  async setting(key: string): Promise<unknown> {
    const result = await this.owner.query<{ value: unknown }>(
      'SELECT value FROM settings WHERE key = $1',
      [key],
    );
    return result.rows[0]?.value;
  }

  // ── Classification state shortcuts (the fingerprints the handlers compute) ────────────────────

  private async inputs(articleId: string) {
    const config = await loadClassificationConfig(this.db, this.settingsEnv);
    const article = await loadClassificationArticle(this.db, articleId);
    if (article === null) throw new Error(`article ${articleId} is gone`);
    const input = modelInput(
      article,
      await listTranslations(this.db, articleId, article.revision),
      config,
    );
    return { config, article, input };
  }

  /**
   * Current Call A facets of the article (scripted answers) written as `engine`/`model` would, and
   * the article moved to `state` with that enrich engine: an article enriched earlier.
   */
  async enrichDirect(
    articleId: string,
    options: {
      engine?: 'typesafe' | 'llm' | 'laya';
      model?: string | null;
      state?: string;
      topics?: Readonly<Record<string, number>>;
    } = {},
  ): Promise<void> {
    const { config, article, input } = await this.inputs(articleId);
    const set = requireSet(config.enrich, 'enrich');
    const state = buildState(input, 'enrich');
    const answers = scriptedAnswers(enrichQuestions(set), {
      ...this.router.script(),
      ...(options.topics === undefined ? {} : { topics: options.topics }),
    });
    const engine = options.engine ?? 'typesafe';
    await this.db.transaction((tx) =>
      writeFacets(
        tx,
        {
          articleId,
          questionSetId: set.id,
          articleRevision: article.revision,
          stateSha256: state.sha256,
          engine,
          model: options.model === undefined ? PRIMARY_MODEL : options.model,
          stateVariant: state.variant,
          answers,
          features: facetFeatures(answers, {}),
        },
        { primaryModel: PRIMARY_MODEL },
      ),
    );
    await this.owner.query(
      'UPDATE articles SET pipeline_state = $2, enrich_engine = $3 WHERE id = $1',
      [articleId, options.state ?? 'enriched', engine],
    );
  }

  /** A card answer for the article's current match input, as `engine` would write it. */
  async answerCard(
    articleId: string,
    cardId: string,
    options: {
      engine: 'typesafe' | 'llm' | 'laya' | 'prefilter';
      model?: string | null;
      p?: number;
    },
  ): Promise<void> {
    const { config, article, input } = await this.inputs(articleId);
    const set = requireSet(config.match, 'match');
    const state = buildState(input, 'match');
    const card = (await loadCardInputs(this.db, [cardId])).get(cardId);
    if (card === undefined) throw new Error(`card ${cardId} is gone`);
    const built = builtCardQuestion(card, config.cardTextMode);
    await this.db.transaction((tx) =>
      writeCardAnswers(
        tx,
        [
          {
            articleId,
            cardId,
            p: options.p ?? 0.5,
            engine: options.engine,
            model:
              options.model === undefined
                ? options.engine === 'typesafe'
                  ? PRIMARY_MODEL
                  : options.engine === 'llm'
                    ? LLM_MODEL
                    : null
                : options.model,
            questionSetSha: set.sha256,
            articleRevision: article.revision,
            stateSha256: state.sha256,
            cardInputSha256: built.sha256,
            stateVariant: state.variant,
          },
        ],
        { primaryModel: PRIMARY_MODEL },
      ),
    );
  }

  /** A level-2 answer for the article's current match input. */
  async answerL2(
    articleId: string,
    l1: string,
    options: { engine: 'typesafe' | 'llm' | 'laya'; model?: string | null },
  ): Promise<void> {
    const { config, article, input } = await this.inputs(articleId);
    const set = requireSet(config.match, 'match');
    const state = buildState(input, 'match');
    const answer = scriptedAnswers({ q: l2Question(l1) }, this.router.script())['q'];
    await this.db.transaction((tx) =>
      writeL2Answers(
        tx,
        [
          {
            articleId,
            l1Id: l1,
            articleRevision: article.revision,
            questionSetSha: set.sha256,
            stateSha256: state.sha256,
            engine: options.engine,
            model:
              options.model === undefined
                ? options.engine === 'typesafe'
                  ? PRIMARY_MODEL
                  : LLM_MODEL
                : options.model,
            stateVariant: state.variant,
            answer: answer as unknown as Record<string, unknown>,
          },
        ],
        { primaryModel: PRIMARY_MODEL },
      ),
    );
  }

  /** Queue rows at the article's current revision, as a producer would record them. */
  async queue(
    articleId: string,
    cardIds: readonly string[],
    options: {
      priority?: number;
      userId?: string;
      attempts?: number;
      lastError?: string;
      /** Due time; for an exhausted row, when it gave up. Default now. */
      nextAttemptAt?: Date;
    } = {},
  ): Promise<void> {
    await this.owner.query(
      `INSERT INTO match_queue (article_id, card_id, article_revision, priority, user_id, attempts,
                                last_error, next_attempt_at)
       SELECT a.id, c.card_id, a.content_revision, $3, $4, $5, $6, coalesce($7, now())
         FROM articles a, unnest($2::bigint[]) AS c(card_id)
        WHERE a.id = $1`,
      [
        articleId,
        cardIds,
        options.priority ?? 5,
        options.userId ?? null,
        options.attempts ?? 0,
        options.lastError ?? null,
        options.nextAttemptAt ?? null,
      ],
    );
  }

  // ── Selected-article requests ────────────────────────────────────────────────────────────────

  /**
   * The training API's selection (spec 05 §1.1): the frozen input snapshot of the article's current
   * revision and the user's held cards, stored as the tenant with its `analysis.process` intent.
   */
  async select(
    userId: string,
    feedId: string,
    articleId: string,
  ): Promise<{ requestId: string; snapshot: AnalysisInputSnapshot }> {
    const config = await loadClassificationConfig(this.db, this.settingsEnv);
    const article = await loadClassificationArticle(this.db, articleId);
    const context = await loadAnalysisCaptureContext(this.db, { userId, feedId, articleId });
    if (article === null || context === null) throw new Error('nothing to select');
    const snapshot = captureAnalysisSnapshot({
      article,
      translations: await listTranslations(this.db, articleId, article.revision),
      context,
      cards: await loadCardInputs(
        this.db,
        context.cards.map((card) => card.cardId),
      ),
      config,
      primaryModel: PRIMARY_MODEL,
      capturedAt: new Date(),
    });
    const version = await this.owner.query<{ v: string }>(
      `SELECT inference_version::text AS v FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
      [userId, feedId],
    );
    const created = await withTenant(this.ownerDb, userId, (tx) =>
      createAnalysisRequest(tx, {
        feedId,
        articleId,
        articleRevision: article.revision,
        inferenceVersion: version.rows[0]?.v ?? '0',
        inputSnapshot: snapshot,
      }),
    );
    return { requestId: created.id, snapshot };
  }

  async analysis(requestId: string): Promise<AnalysisRow> {
    const result = await this.owner.query<{
      status: string;
      attempts: number;
      next_attempt_at: Date;
      last_error_code: string | null;
      lease_token: string | null;
      lease_until: Date | null;
      result_snapshot: Record<string, unknown> | null;
      result_sha: string | null;
      stage_results: Record<string, unknown> | null;
      completed_at: Date | null;
      computed_sha: string | null;
    }>(
      `SELECT status, attempts, next_attempt_at, last_error_code, lease_token::text AS lease_token,
              lease_until, result_snapshot, result_sha, stage_results, completed_at,
              encode(sha256(convert_to(result_snapshot::text, 'UTF8')), 'hex') AS computed_sha
         FROM analysis_requests WHERE id = $1`,
      [requestId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no request ${requestId}`);
    return {
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastErrorCode: row.last_error_code,
      leaseToken: row.lease_token,
      leaseUntil: row.lease_until,
      resultSnapshot: row.result_snapshot,
      resultSha: row.result_sha,
      stageResults: row.stage_results,
      completedAt: row.completed_at,
      computedSha: row.computed_sha,
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────

  async articleRow(articleId: string): Promise<ArticleRow> {
    const result = await this.owner.query<{
      revision: string;
      state: string;
      enrich_engine: string | null;
      cluster_id: string | null;
      cluster_set_id: string | null;
    }>(
      `SELECT content_revision::text AS revision, pipeline_state AS state, enrich_engine,
              story_cluster_id::text AS cluster_id, cluster_set_id::text AS cluster_set_id
         FROM articles WHERE id = $1`,
      [articleId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no article ${articleId}`);
    return {
      revision: row.revision,
      state: row.state,
      enrichEngine: row.enrich_engine,
      clusterId: row.cluster_id,
      clusterSetId: row.cluster_set_id,
    };
  }

  async queueRows(articleId: string): Promise<QueueRow[]> {
    const result = await this.owner.query<{
      card_id: string;
      revision: string;
      priority: number;
      user_id: string | null;
      attempts: number;
      last_error: string | null;
      lease_token: string | null;
      leased: boolean;
      due: boolean;
      next_attempt_at: Date;
    }>(
      `SELECT card_id::text AS card_id, article_revision::text AS revision, priority,
              user_id::text AS user_id, attempts, last_error, lease_token::text AS lease_token,
              (lease_until IS NOT NULL AND lease_until >= now()) AS leased,
              next_attempt_at <= now() AS due, next_attempt_at
         FROM match_queue WHERE article_id = $1 ORDER BY match_queue.card_id`,
      [articleId],
    );
    return result.rows.map((row) => ({
      cardId: row.card_id,
      revision: row.revision,
      priority: row.priority,
      userId: row.user_id,
      attempts: row.attempts,
      lastError: row.last_error,
      leaseToken: row.lease_token,
      leased: row.leased,
      due: row.due,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  async cardAnswers(
    articleId: string,
  ): Promise<
    Array<{ cardId: string; p: number; engine: string; model: string | null; revision: string }>
  > {
    const result = await this.owner.query<{
      card_id: string;
      p: number;
      engine: string;
      model: string | null;
      revision: string;
    }>(
      `SELECT card_id::text AS card_id, p, engine, model, article_revision::text AS revision
         FROM card_answers WHERE article_id = $1 ORDER BY card_answers.card_id`,
      [articleId],
    );
    return result.rows.map((row) => ({
      cardId: row.card_id,
      p: row.p,
      engine: row.engine,
      model: row.model,
      revision: row.revision,
    }));
  }

  async facetRow(articleId: string): Promise<{
    revision: string;
    engine: string;
    model: string | null;
    stateSha256: string;
    variant: string;
    answers: Record<string, unknown>;
    features: Record<string, number>;
  } | null> {
    const result = await this.owner.query<{
      revision: string;
      engine: string;
      model: string | null;
      state_sha256: string;
      state_variant: string;
      answers: Record<string, unknown>;
      features: Record<string, number>;
    }>(
      `SELECT article_revision::text AS revision, engine, model, state_sha256, state_variant,
              answers, features
         FROM article_facets WHERE article_id = $1 AND question_set_id = $2`,
      [articleId, this.sets.enrich],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          revision: row.revision,
          engine: row.engine,
          model: row.model,
          stateSha256: row.state_sha256,
          variant: row.state_variant,
          answers: row.answers,
          features: row.features,
        };
  }

  async l2Rows(
    articleId: string,
  ): Promise<Array<{ l1: string; engine: string; model: string | null; revision: string }>> {
    const result = await this.owner.query<{
      l1_id: string;
      engine: string;
      model: string | null;
      revision: string;
    }>(
      `SELECT l1_id, engine, model, article_revision::text AS revision
         FROM article_topics_l2 WHERE article_id = $1 ORDER BY l1_id`,
      [articleId],
    );
    return result.rows.map((row) => ({
      l1: row.l1_id,
      engine: row.engine,
      model: row.model,
      revision: row.revision,
    }));
  }

  // ── Outbox ───────────────────────────────────────────────────────────────────────────────────

  /** The newest outbox id: intents recorded after it are this step's. */
  async mark(): Promise<string> {
    const result = await this.owner.query<{ id: string }>(
      'SELECT coalesce(max(id), 0)::text AS id FROM job_outbox',
    );
    return result.rows[0]?.id ?? '0';
  }

  async intents(
    queue: string,
    options: { since?: string; pending?: boolean } = {},
  ): Promise<Intent[]> {
    const result = await this.owner.query<{
      id: string;
      queue: string;
      payload: Record<string, unknown>;
      available_at: Date;
      delivered_at: Date | null;
    }>(
      `SELECT id::text AS id, queue, payload, available_at, delivered_at FROM job_outbox
        WHERE queue = $1 AND id > $2::bigint AND ($3::boolean IS NOT TRUE OR delivered_at IS NULL)
        ORDER BY id`,
      [queue, options.since ?? '0', options.pending ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      payload: row.payload,
      availableAt: row.available_at,
      deliveredAt: row.delivered_at,
    }));
  }

  /** Payloads recorded after `since`. */
  async payloads(queue: string, since = '0'): Promise<Array<Record<string, unknown>>> {
    return (await this.intents(queue, { since })).map((intent) => intent.payload);
  }

  /** Mark every pending intent delivered: a test starts from an empty outbox. */
  async clearOutbox(): Promise<void> {
    await this.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  }

  /**
   * Deliver the due pending intents of `queue` accepted by `where` through the real handler, as
   * the relay would (marked delivered first), until none remain.
   */
  async run(
    queue: QueueName,
    where: (payload: Record<string, unknown>) => boolean = () => true,
    context: Partial<JobContext> = {},
  ): Promise<number> {
    let ran = 0;
    for (let round = 0; round < 25; round += 1) {
      const pending = await this.owner.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id::text AS id, payload FROM job_outbox
          WHERE queue = $1 AND delivered_at IS NULL AND available_at <= now() ORDER BY id`,
        [queue],
      );
      const due = pending.rows.filter((row) => where(row.payload));
      if (due.length === 0) return ran;
      for (const row of due) {
        await this.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [
          row.id,
        ]);
        await dispatch(this.handlers, queue, parseJobPayload(queue, row.payload), {
          queue,
          jobId: row.id,
          ...context,
        });
        ran += 1;
      }
    }
    throw new Error(`run(${queue}) did not settle`);
  }

  /** Run `queues` in order, repeatedly, until none of them has due work accepted by `where`. */
  async drain(
    queues: readonly QueueName[],
    where: (payload: Record<string, unknown>) => boolean = () => true,
  ): Promise<void> {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      let ran = 0;
      for (const queue of queues) ran += await this.run(queue, where);
      if (ran === 0) return;
    }
    throw new Error('the pipeline did not settle');
  }

  /** Dispatch one job directly (a duplicate delivery, a replay). */
  async dispatch<Q extends QueueName>(
    queue: Q,
    payload: JobPayloadInput<Q>,
    context: Partial<JobContext> = {},
  ): Promise<void> {
    await dispatch(this.handlers, queue, parseJobPayload(queue, payload), {
      queue,
      jobId: 'direct',
      ...context,
    });
  }
}

/** A payload filter for intents about these articles. */
export const forArticles =
  (...articleIds: string[]) =>
  (payload: Record<string, unknown>): boolean =>
    articleIds.includes(String(payload['articleId']));

/** The users a set of asks carried automatic witnesses for, and the requests of manual ones. */
export function witnessesOf(asks: readonly AskRecord[]): { users: string[]; requests: string[] } {
  const users = new Set<string>();
  const requests = new Set<string>();
  for (const ask of asks) {
    for (const witness of ask.witnesses) {
      if (witness.kind === 'automatic') users.add(witness.userId);
      else requests.add(witness.analysisRequestId);
    }
  }
  return { users: [...users].sort(), requests: [...requests].sort() };
}
