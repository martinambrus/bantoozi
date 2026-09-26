import type { SafeFetchResult } from '../http/index.js';
import type { RobotsChecker } from './robots.js';

/** `article_bodies.status` (spec 02): the terminal outcome of one extraction attempt. */
export type ExtractStatus = 'ok' | 'skipped' | 'blocked' | 'not_html' | 'too_large' | 'failed';

/** The outcome of extracting one article page (spec 03 §8.1 steps 1–6). */
export interface ExtractResult {
  status: ExtractStatus;
  /** Final URL after redirects (spec 03 §8.1 step 3); `null` when nothing was fetched. */
  resolvedUrl: string | null;
  httpStatus: number | null;
  /** The full readable text with paragraph boundaries (never the lead limit). */
  bodyText: string | null;
  /** The full sanitized readable fragment (`sanitizeHtml`, spec 03 §6.3). */
  bodyHtml: string | null;
  bodyLead: string | null;
  wordCount: number | null;
  completeness: 'complete' | 'partial';
  /**
   * Why the result is partial or absent: `paywall`, `teaser`, `truncated`, `no_content`,
   * `extraction_failed`, `skip_host`/`skip_extension`/`skip_media`, `robots`, `not_html`,
   * `too_large`, `cooldown`, `fetch_failed`, `decode_failed`; `null` when complete.
   */
  completenessReason: string | null;
  /**
   * An accepted `rel=canonical` (canonicalized): same registrable domain via `tldts` with the private
   * suffix list (exact host equality when there is no registrable domain), http(s) without
   * credentials, not a home/list page, no conflicting canonicals. The worker canonicalizes and
   * aliases/merges it (spec 03 §8.1 step 5, §8.4).
   */
  canonicalUrl: string | null;
  /** A bounded code, e.g. `no_content`, `robots_disallowed`, `FEED_TIMEOUT`, `FEED_HTTP_404`. */
  error: string | null;
  /** The origin is cooling down: the caller defers the job until then instead of failing it. */
  deferUntil: Date | null;
}

/** The robots policy callback `safeFetch` invokes before every request of a redirect chain. */
export type BeforeRequest = (
  url: URL,
  hop: number,
) => Promise<true | { code: string; message: string }>;

/**
 * Options of the page fetch; the worker binds `safeFetch` with its configuration. Purpose `page`
 * sends `Accept: text/html,application/xhtml+xml` (spec 03 §8.1 step 3).
 */
export interface PageFetchOptions {
  purpose: 'page';
  beforeRequest: BeforeRequest;
}

export interface ExtractDeps {
  /** Page fetch: the worker binds `safeFetch` with its config; tests pass fakes. */
  fetch: (url: string, options: PageFetchOptions) => Promise<SafeFetchResult>;
  robots: RobotsChecker;
  /** Max UTF-8 bytes of body_text + body_html; defaults to 10 MiB. */
  maxOutputBytes?: number;
  /** Clock in epoch ms for a cooldown without `retryAt`; defaults to `Date.now`. */
  now?: () => number;
}

export interface ExtractArticleOptions {
  /** MIME type when the chosen article URL is the entry's enclosure (spec 03 §8.1 step 1). */
  enclosureType?: string | null;
}

/** The fields `extractFromHtml` produces; the fetch-related ones come from `extractArticle`. */
export type HtmlExtractResult = Omit<ExtractResult, 'resolvedUrl' | 'httpStatus' | 'deferUntil'>;
