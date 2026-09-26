import { canonicalizeUrl } from '../canonical/index.js';
import type {
  DecodeResult,
  SafeFetchFailure,
  SafeFetchResult,
  SafeFetchSuccess,
} from '../http/index.js';
import { sniffFeed, type FeedKind, type ParseFeedResult, type ParsedFeed } from '../parse/index.js';

import { validateFeedUrl, type FeedUrlCheck, type FeedUrlRejection } from './feed-url.js';
import { findAlternateFeeds, type AlternateFeedLink } from './html-links.js';
import { cleanLabel } from './text.js';

/** One deadline shared by every request of a discovery, redirects included (spec 03 §10 step 6). */
export const DISCOVERY_DEADLINE_MS = 20_000;
/** HTTP requests one discovery may send, redirect hops included (spec 03 §10 step 6). */
export const DISCOVERY_MAX_REQUESTS = 10;
/** Candidate and probe fetches in flight at once (spec 03 §10 step 6). */
export const DISCOVERY_MAX_CONCURRENT_PROBES = 2;
/** Most candidates one discovery returns (spec 03 §10 step 6). */
export const DISCOVERY_MAX_CANDIDATES = 20;
/** Same-origin paths probed, in this order, when a page declares no feed (spec 03 §10 step 3). */
export const FEED_PROBE_PATHS: readonly string[] = Object.freeze([
  '/feed',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/feed.xml',
  '/index.xml',
]);

/** `safeFetch` follows at most this many redirects per fetch (spec 03 §4.3). */
const MAX_REDIRECTS_PER_FETCH = 5;

/**
 * Transport failures after which a scheme-less input is retried over `http://` (spec 03 §10
 * step 6). TLS errors, address policy (`FEED_BLOCKED_ADDRESS`), DNS answers (the same host fails
 * the same way) and HTTP responses never fall back.
 */
const TRANSPORT_FAILURES: ReadonlySet<string> = new Set(['FEED_CONNECTION_ERROR', 'FEED_TIMEOUT']);

/**
 * Candidate failures that say nothing about whether the URL is a feed: the request ran out of time
 * or the origin asked us to come back later (spec 03 §8.2 cooldowns). When no candidate verifies,
 * the first of these is reported (with its `retryAt`) instead of `FEED_NOT_A_FEED`.
 */
const INCONCLUSIVE_FAILURES: ReadonlySet<string> = new Set([
  'FEED_TIMEOUT',
  'FEED_ORIGIN_COOLDOWN',
  'FEED_HTTP_429',
  'FEED_HTTP_503',
]);

/** A verified feed that discovery offers (spec 08 §4 `POST /subscriptions`). */
export interface FeedCandidate {
  /** Validated fetch URL (`feeds.fetch_url`); the final URL when every redirect was permanent. */
  url: string;
  /** Canonical identity (`feeds.url`, spec 03 §5): an existing feed row with it is reused. */
  canonicalUrl: string;
  /** The feed's own title, else the declaring `<link title>`, else `null`. */
  title: string | null;
  type: FeedKind;
}

/** Options discovery passes to {@link DiscoverDeps.fetch}. */
export interface DiscoveryFetchOptions {
  /** `discovery` for the user's URL, `feed` for candidates and probes. */
  purpose: 'discovery' | 'feed';
  /** What remains of the shared discovery deadline. */
  timeoutMs: number;
  /** Aborts a probe that is no longer needed, or the whole discovery (`DiscoverDeps.signal`). */
  signal?: AbortSignal;
  /** Redirect hops this fetch may follow within the request budget (at most 5). */
  maxRedirects?: number;
}

