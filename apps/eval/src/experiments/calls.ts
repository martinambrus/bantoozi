import {
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  estimateLlmCostUsd,
  estimateLlmInputTokens,
  LLM_ENGINE_VERSION,
  typesafeCostUsd,
  type EngineOutcome,
  type EngineRouter,
  type Question,
} from '@bantoozi/engine';
import {
  cardKey,
  ENRICH_V1,
  MATCH_V1,
  PackOverflowError,
  packRequests,
  type Answer,
  type PackItem,
} from '@bantoozi/questions';
import {
  conservativeRequestTokens,
  isAppError,
  JsonValueSchema,
  type InferenceAuthorization,
  type JsonValue,
} from '@bantoozi/shared';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  articleTranslationSource,
  assessTranslation,
  supportedSourceLanguages,
  TIER2_MAX_ATTEMPTS,
  TIER2_OPTIONS,
  tier2SystemPrompt,
  toExternalCall,
  translateCardText,
  TRANSLATION_POLICY_VERSION,
  translationSourceSha256,
  type Tier2AttemptResult,
  type TranslationAttempt,
  type TranslationQuality,
  type TranslationTexts,
} from '@bantoozi/translate';
import { z } from 'zod';

import type { EvalSnapshot } from '../dataset/snapshot.js';
import { EVAL_CACHE_VERSION, type CacheManifest, type EvalCache } from './cache.js';
import type { RunCard, RunEngine } from './run-config.js';
import { newLogicalRequestId, type EvalTranslators } from './services.js';
import type { BuiltCard, BuiltState, FrozenTranslation } from './states.js';

/**
 * Cached provider calls of one invocation (spec 10 §3). Every Call A, Call B card answer and
 * translation goes through here: a validated cache entry is reused with its provenance; a miss is
 * asked through the eval router (or recorded through it, for translations), and only a validated
 * success is written to the cache. In estimate mode nothing is sent: a miss adds its admission
 * estimate (spec 04 §6.1, the same bound the router reserves) to the invocation estimate.
 *
 * A refusal of the invocation cap (`budget`) stops the invocation (status `aborted`): every later
 * call returns `aborted` without being sent, and the answers already received are kept.
 */

/** Adapter/schema versions in every engine manifest: a change invalidates cached answers. */
export const ENGINE_ADAPTER_VERSIONS = {
  typesafe: 'typesafe-systemone-v1',
  llm: LLM_ENGINE_VERSION,
  laya: 'laya-v0',
} as const;

export interface LatencySamples {
  [kind: string]: number[];
}

/** What an invocation measured (spec 10 §3 "G1 cost", §4 "Operations"). */
export interface RunStats {
  estimateUsd: number;
  estimateCalls: number;
  cacheHits: number;
  cacheMisses: number;
  cacheSavingsUsd: number;
  /** Cost of live successful calls (the router records failed attempts separately). */
  liveCostUsd: number;
  tokens: { input: number; output: number };
  latencyMs: LatencySamples;
  cacheLookupMs: number[];
  /** The logical request ids of this invocation's calls (engine and translation). */
  logicalRequestIds: string[];
  /** `estimateUsd` and `cacheSavingsUsd` split by the language of each call's article. */
  byLang: Record<string, LangCost>;
}

export interface LangCost {
  estimateUsd: number;
  cacheSavingsUsd: number;
}

export function createRunStats(): RunStats {
  return {
    estimateUsd: 0,
    estimateCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSavingsUsd: 0,
    liveCostUsd: 0,
    tokens: { input: 0, output: 0 },
    latencyMs: {},
    cacheLookupMs: [],
    logicalRequestIds: [],
    byLang: {},
  };
}

export interface AbortState {
  aborted: boolean;
  reason: string | null;
}

export interface CallEnv {
  /** Null in estimate mode. */
  router: EngineRouter | null;
  cache: EvalCache;
  /** The run id of the `eval` authorization; null in estimate mode. */
  runId: string | null;
  /** The pinned engine; null for runs without engine calls. */
  engine: RunEngine | null;
  translators: EvalTranslators;
  credentials: CredentialResolver;
  /** The tier-2 model of E4 (`OLLAMA_MODEL_FAST`). */
  ollamaModel: string;
  stats: RunStats;
  abort: AbortState;
  estimating: boolean;
  /** Monotonic milliseconds for latency. */
  clockMs: () => number;
  /** Article id → sample language, for the per-language cost split (`und` when unknown). */
  articleLang: ReadonlyMap<string, string>;
}

