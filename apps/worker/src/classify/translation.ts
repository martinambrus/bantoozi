import { randomUUID } from 'node:crypto';

import { isInferenceAuthorized, type Executor, type TranslationInput } from '@bantoozi/db';
import type { EngineRouter } from '@bantoozi/engine';
import type { InferenceAuthorization } from '@bantoozi/shared';
import type { CredentialResolver } from '@bantoozi/shared/server';
import {
  TIER2_MAX_ATTEMPTS,
  assessTranslation,
  skippedTier2QualityDetail,
  toExternalCall,
  translationQualityDetail,
  type LibreTranslateClient,
  type OllamaTranslator,
  type Tier2AttemptResult,
  type TranslationQuality,
  type TranslationTexts,
} from '@bantoozi/translate';

/**
 * What the translation stages need (spec 07 §2–3): the tier-1 client, the tier-2 translator, the
 * credential resolver that unwraps the active Ollama key for one attempt, and the configured
 * models. `packages/translate` only makes HTTP calls; every attempt is recorded through the router
 * and every tier-2 attempt reserves spend and a daily-cap slot first.
 */
export interface TranslationDeps {
  libretranslate: LibreTranslateClient;
  ollama: OllamaTranslator;
  credentials: CredentialResolver;
  /** OLLAMA_MODEL_FAST, the default tier-2 model. */
  modelFast: string;
  /** OLLAMA_MODEL_STRONG, only for feeds flagged `translate_strong`. */
  modelStrong: string;
  /**
   * Source languages with an installed `→ en` model (a cached `/languages`); `undefined` while
   * unknown, in which case LibreTranslate itself rejects an unsupported pair (terminal for the
   * revision).
   */
  supportedSources?: () => Promise<ReadonlySet<string> | undefined>;
}

/** One translation of exact source fields, recorded under one authorization. */
export interface TranslationJob {
  articleId: string;
  /** The revision the source fields belong to (live, or a request's frozen revision). */
  articleRevision: string;
  sourceLang: string;
  source: TranslationTexts;
  /** `translationSourceSha256(sourceLang, source)`. */
  sourceSha256: string;
  authorization: InferenceAuthorization;
  /** Cost attribution of a selected request. */
  userId?: string;
}

export type TierOutcome =
  /** A row to store: a translation graded by spec 07 §4, a terminal failure or a skipped tier 2. */
  | { kind: 'row'; row: TranslationInput }
  /** Tier 1 had nothing to send (`und`, no text): the state stays native. */
  | { kind: 'none' }
  /**
   * No row: a failure a later attempt may not repeat (network, timeout, 5xx, 429, cancellation, and
   * a tier-1 auth failure), with the server's retry time when it gave one.
   */
  | { kind: 'transient'; reason: string; retryAt?: Date }
  /** The authorization no longer holds: no row, no further attempt. */
  | { kind: 'no_demand' };

function baseRow(job: TranslationJob) {
  return {
    articleId: job.articleId,
    articleRevision: job.articleRevision,
    sourceSha256: job.sourceSha256,
    sourceLang: job.sourceLang,
  };
}

function gradedRow(
  job: TranslationJob,
  engine: 'libretranslate' | 'ollama',
  model: string | null,
  texts: TranslationTexts,
  credentialVersion: string | undefined,
): TranslationInput {
  const assessment = assessTranslation(job.source, texts, job.sourceLang);
  const quality: TranslationQuality = assessment.skipped ? 'fail' : assessment.quality;
  return {
    ...baseRow(job),
    engine,
    model,
    title: texts.title,
    excerpt: texts.excerpt,
    bodyLead: texts.body_lead,
    quality,
    qualityDetail: {
      ...translationQualityDetail({
        assessment,
        ...(credentialVersion === undefined ? {} : { credentialVersion }),
      }),
    },
  };
}

function failedRow(
  job: TranslationJob,
  engine: 'libretranslate' | 'ollama',
  model: string | null,
  detail: Record<string, unknown>,
): TranslationInput {
  return {
    ...baseRow(job),
    engine,
    model,
    title: null,
    excerpt: null,
    bodyLead: null,
    quality: 'fail',
    qualityDetail: detail,
  };
}

const CREDENTIAL_VERSION = /^[1-9]\d{0,18}$/;
const versionOf = (value: string | undefined): string | undefined =>
  value !== undefined && CREDENTIAL_VERSION.test(value) ? value : undefined;

/**
 * Tier 1 (spec 07 §3 step 2): the free CPU translation, after rechecking the authorization. Every
 * HTTP attempt is recorded as a zero-cost `libretranslate` call. A translation is graded; a
 * terminal failure (unsupported language, invalid request or response) becomes a `fail` row, so
 * the revision is never retried; other failures are transient.
 */
export async function runTier1(
  db: Executor,
  router: EngineRouter,
  translation: TranslationDeps,
  job: TranslationJob,
): Promise<TierOutcome> {
  if (!(await isInferenceAuthorized(db, job.authorization))) return { kind: 'no_demand' };
  const supported = await translation.supportedSources?.();
  const result = await translation.libretranslate.translateArticle({
    source: job.source,
    lang: job.sourceLang,
    ...(supported === undefined ? {} : { supportedSources: supported }),
  });
  const logicalRequestId = randomUUID();
  for (const attempt of result.attempts) {
    await router.recordExternalCall(
      toExternalCall(attempt, {
        logicalRequestId,
        articleId: job.articleId,
        articleRevision: job.articleRevision,
      }),
    );
  }
  switch (result.status) {
    case 'translated':
    case 'passthrough':
      return { kind: 'row', row: gradedRow(job, 'libretranslate', null, result.texts, undefined) };
    case 'not_requested':
      return { kind: 'none' };
    case 'failed':
      return result.terminal
        ? {
            kind: 'row',
            row: failedRow(job, 'libretranslate', null, {
              ...translationQualityDetail({ failure: result.reason }),
            }),
          }
        : {
            kind: 'transient',
            reason: result.reason,
            ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
          };
  }
}