/** I/O of {@link discoverFeed}, injected so apps wire `safeFetch` and tests use fakes. */
export interface DiscoverDeps {
  /** `safeFetch` bound to the user agent, body cap, origin limiter and `allowPrivate`. */
  fetch: (url: string, options: DiscoveryFetchOptions) => Promise<SafeFetchResult>;
  /** `parseFeed` (spec 03 §6). */
  parse: (text: string, options: { url: string; contentType?: string }) => Promise<ParseFeedResult>;
  /** `decodeBody` (spec 03 §4). */
  decode: (bytes: Uint8Array, contentType: string | undefined) => DecodeResult;
  /** Epoch-ms clock for the shared deadline (default `Date.now`). */
  now?: () => number;
  /** `FETCH_ALLOW_PRIVATE`: URL validation accepts private addresses and any port. */
  allowPrivate?: boolean;
  /** One shared deadline for the whole discovery (default {@link DISCOVERY_DEADLINE_MS}). */
  deadlineMs?: number;
  /** HTTP request budget, redirect hops included (default {@link DISCOVERY_MAX_REQUESTS}). */
  maxRequests?: number;
  /** Concurrent candidate/probe fetches (default {@link DISCOVERY_MAX_CONCURRENT_PROBES}). */
  maxConcurrentProbes?: number;
  /** Cancels the discovery, e.g. when the API client disconnects. */
  signal?: AbortSignal;
}

export interface DiscoverySuccess {
  ok: true;
  /** One → subscribe; several → the user chooses (spec 08 §4). Verified, deduplicated, ≤ 20. */
  candidates: FeedCandidate[];
  /**
   * Present when there is exactly one candidate: the parse of its only fetch, reused for the title
   * instead of downloading the feed a second time (spec 03 §10 step 6).
   */
  validated?: { candidate: FeedCandidate; parsed: ParsedFeed };
}

export interface DiscoveryFailure {
  ok: false;
  /**
   * `FEED_INVALID_URL` / `FEED_BLOCKED_ADDRESS` (URL validation), a `safeFetch` code of the user's
   * URL, `FEED_DECODE_ERROR`, `FEED_PARSE_ERROR` (the URL is a broken feed), `FEED_NOT_A_FEED`,
   * `FEED_TIMEOUT` (deadline or cancellation), an inconclusive candidate failure, or `INTERNAL`
   * when an injected dependency rejected (e.g. the origin limiter's database is down).
   */
  code: string;
  /** English, log-safe: never contains a URL or a query. */
  message: string;
  /** When to try again (origin cooldown, `Retry-After`). */
  retryAt?: Date;
  /** Why URL validation rejected the input (`FEED_INVALID_URL` / `FEED_BLOCKED_ADDRESS`). */
  reason?: FeedUrlRejection;
  /** The rejection of an injected dependency (`INTERNAL` only), for the caller's error log. */
  cause?: unknown;
}

export type DiscoverResult = DiscoverySuccess | DiscoveryFailure;

/**
 * Feed discovery for `POST /subscriptions` (spec 03 §10, spec 08 §4). Never throws.
 *
 * 1. The input is trimmed; without a scheme (`example.com/blog`, `example.com:8080`) it is tried as
 *    `https://…`, then as `http://…` only if the HTTPS attempt failed in transport
 *    (`FEED_CONNECTION_ERROR`, `FEED_TIMEOUT`), never after a TLS, address-policy, DNS or HTTP
 *    failure. Every URL passes `validateFeedUrl` before it is requested.
 * 2. A response that parses as a feed is the single candidate.
 * 3. A response that `sniffFeed` (spec 03 §6) calls HTML: its `<link rel="alternate">` feeds
 *    (`findAlternateFeeds`; RSS, Atom and JSON Feed types first, plain `application/json` last) are
 *    validated, deduplicated by canonical URL, capped at 20, and each is fetched and parsed:
 *    declaring is not proof. When none of them is a feed, {@link FEED_PROBE_PATHS} are probed on
 *    the page's final origin in order, and the first path (in that order) that parses as a feed is
 *    the candidate. Any other response fails with its parse error (`FEED_NOT_A_FEED`, or
 *    `FEED_PARSE_ERROR` for a broken feed).
 * 4. Candidates are the verified feeds, deduplicated by canonical URL. A candidate's URL becomes
 *    the final URL only when every redirect was permanent (spec 03 §4.3: a temporary destination
 *    is never stored). With exactly one candidate, `validated` carries its parse.
 * 5. No candidate: `FEED_TIMEOUT` when the deadline cut discovery short, else the first
 *    inconclusive candidate failure (timeout, origin cooldown, 429, 503), else `FEED_NOT_A_FEED`.
 *
 * All requests share one deadline (`deadlineMs`, 20 s) and a budget of `maxRequests` (10) HTTP
 * requests; each fetch counts 1 plus the redirect hops it reports and may follow at most the hops
 * left in the budget and not reserved by fetches in flight, so concurrent probes can never exceed
 * it together. Candidates and probes run at most `maxConcurrentProbes` (2) at a time; a probe that
 * can no longer win is aborted.
 */
