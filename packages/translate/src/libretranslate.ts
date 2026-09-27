import { setTimeout as delay } from 'node:timers/promises';

import { systemClock, type CallStatus, type Clock } from '@bantoozi/shared';
import type { Dispatcher } from 'undici';

import { isPlainObject, ownValue } from './guards.js';
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
  type AttemptSignal,
} from './http.js';
import { articleSourceFields, isBlankText } from './source.js';
import type { SourceField, TranslationAttempt, TranslationTexts } from './types.js';

/**
 * Tier 1: the self-hosted LibreTranslate container (spec 07 §2–3). Free CPU translation of an
 * explicit ordered field list, `POST {LIBRETRANSLATE_URL}/translate` with
 * `{q: [...texts], source, target: 'en', format: 'text'}`. The source language is always explicit
 * (never `auto`), so Slovak is never silently treated as Czech; `en` is passed through and `und`
 * is never requested. At most two HTTP attempts, retrying only transient failures (network,
 * timeout, 429, 5xx) after a bounded backoff; validation and unsupported-language failures are
 * terminal for the revision. Every attempt's metadata is returned for the caller to record
 * (`engine_calls`, engine `libretranslate`, cost 0).
 */

/** Spec 07 §3 step 2 (30 s per attempt, at most 2 attempts) and this client's bounds. */
export const LIBRETRANSLATE_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  maxAttempts: 2,
  /** Delay before the second attempt (a longer valid `Retry-After` wins). */
  backoffMs: 1_000,
  /** A server delay above this is not waited for: the call fails with `retryAt` instead. */
  maxRetryDelayMs: 5_000,
  /** Concurrent connections to the container from this process (spec 07 §2: bounded CPU). */
  maxConnections: 2,
  maxResponseBytes: 256 * 1024,
});

/** Hard cap on HTTP attempts per call (spec 07 §3 step 2). */
export const LIBRETRANSLATE_MAX_ATTEMPTS = 2;
/** Longest text of one field, in code points (a programming error beyond it). */
export const TIER1_MAX_TEXT_CHARS = 2_000;
/** Longest request: all texts together, in code points. */
export const TIER1_MAX_REQUEST_CHARS = 6_000;
/** A translated text longer than this is an invalid response. */
export const TIER1_MAX_OUTPUT_CHARS = 8_000;

/** The pairs tier 1 must support before G1 (spec 07 §2). */
export const REQUIRED_TIER1_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(['sk', 'en'] as const),
  Object.freeze(['cs', 'en'] as const),
]);

/** Request languages are ISO 639-1 codes; `auto` never. */
const REQUEST_LANG = /^[a-z]{2}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** Codes in `/languages`: `en`, `zh-Hans`, `pt-BR`, … */
const LT_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}$/;
const MAX_LANGUAGES = 500;
const MAX_LANGUAGE_NAME_CHARS = 100;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
/** LibreTranslate's 400 messages for a missing model: "xx is not supported", "… is not available as a target language from …". */
const UNSUPPORTED_MESSAGE = /not supported|not available/i;

const noop = (): void => undefined;

