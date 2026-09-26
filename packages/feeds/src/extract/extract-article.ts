import { decodeBody, DEFAULT_COOLDOWN_MS, type SafeFetchResult } from '../http/index.js';
import { extractFromHtml } from './extract-html.js';
import type { RobotsDecision } from './robots.js';
import { type ExtractionSkipReason, extractionSkipReason } from './skip-list.js';
import type { BeforeRequest, ExtractArticleOptions, ExtractDeps, ExtractResult } from './types.js';

/** Stored as `article_bodies.extractor_version` / `article_snapshots.extractor_version`. */
export const EXTRACTOR_VERSION = 'readability-v1';

const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** Tab, LF, FF, CR and space: what may precede the first `<` of untyped markup. */
const HTML_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

type PageFailure = Extract<SafeFetchResult, { ok: false }>;

/** Why the redirect policy callback stopped the chain. */
type Denial = { url: string; skip: ExtractionSkipReason } | { url: string; robots: RobotsDecision };

/**
 * `article.extract` steps 1–6 for one linked article URL (spec 03 §8.1); the worker handles
 * linkless items, redirect/canonical aliases and merges, language, storage and pipeline advance.
 * Never throws.
 *
 * 1. Skip list → `skipped` without a request (reason `skip_host`/`skip_extension`/`skip_media`).
 * 2. robots.txt for the article URL (`deps.robots`) → `blocked` (reason `robots`, error
 *    `robots_disallowed` or `robots_unreachable`); a cooling-down origin defers the job
 *    (`deferUntil`) instead of failing it.
 * 3. Fetch through `deps.fetch` (purpose `page`: `Accept: text/html,application/xhtml+xml`). Its
 *    `beforeRequest` callback re-checks robots, and the skip list, for every redirect destination
 *    before it is requested, so a disallowed destination is `blocked` and a skipped one `skipped`.
 *    Fetch failures keep their bounded code (`FEED_TIMEOUT`, `FEED_HTTP_404`, …); `FEED_TOO_LARGE`
 *    is `too_large`; `FEED_ORIGIN_COOLDOWN` and 429/503 results with `retryAt` defer the job.
 *    `resolvedUrl` is the final URL after redirects.
 * 4. A non-HTML `Content-Type` is `not_html` (without one, the body must start like markup); the
 *    body is decoded with `decodeBody` (HTTP charset, BOM, `<meta charset>`, then UTF-8).
 * 5–6. `extractFromHtml` on the decoded page with the final URL as its base.
 */
export async function extractArticle(
  url: string,
  deps: ExtractDeps,
  options: ExtractArticleOptions = {},
): Promise<ExtractResult> {
  try {
    return await extractLinkedArticle(url, deps, options);
  } catch {
    return outcome({
      status: 'failed',
      completenessReason: 'extraction_failed',
      error: 'extraction_failed',
    });
  }
}

async function extractLinkedArticle(
  url: string,
  deps: ExtractDeps,
  options: ExtractArticleOptions,
): Promise<ExtractResult> {
  const now = deps.now ?? Date.now;
  const skip = extractionSkipReason(url, options);
  if (skip !== null) return outcome({ status: 'skipped', completenessReason: skip });

  const target = URL.parse(url);
  if (target === null || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return outcome({
      status: 'failed',
      completenessReason: 'fetch_failed',
      error: 'FEED_INVALID_URL',
    });
  }
  const robots = await deps.robots.check(target);
  if (!robots.allowed) return robotsOutcome(robots, { resolvedUrl: null, httpStatus: null }, now);

  const policy: { denial: Denial | null } = { denial: null };
  const beforeRequest: BeforeRequest = async (next) => {
    // The article URL itself was checked above; every redirect destination is checked here.
    if (next.href === target.href) return true;
    const skipped = extractionSkipReason(next.href);
    if (skipped !== null) {
      policy.denial = { url: next.href, skip: skipped };
      return { code: skipped, message: 'redirect to a URL on the extraction skip list' };
    }
    const decision = await deps.robots.check(next);
    if (decision.allowed) return true;
    policy.denial = { url: next.href, robots: decision };
    return { code: robotsErrorCode(decision), message: `robots.txt check: ${decision.reason}` };
  };

  const response = await deps.fetch(url, { purpose: 'page', beforeRequest });
  if (!response.ok) return fetchFailure(response, policy.denial, now);

  const resolvedUrl = response.finalUrl;
  const httpStatus = response.status;
  if (httpStatus < 200 || httpStatus > 299) {
    return outcome({
      status: 'failed',
      resolvedUrl,
      httpStatus,
      completenessReason: 'fetch_failed',
      error: `FEED_HTTP_${httpStatus}`,
    });
  }
  const contentType = response.headers['content-type'];
  if (!isHtml(contentType, response.bodyBytes)) {
    return outcome({ status: 'not_html', resolvedUrl, httpStatus, completenessReason: 'not_html' });
  }
  const decoded = decodeBody(response.bodyBytes, contentType);
  if (!decoded.ok) {
    return outcome({
      status: 'failed',
      resolvedUrl,
      httpStatus,
      completenessReason: 'decode_failed',
      error: decoded.code,
    });
  }
  const extracted = extractFromHtml(
    decoded.text,
    resolvedUrl,
    deps.maxOutputBytes === undefined ? {} : { maxOutputBytes: deps.maxOutputBytes },
  );
  return { ...extracted, resolvedUrl, httpStatus, deferUntil: null };
}