export async function discoverFeed(input: string, deps: DiscoverDeps): Promise<DiscoverResult> {
  try {
    return await new Discovery(deps).run(input);
  } catch (error) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: 'Feed discovery failed unexpectedly',
      cause: error,
    };
  }
}

type AcceptedUrl = Extract<FeedUrlCheck, { ok: true }>;

interface QueueItem {
  accepted: AcceptedUrl;
  /** The declaring `<link title>`, used when the feed has no title of its own. */
  linkTitle: string | null;
}

interface VerifiedFeed {
  candidate: FeedCandidate;
  parsed: ParsedFeed;
}

type Verification =
  | ({ kind: 'feed' } & VerifiedFeed)
  | { kind: 'not_a_feed' }
  | { kind: 'failed'; failure: SafeFetchFailure }
  | { kind: 'skipped' };

/** State of one discovery: the shared deadline, the request budget and why work stopped. */
class Discovery {
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly maxRequests: number;
  private readonly concurrency: number;
  private readonly allowPrivate: boolean;
  private requests = 0;
  /**
   * Redirect hops reserved by fetches in flight: each fetch reserves its hop allowance before it
   * starts, so concurrent fetches can never follow more redirects together than the budget has.
   * A finished fetch charges the hops it followed and releases the rest.
   */
  private reserved = 0;
  /** Wakes probes waiting for a fetch in flight to release its reserved hops. */
  private released: Array<() => void> = [];
  private deadlineReached = false;
  private budgetExhausted = false;
  private cancelled = false;
  private crashed = false;

  constructor(private readonly deps: DiscoverDeps) {
    this.now = deps.now ?? Date.now;
    this.deadline = this.now() + (deps.deadlineMs ?? DISCOVERY_DEADLINE_MS);
    this.maxRequests = deps.maxRequests ?? DISCOVERY_MAX_REQUESTS;
    this.concurrency = Math.max(
      1,
      Math.floor(deps.maxConcurrentProbes ?? DISCOVERY_MAX_CONCURRENT_PROBES),
    );
    this.allowPrivate = deps.allowPrivate === true;
  }

  async run(input: string): Promise<DiscoverResult> {
    const attempts = fetchAttempts(input);
    if (attempts === null) return urlFailure('invalid_url');
    let failure: SafeFetchFailure | undefined;
    for (const attempt of attempts) {
      const accepted = this.accept(attempt);
      if (!accepted.ok) return urlFailure(accepted.reason);
      if (!this.canStart()) break;
      const response = await this.fetch(accepted.fetchUrl, 'discovery');
      if (response.ok) return await this.fromPage(accepted, response);
      failure = response;
      if (!TRANSPORT_FAILURES.has(response.code)) break;
    }
    return failure === undefined ? this.stoppedFailure() : fetchFailure(failure);
  }

