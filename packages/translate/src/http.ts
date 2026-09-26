import type { CallStatus } from '@bantoozi/shared';
import { Agent, type Dispatcher } from 'undici';

/**
 * HTTP plumbing shared by both translators (internal to the package). The translators talk only
 * to their configured endpoints: LibreTranslate on the compose network, Ollama Cloud at
 * `OLLAMA_BASE_URL` (spec 07 §2). Redirects are never followed (undici's `request` does not), so an
 * Authorization header can never be forwarded to another origin (spec 04 §1.2). Error descriptions
 * are built from status numbers and error codes only, never from messages or bodies, which could
 * echo article text or a key.
 */

/** Response headers above this size fail the request (undici `maxHeaderSize`). */
const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;
/** Connection setup never waits longer than this, however long the attempt deadline is. */
const MAX_CONNECT_TIMEOUT_MS = 10_000;
/** A server-requested delay is honoured for at most 24 hours. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** Node timers overflow above 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

/** Failures that happen before a request leaves the process: nothing can have been billed. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EAI_NODATA',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

/** Validates a configured positive duration (a programming or configuration error throws). */
export function checkDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive number of milliseconds of at most 2^31 - 1`);
  }
  return value;
}

/** Validates a configured positive integer. */
export function checkPositiveInteger(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * Parses a configured base URL (`LIBRETRANSLATE_URL`, `OLLAMA_BASE_URL`): absolute http(s), no
 * credentials, query or fragment. The result ends with `/`, so endpoints resolve below its path.
 */
export function parseBaseUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${name} must be an absolute http(s) URL`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`${name} must not contain credentials, a query or a fragment`);
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * The client's own connection pool: at most `connections` concurrent requests per origin, so a
 * busy translator queues requests instead of opening unbounded sockets (spec 07 §2), HTTP/1.1
 * only, bounded headers.
 */
export function createAgent(connections: number, timeoutMs: number): Agent {
  return new Agent({
    connections,
    headersTimeout: Math.ceil(timeoutMs),
    bodyTimeout: Math.ceil(timeoutMs),
    maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
    allowH2: false,
    connect: { timeout: Math.min(MAX_CONNECT_TIMEOUT_MS, Math.ceil(timeoutMs)) },
  });
}

/** One attempt's abort signal: its own deadline plus the caller's cancellation. */
export interface AttemptSignal {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  cancelled(): boolean;
  dispose(): void;
}

export function attemptSignal(timeoutMs: number, external: AbortSignal | undefined): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('attempt deadline exceeded'));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(new Error('attempt cancelled'));
  if (external?.aborted === true) onAbort();
  else external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => !timedOut && external?.aborted === true,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** A response body stream as undici returns it. */
export interface BodyStream extends AsyncIterable<unknown> {
  destroy(error?: Error): unknown;
}

/**
 * Reads a response body with its size capped: `undefined` when it is larger than `maxBytes` (a
 * `Content-Length` above the cap fails before reading; the stream is destroyed). A stream error,
 * such as the attempt deadline aborting the request, rejects.
 */
export async function readBoundedBody(
  body: BodyStream,
  contentLength: string | undefined,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (contentLength !== undefined && /^\s*\d+\s*$/.test(contentLength)) {
    if (Number(contentLength) > maxBytes) {
      body.destroy();
      return undefined;
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) {
      body.destroy();
      return undefined;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/** Discards a body that is not read, so its connection is released. */
export function discardBody(body: BodyStream & { destroyed?: boolean }): void {
  if (body.destroyed !== true) body.destroy();
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Strict UTF-8 JSON: `undefined` for invalid UTF-8 or JSON. */
export function parseJsonBytes(bytes: Uint8Array): { value: unknown } | undefined {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The delay a `Retry-After` header asks for, in ms: delta-seconds or an HTTP date, clamped to
 * [0, 24 h]. `undefined` when absent or invalid.
 */
export function retryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  if (!/^[A-Za-z]{3},/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS);
}

/** The first log-safe `code` in an error's cause chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
    current = cause;
  }
  return undefined;
}

/** A thrown attempt failure, classified. */
export interface ThrownFailure {
  kind: 'timeout' | 'cancelled' | 'network_error';
  status: CallStatus;
  /** Log-safe: `timeout`, `cancelled`, `network` or `network:<CODE>`. */
  error: string;
  /** False only when the request certainly never left the process. */
  maybeSent: boolean;
}

/**
 * Classifies an error thrown while sending a request or reading its response: the attempt's own
 * deadline → `timeout`; the caller's abort → `cancelled`; anything else a network error described
 * by its error code alone (never its message).
 */
export function classifyThrown(error: unknown, signal: AttemptSignal): ThrownFailure {
  const code = errorCode(error);
  const maybeSent = code === undefined || !NOT_SENT_CODES.has(code);
  if (signal.timedOut() || (code !== undefined && TIMEOUT_CODES.has(code))) {
    return { kind: 'timeout', status: 'timeout', error: 'timeout', maybeSent };
  }
  if (signal.cancelled()) {
    return { kind: 'cancelled', status: 'error', error: 'cancelled', maybeSent };
  }
  return {
    kind: 'network_error',
    status: 'error',
    error: code === undefined ? 'network' : `network:${code}`,
    maybeSent,
  };
}

/** Sends one request through `dispatcher` (undici `Dispatcher.request`, never following redirects). */
export function send(
  dispatcher: Dispatcher,
  url: URL,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
): Promise<Dispatcher.ResponseData> {
  return dispatcher.request({
    origin: url.origin,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers: options.headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: options.signal,
  });
}

/** In `u` mode a surrogate pair is one astral code point, so this matches lone surrogates only. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Whether a translated string is safe to store: no NUL (PostgreSQL text) and no lone surrogate. */
export function isStorableText(text: string): boolean {
  return !text.includes('\u0000') && !LONE_SURROGATE.test(text);
}

/** Length in Unicode code points. */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
