import {
  REQUEST_OVERHEAD_TOKENS,
  conservativeTokens,
  systemClock,
  type CallStatus,
  type Clock,
} from '@bantoozi/shared';
import { languageName } from '@bantoozi/shared/server';
import type { Dispatcher } from 'undici';

import { isCount, isPlainObject, ownValue } from './guards.js';
import {
  attemptSignal,
  checkDuration,
  checkPositiveInteger,
  classifyThrown,
  codePoints,
  createAgent,
  discardBody,
  firstHeader,
  isStorableText,
  parseBaseUrl,
  parseJsonBytes,
  readBoundedBody,
  retryAfterMs,
  send,
} from './http.js';
import { ARTICLE_SOURCE_LIMITS, isBlankText } from './source.js';
import {
  TRANSLATION_FIELDS,
  type TranslationAttempt,
  type TranslationField,
  type TranslationTexts,
} from './types.js';

/**
 * Tier 2: Ollama Cloud GLM (spec 07 §3 step 3), `POST {OLLAMA_BASE_URL}/api/chat` with the
 * configured fast or strong model, `stream: false`, `options: {temperature: 0, num_predict: 2048}`
 * and the spec's system prompt; the user message is the JSON of `{title, excerpt, body_lead}`.
 * No `format` field: Cloud structured output is not assumed (spec 04 §8), so `message.content` is
 * validated locally and must be JSON with exactly the three string keys, each bounded. Field values
 * are untrusted text, never instructions: no tools are offered and tool calls are rejected.
 *
 * ONE HTTP attempt per call. The caller owns the loop: it reserves spend before each attempt
 * (`router.reserveExternalCall`) and may make one repair attempt under a new reservation
 * (`attempt: 2`), never more (spec 07 §3). The API key arrives with each attempt (`auth`, resolved
 * through the credential resolver, spec 04 §1.2), is sent only in the Authorization header of this
 * one request and appears in no result, error or log.
 */

/** Spec 07 §3; `<Language>` is replaced with the source language's English name. */
export const TIER2_SYSTEM_PROMPT_TEMPLATE =
  "You are a professional translator. Translate every field of the user's JSON from <Language> to English. Keep names, numbers, product names and quotes' meaning. Do not add or remove information. Output only JSON with the same keys.";

/** Request options (spec 07 §3): deterministic, output bounded to 2,048 tokens. */
export const TIER2_OPTIONS = Object.freeze({ temperature: 0, num_predict: 2048 });

/** Spec 04 §8 limits: 60 s per attempt; `OLLAMA_MAX_CONCURRENCY` (default 1) connections. */
export const TIER2_DEFAULTS = Object.freeze({
  timeoutMs: 60_000,
  maxConnections: 1,
  maxResponseBytes: 256 * 1024,
});

/** The first attempt plus one bounded repair attempt (spec 07 §3). */
export const TIER2_MAX_ATTEMPTS = 2;
/** A translated field longer than this is an invalid response. */
export const TIER2_MAX_OUTPUT_CHARS = 8_000;

/** Version of {@link OLLAMA_PRICES}: the Ollama pricing page as checked on this date (spec 04 §8). */
export const OLLAMA_PRICE_TABLE_VERSION = '2026-09-25';

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** USD per million tokens (spec 04 §8): peak uncached rates, used for admission and settlement. */
export const OLLAMA_PRICES: PriceTable = Object.freeze({
  'glm-5.3-flash': Object.freeze({ inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.5 }),
  'glm-5.3': Object.freeze({ inputPerMTokUsd: 1.4, outputPerMTokUsd: 4.4 }),
  // Reachable on the Free plan (D-143).
  'gemma4:31b': Object.freeze({ inputPerMTokUsd: 0.14, outputPerMTokUsd: 0.4 }),
});

/** The model id format of `OLLAMA_MODEL_FAST`/`OLLAMA_MODEL_STRONG` (spec 01 §3). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
/** Visible ASCII with inner spaces; at most 4 KiB (spec 04 §1.2). */
const HEADER_SAFE_KEY = /^[\x21-\x7e](?:[\x20-\x7e]{0,4094}[\x21-\x7e])?$/;
/** A DB credential version: a decimal bigint id (metadata only). */
const CREDENTIAL_VERSION = /^[1-9]\d{0,18}$/;
/** One wrapping Markdown code fence (```json … ```), tolerated around the JSON. */
const CODE_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

