import { constants as bufferConstants } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

import { feedHttpErrorCode, type FeedErrorCode, type OriginLimiter } from '@bantoozi/shared';
import { Agent, type Dispatcher } from 'undici';

import { ACCEPT_ENCODING, decodeContent, parseContentCodings, readWireBody } from './body.js';
import { createSafeConnector, type Dial } from './connector.js';
import { classifyNetworkError, findSafeFetchError } from './errors.js';
import { systemResolver, type Resolver } from './lookup.js';
import { parseRetryAfter } from './retry-after.js';
import { checkRequestUrl, originOf, parseUrl, requestKey } from './url.js';

/** What a fetch is for; picks the default `Accept` header (spec 03 §4.5). */
export type FetchPurpose = 'feed' | 'page' | 'robots' | 'discovery';

/** One followed redirect. */
export interface RedirectHop {
  status: number;
  from: string;
  to: string;
}

export interface SafeFetchOptions {
  /** Picks the default `Accept` header. */
  purpose: FetchPurpose;
  /** `FETCH_USER_AGENT` or a per-feed override. */
  userAgent: string;
  /** Overrides the purpose default. */
  accept?: string;
  /**
   * `If-None-Match` / `If-Modified-Since`, sent only while the request URL is still the original
   * URL (validators are stripped after a redirect).
   */
  conditional?: { etag?: string | null; lastModified?: string | null };
  /**
   * ONE deadline for the entire chain: DNS, limiter waits, every hop, body and decompression
   * (`FETCH_TIMEOUT_MS`).
   */
  timeoutMs: number;
  /** Cap on BOTH compressed and decompressed body bytes (`FETCH_MAX_BYTES`) → `FEED_TOO_LARGE`. */
  maxBytes: number;
  /** Per-response headers timeout; default 10 s. */
  headersTimeoutMs?: number;
  /** Default 5. */
  maxRedirects?: number;
  /**
   * `FETCH_ALLOW_PRIVATE` escape hatch for local fixture servers: disables BOTH the address checks
   * and the port allow-list. Config validation refuses it in production.
   */
  allowPrivate?: boolean;
  /** Injectable DNS; default {@link systemResolver}. */
  resolver?: Resolver;
  /** The per-origin politeness throttle (spec 03 §8.2); omitted → no throttling. */
  limiter?: OriginLimiter;
  /**
   * Policy callback before EVERY request (hop 0 included), after the URL checks and before the
   * limiter; article extraction checks robots here. A denial ends the fetch with
   * `FEED_POLICY_DENIED` and `policy` set.
   */
  beforeRequest?: (url: URL, hop: number) => Promise<true | { code: string; message: string }>;
  /** Caller cancellation; an abort ends the fetch with `FEED_TIMEOUT`. */
  signal?: AbortSignal;
  /** Injectable ms clock for limiter and cooldown maths in tests; default `Date.now`. */
  now?: () => number;
}

/** Spec 03 §4.8 codes plus `FEED_POLICY_DENIED` for a `beforeRequest` denial. */
export type SafeFetchErrorCode = FeedErrorCode | 'FEED_POLICY_DENIED';

export interface SafeFetchSuccess {
  ok: true;
  /** 2xx, or 304 for a conditional request (a bodyless success). */
  status: number;
  finalUrl: string;
  /** True only when there was at least one redirect and EVERY hop was 301 or 308. */
  permanentRedirect: boolean;
  redirects: RedirectHop[];
  /** Response headers with lower-case names (`set-cookie` dropped; at most 32 KiB in total). */
  headers: Record<string, string>;
  /** The decompressed body; empty for 304. */
  bodyBytes: Uint8Array;
}