function fetchFailure(
  response: PageFailure,
  denial: Denial | null,
  now: () => number,
): ExtractResult {
  const resolvedUrl = response.finalUrl ?? null;
  const httpStatus = response.status ?? null;
  if (response.code === 'FEED_POLICY_DENIED' && denial !== null) {
    if ('skip' in denial) {
      return outcome({
        status: 'skipped',
        resolvedUrl: resolvedUrl ?? denial.url,
        httpStatus,
        completenessReason: denial.skip,
      });
    }
    return robotsOutcome(
      denial.robots,
      { resolvedUrl: resolvedUrl ?? denial.url, httpStatus },
      now,
    );
  }
  if (response.code === 'FEED_ORIGIN_COOLDOWN' || response.retryAt !== undefined) {
    return deferred(response.retryAt, now, { resolvedUrl, httpStatus, error: response.code });
  }
  if (response.code === 'FEED_TOO_LARGE') {
    return outcome({
      status: 'too_large',
      resolvedUrl,
      httpStatus,
      completenessReason: 'too_large',
      error: response.code,
    });
  }
  return outcome({
    status: 'failed',
    resolvedUrl,
    httpStatus,
    completenessReason: 'fetch_failed',
    error:
      response.code === 'FEED_POLICY_DENIED'
        ? (response.policy?.code ?? response.code)
        : response.code,
  });
}

function robotsOutcome(
  decision: RobotsDecision,
  where: { resolvedUrl: string | null; httpStatus: number | null },
  now: () => number,
): ExtractResult {
  if (decision.reason === 'cooldown') {
    return deferred(decision.retryAt, now, { ...where, error: robotsErrorCode(decision) });
  }
  return outcome({
    ...where,
    status: 'blocked',
    completenessReason: 'robots',
    error: robotsErrorCode(decision),
  });
}

function robotsErrorCode(decision: RobotsDecision): string {
  switch (decision.reason) {
    case 'cooldown':
      return 'robots_cooldown';
    case 'unreachable':
      return 'robots_unreachable';
    default:
      return 'robots_disallowed';
  }
}

/** A cooling-down origin: the caller defers the job until `deferUntil` instead of failing it. */
function deferred(
  retryAt: Date | undefined,
  now: () => number,
  fields: { resolvedUrl: string | null; httpStatus: number | null; error: string },
): ExtractResult {
  return outcome({
    ...fields,
    status: 'failed',
    completenessReason: 'cooldown',
    deferUntil: retryAt ?? new Date(now() + DEFAULT_COOLDOWN_MS),
  });
}

/** Whether the response is HTML (spec 03 §8.1 step 3): by media type, or by markup if untyped. */
function isHtml(contentType: string | undefined, body: Uint8Array): boolean {
  const mediaType = contentType?.split(/[;,]/)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== '') return HTML_MEDIA_TYPES.has(mediaType);
  let index = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (index < body.length && HTML_WHITESPACE.has(body[index] ?? 0)) index += 1;
  return body[index] === 0x3c;
}

function outcome(fields: Partial<ExtractResult> & Pick<ExtractResult, 'status'>): ExtractResult {
  return {
    resolvedUrl: null,
    httpStatus: null,
    bodyText: null,
    bodyHtml: null,
    bodyLead: null,
    wordCount: null,
    completeness: 'partial',
    completenessReason: null,
    canonicalUrl: null,
    error: null,
    deferUntil: null,
    ...fields,
  };
}
