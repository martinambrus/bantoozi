import type { CallStatus, ExternalCall } from '@bantoozi/shared';

/**
 * Shared types of `@bantoozi/translate` (spec 07). The package only makes HTTP calls and pure
 * assessments; the `article.translate` handler reserves budget, records every attempt through
 * `EngineRouter.recordExternalCall` and stores `article_translations` rows.
 */

/** The translated article fields, in their fixed order (spec 07 §3: title, excerpt, body lead). */
export const TRANSLATION_FIELDS = ['title', 'excerpt', 'body_lead'] as const;
export type TranslationField = (typeof TRANSLATION_FIELDS)[number];

/**
 * An article's translatable text, as source or as translation. The keys are the
 * `article_translations` columns and the tier-2 JSON keys; `null` is an absent field.
 */
export type TranslationTexts = Record<TranslationField, string | null>;

/**
 * One text to translate, tagged with the field it belongs to. Requests keep this explicit ordered
 * mapping, so filtering out an absent field never shifts an excerpt into the title (spec 07 §3).
 */
export interface SourceField<F extends string = TranslationField> {
  field: F;
  text: string;
}

/** `article_translations.quality` (spec 02, spec 07 §4). */
export type TranslationQuality = 'ok' | 'weak' | 'fail';

/** `article_translations.engine`: tier 1 or tier 2 (spec 07 §2). */
export type TranslationEngine = 'libretranslate' | 'ollama';

/**
 * Metadata of ONE HTTP attempt, for the caller's `recordExternalCall` (spec 04 §1, spec 07 §2). It
 * never contains article text, provider response bodies or API keys: `error` is a short code from
 * a fixed vocabulary (e.g. `http_503`, `network:ECONNRESET`, `invalid_response:extra_keys`).
 */
export interface TranslationAttempt {
  /** The `engine_calls` engine: tier 1 is `libretranslate`, tier 2 is `llm` (spec 07 §2). */
  engine: 'libretranslate' | 'llm';
  /** The requested tier-2 model; absent for tier 1. */
  model?: string;
  /** 1-based attempt ordinal. */
  attempt: number;
  status: CallStatus;
  /** The HTTP status, when a response arrived. */
  httpStatus?: number;
  /** A log-safe failure code; absent on success. */
  error?: string;
  /** When the request was sent (the `engine_calls.created_at` send timestamp, spec 04 §6). */
  startedAt: Date;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Tier 1 costs nothing; tier 2 is priced from token usage (spec 04 §8). */
  costUsd: number;
  /**
   * `uncertain` when the provider may have billed usage that is not known (a timeout or broken
   * connection after sending, an unreadable response): the caller keeps the reservation charged.
   */
  billing: 'known' | 'uncertain';
  /** Credential metadata only (never the key); from the per-attempt auth of tier 2. */
  credentialVersion?: string;
}

/** Identifiers the caller adds when it records an attempt. */
export interface ExternalCallContext {
  logicalRequestId: string;
  articleId?: string;
  articleRevision?: string;
  stateSha256?: string;
}

/**
 * The `ExternalCall` for one attempt (spec 04 §1): `kind = 'translate'`, engine and cost as spec
 * 07 §2 prescribes (tier 1 `libretranslate` at cost 0, tier 2 `llm` priced from token usage).
 */
export function toExternalCall(
  attempt: TranslationAttempt,
  context: ExternalCallContext,
): ExternalCall {
  return {
    engine: attempt.engine,
    kind: 'translate',
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
    ...(context.articleId === undefined ? {} : { articleId: context.articleId }),
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costUsd: attempt.costUsd,
    latencyMs: attempt.latencyMs,
    status: attempt.status,
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    billing: attempt.billing,
    logicalRequestId: context.logicalRequestId,
    attempt: attempt.attempt,
    ...(context.articleRevision === undefined ? {} : { articleRevision: context.articleRevision }),
    ...(context.stateSha256 === undefined ? {} : { stateSha256: context.stateSha256 }),
    ...(attempt.credentialVersion === undefined
      ? {}
      : { credentialVersion: attempt.credentialVersion }),
  };
}