export interface SafeFetchFailure {
  ok: false;
  code: SafeFetchErrorCode;
  /** The HTTP status for `FEED_HTTP_<status>` and for a failed redirect response. */
  status?: number;
  /** Log-safe: never contains a URL, a query or a resolved address. */
  message: string;
  /** The URL being fetched when the fetch failed (may contain a query: redact before logging). */
  finalUrl?: string;
  redirects?: RedirectHop[];
  /** The bounded response headers of an HTTP failure (for `Retry-After`); never a body. */
  headers?: Record<string, string>;
  /** When to try again: the 429/503 cooldown end, or the origin's cooldown/throttle slot. */
  retryAt?: Date;
  /** The denial returned by `beforeRequest` (`FEED_POLICY_DENIED` only). */
  policy?: { code: string; message: string };
}

/** The result union of `safeFetch` (spec 03 §4.7). */
export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

const FEED_TYPES =
  'application/rss+xml, application/atom+xml, application/feed+json, application/rdf+xml;q=0.9, ' +
  'application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8';

/** Default `Accept` header per purpose (spec 03 §4.5, §8.1 step 3). */
export const ACCEPT_HEADERS: Readonly<Record<FetchPurpose, string>> = Object.freeze({
  feed: `${FEED_TYPES}, */*;q=0.1`,
  page: 'text/html,application/xhtml+xml',
  robots: 'text/plain',
  discovery: `text/html, application/xhtml+xml, ${FEED_TYPES}, */*;q=0.1`,
});

/** Per-response headers timeout (spec 03 §4.4). */
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
/** Redirect hops followed before `FEED_TOO_MANY_REDIRECTS` (spec 03 §4.3). */
export const DEFAULT_MAX_REDIRECTS = 5;
/** Response headers above this size fail with `FEED_TOO_LARGE` (undici `maxHeaderSize`). */
export const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;
/** Cooldown after a 429/503 without a usable `Retry-After` (spec 03 §8.2: at least 60 s). */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** A limiter lease outlives the whole fetch deadline by this margin (spec 03 §8.2). */
export const LEASE_MARGIN_MS = 5_000;

const CONNECT_TIMEOUT_MS = 10_000;
/** Floor for limiter waits, so a limiter answering `wait` for a past instant cannot spin. */
const MIN_LIMITER_WAIT_MS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PERMANENT_REDIRECT_STATUSES = new Set([301, 308]);
const VISIBLE_ASCII = /^[\t\x20-\x7e]+$/;
const VALIDATOR_VALUE = /^[\t\x20-\x7e\x80-\xff]{1,4096}$/;
const EMPTY_BODY = new Uint8Array(0);
const ABORTED: unique symbol = Symbol('aborted');

const noop = (): void => undefined;

interface Settings {
  userAgent: string;
  accept: string;
  timeoutMs: number;
  maxBytes: number;
  headersTimeoutMs: number;
  maxRedirects: number;
  allowPrivate: boolean;
  resolver: Resolver;
  limiter: OriginLimiter | undefined;
  beforeRequest: SafeFetchOptions['beforeRequest'];
  etag: string | undefined;
  lastModified: string | undefined;
  now: () => number;
}

/** Node timers overflow above 2^31 - 1 ms (and then fire after 1 ms). */
const isTimerDuration = (ms: number): boolean =>
  Number.isFinite(ms) && ms > 0 && ms <= 2_147_483_647;

const validator = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' && VALIDATOR_VALUE.test(value) ? value : undefined;

/** Options are trusted configuration: invalid values are programming errors and throw. */
function resolveSettings(options: SafeFetchOptions): Settings {
  if (!Object.hasOwn(ACCEPT_HEADERS, options.purpose)) {
    throw new TypeError('safeFetch: unknown purpose');
  }
  if (typeof options.userAgent !== 'string' || !VISIBLE_ASCII.test(options.userAgent)) {
    throw new TypeError('safeFetch: userAgent must be a non-empty visible-ASCII header value');
  }
  if (options.accept !== undefined && !VISIBLE_ASCII.test(options.accept)) {
    throw new TypeError('safeFetch: accept must be a visible-ASCII header value');
  }
  if (!isTimerDuration(options.timeoutMs)) {
    throw new RangeError('safeFetch: timeoutMs must be a positive number of at most 2^31 - 1 ms');
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > bufferConstants.MAX_LENGTH
  ) {
    throw new RangeError('safeFetch: maxBytes must be a positive integer within the Buffer limit');
  }
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  if (!isTimerDuration(headersTimeoutMs)) {
    throw new RangeError(
      'safeFetch: headersTimeoutMs must be a positive number of at most 2^31 - 1 ms',
    );
  }
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError('safeFetch: maxRedirects must be a non-negative integer');
  }
  return {
    userAgent: options.userAgent,
    accept: options.accept ?? ACCEPT_HEADERS[options.purpose],
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    headersTimeoutMs: Math.ceil(headersTimeoutMs),
    maxRedirects,
    allowPrivate: options.allowPrivate === true,
    resolver: options.resolver ?? systemResolver,
    limiter: options.limiter,
    beforeRequest: options.beforeRequest,
    etag: validator(options.conditional?.etag),
    lastModified: validator(options.conditional?.lastModified),
    now: options.now ?? Date.now,
  };
}