/** Add `usd` to a cost total and to its article language's share (totals = Σ byLang). */
function addCost(env: CallEnv, articleId: string, field: keyof LangCost, usd: number): void {
  env.stats[field] += usd;
  const lang = env.articleLang.get(articleId) ?? 'und';
  const cell = (env.stats.byLang[lang] ??= { estimateUsd: 0, cacheSavingsUsd: 0 });
  cell[field] += usd;
}

const authorization = (env: CallEnv): InferenceAuthorization => ({
  type: 'eval',
  runId: env.runId ?? '0',
});

function sample(env: CallEnv, kind: string, ms: number): void {
  (env.stats.latencyMs[kind] ??= []).push(Math.max(0, ms));
}

async function lookup<T>(
  env: CallEnv,
  manifest: CacheManifest,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const started = env.clockMs();
  const hit = await env.cache.get(manifest, schema);
  env.stats.cacheLookupMs.push(Math.max(0, env.clockMs() - started));
  if (hit === null) env.stats.cacheMisses += 1;
  else env.stats.cacheHits += 1;
  return hit;
}

function engineManifest(engine: RunEngine, extra: CacheManifest): CacheManifest {
  return {
    v: EVAL_CACHE_VERSION,
    provider: engine.provider,
    model: engine.model,
    adapter: ENGINE_ADAPTER_VERSIONS[engine.provider],
    decoding:
      engine.provider === 'llm'
        ? { maxOutputTokens: engine.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS }
        : null,
    ...extra,
  };
}

/** The admission estimate of one request (spec 04 §6.1), the bound the router reserves. */
export function requestEstimateUsd(
  engine: RunEngine,
  state: unknown,
  questions: Record<string, Question>,
): number {
  if (engine.provider === 'llm') {
    return estimateLlmCostUsd(
      estimateLlmInputTokens(state as never, questions),
      engine.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS,
      engine.model,
    );
  }
  return typesafeCostUsd(conservativeRequestTokens(state, questions), engine.pricePerMTokUsd ?? 0);
}

type Failed = { ok: false; reason: string };

function failureOf(outcome: Extract<EngineOutcome, { ok: false }>, env: CallEnv): Failed {
  if (outcome.reason === 'budget') {
    env.abort.aborted = true;
    env.abort.reason ??= 'budget';
  }
  const detail = outcome.detail === undefined ? '' : `:${outcome.detail}`;
  return { ok: false, reason: `${outcome.reason}${detail}`.slice(0, 120) };
}

// ── Call A ──────────────────────────────────────────────────────────────────────────────────────

const AnswerSchema = z.custom<Answer>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    ['noul', 'choice', 'score'].includes((value as { type?: unknown }).type as string),
);

