import { request, type Dispatcher } from 'undici';

import { parseRetryAfter } from './retry.js';
import type { EngineAttempt } from './types.js';

/**
 * The single HTTP wire attempt shared by the remote engines (spec 04 §3, §8), internal to this
 * package: one JSON POST with the resolved bearer credential, one deadline for connect, headers and
 * body, bounded response bytes, never a redirect (Authorization must not follow one), and the
 * status table of spec 04 §3. The credential is only ever placed in the Authorization header: never
 * in a URL, an error detail or a log field. Provider error bodies can echo private inputs, so only a
 * sanitized error code is ever taken from them.
 */

export type AttemptFailure = Extract<EngineAttempt, { ok: false }>;

/** Default cap on a success response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/** How much of a 400/413/422 body is read to find an error code. */
const ERROR_BODY_BYTES = 8 * 1024;
/** Statuses of a request the provider refused as invalid (spec 04 §3: no blind retry/fallback). */
const INVALID_REQUEST_STATUSES = new Set([400, 413, 422]);
const API_KEY = /^[\x21-\x7e]{1,4096}$/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
const EMPTY = new Uint8Array(0);

/** Transport error codes raised before any request byte reached the provider. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_INVALID_ARG',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);
/** TLS handshake failures, also before any request byte. */
const TLS_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;
/** Programming errors: retrying cannot help. */
const PERMANENT_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const noop = (): void => undefined;

/** A failed attempt that never reached the provider: nothing can have been billed. */
export function notSent(
  status: AttemptFailure['status'],
  detail: string,
  retryable = false,
): AttemptFailure {
  return { ok: false, status, retryable, detail, billing: 'known' };
}

/**
 * Whether a resolved credential can be sent as a header at all: 1..4,096 visible ASCII characters.
 * Anything else is refused as an auth error without a request (no header injection, no retries).
 */
export function isUsableApiKey(apiKey: unknown): apiKey is string {
  return typeof apiKey === 'string' && API_KEY.test(apiKey);
}

/**
 * `{base}{path}` for a configured provider base URL (trusted host configuration, checked once at
 * engine construction): `http:`/`https:` only (`https:` in production), no userinfo, query or
 * fragment, so a credential is only ever sent to that origin and path.
 */
export function providerEndpoint(
  baseUrl: string,
  path: string,
  options: { production: boolean; engine: string },
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`${options.engine}: baseUrl is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${options.engine}: baseUrl must be http(s)`);
  }
  if (options.production && url.protocol !== 'https:') {
    throw new TypeError(`${options.engine}: baseUrl must be https in production`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`${options.engine}: baseUrl must not carry credentials, a query or a hash`);
  }
  return `${url.href.replace(/\/+$/, '')}${path}`;
}

/** Validates a positive timer duration (Node timers overflow above 2^31 − 1 ms). */
export function checkTimeout(ms: number, engine: string): number {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new RangeError(`${engine}: timeoutMs must be a positive number of at most 2^31 - 1 ms`);
  }
  return ms;
}