const noop = (): void => undefined;

/** The exact `/api/chat` body (spec 07 §3). */
export interface Tier2ChatRequest {
  model: string;
  stream: false;
  options: { temperature: number; num_predict: number };
  messages: [{ role: 'system'; content: string }, { role: 'user'; content: string }];
}

/** Per-attempt credential: the key goes into one Authorization header only. */
export interface TranslatorAuth {
  apiKey: string;
  /** DB credential version for accounting (never the key); absent for an env key. */
  credentialVersion?: string | undefined;
}

export type Tier2FailureReason =
  | 'auth_error'
  | 'invalid_request'
  | 'model_unavailable'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'cancelled';

export type Tier2AttemptResult =
  | {
      ok: true;
      /** The translation; absent source fields stay `null` whatever the model returned. */
      texts: TranslationTexts;
      /** The requested (configured) model: the row's provenance. */
      model: string;
      /** The model the response names, when valid. */
      reportedModel?: string;
      attempt: TranslationAttempt;
    }
  | {
      ok: false;
      reason: Tier2FailureReason;
      /**
       * Worth another attempt under a new reservation: invalid output (the caller's one "repair"
       * attempt) and transient transport failures (left to the caller's job retry, spec 07 §3).
       * Auth, request, model and cancellation failures are not.
       */
      retryable: boolean;
      /** A 429/503 server delay. */
      retryAfterMs?: number;
      attempt: TranslationAttempt;
    };

export interface Tier2Estimate {
  inputTokens: number;
  /** The enforced output maximum (`num_predict`). */
  outputTokens: number;
  /** Admission estimate: input estimate plus `num_predict` at the output price (spec 04 §6.1). */
  estimateUsd: number;
}

export interface Tier2Input {
  /** The configured `OLLAMA_MODEL_FAST` or `OLLAMA_MODEL_STRONG`; never hard-coded. */
  model: string;
  /** ISO 639-1 source language; `en` and `und` are never sent to tier 2. */
  sourceLang: string;
  source: TranslationTexts;
}

export interface OllamaTranslatorOptions {
  /** `OLLAMA_BASE_URL`. */
  baseUrl: string;
  timeoutMs?: number;
  maxConnections?: number;
  maxResponseBytes?: number;
  /** Default {@link OLLAMA_PRICES}. */
  prices?: PriceTable;
  /** Injected undici dispatcher (tests: `MockAgent`); default: the translator's own pool. */
  dispatcher?: Dispatcher;
  clock?: Clock;
}

export interface OllamaTranslator {
  /** Exactly one HTTP attempt. */
  translateOnce(
    input: Tier2Input & { auth: TranslatorAuth; attempt?: number; signal?: AbortSignal },
  ): Promise<Tier2AttemptResult>;
  /** The admission estimate to reserve before an attempt. */
  estimate(input: Tier2Input): Tier2Estimate;
  close(): Promise<void>;
}

/** The system prompt for `sourceLang` (a programming error for `en`, `und` or an invalid code). */
export function tier2SystemPrompt(sourceLang: string): string {
  const name = sourceLang === 'en' || sourceLang === 'und' ? undefined : languageName(sourceLang);
  if (name === undefined || !/^[a-z]{2}$/.test(sourceLang)) {
    throw new TypeError('tier 2: sourceLang must be a non-English ISO 639-1 code');
  }
  return TIER2_SYSTEM_PROMPT_TEMPLATE.replace('<Language>', name);
}

function checkSource(source: TranslationTexts): void {
  let nonblank = 0;
  for (const field of TRANSLATION_FIELDS) {
    const value: unknown = source[field];
    if (value === null) continue;
    if (typeof value !== 'string') throw new TypeError(`tier 2: source ${field} is not a string`);
    if (codePoints(value) > ARTICLE_SOURCE_LIMITS[field]) {
      throw new RangeError(
        `tier 2: source ${field} exceeds ${ARTICLE_SOURCE_LIMITS[field]} characters`,
      );
    }
    if (!isBlankText(value)) nonblank += 1;
  }
  if (nonblank === 0) throw new TypeError('tier 2: the source has no text to translate');
}

/**
 * The exact request body of spec 07 §3: the model, `stream: false`, the options and two messages;
 * the user message is the JSON of all three fields, absent ones as empty strings. No `format`, no
 * tools.
 */