/** State of one fetch: its settings, dispatcher, signals and the redirects followed so far. */
interface Chain {
  readonly settings: Settings;
  readonly agent: Agent;
  /** Deadline or caller abort. */
  readonly signal: AbortSignal;
  readonly deadline: AbortSignal;
  readonly external: AbortSignal | undefined;
  /** The deadline on the injected clock, for limiter decisions. */
  readonly deadlineAt: number;
  readonly originalKey: string;
  readonly redirects: RedirectHop[];
}

type FailureExtras = Pick<SafeFetchFailure, 'status' | 'headers' | 'retryAt' | 'policy'>;

function failure(
  chain: Chain,
  url: URL,
  code: SafeFetchErrorCode,
  message: string,
  extras: FailureExtras = {},
): SafeFetchFailure {
  return {
    ok: false,
    code,
    message,
    finalUrl: url.href,
    redirects: [...chain.redirects],
    ...extras,
  };
}

function timeoutFailure(chain: Chain, url: URL): SafeFetchFailure {
  if (!chain.deadline.aborted && chain.external?.aborted === true) {
    return failure(chain, url, 'FEED_TIMEOUT', 'the fetch was aborted by the caller');
  }
  return failure(
    chain,
    url,
    'FEED_TIMEOUT',
    `no complete response within ${chain.settings.timeoutMs} ms`,
  );
}

function networkFailure(chain: Chain, url: URL, error: unknown): SafeFetchFailure {
  // Our own failures (blocked address, DNS, size, decoding) win over a simultaneous abort.
  if (findSafeFetchError(error) === undefined && chain.signal.aborted) {
    return timeoutFailure(chain, url);
  }
  const { code, message } = classifyNetworkError(error);
  return failure(chain, url, code, message);
}

function success(
  chain: Chain,
  url: URL,
  status: number,
  headers: Record<string, string>,
  bodyBytes: Uint8Array,
): SafeFetchSuccess {
  const redirects = [...chain.redirects];
  return {
    ok: true,
    status,
    finalUrl: url.href,
    permanentRedirect:
      redirects.length > 0 && redirects.every((hop) => PERMANENT_REDIRECT_STATUSES.has(hop.status)),
    redirects,
    headers,
    bodyBytes,
  };
}

/** Resolves with `ABORTED` as soon as `signal` aborts; a later settlement is ignored. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.then(noop, noop);
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Limiter cleanup never fails the fetch: an unreleased lease just expires (spec 03 §8.2). */
function quietly(action: () => Promise<void>): Promise<void> {
  try {
    return action().then(noop, noop);
  } catch {
    return Promise.resolve();
  }
}

type Slot = { ok: true; token: string | undefined } | { ok: false; result: SafeFetchFailure };

/**
 * Reserves a request start at `origin` before a hop (spec 03 §8.2). `granted` → send; `wait` →
 * sleep until `retryAt` when that is before the deadline and ask again, otherwise
 * `FEED_ORIGIN_COOLDOWN`; `blocked` → `FEED_ORIGIN_COOLDOWN` at once, with no request. The lease
 * outlives the whole deadline. A failing `reserve` rejects the fetch: no request was sent and it is
 * an infrastructure failure, not the feed's.
 */