/** Validates a positive integer option such as a byte cap. */
export function checkPositiveInteger(value: number, name: string, engine: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${engine}: ${name} must be a positive integer`);
  }
  return value;
}

/** Lower-case header names; repeated headers joined with `, `. */
function flattenHeaders(raw: Dispatcher.ResponseData['headers']): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    entries.push([name.toLowerCase(), Array.isArray(value) ? value.join(', ') : value]);
  }
  return Object.fromEntries(entries);
}

/** The first transport error code found on an error or its causes. */
function transportCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A transport failure (spec 04 §3: network errors and timeouts are transient). `responseStarted`:
 * the provider already answered, so the request was certainly sent.
 */
function transportFailure(error: unknown, responseStarted: boolean): AttemptFailure {
  const code = transportCode(error);
  const shownCode = code !== undefined && TRANSPORT_CODE.test(code) ? code : 'unknown';
  const sent =
    responseStarted || code === undefined || !(NOT_SENT_CODES.has(code) || TLS_CODE.test(code));
  const billing = sent ? 'uncertain' : 'known';
  if (code !== undefined && TIMEOUT_CODES.has(code)) {
    return {
      ok: false,
      status: 'timeout',
      retryable: true,
      detail: `timeout:${shownCode}`,
      billing,
    };
  }
  const retryable = code === undefined || !PERMANENT_CODES.has(code);
  return { ok: false, status: 'error', retryable, detail: `network:${shownCode}`, billing };
}

interface BoundedBody {
  bytes: Uint8Array;
  /** The body was longer than the limit; `bytes` holds only its first `limit` bytes. */
  tooLarge: boolean;
}

/** Reads at most `limit` bytes; a longer body is destroyed as soon as it passes the limit. */
async function readBounded(
  body: Dispatcher.ResponseData['body'],
  limit: number,
  contentLength: string | undefined,
): Promise<BoundedBody> {
  if (contentLength !== undefined && /^\d+$/.test(contentLength.trim())) {
    if (Number(contentLength) > limit) {
      body.destroy();
      return { bytes: EMPTY, tooLarge: true };
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (total + bytes.length > limit) {
      chunks.push(bytes.subarray(0, limit - total));
      body.destroy();
      return { bytes: Buffer.concat(chunks, limit), tooLarge: true };
    }
    chunks.push(bytes);
    total += bytes.length;
  }
  return { bytes: Buffer.concat(chunks, total), tooLarge: false };
}

export interface PostJsonInput {
  /** The provider endpoint from {@link providerEndpoint}. */
  url: string;
  /** Sent only as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** The serialized JSON body. */
  body: string;
  /** One deadline for connect, headers and the whole body. */
  timeoutMs: number;
  /** Caller cancellation. */
  signal: AbortSignal;
  /** Cap on a 2xx body. */
  maxResponseBytes: number;
  /** Injected transport (tests: MockAgent); must not follow redirects. Default: undici's global. */
  dispatcher?: Dispatcher | undefined;
}

export type PostJsonOutcome =
  | {
      kind: 'response';
      status: number;
      headers: Record<string, string>;
      /** A 2xx body (bounded), the start of a 400/413/422 body, otherwise empty. */
      body: Uint8Array;
      tooLarge: boolean;
    }
  | { kind: 'failed'; failure: AttemptFailure };

/**
 * Sends one JSON POST (spec 04 §3–4: ONE wire attempt; the router owns retries). Never rejects:
 * transport errors, the deadline and caller cancellation become a `failed` outcome whose billing is
 * `uncertain` whenever the request may have reached the provider.
 */
export async function postJson(input: PostJsonInput): Promise<PostJsonOutcome> {
  if (input.signal.aborted) return { kind: 'failed', failure: notSent('error', 'cancelled') };
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`provider deadline of ${input.timeoutMs} ms exceeded`));
  }, input.timeoutMs);
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const aborted = (): AttemptFailure | undefined => {
    if (deadline.signal.aborted) {
      return {
        ok: false,
        status: 'timeout',
        retryable: true,
        detail: 'timeout',
        billing: 'uncertain',
      };
    }
    if (input.signal.aborted) {
      return {
        ok: false,
        status: 'error',
        retryable: false,
        detail: 'cancelled',
        billing: 'uncertain',
      };
    }
    return undefined;
  };
  try {
    // `maxRedirections: 0` also disables a redirect interceptor on an injected dispatcher.
    const options: NonNullable<Parameters<typeof request>[1]> & { maxRedirections: 0 } = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: input.body,
      signal,
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
      maxRedirections: 0,
      ...(input.dispatcher === undefined ? {} : { dispatcher: input.dispatcher }),
    };
    let response: Dispatcher.ResponseData<unknown>;
    try {
      response = await request(input.url, options);
    } catch (error) {
      return { kind: 'failed', failure: aborted() ?? transportFailure(error, false) };
    }
    const { statusCode, body } = response;
    // An abort destroys an unread body with an error; nobody may be listening yet.
    body.on('error', noop);
    const headers = flattenHeaders(response.headers);
    const success = statusCode >= 200 && statusCode < 300;
    const limit = success
      ? input.maxResponseBytes
      : INVALID_REQUEST_STATUSES.has(statusCode)
        ? ERROR_BODY_BYTES
        : 0;
    try {
      if (limit === 0) {
        body.destroy();
        return { kind: 'response', status: statusCode, headers, body: EMPTY, tooLarge: false };
      }
      const read = await readBounded(body, limit, headers['content-length']);
      return {
        kind: 'response',
        status: statusCode,
        headers,
        body: read.bytes,
        tooLarge: read.tooLarge,
      };
    } catch (error) {
      if (!body.destroyed) body.destroy();
      return { kind: 'failed', failure: aborted() ?? transportFailure(error, true) };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The sanitized `code`/`type` of a JSON error body; never its message (it can echo inputs). */
function providerErrorCode(body: Uint8Array): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  const candidates: unknown[] = [];
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const top = parsed as Record<string, unknown>;
    const nested = Object.hasOwn(top, 'error') ? top.error : undefined;
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const inner = nested as Record<string, unknown>;
      if (Object.hasOwn(inner, 'code')) candidates.push(inner.code);
      if (Object.hasOwn(inner, 'type')) candidates.push(inner.type);
    }
    if (Object.hasOwn(top, 'code')) candidates.push(top.code);
    if (Object.hasOwn(top, 'type')) candidates.push(top.type);
  }
  const code = candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && ERROR_CODE.test(candidate),
  );
  return code;
}

/**
 * Maps a non-2xx provider response to an attempt (spec 04 §3 status table). HTTP answers are never
 * billable, so billing is `known` with no usage.
 */
export function httpStatusFailure(
  status: number,
  headers: Record<string, string>,
  body: Uint8Array,
  nowMs: number,
): AttemptFailure {
  const detail = `http_${status}`;
  if (status === 401 || status === 403) {
    return { ok: false, status: 'auth_error', retryable: false, detail, billing: 'known' };
  }
  if (INVALID_REQUEST_STATUSES.has(status)) {
    const code = providerErrorCode(body);
    return {
      ok: false,
      status: 'invalid_request',
      retryable: false,
      detail: code === undefined ? detail : `${detail}:${code}`,
      billing: 'known',
    };
  }
  const retryAfterMs = parseRetryAfter(headers['retry-after'], nowMs);
  const delay = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 429) {
    return {
      ok: false,
      status: 'rate_limited',
      retryable: true,
      detail,
      billing: 'known',
      ...delay,
    };
  }
  if (status >= 500 && status <= 599) {
    return { ok: false, status: 'error', retryable: true, detail, billing: 'known', ...delay };
  }
  // Redirects (never followed) and other 4xx: unsupported model/endpoint or a permanent error.
  return { ok: false, status: 'error', retryable: false, detail, billing: 'known' };
}

/** Decodes a JSON body strictly as UTF-8 (a BOM is dropped); undefined when it is not JSON. */
export function parseJsonBody(body: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) };
  } catch {
    return { ok: false };
  }
}

/** A nonnegative safe integer (token counts), or undefined. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** An own data property of a parsed JSON object (never inherited, never a getter). */
export function field(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Caps a detail for the `engine_calls.error` column. */
export function capDetail(detail: string): string {
  return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}