export interface LibreTranslateClientOptions {
  /** `LIBRETRANSLATE_URL`. */
  baseUrl: string;
  /** Per attempt; default 30 s. */
  timeoutMs?: number;
  /** 1 or 2; default 2. */
  maxAttempts?: number;
  backoffMs?: number;
  maxRetryDelayMs?: number;
  /** Size of the client's own connection pool; ignored with `dispatcher`. */
  maxConnections?: number;
  maxResponseBytes?: number;
  /** Injected undici dispatcher (tests: `MockAgent`); default: the client's own pool. */
  dispatcher?: Dispatcher;
  /** Backoff sleep; default a real timer that rejects when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: Clock;
}

/** Why a tier-1 call failed. Only the first three are terminal for the article revision. */
export type Tier1FailureReason =
  | 'unsupported_language'
  | 'invalid_request'
  | 'invalid_response'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'auth_error'
  | 'http_error'
  | 'cancelled';

const TERMINAL_REASONS: ReadonlySet<Tier1FailureReason> = new Set([
  'unsupported_language',
  'invalid_request',
  'invalid_response',
]);

export interface Tier1TranslateInput<F extends string> {
  /** The explicit ordered field mapping; blank texts are left out of the request. */
  fields: ReadonlyArray<SourceField<F>>;
  /** ISO 639-1 source language, or `und`. */
  source: string;
  target?: 'en';
  /**
   * Source languages with an installed `→ en` model (from a cached `/languages`, see
   * {@link supportedSourceLanguages}). A language outside it fails as `unsupported_language`
   * without a request.
   */
  supportedSources?: ReadonlySet<string>;
  signal?: AbortSignal;
  /**
   * Asked before every HTTP attempt, the retry included: `false` sends nothing more and fails the
   * call as `cancelled`, with the attempts already made (the caller's authorization to send the
   * text lapsed, spec 07 §2).
   */
  beforeAttempt?: () => Promise<boolean>;
}

export type Tier1Result<F extends string> =
  /** Translated texts of the nonblank fields, in request order, each with its own field. */
  | { status: 'translated'; translations: SourceField<F>[]; attempts: TranslationAttempt[] }
  /** The source is English: the nonblank fields as they are, no request. */
  | { status: 'passthrough'; translations: SourceField<F>[]; attempts: TranslationAttempt[] }
  /** `und` stays native, and nothing nonblank means nothing to send: no request. */
  | {
      status: 'not_requested';
      reason: 'undetermined_language' | 'no_text';
      attempts: TranslationAttempt[];
    }
  | {
      status: 'failed';
      reason: Tier1FailureReason;
      /**
       * True when the failure is final for this article revision (validation, unsupported
       * language, invalid response): the caller stores a `fail` row. Transient, configuration and
       * cancellation failures are not: the caller may retry the job later.
       */
      terminal: boolean;
      /** When a 429/5xx asked for a delay: the earliest sensible retry. */
      retryAt?: Date;
      attempts: TranslationAttempt[];
    };

export type Tier1ArticleResult =
  | {
      status: 'translated' | 'passthrough';
      /** Absent source fields stay `null`. */
      texts: TranslationTexts;
      attempts: TranslationAttempt[];
    }
  | Extract<Tier1Result<never>, { status: 'not_requested' | 'failed' }>;

export interface LibreTranslateLanguage {
  code: string;
  name: string;
  targets: string[];
}

export type LanguagesResult =
  | { ok: true; languages: LibreTranslateLanguage[]; attempt: TranslationAttempt }
  | { ok: false; reason: Tier1FailureReason; attempt: TranslationAttempt };

export interface LibreTranslateClient {
  translate<F extends string>(input: Tier1TranslateInput<F>): Promise<Tier1Result<F>>;
  /** {@link LibreTranslateClient.translate} of an article's title, excerpt and body lead. */
  translateArticle(input: {
    source: TranslationTexts;
    lang: string;
    supportedSources?: ReadonlySet<string>;
    signal?: AbortSignal;
    beforeAttempt?: () => Promise<boolean>;
  }): Promise<Tier1ArticleResult>;
  /** `GET /languages`, one attempt: what the container can translate. */
  languages(options?: { signal?: AbortSignal }): Promise<LanguagesResult>;
  /** Closes the client's own connection pool (never an injected dispatcher). */
  close(): Promise<void>;
}

type AttemptOutcome<T> =
  | { ok: true; value: T; attempt: TranslationAttempt }
  | {
      ok: false;
      reason: Tier1FailureReason;
      retryable: boolean;
      retryAfterMs?: number;
      attempt: TranslationAttempt;
    };

/** The failure an HTTP status means (spec 07 §3 step 2; spec 04 §3 for the status vocabulary). */
function statusFailure(statusCode: number): {
  reason: Tier1FailureReason;
  status: CallStatus;
  retryable: boolean;
} {
  if (statusCode === 401 || statusCode === 403) {
    return { reason: 'auth_error', status: 'auth_error', retryable: false };
  }
  if (statusCode === 429)
    return { reason: 'rate_limited', status: 'rate_limited', retryable: true };
  if (statusCode >= 500 && statusCode <= 599) {
    return { reason: 'server_error', status: 'error', retryable: true };
  }
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return { reason: 'invalid_request', status: 'invalid_request', retryable: false };
  }
  return { reason: 'http_error', status: 'error', retryable: false };
}