const EnrichValueSchema = z.object({
  engine: z.string(),
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export type EnrichResult =
  | { ok: true; engine: string; model: string; answers: Record<string, Answer>; cached: boolean }
  | Failed;

export async function askEnrich(
  env: CallEnv,
  input: { articleId: string; revision: string; state: BuiltState },
): Promise<EnrichResult> {
  const engine = env.engine;
  if (engine === null) return { ok: false, reason: 'no_engine' };
  const questions: Record<string, Question> = { ...ENRICH_V1.questions };
  const manifest = engineManifest(engine, {
    op: 'ask',
    call: 'enrich',
    questionSet: { version: ENRICH_V1.version, sha: ENRICH_V1.sha256 },
    stateSha256: input.state.sha256,
    contentRevision: input.revision,
  });
  const hit = await lookup(env, manifest, EnrichValueSchema);
  if (hit !== null) {
    addCost(env, input.articleId, 'cacheSavingsUsd', hit.costUsd);
    return { ok: true, engine: hit.engine, model: hit.model, answers: hit.answers, cached: true };
  }
  if (env.estimating) {
    addCost(
      env,
      input.articleId,
      'estimateUsd',
      requestEstimateUsd(engine, input.state.state, questions),
    );
    env.stats.estimateCalls += 1;
    return { ok: false, reason: 'estimate' };
  }
  if (env.abort.aborted || env.router === null) return { ok: false, reason: 'aborted' };
  const started = env.clockMs();
  const outcome = await env.router.ask({
    kind: 'eval',
    state: input.state.state,
    questions,
    questionSetSha: ENRICH_V1.sha256,
    articleId: input.articleId,
    articleRevision: input.revision,
    stateSha256: input.state.sha256,
    priority: 'bulk',
    authorization: authorization(env),
  });
  if (!outcome.ok) return failureOf(outcome, env);
  sample(env, 'enrich', outcome.latencyMs || env.clockMs() - started);
  env.stats.liveCostUsd += outcome.costUsd;
  env.stats.tokens.input += outcome.usage.inputTokens;
  env.stats.tokens.output += outcome.usage.outputTokens;
  await env.cache.put(manifest, {
    engine: outcome.engine,
    model: outcome.model,
    answers: outcome.answers as unknown as JsonValue,
    costUsd: outcome.costUsd,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
  });
  return {
    ok: true,
    engine: outcome.engine,
    model: outcome.model,
    answers: outcome.answers,
    cached: false,
  };
}

// ── Call B ──────────────────────────────────────────────────────────────────────────────────────

const CardValueSchema = z.object({
  engine: z.string(),
  model: z.string(),
  p: z.number().min(0).max(1),
  costUsd: z.number(),
});

export type CardResult =
  { ok: true; p: number; engine: string; model: string; cached: boolean } | Failed;

export interface CardAsk {
  cardId: string;
  built: BuiltCard;
  /** The private owner (packed separately, spec 05 §5.2); null for shared cards. */
  owner: string | null;
}

/**
 * Call B for one article state: each card answer is cached under its own manifest (engine, model,
 * match set, state, `card_input_sha256`), the production cache identity of `card_answers`, so a
 * card shared by experiments or reruns is asked once. Uncached cards are packed exactly like
 * production (`packRequests`) and asked pack by pack; a pack's cost is shared equally by its cards
 * for the cache-savings figure.
 */
export async function askCards(
  env: CallEnv,
  input: { articleId: string; revision: string; state: BuiltState; cards: readonly CardAsk[] },
): Promise<Map<string, CardResult>> {
  const results = new Map<string, CardResult>();
  const engine = env.engine;
  if (engine === null) {
    for (const card of input.cards) results.set(card.cardId, { ok: false, reason: 'no_engine' });
    return results;
  }
  const manifests = new Map<string, CacheManifest>();
  const missing: CardAsk[] = [];
  for (const card of input.cards) {
    if (manifests.has(card.cardId)) continue;
    const manifest = engineManifest(engine, {
      op: 'ask',
      call: 'match.card',
      questionSet: { version: MATCH_V1.version, sha: MATCH_V1.sha256 },
      stateSha256: input.state.sha256,
      cardInputSha256: card.built.sha256,
      contentRevision: input.revision,
    });
    manifests.set(card.cardId, manifest);
    const hit = await lookup(env, manifest, CardValueSchema);
    if (hit === null) {
      missing.push(card);
      continue;
    }
    addCost(env, input.articleId, 'cacheSavingsUsd', hit.costUsd);
    results.set(card.cardId, {
      ok: true,
      p: hit.p,
      engine: hit.engine,
      model: hit.model,
      cached: true,
    });
  }
  if (missing.length === 0) return results;

  const items: PackItem[] = missing.map((card) => ({
    key: cardKey(card.cardId),
    question: card.built.question,
    owner: card.owner,
    kind: 'card',
    interactive: false,
    queuedAt: 0,
    cardId: card.cardId,
  }));
  const byKey = new Map(missing.map((card) => [cardKey(card.cardId), card]));
  let packs: ReturnType<typeof packRequests>;
  for (;;) {
    try {
      packs = packRequests(input.state.state, items);
      break;
    } catch (error) {
      if (!(error instanceof PackOverflowError)) throw error;
      // A question that cannot fit even alone is a permanent invalid request (spec 05 §5.5).
      const overflowing =
        error.key === null
          ? items.splice(0)
          : items.splice(
              items.findIndex((item) => item.key === error.key),
              1,
            );
      for (const item of overflowing) {
        if (item.cardId !== undefined) {
          results.set(item.cardId, { ok: false, reason: 'invalid_request:pack_overflow' });
        }
      }
      if (items.length === 0) return results;
    }
  }

  for (const pack of packs) {
    const cards = pack.keys.flatMap((key) => {
      const card = byKey.get(key);
      return card === undefined ? [] : [card];
    });
    if (env.estimating) {
      addCost(
        env,
        input.articleId,
        'estimateUsd',
        requestEstimateUsd(engine, input.state.state, pack.questions),
      );
      env.stats.estimateCalls += 1;
      for (const card of cards) results.set(card.cardId, { ok: false, reason: 'estimate' });
      continue;
    }
    if (env.abort.aborted || env.router === null) {
      for (const card of cards) results.set(card.cardId, { ok: false, reason: 'aborted' });
      continue;
    }
    const started = env.clockMs();
    const outcome = await env.router.ask({
      kind: 'eval',
      state: input.state.state,
      questions: pack.questions,
      questionSetSha: MATCH_V1.sha256,
      articleId: input.articleId,
      articleRevision: input.revision,
      stateSha256: input.state.sha256,
      cardIds: cards.map((card) => card.cardId),
      priority: 'bulk',
      authorization: authorization(env),
    });
    if (!outcome.ok) {
      const failure = failureOf(outcome, env);
      for (const card of cards) results.set(card.cardId, failure);
      continue;
    }
    sample(env, 'match', outcome.latencyMs || env.clockMs() - started);
    env.stats.liveCostUsd += outcome.costUsd;
    env.stats.tokens.input += outcome.usage.inputTokens;
    env.stats.tokens.output += outcome.usage.outputTokens;
    const share = cards.length === 0 ? 0 : outcome.costUsd / cards.length;
    for (const card of cards) {
      const answer = outcome.answers[cardKey(card.cardId)];
      if (answer?.type !== 'noul') {
        results.set(card.cardId, { ok: false, reason: 'error:unanswered' });
        continue;
      }
      const manifest = manifests.get(card.cardId);
      if (manifest !== undefined) {
        await env.cache.put(manifest, {
          engine: outcome.engine,
          model: outcome.model,
          p: answer.p,
          costUsd: share,
        });
      }
      results.set(card.cardId, {
        ok: true,
        p: answer.p,
        engine: outcome.engine,
        model: outcome.model,
        cached: false,
      });
    }
  }
  return results;
}

// ── Translations ────────────────────────────────────────────────────────────────────────────────

const TextsSchema = z.object({
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
  body_lead: z.string().nullable(),
});

const TranslationValueSchema = z.object({
  engine: z.enum(['libretranslate', 'ollama']),
  model: z.string().nullable(),
  texts: TextsSchema,
  costUsd: z.number(),
});

export type TranslationResult =
  /** `translation` null: nothing to translate (English, undetermined, no text). */
  { ok: true; translation: FrozenTranslation | null; cached: boolean } | Failed;

/** The quality of a translation of `source` (spec 07 §4); a skipped assessment is `fail`. */
export function gradeTranslation(
  source: TranslationTexts,
  texts: TranslationTexts,
  lang: string,
): TranslationQuality {
  const assessment = assessTranslation(source, texts, lang);
  return assessment.skipped ? 'fail' : assessment.quality;
}

async function recordAttempts(
  env: CallEnv,
  attempts: readonly TranslationAttempt[],
  context: { articleId?: string; articleRevision?: string },
): Promise<void> {
  if (env.router === null || attempts.length === 0) return;
  const logicalRequestId = newLogicalRequestId();
  env.stats.logicalRequestIds.push(logicalRequestId);
  for (const attempt of attempts) {
    await env.router.recordExternalCall(
      toExternalCall(attempt, {
        logicalRequestId,
        ...(context.articleId === undefined ? {} : { articleId: context.articleId }),
        ...(context.articleRevision === undefined
          ? {}
          : { articleRevision: context.articleRevision }),
      }),
    );
    sample(env, 'translate', attempt.latencyMs);
  }
}

const supportedByEnv = new WeakMap<CallEnv, Promise<ReadonlySet<string> | undefined>>();

/** The installed `→ en` source languages of LibreTranslate (one `/languages` per invocation). */
async function supportedSources(env: CallEnv): Promise<ReadonlySet<string> | undefined> {
  let cached = supportedByEnv.get(env);
  if (cached === undefined) {
    cached = (async () => {
      const result = await env.translators.libretranslate().languages();
      await recordAttempts(env, [result.attempt], {});
      return result.ok ? supportedSourceLanguages(result.languages) : undefined;
    })();
    supportedByEnv.set(env, cached);
  }
  return cached;
}

/**
 * Tier 1 (LibreTranslate) or tier 2 (Ollama, E4) translation of a frozen article (spec 07 §3),
 * with the production source fields and grading. English and undetermined articles are never
 * translated. A translated (or passthrough) result is cached; a failure is recorded, not cached.
 */
export async function translateArticle(
  env: CallEnv,
  input: { snapshot: EvalSnapshot; provider: 'libretranslate' | 'ollama' },
): Promise<TranslationResult> {
  const { snapshot } = input;
  const lang = snapshot.lang;
  if (lang === 'en' || lang === 'und' || !/^[a-z]{2}$/.test(lang)) {
    return { ok: true, translation: null, cached: false };
  }
  const source = articleTranslationSource({
    title: snapshot.input.title,
    excerpt: snapshot.input.excerpt,
    body_lead: snapshot.input.bodyLead,
  });
  if (source.title === null && source.excerpt === null && source.body_lead === null) {
    return { ok: true, translation: null, cached: false };
  }
  const model = input.provider === 'ollama' ? env.ollamaModel : null;
  const manifest: CacheManifest = {
    v: EVAL_CACHE_VERSION,
    op: 'translate.article',
    provider: input.provider,
    model,
    policy: TRANSLATION_POLICY_VERSION,
    decoding:
      input.provider === 'ollama'
        ? {
            systemPrompt: tier2SystemPrompt(lang),
            temperature: TIER2_OPTIONS.temperature,
            numPredict: TIER2_OPTIONS.num_predict,
          }
        : null,
    sourceLang: lang,
    target: 'en',
    sourceSha256: translationSourceSha256(lang, source),
  };
  const hit = await lookup(env, manifest, TranslationValueSchema);
  if (hit !== null) {
    addCost(env, snapshot.articleId, 'cacheSavingsUsd', hit.costUsd);
    return {
      ok: true,
      translation: {
        engine: hit.engine,
        model: hit.model,
        texts: hit.texts,
        quality: gradeTranslation(source, hit.texts, lang),
      },
      cached: true,
    };
  }
  if (input.provider === 'ollama') return translateTier2(env, snapshot, source, manifest);
  if (env.estimating) return { ok: false, reason: 'estimate' };
  if (env.abort.aborted) return { ok: false, reason: 'aborted' };
  const sources = await supportedSources(env);
  const result = await env.translators.libretranslate().translateArticle({
    source,
    lang,
    ...(sources === undefined ? {} : { supportedSources: sources }),
  });
  await recordAttempts(env, result.attempts, {
    articleId: snapshot.articleId,
    articleRevision: snapshot.contentRevision,
  });
  if (result.status === 'not_requested') return { ok: true, translation: null, cached: false };
  if (result.status === 'failed') return { ok: false, reason: `libretranslate:${result.reason}` };
  await env.cache.put(manifest, {
    engine: 'libretranslate',
    model: null,
    texts: result.texts,
    costUsd: 0,
  });
  return {
    ok: true,
    translation: {
      engine: 'libretranslate',
      model: null,
      texts: result.texts,
      quality: gradeTranslation(source, result.texts, lang),
    },
    cached: false,
  };
}

type Tier2Send =
  { kind: 'denied' } | { kind: 'sent'; reservationId: string; result: Tier2AttemptResult };

/** Tier 2 as the worker runs it (reserve inside the credential callback, one repair attempt). */
async function translateTier2(
  env: CallEnv,
  snapshot: EvalSnapshot,
  source: TranslationTexts,
  manifest: CacheManifest,
): Promise<TranslationResult> {
  const translator = env.translators.ollama();
  const input = { model: env.ollamaModel, sourceLang: snapshot.lang, source };
  const estimate = translator.estimate(input);
  if (env.estimating) {
    addCost(env, snapshot.articleId, 'estimateUsd', estimate.estimateUsd);
    env.stats.estimateCalls += 1;
    return { ok: false, reason: 'estimate' };
  }
  const router = env.router;
  if (env.abort.aborted || router === null) return { ok: false, reason: 'aborted' };
  const logicalRequestId = newLogicalRequestId();
  env.stats.logicalRequestIds.push(logicalRequestId);
  let last: Tier2AttemptResult | undefined;
  for (let attempt = 1; attempt <= TIER2_MAX_ATTEMPTS; attempt += 1) {
    let sent: Tier2Send;
    try {
      sent = await env.credentials.useActive(
        'ollama',
        AbortSignal.timeout(120_000),
        async (auth): Promise<Tier2Send> => {
          const reservationId = await router.reserveExternalCall({
            engine: 'llm',
            kind: 'translate',
            estimateUsd: estimate.estimateUsd,
            priority: 'bulk',
            authorization: authorization(env),
          });
          if (reservationId === null) return { kind: 'denied' };
          const result = await translator.translateOnce({
            ...input,
            auth: {
              apiKey: auth.apiKey,
              ...(auth.credentialVersion === undefined
                ? {}
                : { credentialVersion: auth.credentialVersion }),
            },
            attempt,
          });
          return { kind: 'sent', reservationId, result };
        },
      );
    } catch (error) {
      if (isAppError(error) && error.code === 'ENGINE_UNAVAILABLE') {
        return last === undefined ? { ok: false, reason: 'no_key' } : failedTier2(last);
      }
      throw error;
    }
    if (sent.kind === 'denied') {
      // An eval router refuses only for its invocation cap: the invocation stops here.
      env.abort.aborted = true;
      env.abort.reason ??= 'budget';
      return last === undefined ? { ok: false, reason: 'budget' } : failedTier2(last);
    }
    const { result } = sent;
    const { overrun } = await router.recordExternalCall(
      toExternalCall(result.attempt, {
        logicalRequestId,
        articleId: snapshot.articleId,
        articleRevision: snapshot.contentRevision,
      }),
      sent.reservationId,
    );
    sample(env, 'translate', result.attempt.latencyMs);
    last = result;
    if (result.ok) {
      env.stats.liveCostUsd += result.attempt.costUsd;
      env.stats.tokens.input += result.attempt.inputTokens;
      env.stats.tokens.output += result.attempt.outputTokens;
      await env.cache.put(manifest, {
        engine: 'ollama',
        model: result.model,
        texts: result.texts,
        costUsd: result.attempt.costUsd,
      });
      return {
        ok: true,
        translation: {
          engine: 'ollama',
          model: result.model,
          texts: result.texts,
          quality: gradeTranslation(source, result.texts, snapshot.lang),
        },
        cached: false,
      };
    }
    if (overrun || result.reason !== 'invalid_response') break;
  }
  return last === undefined ? { ok: false, reason: 'error' } : failedTier2(last);
}

function failedTier2(last: Tier2AttemptResult): Failed {
  return { ok: false, reason: last.ok ? 'error' : `ollama:${last.reason}` };
}

const CardTextValueSchema = z.object({
  lang: z.string(),
  status: z.string(),
  interestEn: z.string().nullable(),
  notForEn: z.string().nullable(),
});

/**
 * Card text in `english` mode (spec 07 §5, spec 10 §3 "cards translated to English by
 * LibreTranslate"): the production `translateCardText` (hinted detection, tier 1 only, the pair
 * published only as a whole and only when its assessment is `ok`). Every outcome but a failed
 * call is cached; the card keeps its original text whenever no `ok` pair exists.
 */
export async function translateCard(
  env: CallEnv,
  card: RunCard,
  locale: string | null = null,
): Promise<RunCard> {
  const sources = await supportedSources(env);
  const manifest: CacheManifest = {
    v: EVAL_CACHE_VERSION,
    op: 'translate.card',
    provider: 'libretranslate',
    policy: TRANSLATION_POLICY_VERSION,
    interest: card.interest,
    notFor: card.notFor,
    locale,
    supportedSources: sources === undefined ? null : [...sources].sort(),
  };
  const apply = (value: z.infer<typeof CardTextValueSchema>): RunCard => ({
    ...card,
    interestEn: value.interestEn,
    notForEn: value.notForEn,
    lang: value.lang,
    textStatus: value.status,
  });
  const hit = await lookup(env, manifest, CardTextValueSchema);
  if (hit !== null) return apply(hit);
  if (sources === undefined)
    return { ...card, interestEn: null, notForEn: null, textStatus: 'failed' };
  const result = await translateCardText(env.translators.libretranslate(), {
    interest: card.interest,
    notFor: card.notFor,
    locale,
    supportedSources: sources,
  });
  await recordAttempts(env, result.attempts, {});
  const value = {
    lang: result.lang,
    status: result.status,
    interestEn: result.interestEn,
    notForEn: result.notForEn,
  };
  if (result.status !== 'failed') await env.cache.put(manifest, value);
  return apply(value);
}

/** A JSON-safe copy of an answer (normalized numbers are finite already). */
export function jsonAnswer(answer: Answer): JsonValue {
  return JsonValueSchema.parse(answer);
}