async function reserveStart(chain: Chain, origin: string, url: URL): Promise<Slot> {
  const { limiter, now } = chain.settings;
  if (limiter === undefined) return { ok: true, token: undefined };
  const leaseMs = Math.ceil(chain.settings.timeoutMs) + LEASE_MARGIN_MS;
  for (;;) {
    if (chain.signal.aborted) return { ok: false, result: timeoutFailure(chain, url) };
    const pending = limiter.reserve(origin, { leaseMs });
    const reservation = await untilAborted(pending, chain.signal);
    if (reservation === ABORTED) {
      // A start granted after the deadline is handed straight back.
      pending.then((late) => {
        if (late.status === 'granted') void quietly(() => limiter.release(origin, late.token));
      }, noop);
      return { ok: false, result: timeoutFailure(chain, url) };
    }
    if (reservation.status === 'granted') return { ok: true, token: reservation.token };
    if (reservation.status === 'blocked') {
      return {
        ok: false,
        result: failure(
          chain,
          url,
          'FEED_ORIGIN_COOLDOWN',
          'the origin is cooling down; nothing was sent',
          {
            retryAt: reservation.until,
          },
        ),
      };
    }
    const retryAtMs = reservation.retryAt.getTime();
    if (Number.isNaN(retryAtMs)) throw new TypeError('OriginLimiter returned an invalid retryAt');
    if (retryAtMs >= chain.deadlineAt) {
      return {
        ok: false,
        result: failure(
          chain,
          url,
          'FEED_ORIGIN_COOLDOWN',
          'the origin throttle cannot start the request before the deadline',
          { retryAt: reservation.retryAt },
        ),
      };
    }
    try {
      await delay(Math.max(MIN_LIMITER_WAIT_MS, retryAtMs - now()), undefined, {
        signal: chain.signal,
      });
    } catch {
      return { ok: false, result: timeoutFailure(chain, url) };
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Lower-case names; repeated headers joined with `, `; `set-cookie` dropped (never forwarded). */
function responseHeaders(raw: Dispatcher.ResponseData['headers']): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === 'set-cookie') continue;
    entries.push([lower, Array.isArray(value) ? value.join(', ') : value]);
  }
  return Object.fromEntries(entries);
}

function requestHeaders(chain: Chain, url: URL): Record<string, string> {
  const { settings } = chain;
  const headers: Record<string, string> = {
    'user-agent': settings.userAgent,
    accept: settings.accept,
    'accept-encoding': ACCEPT_ENCODING,
  };
  // Conditional validators belong to the original URL only; never cookies or credentials.
  if (requestKey(url) === chain.originalKey) {
    if (settings.etag !== undefined) headers['if-none-match'] = settings.etag;
    if (settings.lastModified !== undefined) headers['if-modified-since'] = settings.lastModified;
  }
  return headers;
}

type HopStep =
  | { kind: 'result'; result: SafeFetchResult }
  | { kind: 'redirect'; status: number; location: string };

const done = (result: SafeFetchResult): HopStep => ({ kind: 'result', result });

/**
 * Sends one request and turns its response into a result or a redirect (spec 03 §4.3–4.4, §4.7).
 * Every response body that is not consumed is destroyed; error bodies are never read.
 */