/** Validates the caller's field list (programming errors throw). */
function checkFields<F extends string>(fields: ReadonlyArray<SourceField<F>>): SourceField<F>[] {
  if (!Array.isArray(fields)) throw new TypeError('LibreTranslate: fields must be an array');
  const seen = new Set<string>();
  let total = 0;
  for (const entry of fields) {
    if (!isPlainObject(entry)) throw new TypeError('LibreTranslate: invalid field entry');
    const { field, text } = entry;
    if (typeof field !== 'string' || !FIELD_NAME.test(field)) {
      throw new TypeError('LibreTranslate: invalid field name');
    }
    if (seen.has(field)) throw new TypeError(`LibreTranslate: duplicate field ${field}`);
    seen.add(field);
    if (typeof text !== 'string') throw new TypeError(`LibreTranslate: ${field} is not a string`);
    const chars = codePoints(text);
    if (chars > TIER1_MAX_TEXT_CHARS) {
      throw new RangeError(`LibreTranslate: ${field} exceeds ${TIER1_MAX_TEXT_CHARS} characters`);
    }
    total += chars;
  }
  if (total > TIER1_MAX_REQUEST_CHARS) {
    throw new RangeError(
      `LibreTranslate: the request exceeds ${TIER1_MAX_REQUEST_CHARS} characters`,
    );
  }
  return [...fields];
}

/**
 * The `translatedText` array of a 200 response, validated against the request: exactly one string
 * per sent text, each bounded and storable. Anything else is an invalid response and never becomes
 * article text (spec 07 §6). Returns a problem code on failure.
 */
function translatedTexts(value: unknown, expected: number): string[] | string {
  if (!isPlainObject(value)) return 'shape';
  const list = ownValue(value, 'translatedText');
  if (!Array.isArray(list)) return 'shape';
  if (list.length !== expected) return 'length_mismatch';
  const texts: string[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'string') return 'non_string';
    if (codePoints(item) > TIER1_MAX_OUTPUT_CHARS) return 'text_too_long';
    if (!isStorableText(item)) return 'unstorable_text';
    texts.push(item.trim());
  }
  return texts;
}

/** The `/languages` list, validated; a problem code on failure. Unknown entry keys are ignored. */
function languageList(value: unknown): LibreTranslateLanguage[] | string {
  if (!Array.isArray(value)) return 'shape';
  if (value.length > MAX_LANGUAGES) return 'too_many_languages';
  const languages: LibreTranslateLanguage[] = [];
  for (const item of value as unknown[]) {
    if (!isPlainObject(item)) return 'shape';
    const code = ownValue(item, 'code');
    const name = ownValue(item, 'name');
    const targets = ownValue(item, 'targets');
    if (typeof code !== 'string' || !LT_CODE.test(code)) return 'invalid_code';
    if (
      typeof name !== 'string' ||
      codePoints(name) > MAX_LANGUAGE_NAME_CHARS ||
      !isStorableText(name)
    ) {
      return 'invalid_name';
    }
    if (!Array.isArray(targets) || targets.length > MAX_LANGUAGES) return 'invalid_targets';
    const codes: string[] = [];
    for (const target of targets as unknown[]) {
      if (typeof target !== 'string' || !LT_CODE.test(target)) return 'invalid_targets';
      codes.push(target);
    }
    languages.push({ code, name, targets: codes });
  }
  return languages;
}

/** Whether a 400/413/422 body says the language pair has no installed model. */
async function isUnsupportedLanguage(
  body: Dispatcher.ResponseData['body'],
  contentLength: string | undefined,
): Promise<boolean> {
  try {
    const bytes = await readBoundedBody(body, contentLength, MAX_ERROR_BODY_BYTES);
    const parsed = bytes === undefined ? undefined : parseJsonBytes(bytes);
    if (parsed === undefined || !isPlainObject(parsed.value)) return false;
    const message = ownValue(parsed.value, 'error');
    return typeof message === 'string' && UNSUPPORTED_MESSAGE.test(message);
  } catch {
    return false;
  }
}

/** Source languages that the container can translate into `target` (from `/languages`). */
export function supportedSourceLanguages(
  languages: readonly LibreTranslateLanguage[],
  target = 'en',
): Set<string> {
  const codes = new Set<string>();
  for (const language of languages) {
    if (language.code !== target && language.targets.includes(target)) codes.add(language.code);
  }
  return codes;
}

/** The required pairs (default `sk→en`, `cs→en`) that `/languages` does not list. */
export function missingLanguagePairs(
  languages: readonly LibreTranslateLanguage[],
  pairs: ReadonlyArray<readonly [string, string]> = REQUIRED_TIER1_PAIRS,
): Array<[string, string]> {
  return pairs
    .filter(
      ([source, target]) =>
        !languages.some(
          (language) => language.code === source && language.targets.includes(target),
        ),
    )
    .map(([source, target]): [string, string] => [source, target]);
}