  /** Steps 2–5 for the fetched user URL. */
  private async fromPage(
    accepted: AcceptedUrl,
    response: SafeFetchSuccess,
  ): Promise<DiscoverResult> {
    const contentType = response.headers['content-type'];
    const decoded = this.deps.decode(response.bodyBytes, contentType);
    if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
    const parsed = await this.parse(decoded.text, response.finalUrl, contentType);
    if (parsed.ok) return conclude([this.verified(accepted, response, parsed, null)]);
    if (sniffFeed(decoded.text, contentType) !== 'html') {
      return { ok: false, code: parsed.code, message: parsed.message };
    }

    const tried = new Set<string>([accepted.canonicalUrl]);
    const finalIdentity = canonicalizeUrl(response.finalUrl);
    if (finalIdentity.ok) tried.add(finalIdentity.url);

    const links = findAlternateFeeds(decoded.text, response.finalUrl);
    const alternates = this.queue(prioritized(links), tried);
    const verifications = await this.verifyAll(alternates, false);
    let feeds = feedsOf(verifications);
    if (feeds.length === 0) {
      const probes = this.queue(probeLinks(response.finalUrl), tried);
      const probeVerifications = await this.verifyAll(probes, true);
      verifications.push(...probeVerifications);
      feeds = feedsOf(probeVerifications).slice(0, 1);
    }
    return feeds.length > 0 ? conclude(feeds) : this.noFeed(verifications);
  }

  /** Validated, not yet tried links, in order, at most {@link DISCOVERY_MAX_CANDIDATES}. */
  private queue(links: readonly CandidateLink[], tried: Set<string>): QueueItem[] {
    const items: QueueItem[] = [];
    for (const link of links) {
      if (items.length >= DISCOVERY_MAX_CANDIDATES) break;
      const accepted = this.accept(link.url);
      if (!accepted.ok || tried.has(accepted.canonicalUrl)) continue;
      tried.add(accepted.canonicalUrl);
      items.push({ accepted, linkTitle: link.title });
    }
    return items;
  }

  /**
   * Fetches and parses queued candidates, at most `concurrency` at a time, in queue order, while
   * the deadline and budget allow. With `firstFeedWins`, no item after a verified one is started
   * and those in flight are aborted, so the earliest feed in queue order wins.
   */
  private async verifyAll(
    queue: readonly QueueItem[],
    firstFeedWins: boolean,
  ): Promise<Verification[]> {
    const results: Verification[] = queue.map(() => ({ kind: 'skipped' }));
    const inFlight = new Map<number, AbortController>();
    let next = 0;
    let winner = Number.POSITIVE_INFINITY;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        const item = queue[index];
        if (item === undefined || index > winner) return;
        if (this.reservedOut()) {
          // Only hops reserved by a fetch in flight block this start: wait until it finishes.
          await new Promise<void>((resolve) => this.released.push(resolve));
          continue;
        }
        if (!this.canStart()) return;
        next += 1;
        const controller = new AbortController();
        inFlight.set(index, controller);
        let result: Verification;
        try {
          result = await this.verify(item, controller.signal);
        } catch (error) {
          this.crashed = true;
          for (const other of inFlight.values()) other.abort();
          throw error;
        } finally {
          inFlight.delete(index);
        }
        results[index] = result;
        if (firstFeedWins && result.kind === 'feed' && index < winner) {
          winner = index;
          for (const [other, pending] of inFlight) if (other > index) pending.abort();
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, worker);
    for (const settled of await Promise.allSettled(workers)) {
      if (settled.status === 'rejected') throw settled.reason;
    }
    return results;
  }

  private async verify(item: QueueItem, signal: AbortSignal): Promise<Verification> {
    const response = await this.fetch(item.accepted.fetchUrl, 'feed', signal);
    if (!response.ok) return { kind: 'failed', failure: response };
    const contentType = response.headers['content-type'];
    const decoded = this.deps.decode(response.bodyBytes, contentType);
    if (!decoded.ok) return { kind: 'not_a_feed' };
    const parsed = await this.parse(decoded.text, response.finalUrl, contentType);
    if (!parsed.ok) return { kind: 'not_a_feed' };
    return { kind: 'feed', ...this.verified(item.accepted, response, parsed, item.linkTitle) };
  }

