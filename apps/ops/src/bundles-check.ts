import { decodeBody, parseFeed, safeFetch, type SafeFetchOptions } from '@bantoozi/feeds';
import type { StarterBundle, StarterFeedLang } from '@bantoozi/shared';
import { detectLanguage } from '@bantoozi/shared/server';

export interface BundleFeed {
  bundle: string;
  url: string;
  lang: StarterFeedLang;
}

export type FeedStatus = 'ok' | 'failed' | 'lang-mismatch';

export interface FeedCheckResult {
  bundle: string;
  url: string;
  declaredLang: StarterFeedLang;
  status: FeedStatus;
  httpStatus: number | null;
  /** Failure code (`FEED_HTTP_404`, `FEED_NOT_A_FEED`, …) or null. */
  code: string | null;
  message: string | null;
  items: number;
  /** ISO 639-1 of the first items' text, `und` when too short, null when nothing was parsed. */
  detectedLang: string | null;
}

export interface BundlesReport {
  generatedAt: string;
  results: FeedCheckResult[];
  summary: { total: number; ok: number; failed: number; langMismatch: number };
}

const LANGS = new Set(['en', 'sk', 'cs']);
/** Items whose text feeds the language check. */
const SAMPLE_ITEMS = 10;

/** Data validation without network: https addresses, no duplicates, `lang` set. Returns problems. */
export function validateBundles(bundles: readonly StarterBundle[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles) {
    for (const feed of bundle.feeds) {
      const where = `${bundle.id}: ${feed.url}`;
      if (!URL.canParse(feed.url) || new URL(feed.url).protocol !== 'https:') {
        problems.push(`${where} is not an https address`);
      }
      if (seen.has(feed.url)) problems.push(`${where} is a duplicate address`);
      seen.add(feed.url);
      if (!LANGS.has(feed.lang)) problems.push(`${where} has no valid lang (en, sk or cs)`);
    }
  }
  return problems;
}

export function flattenBundles(bundles: readonly StarterBundle[]): BundleFeed[] {
  return bundles.flatMap((bundle) =>
    bundle.feeds.map((feed) => ({ bundle: bundle.id, url: feed.url, lang: feed.lang })),
  );
}

export interface LiveOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Local fixture servers only (FETCH_ALLOW_PRIVATE). */
  allowPrivate?: boolean;
  concurrency?: number;
  now?: Date;
}

async function checkOne(feed: BundleFeed, options: LiveOptions): Promise<FeedCheckResult> {
  const base = {
    bundle: feed.bundle,
    url: feed.url,
    declaredLang: feed.lang,
    httpStatus: null,
    code: null,
    message: null,
    items: 0,
    detectedLang: null,
  } satisfies Omit<FeedCheckResult, 'status'>;
  const failed = (code: string, message: string, httpStatus: number | null = null) =>
    ({ ...base, status: 'failed', code, message, httpStatus }) satisfies FeedCheckResult;

  const fetchOptions: SafeFetchOptions = {
    purpose: 'feed',
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 5_242_880,
    ...(options.allowPrivate === true ? { allowPrivate: true } : {}),
  };
  const response = await safeFetch(feed.url, fetchOptions);
  if (!response.ok) return failed(response.code, response.message, response.status ?? null);

  const contentType = response.headers['content-type'];
  const decoded = decodeBody(response.bodyBytes, contentType);
  if (!decoded.ok) return failed(decoded.code, decoded.message, response.status);
  const parsed = await parseFeed(decoded.text, {
    url: response.finalUrl,
    ...(contentType === undefined ? {} : { contentType }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!parsed.ok) return failed(parsed.code, parsed.message, response.status);

  const text = parsed.items
    .slice(0, SAMPLE_ITEMS)
    .map((item) => `${item.title}. ${item.excerpt ?? ''}`)
    .join('\n');
  const detectedLang = detectLanguage(text).lang;
  const mismatch = detectedLang !== 'und' && detectedLang !== feed.lang;
  return {
    ...base,
    status: mismatch ? 'lang-mismatch' : 'ok',
    httpStatus: response.status,
    items: parsed.items.length,
    detectedLang,
  };
}

/** Fetches every feed through the SSRF-safe client, parses it and compares the language. */
export async function checkBundlesLive(
  feeds: readonly BundleFeed[],
  options: LiveOptions,
): Promise<BundlesReport> {
  const results: FeedCheckResult[] = new Array<FeedCheckResult>(feeds.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? 4, feeds.length) },
    async () => {
      for (;;) {
        const index = next++;
        const feed = feeds[index];
        if (feed === undefined) return;
        try {
          results[index] = await checkOne(feed, options);
        } catch (error) {
          results[index] = {
            bundle: feed.bundle,
            url: feed.url,
            declaredLang: feed.lang,
            status: 'failed',
            httpStatus: null,
            code: 'CHECK_ERROR',
            message: error instanceof Error ? error.message : String(error),
            items: 0,
            detectedLang: null,
          };
        }
      }
    },
  );
  await Promise.all(workers);
  const count = (status: FeedStatus) => results.filter((r) => r.status === status).length;
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    results,
    summary: {
      total: results.length,
      ok: count('ok'),
      failed: count('failed'),
      langMismatch: count('lang-mismatch'),
    },
  };
}

export function renderMarkdown(report: BundlesReport): string {
  const { summary } = report;
  const lines = [
    '# Starter bundle live check',
    '',
    `Generated ${report.generatedAt}. ${summary.total} feeds: ${summary.ok} ok, ` +
      `${summary.failed} failed, ${summary.langMismatch} lang-mismatch.`,
    '',
    '| Bundle | Feed | Status | HTTP | Items | Declared | Detected | Code |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.results.map(
      (r) =>
        `| ${r.bundle} | ${r.url} | ${r.status} | ${r.httpStatus ?? ''} | ${r.items} | ` +
        `${r.declaredLang} | ${r.detectedLang ?? ''} | ${r.code ?? ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