export function buildTier2Request(input: Tier2Input): Tier2ChatRequest {
  if (typeof input.model !== 'string' || !MODEL_ID.test(input.model)) {
    throw new TypeError('tier 2: invalid model id');
  }
  const system = tier2SystemPrompt(input.sourceLang);
  checkSource(input.source);
  const text = (field: TranslationField): string => input.source[field] ?? '';
  return {
    model: input.model,
    stream: false,
    options: { temperature: TIER2_OPTIONS.temperature, num_predict: TIER2_OPTIONS.num_predict },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          title: text('title'),
          excerpt: text('excerpt'),
          body_lead: text('body_lead'),
        }),
      },
    ],
  };
}

function priceOf(model: string, prices: PriceTable): ModelPrice {
  const price = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (price === undefined) throw new TypeError(`tier 2: no price for model ${model}`);
  return price;
}

/** USD for token usage at `price`. */
export function tier2CostUsd(
  price: ModelPrice,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const usd =
    (usage.inputTokens * price.inputPerMTokUsd + usage.outputTokens * price.outputPerMTokUsd) / 1e6;
  return Math.round(usd * 1e12) / 1e12;
}

/**
 * The admission estimate for one attempt (spec 04 §6.1, spec 07 §2): the conservative token bound
 * of the exact messages plus the request overhead, and `num_predict` output tokens, both at the
 * model's price. An unpriced model is a configuration error and throws.
 */
export function estimateTier2Cost(
  input: Tier2Input,
  prices: PriceTable = OLLAMA_PRICES,
): Tier2Estimate {
  const request = buildTier2Request(input);
  const price = priceOf(input.model, prices);
  const inputTokens = conservativeTokens(request.messages) + REQUEST_OVERHEAD_TOKENS;
  const outputTokens = TIER2_OPTIONS.num_predict;
  return {
    inputTokens,
    outputTokens,
    estimateUsd: tier2CostUsd(price, { inputTokens, outputTokens }),
  };
}

/**
 * Validates `message.content`: JSON (optionally inside one Markdown code fence) that is an object
 * with exactly the keys `title`, `excerpt`, `body_lead`, each a bounded storable string. Anything
 * else is a problem code and never becomes article text (spec 07 §6). A source field that is absent
 * stays `null` in the result, whatever the model wrote for it.
 */