  /** The candidate for a feed fetched from `accepted` (step 4). */
  private verified(
    accepted: AcceptedUrl,
    response: SafeFetchSuccess,
    result: Extract<ParseFeedResult, { ok: true }>,
    linkTitle: string | null,
  ): VerifiedFeed {
    let adopted = accepted;
    if (response.permanentRedirect) {
      const final = this.accept(response.finalUrl);
      if (final.ok) adopted = final;
    }
    const { ok: _ok, ...parsed } = result;
    return {
      candidate: {
        url: adopted.fetchUrl,
        canonicalUrl: adopted.canonicalUrl,
        title: cleanLabel(parsed.feed.title) ?? linkTitle,
        type: parsed.kind,
      },
      parsed,
    };
  }

  /** Why no candidate verified (step 5). */
  private noFeed(verifications: readonly Verification[]): DiscoveryFailure {
    if (this.cancelled || this.deadlineReached) return this.stoppedFailure();
    for (const verification of verifications) {
      if (verification.kind === 'failed' && INCONCLUSIVE_FAILURES.has(verification.failure.code)) {
        return fetchFailure(verification.failure);
      }
    }
    return {
      ok: false,
      code: 'FEED_NOT_A_FEED',
      message: this.budgetExhausted
        ? `No feed was found within the budget of ${this.maxRequests} requests`
        : 'No feed was found at this address',
    };
  }

  /** The failure when work stopped before any response: cancellation, deadline or budget. */
  private stoppedFailure(): DiscoveryFailure {
    if (this.cancelled) {
      return { ok: false, code: 'FEED_TIMEOUT', message: 'Feed discovery was cancelled' };
    }
    if (this.deadlineReached) {
      return {
        ok: false,
        code: 'FEED_TIMEOUT',
        message: 'Feed discovery ran out of time before it found a feed',
      };
    }
    return {
      ok: false,
      code: 'FEED_NOT_A_FEED',
      message: `No feed was found within the budget of ${this.maxRequests} requests`,
    };
  }

  /** Whether another request may start; records why not. */
  private canStart(): boolean {
    if (this.crashed) return false;
    if (this.deps.signal?.aborted === true) {
      this.cancelled = true;
      return false;
    }
    if (this.now() >= this.deadline) {
      this.deadlineReached = true;
      return false;
    }
    if (this.requests >= this.maxRequests) {
      this.budgetExhausted = true;
      return false;
    }
    return true;
  }

  /**
   * Whether the budget left after the requests sent is fully reserved by fetches in flight: a new
   * request must wait for one of them to release its unused hops (it is not exhausted yet).
   */
  private reservedOut(): boolean {
    return (
      this.reserved > 0 &&
      this.requests < this.maxRequests &&
      this.requests + this.reserved >= this.maxRequests
    );
  }

  /** One budgeted fetch; the caller has checked {@link canStart}. */
  private async fetch(
    url: string,
    purpose: DiscoveryFetchOptions['purpose'],
    signal?: AbortSignal,
  ): Promise<SafeFetchResult> {
    // The request itself, then as many redirect hops as the unreserved budget still allows.
    this.requests += 1;
    const hops = Math.max(
      0,
      Math.min(MAX_REDIRECTS_PER_FETCH, this.maxRequests - this.requests - this.reserved),
    );
    this.reserved += hops;
    const options: DiscoveryFetchOptions = {
      purpose,
      timeoutMs: Math.max(1, this.deadline - this.now()),
      maxRedirects: hops,
    };
    const combined = anySignal(signal, this.deps.signal);
    if (combined !== undefined) options.signal = combined;
    try {
      const result = await this.deps.fetch(url, options);
      this.requests += Math.min(hops, result.redirects?.length ?? 0);
      return result;
    } finally {
      this.reserved -= hops;
      for (const wake of this.released.splice(0)) wake();
    }
  }