export function createLibreTranslateClient(
  options: LibreTranslateClientOptions,
): LibreTranslateClient {
  const base = parseBaseUrl(options.baseUrl, 'LibreTranslate baseUrl');
  const translateUrl = new URL('translate', base);
  const languagesUrl = new URL('languages', base);
  const timeoutMs = checkDuration(
    options.timeoutMs ?? LIBRETRANSLATE_DEFAULTS.timeoutMs,
    'LibreTranslate timeoutMs',
  );
  const maxAttempts = checkPositiveInteger(
    options.maxAttempts ?? LIBRETRANSLATE_DEFAULTS.maxAttempts,
    'LibreTranslate maxAttempts',
    LIBRETRANSLATE_MAX_ATTEMPTS,
  );
  const backoffMs = checkDuration(
    options.backoffMs ?? LIBRETRANSLATE_DEFAULTS.backoffMs,
    'LibreTranslate backoffMs',
  );
  const maxRetryDelayMs = checkDuration(
    options.maxRetryDelayMs ?? LIBRETRANSLATE_DEFAULTS.maxRetryDelayMs,
    'LibreTranslate maxRetryDelayMs',
  );
  const maxResponseBytes = checkPositiveInteger(
    options.maxResponseBytes ?? LIBRETRANSLATE_DEFAULTS.maxResponseBytes,
    'LibreTranslate maxResponseBytes',
    64 * 1024 * 1024,
  );
  const ownAgent =
    options.dispatcher === undefined
      ? createAgent(
          checkPositiveInteger(
            options.maxConnections ?? LIBRETRANSLATE_DEFAULTS.maxConnections,
            'LibreTranslate maxConnections',
            64,
          ),
          timeoutMs,
        )
      : undefined;
  const dispatcher: Dispatcher = options.dispatcher ?? (ownAgent as Dispatcher);
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const clock = options.clock ?? systemClock;

  const attemptRecord = (
    n: number,
    startedAt: Date,
    status: CallStatus,
    extras: { httpStatus?: number; error?: string } = {},
  ): TranslationAttempt => ({
    engine: 'libretranslate',
    attempt: n,
    status,
    ...extras,
    startedAt,
    latencyMs: Math.max(0, clock.now().getTime() - startedAt.getTime()),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    billing: 'known',
  });

  /** Sends one request and validates a 2xx body with `parse`; failures are classified. */
  async function attempt<T>(
    n: number,
    url: URL,
    request: { method: 'GET' | 'POST'; body?: string },
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T | string,
  ): Promise<AttemptOutcome<T>> {
    const startedAt = clock.now();
    const deadline: AttemptSignal = attemptSignal(timeoutMs, signal);
    const thrown = (error: unknown, httpStatus?: number): AttemptOutcome<T> => {
      const failure = classifyThrown(error, deadline);
      return {
        ok: false,
        reason: failure.kind,
        retryable: failure.kind !== 'cancelled',
        attempt: attemptRecord(n, startedAt, failure.status, {
          ...(httpStatus === undefined ? {} : { httpStatus }),
          error: failure.error,
        }),
      };
    };
    try {
      let response: Dispatcher.ResponseData;
      try {
        response = await send(dispatcher, url, {
          method: request.method,
          headers:
            request.body === undefined
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: deadline.signal,
        });
      } catch (error) {
        return thrown(error);
      }
      const { statusCode, body } = response;
      // A deadline abort destroys an unread body with an error; nobody may be listening yet.
      body.on('error', noop);
      const contentLength = firstHeader(response.headers['content-length']);
      if (statusCode >= 200 && statusCode < 300) {
        const invalid = (problem: string): AttemptOutcome<T> => ({
          ok: false,
          reason: 'invalid_response',
          retryable: false,
          attempt: attemptRecord(n, startedAt, 'invalid_response', {
            httpStatus: statusCode,
            error: `invalid_response:${problem}`,
          }),
        });
        let bytes: Buffer | undefined;
        try {
          bytes = await readBoundedBody(body, contentLength, maxResponseBytes);
        } catch (error) {
          return thrown(error, statusCode);
        }
        if (bytes === undefined) return invalid('too_large');
        const parsed = parseJsonBytes(bytes);
        if (parsed === undefined) return invalid('not_json');
        const value = parse(parsed.value);
        if (typeof value === 'string') return invalid(value);
        return {
          ok: true,
          value,
          attempt: attemptRecord(n, startedAt, 'ok', { httpStatus: statusCode }),
        };
      }
      const failure = statusFailure(statusCode);
      if (
        failure.reason === 'invalid_request' &&
        (await isUnsupportedLanguage(body, contentLength))
      ) {
        failure.reason = 'unsupported_language';
      }
      discardBody(body);
      const wait =
        failure.retryable && (statusCode === 429 || statusCode === 503)
          ? retryAfterMs(firstHeader(response.headers['retry-after']), clock.now().getTime())
          : undefined;
      return {
        ok: false,
        reason: failure.reason,
        retryable: failure.retryable,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
        attempt: attemptRecord(n, startedAt, failure.status, {
          httpStatus: statusCode,
          error: `http_${statusCode}`,
        }),
      };
    } finally {
      deadline.dispose();
    }
  }

  async function translate<F extends string>(
    input: Tier1TranslateInput<F>,
  ): Promise<Tier1Result<F>> {
    const target = input.target ?? 'en';
    if (target !== 'en') throw new TypeError('LibreTranslate: the target language must be en');
    const { source } = input;
    if (typeof source !== 'string' || (source !== 'und' && !REQUEST_LANG.test(source))) {
      throw new TypeError('LibreTranslate: source must be an ISO 639-1 code or und');
    }
    const fields = checkFields(input.fields);
    if (source === 'und') {
      return { status: 'not_requested', reason: 'undetermined_language', attempts: [] };
    }
    const sent = fields.filter((entry) => !isBlankText(entry.text));
    if (sent.length === 0) return { status: 'not_requested', reason: 'no_text', attempts: [] };
    if (source === target) {
      return {
        status: 'passthrough',
        translations: sent.map(({ field, text }) => ({ field, text })),
        attempts: [],
      };
    }
    if (input.supportedSources !== undefined && !input.supportedSources.has(source)) {
      return { status: 'failed', reason: 'unsupported_language', terminal: true, attempts: [] };
    }

    const body = JSON.stringify({
      q: sent.map((entry) => entry.text),
      source,
      target,
      format: 'text',
    });
    const attempts: TranslationAttempt[] = [];
    for (let n = 1; ; n += 1) {
      if (input.beforeAttempt !== undefined && !(await input.beforeAttempt())) {
        return { status: 'failed', reason: 'cancelled', terminal: false, attempts };
      }
      const outcome = await attempt(
        n,
        translateUrl,
        { method: 'POST', body },
        input.signal,
        (value) => translatedTexts(value, sent.length),
      );
      attempts.push(outcome.attempt);
      if (outcome.ok) {
        return {
          status: 'translated',
          // Index i of the response belongs to the i-th SENT field: the explicit mapping.
          translations: sent.map(({ field }, i) => ({ field, text: outcome.value[i] ?? '' })),
          attempts,
        };
      }
      const failed = (retryInMs: number | undefined): Tier1Result<F> => ({
        status: 'failed',
        reason: outcome.reason,
        terminal: TERMINAL_REASONS.has(outcome.reason),
        ...(retryInMs === undefined
          ? {}
          : { retryAt: new Date(clock.now().getTime() + retryInMs) }),
        attempts,
      });
      if (!outcome.retryable || n >= maxAttempts) return failed(outcome.retryAfterMs);
      // Never sooner than a valid server delay; never a long sleep inside a worker.
      const wait = Math.max(backoffMs, outcome.retryAfterMs ?? 0);
      if (wait > maxRetryDelayMs) return failed(wait);
      try {
        await sleep(wait, input.signal);
      } catch {
        return { status: 'failed', reason: 'cancelled', terminal: false, attempts };
      }
      if (input.signal?.aborted === true) {
        return { status: 'failed', reason: 'cancelled', terminal: false, attempts };
      }
    }
  }

  return {
    translate,
    async translateArticle(input) {
      const result = await translate({
        fields: articleSourceFields(input.source),
        source: input.lang,
        ...(input.supportedSources === undefined
          ? {}
          : { supportedSources: input.supportedSources }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.beforeAttempt === undefined ? {} : { beforeAttempt: input.beforeAttempt }),
      });
      if (result.status !== 'translated' && result.status !== 'passthrough') return result;
      const texts: TranslationTexts = { title: null, excerpt: null, body_lead: null };
      for (const { field, text } of result.translations) texts[field] = text;
      return { status: result.status, texts, attempts: result.attempts };
    },
    async languages(options = {}) {
      const outcome = await attempt(
        1,
        languagesUrl,
        { method: 'GET' },
        options.signal,
        languageList,
      );
      return outcome.ok
        ? { ok: true, languages: outcome.value, attempt: outcome.attempt }
        : { ok: false, reason: outcome.reason, attempt: outcome.attempt };
    },
    async close() {
      await ownAgent?.close();
    },
  };
}