export function parseTier2Content(
  content: string,
  source: TranslationTexts,
): { ok: true; texts: TranslationTexts } | { ok: false; problem: string } {
  let text = content.trim();
  const fenced = CODE_FENCE.exec(text);
  if (fenced !== null) text = (fenced[1] ?? '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, problem: 'not_json' };
  }
  if (!isPlainObject(value)) return { ok: false, problem: 'not_an_object' };
  const keys = Object.keys(value);
  if (keys.some((key) => !(TRANSLATION_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, problem: 'extra_keys' };
  }
  const texts: TranslationTexts = { title: null, excerpt: null, body_lead: null };
  for (const field of TRANSLATION_FIELDS) {
    if (!Object.hasOwn(value, field)) return { ok: false, problem: 'missing_keys' };
    const translated = value[field];
    if (typeof translated !== 'string') return { ok: false, problem: 'non_string_field' };
    if (codePoints(translated) > TIER2_MAX_OUTPUT_CHARS)
      return { ok: false, problem: 'field_too_long' };
    if (!isStorableText(translated)) return { ok: false, problem: 'unstorable_text' };
    texts[field] = isBlankText(source[field]) ? null : translated.trim();
  }
  return { ok: true, texts };
}

interface Envelope {
  usage: { inputTokens: number; outputTokens: number; known: boolean };
  reportedModel?: string;
  content?: string;
  problem?: string;
}

/**
 * The non-streamed `/api/chat` response: token usage (`prompt_eval_count`, `eval_count`), the
 * reported model and `message.content` of a finished assistant message. A response cut at
 * `num_predict` (`done_reason: 'length'`) is truncated, never partial success (spec 04 §6.1).
 */
function readEnvelope(value: unknown): Envelope {
  const unknownUsage = { inputTokens: 0, outputTokens: 0, known: false };
  if (!isPlainObject(value)) return { usage: unknownUsage, problem: 'envelope' };
  const input = ownValue(value, 'prompt_eval_count');
  const output = ownValue(value, 'eval_count');
  const usage = {
    inputTokens: isCount(input) ? input : 0,
    outputTokens: isCount(output) ? output : 0,
    known: isCount(input) && isCount(output),
  };
  const model = ownValue(value, 'model');
  const envelope: Envelope = {
    usage,
    ...(typeof model === 'string' && MODEL_ID.test(model) ? { reportedModel: model } : {}),
  };
  const doneReason = ownValue(value, 'done_reason');
  if (doneReason === 'length') return { ...envelope, problem: 'truncated' };
  if (ownValue(value, 'done') !== true) return { ...envelope, problem: 'not_done' };
  if (doneReason !== undefined && doneReason !== 'stop')
    return { ...envelope, problem: 'not_stopped' };
  const message = ownValue(value, 'message');
  if (!isPlainObject(message) || ownValue(message, 'role') !== 'assistant') {
    return { ...envelope, problem: 'envelope' };
  }
  const toolCalls = ownValue(message, 'tool_calls');
  if (toolCalls !== undefined && !(Array.isArray(toolCalls) && toolCalls.length === 0)) {
    return { ...envelope, problem: 'tool_calls' };
  }
  const content = ownValue(message, 'content');
  if (typeof content !== 'string') return { ...envelope, problem: 'envelope' };
  return { ...envelope, content };
}

/** The failure an HTTP status means; only a 5xx may have generated (billed) output. */
function statusFailure(statusCode: number): {
  reason: Tier2FailureReason;
  status: CallStatus;
  retryable: boolean;
  billing: 'known' | 'uncertain';
} {
  if (statusCode === 401 || statusCode === 403) {
    return { reason: 'auth_error', status: 'auth_error', retryable: false, billing: 'known' };
  }
  if (statusCode === 404) {
    return { reason: 'model_unavailable', status: 'error', retryable: false, billing: 'known' };
  }
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return {
      reason: 'invalid_request',
      status: 'invalid_request',
      retryable: false,
      billing: 'known',
    };
  }
  if (statusCode === 429) {
    return { reason: 'rate_limited', status: 'rate_limited', retryable: true, billing: 'known' };
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return { reason: 'server_error', status: 'error', retryable: true, billing: 'uncertain' };
  }
  return { reason: 'http_error', status: 'error', retryable: false, billing: 'known' };
}