async function sendHop(chain: Chain, url: URL, origin: string): Promise<HopStep> {
  const { settings } = chain;
  let response: Dispatcher.ResponseData;
  try {
    response = await chain.agent.request({
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: requestHeaders(chain, url),
      signal: chain.signal,
    });
  } catch (error) {
    return done(networkFailure(chain, url, error));
  }
  const { statusCode, body } = response;
  // A deadline abort destroys an unread body with an error; nobody may be listening yet.
  body.on('error', noop);
  const discard = (): void => {
    if (!body.destroyed) body.destroy();
  };
  const headers = responseHeaders(response.headers);
  try {
    if (REDIRECT_STATUSES.has(statusCode)) {
      discard();
      const locations = response.headers.location;
      const location = firstHeader(locations);
      if (location === undefined) {
        return done(
          failure(
            chain,
            url,
            feedHttpErrorCode(statusCode),
            'a redirect without a Location header',
            {
              status: statusCode,
              headers,
            },
          ),
        );
      }
      if (Array.isArray(locations) && locations.some((value) => value !== location)) {
        return done(
          failure(chain, url, 'FEED_INVALID_URL', 'a redirect with conflicting Location headers', {
            status: statusCode,
          }),
        );
      }
      return { kind: 'redirect', status: statusCode, location };
    }
    if (statusCode === 304) {
      discard();
      return done(success(chain, url, statusCode, headers, EMPTY_BODY));
    }
    if (statusCode >= 200 && statusCode < 300) {
      const codings = parseContentCodings(firstHeader(response.headers['content-encoding']));
      const wire = await readWireBody(
        body,
        firstHeader(response.headers['content-length']),
        settings.maxBytes,
      );
      const content = await decodeContent(wire, codings, settings.maxBytes, chain.signal);
      const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
      return done(success(chain, url, statusCode, headers, bytes));
    }
    discard();
    if (statusCode < 100 || statusCode > 599) {
      return done(failure(chain, url, 'FEED_CONNECTION_ERROR', 'an invalid HTTP status'));
    }
    const code = feedHttpErrorCode(statusCode);
    if (statusCode !== 429 && statusCode !== 503) {
      return done(failure(chain, url, code, `HTTP ${statusCode}`, { status: statusCode, headers }));
    }
    // Spec 03 §8.2: persist the origin cooldown the server asked for (at least 60 s without a
    // usable Retry-After, at most 24 h). No jitter here, so the server's delay is never shortened.
    const nowMs = settings.now();
    const until =
      parseRetryAfter(firstHeader(response.headers['retry-after']), nowMs) ??
      new Date(nowMs + DEFAULT_COOLDOWN_MS);
    const { limiter } = settings;
    if (limiter !== undefined) {
      await untilAborted(
        quietly(() => limiter.block(origin, until)),
        chain.signal,
      );
    }
    return done(
      failure(chain, url, code, `HTTP ${statusCode}`, {
        status: statusCode,
        headers,
        retryAt: until,
      }),
    );
  } catch (error) {
    discard();
    return done(networkFailure(chain, url, error));
  }
}

/** Follows the redirect chain hop by hop, re-running every check on every hop (spec 03 §4.3). */
async function followChain(chain: Chain, start: URL): Promise<SafeFetchResult> {
  const { settings, redirects } = chain;
  const visited = new Set<string>();
  let current = start;
  for (let hop = 0; ; hop += 1) {
    visited.add(requestKey(current));
    const check = checkRequestUrl(current, settings.allowPrivate);
    if (!check.ok) return failure(chain, current, check.code, check.message);
    if (chain.signal.aborted) return timeoutFailure(chain, current);

    const { beforeRequest } = settings;
    if (beforeRequest !== undefined) {
      const verdict = await untilAborted(beforeRequest(new URL(current.href), hop), chain.signal);
      if (verdict === ABORTED) return timeoutFailure(chain, current);
      if (verdict !== true) {
        return failure(chain, current, 'FEED_POLICY_DENIED', 'the request was denied by policy', {
          policy: { code: String(verdict.code), message: String(verdict.message) },
        });
      }
    }

    const origin = originOf(current);
    const slot = await reserveStart(chain, origin, current);
    if (!slot.ok) return slot.result;
    let step: HopStep;
    try {
      step = await sendHop(chain, current, origin);
    } finally {
      const { limiter } = settings;
      const { token } = slot;
      if (limiter !== undefined && token !== undefined) {
        // Released after the body was consumed or destroyed; not awaited past the deadline.
        await untilAborted(
          quietly(() => limiter.release(origin, token)),
          chain.signal,
        );
      }
    }
    if (step.kind === 'result') return step.result;

    if (redirects.length >= settings.maxRedirects) {
      return failure(
        chain,
        current,
        'FEED_TOO_MANY_REDIRECTS',
        `more than ${settings.maxRedirects} redirects`,
        { status: step.status },
      );
    }
    const next = parseUrl(step.location.trim(), current);
    if (!next.ok) {
      return failure(
        chain,
        current,
        'FEED_INVALID_URL',
        `an invalid redirect Location: ${next.message}`,
        {
          status: step.status,
        },
      );
    }
    if (visited.has(requestKey(next.url))) {
      return failure(chain, current, 'FEED_TOO_MANY_REDIRECTS', 'a redirect loop', {
        status: step.status,
      });
    }
    redirects.push({ status: step.status, from: current.href, to: next.url.href });
    current = next.url;
  }
}