  /** `parseFeed` with the response's final URL as the base for relative links. */
  private parse(
    text: string,
    url: string,
    contentType: string | undefined,
  ): Promise<ParseFeedResult> {
    return this.deps.parse(text, contentType === undefined ? { url } : { url, contentType });
  }

  private accept(url: string): FeedUrlCheck {
    return validateFeedUrl(url, { allowPrivate: this.allowPrivate });
  }
}

/** What {@link Discovery.queue} reads from a declared link or a probe path. */
type CandidateLink = Pick<AlternateFeedLink, 'url' | 'title'>;

/** A scheme at the start of the input; `host:8080/…` (a digit after the colon) is not one. */
const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:(?!\d)/i;

/** The URLs to try for the user's input (step 1), or `null` for an empty input. */
function fetchAttempts(input: string): string[] | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (EXPLICIT_SCHEME.test(trimmed)) return [trimmed];
  const authority = trimmed.startsWith('//') ? trimmed : `//${trimmed}`;
  return [`https:${authority}`, `http:${authority}`];
}

/** Feed-specific link types first, generic `application/json` (often an API, not a feed) last. */
function prioritized(links: readonly AlternateFeedLink[]): AlternateFeedLink[] {
  return [
    ...links.filter((link) => link.type !== 'application/json'),
    ...links.filter((link) => link.type === 'application/json'),
  ];
}

function probeLinks(pageUrl: string): CandidateLink[] {
  return FEED_PROBE_PATHS.map((path) => ({ url: new URL(path, pageUrl).href, title: null }));
}

function feedsOf(verifications: readonly Verification[]): VerifiedFeed[] {
  const feeds: VerifiedFeed[] = [];
  for (const verification of verifications) {
    if (verification.kind === 'feed') {
      feeds.push({ candidate: verification.candidate, parsed: verification.parsed });
    }
  }
  return feeds;
}

/** Deduplicates verified feeds by canonical URL (two links may redirect to one feed). */
function conclude(feeds: readonly VerifiedFeed[]): DiscoverySuccess {
  const seen = new Set<string>();
  const unique: VerifiedFeed[] = [];
  for (const feed of feeds) {
    if (seen.has(feed.candidate.canonicalUrl)) continue;
    seen.add(feed.candidate.canonicalUrl);
    unique.push(feed);
    if (unique.length >= DISCOVERY_MAX_CANDIDATES) break;
  }
  const [only] = unique;
  if (unique.length === 1 && only !== undefined) {
    return { ok: true, candidates: [only.candidate], validated: only };
  }
  return { ok: true, candidates: unique.map((feed) => feed.candidate) };
}

function fetchFailure(failure: SafeFetchFailure): DiscoveryFailure {
  return {
    ok: false,
    code: failure.code,
    message: failure.message,
    ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
  };
}

const URL_REJECTION_MESSAGES: Readonly<Record<FeedUrlRejection, string>> = {
  invalid_url: 'The address is not a valid URL',
  unsupported_scheme: 'Only http and https feed addresses are supported',
  credentials:
    'Feed addresses must not contain a user name or password: only public feeds can be subscribed',
  credential_param:
    'Feed addresses must not contain credential parameters (token, access_token, api_key, auth, ' +
    'password): only public feeds can be subscribed',
  blocked_address: 'The address is not a public internet destination',
  too_long: 'The feed address is too long',
};

function urlFailure(reason: FeedUrlRejection): DiscoveryFailure {
  return {
    ok: false,
    code: reason === 'blocked_address' ? 'FEED_BLOCKED_ADDRESS' : 'FEED_INVALID_URL',
    message: URL_REJECTION_MESSAGES[reason],
    reason,
  };
}

function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}