export function createOllamaTranslator(options: OllamaTranslatorOptions): OllamaTranslator {
  const chatUrl = new URL('api/chat', parseBaseUrl(options.baseUrl, 'Ollama baseUrl'));
  const timeoutMs = checkDuration(
    options.timeoutMs ?? TIER2_DEFAULTS.timeoutMs,
    'Ollama timeoutMs',
  );
  const maxResponseBytes = checkPositiveInteger(
    options.maxResponseBytes ?? TIER2_DEFAULTS.maxResponseBytes,
    'Ollama maxResponseBytes',
    64 * 1024 * 1024,
  );
  const prices = options.prices ?? OLLAMA_PRICES;
  const ownAgent =
    options.dispatcher === undefined
      ? createAgent(
          checkPositiveInteger(
            options.maxConnections ?? TIER2_DEFAULTS.maxConnections,
            'Ollama maxConnections',
            64,
          ),
          timeoutMs,
        )
      : undefined;
  const dispatcher: Dispatcher = options.dispatcher ?? (ownAgent as Dispatcher);
  const clock = options.clock ?? systemClock;

  async function translateOnce(
    input: Tier2Input & { auth: TranslatorAuth; attempt?: number; signal?: AbortSignal },
  ): Promise<Tier2AttemptResult> {
    const n = input.attempt ?? 1;
    if (!Number.isSafeInteger(n) || n < 1 || n > TIER2_MAX_ATTEMPTS) {
      throw new RangeError(`tier 2: attempt must be between 1 and ${TIER2_MAX_ATTEMPTS}`);
    }
    const body = JSON.stringify(buildTier2Request(input));
    const price = priceOf(input.model, prices);
    const version = input.auth.credentialVersion;
    const credential =
      typeof version === 'string' && CREDENTIAL_VERSION.test(version)
        ? { credentialVersion: version }
        : {};
    const startedAt = clock.now();
    const record = (
      status: CallStatus,
      extras: {
        httpStatus?: number;
        error?: string;
        usage?: { inputTokens: number; outputTokens: number; known: boolean };
        billing?: 'known' | 'uncertain';
      },
    ): TranslationAttempt => {
      const usage = extras.usage ?? { inputTokens: 0, outputTokens: 0, known: true };
      return {
        engine: 'llm',
        model: input.model,
        attempt: n,
        status,
        ...(extras.httpStatus === undefined ? {} : { httpStatus: extras.httpStatus }),
        ...(extras.error === undefined ? {} : { error: extras.error }),
        startedAt,
        latencyMs: Math.max(0, clock.now().getTime() - startedAt.getTime()),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: tier2CostUsd(price, usage),
        billing: extras.billing ?? (usage.known ? 'known' : 'uncertain'),
        ...credential,
      };
    };

    const { apiKey } = input.auth;
    if (typeof apiKey !== 'string' || !HEADER_SAFE_KEY.test(apiKey)) {
      // Nothing is sent; the key is never echoed.
      return {
        ok: false,
        reason: 'auth_error',
        retryable: false,
        attempt: record('auth_error', { error: 'invalid_key_format' }),
      };
    }

    const deadline = attemptSignal(timeoutMs, input.signal);
    try {
      let response: Dispatcher.ResponseData;
      try {
        response = await send(dispatcher, chatUrl, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: deadline.signal,
        });
      } catch (error) {
        const failure = classifyThrown(error, deadline);
        return {
          ok: false,
          reason: failure.kind,
          retryable: failure.kind !== 'cancelled',
          attempt: record(failure.status, {
            error: failure.error,
            billing: failure.maybeSent ? 'uncertain' : 'known',
          }),
        };
      }
      const { statusCode, body: responseBody } = response;
      // A deadline abort destroys an unread body with an error; nobody may be listening yet.
      responseBody.on('error', noop);
      if (statusCode !== 200) {
        discardBody(responseBody);
        const failure = statusFailure(statusCode);
        const wait =
          statusCode === 429 || statusCode === 503
            ? retryAfterMs(firstHeader(response.headers['retry-after']), clock.now().getTime())
            : undefined;
        return {
          ok: false,
          reason: failure.reason,
          retryable: failure.retryable,
          ...(wait === undefined ? {} : { retryAfterMs: wait }),
          attempt: record(failure.status, {
            httpStatus: statusCode,
            error: `http_${statusCode}`,
            billing: failure.billing,
          }),
        };
      }

      const invalid = (problem: string, usage?: Envelope['usage']): Tier2AttemptResult => ({
        ok: false,
        reason: 'invalid_response',
        retryable: true,
        attempt: record('invalid_response', {
          httpStatus: statusCode,
          error: `invalid_response:${problem}`,
          ...(usage === undefined ? { billing: 'uncertain' as const } : { usage }),
        }),
      });
      let bytes: Buffer | undefined;
      try {
        bytes = await readBoundedBody(
          responseBody,
          firstHeader(response.headers['content-length']),
          maxResponseBytes,
        );
      } catch (error) {
        const failure = classifyThrown(error, deadline);
        return {
          ok: false,
          reason: failure.kind,
          retryable: failure.kind !== 'cancelled',
          attempt: record(failure.status, {
            httpStatus: statusCode,
            error: failure.error,
            billing: 'uncertain',
          }),
        };
      }
      if (bytes === undefined) return invalid('too_large');
      const parsed = parseJsonBytes(bytes);
      if (parsed === undefined) return invalid('not_json');
      const envelope = readEnvelope(parsed.value);
      if (envelope.problem !== undefined || envelope.content === undefined) {
        return invalid(envelope.problem ?? 'envelope', envelope.usage);
      }
      const content = parseTier2Content(envelope.content, input.source);
      if (!content.ok) return invalid(content.problem, envelope.usage);
      return {
        ok: true,
        texts: content.texts,
        model: input.model,
        ...(envelope.reportedModel === undefined ? {} : { reportedModel: envelope.reportedModel }),
        attempt: record('ok', { httpStatus: statusCode, usage: envelope.usage }),
      };
    } finally {
      deadline.dispose();
    }
  }

  return {
    translateOnce,
    estimate: (input) => estimateTier2Cost(input, prices),
    async close() {
      await ownAgent?.close();
    },
  };
}