/**
 * Internal wiring that is never part of {@link SafeFetchOptions}.
 * @internal
 */
export interface SafeFetchInternals {
  /** Test-only socket-destination rewrite; see {@link Dial}. */
  dial?: Dial;
}

/**
 * `safeFetch` plus test-only internals. **Only tests call this**, importing it from this module;
 * the package entry does not export it, and production code always goes through `safeFetch`.
 * @internal
 */
export async function safeFetchWithInternals(
  url: string,
  options: SafeFetchOptions,
  internals: SafeFetchInternals,
): Promise<SafeFetchResult> {
  const settings = resolveSettings(options);
  const parsed = parseUrl(url);
  if (!parsed.ok) return { ok: false, code: 'FEED_INVALID_URL', message: parsed.message };

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error(`safeFetch deadline of ${settings.timeoutMs} ms exceeded`));
  }, settings.timeoutMs);
  const external = options.signal;
  const signal =
    external === undefined ? deadline.signal : AbortSignal.any([deadline.signal, external]);
  const agent = new Agent({
    connect: createSafeConnector({
      resolver: settings.resolver,
      allowPrivate: settings.allowPrivate,
      connectTimeoutMs: Math.min(CONNECT_TIMEOUT_MS, Math.ceil(settings.timeoutMs)),
      dial: internals.dial,
    }),
    headersTimeout: settings.headersTimeoutMs,
    bodyTimeout: Math.ceil(settings.timeoutMs),
    maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
    allowH2: false,
  });
  const chain: Chain = {
    settings,
    agent,
    signal,
    deadline: deadline.signal,
    external,
    deadlineAt: settings.now() + settings.timeoutMs,
    originalKey: requestKey(parsed.url),
    redirects: [],
  };
  try {
    return await followChain(chain, parsed.url);
  } finally {
    clearTimeout(timer);
    agent.destroy().catch(noop);
  }
}

/**
 * The only outbound HTTP client for feeds, pages, discovery and robots.txt (spec 03 §4): a
 * user-supplied URL must never reach an internal service or hang a worker.
 *
 * - URL checks on every hop: `http:`/`https:` only, no userinfo, ≤ 8,192 bytes, ports 80/443/8080/
 *   8443, IP-literal hosts validated directly; hostnames validated at connect time by
 *   `safeLookup` (any blocked answer rejects; the socket uses exactly the validated addresses).
 * - Redirects (301/302/303/307/308) are followed manually up to `maxRedirects`, each hop
 *   re-validated, policy-checked (`beforeRequest`) and throttled at its own origin; loops,
 *   missing or invalid `Location` fail; conditional validators go to the original URL only.
 * - One deadline covers DNS, limiter waits, every hop, the body and decompression; the body is
 *   capped at `maxBytes` compressed AND decompressed (gzip, deflate, br decoded here); headers are
 *   capped at 32 KiB; TLS is always verified; no environment proxy is ever used.
 * - 2xx → body; 304 → bodyless success; other statuses → `FEED_HTTP_<status>` with the response
 *   headers; 429/503 also persist an origin cooldown through the limiter and return `retryAt`.
 *
 * Never rejects for network, HTTP or URL errors: those become `{ ok: false, code }`. It rejects
 * only for programming or infrastructure errors: invalid options, or a throwing `limiter.reserve`
 * or `beforeRequest` (nothing was fetched, and a database outage must not count against a feed).
 */
export function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  return safeFetchWithInternals(url, options, {});
}