/**
 * Tier 2 (spec 07 §3 step 3), once per content revision: without an enabled active Ollama key, or
 * when the reservation is refused for the daily cap or the budget, a skipped `fail` row records
 * the attempt; otherwise one attempt, plus one repair attempt after invalid output, each under its
 * own reservation and recorded with its actual usage. A translation is graded; invalid output after
 * the repair and a terminal provider failure (auth, request, model) become a `fail` row. A
 * transport failure (429, 5xx, timeout, network) or a cancellation stores no row: it is transient,
 * with the server's retry time when known, and the job's own retry runs tier 2 again (D-74), never
 * a second in-process attempt as well. `no_demand` when the authorization lapsed.
 */
export async function runTier2(
  db: Executor,
  router: EngineRouter,
  translation: TranslationDeps,
  job: TranslationJob,
  model: string,
): Promise<TierOutcome> {
  const credential = await translation.credentials.metadata('ollama');
  const skipped = (reason: 'no_key' | 'cap' | 'budget'): TierOutcome => {
    const version = versionOf(credential.activeVersion);
    return {
      kind: 'row',
      row: failedRow(job, 'ollama', model, { ...skippedTier2QualityDetail(reason, version) }),
    };
  };
  if (credential.source === 'none' || !credential.enabled) return skipped('no_key');

  const input = { model, sourceLang: job.sourceLang, source: job.source };
  const estimate = translation.ollama.estimate(input);
  const logicalRequestId = randomUUID();
  let last: Tier2AttemptResult | undefined;
  for (let attempt = 1; attempt <= TIER2_MAX_ATTEMPTS; attempt += 1) {
    const reservationId = await router.reserveExternalCall({
      engine: 'llm',
      kind: 'translate',
      estimateUsd: estimate.estimateUsd,
      priority: 'bulk',
      ...(job.userId === undefined ? {} : { userId: job.userId }),
      authorization: job.authorization,
    });
    if (reservationId === null) {
      // The repair attempt was not admitted: the first attempt's failure stands.
      if (last !== undefined) break;
      if (!(await isInferenceAuthorized(db, job.authorization))) return { kind: 'no_demand' };
      return skipped((await router.canSpend(estimate.estimateUsd, 'bulk')) ? 'cap' : 'budget');
    }
    let result: Tier2AttemptResult;
    try {
      result = await translation.credentials.useActive(
        'ollama',
        AbortSignal.timeout(120_000),
        (auth) =>
          translation.ollama.translateOnce({
            ...input,
            auth: {
              apiKey: auth.apiKey,
              ...(auth.credentialVersion === undefined
                ? {}
                : { credentialVersion: auth.credentialVersion }),
            },
            attempt,
          }),
      );
    } catch (error) {
      // No usable key after all (revoked meanwhile), or an unexpected failure around the send: the
      // reservation stays charged conservatively and the job may run again.
      await router.recordExternalCall(
        {
          engine: 'llm',
          kind: 'translate',
          model,
          articleId: job.articleId,
          articleRevision: job.articleRevision,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          status: 'error',
          error: 'credential_or_send_failure',
          billing: 'uncertain',
          logicalRequestId,
          attempt,
        },
        reservationId,
      );
      throw error;
    }
    await router.recordExternalCall(
      toExternalCall(result.attempt, {
        logicalRequestId,
        articleId: job.articleId,
        articleRevision: job.articleRevision,
      }),
      reservationId,
    );
    last = result;
    // Only invalid output earns the repair attempt.
    if (result.ok || result.reason !== 'invalid_response') break;
  }
  if (last === undefined) return skipped('budget');
  if (last.ok) {
    return {
      kind: 'row',
      row: gradedRow(
        job,
        'ollama',
        last.model,
        last.texts,
        versionOf(last.attempt.credentialVersion),
      ),
    };
  }
  if (last.reason === 'cancelled' || (last.retryable && last.reason !== 'invalid_response')) {
    const { startedAt, latencyMs } = last.attempt;
    return {
      kind: 'transient',
      reason: last.reason,
      ...(last.retryAfterMs === undefined
        ? {}
        : { retryAt: new Date(startedAt.getTime() + latencyMs + last.retryAfterMs) }),
    };
  }
  const version = versionOf(last.attempt.credentialVersion);
  return {
    kind: 'row',
    row: failedRow(job, 'ollama', model, {
      ...translationQualityDetail({
        failure: last.reason,
        ...(version === undefined ? {} : { credentialVersion: version }),
      }),
    }),
  };
}

/** The texts of a stored row, in the translate package's field names. */
export function rowTexts(row: {
  title: string | null;
  excerpt: string | null;
  bodyLead: string | null;
}): TranslationTexts {
  return { title: row.title, excerpt: row.excerpt, body_lead: row.bodyLead };
}
