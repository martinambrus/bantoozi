import { decodeBody, parseFeed, redactFeedUrl, safeFetch, type Resolver } from '@bantoozi/feeds';

import type { GoldenFeed } from './feed-list.js';

/**
 * `eval ingest-sample --dry-run` (spec 10 §2.1): fetch every golden feed once through the SSRF-safe
 * client (spec 03 §4) with the eval process's fetch limits and report whether it answers and parses
 * as a feed. Nothing is written to the database.
 */

export interface ProbeOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
  /** Parallel probes; default 6. */
  concurrency?: number;
  resolver?: Resolver;
  now?: () => Date;
}

export type ProbeResult =
  | {
      feed: GoldenFeed;
      ok: true;
      status: number;
      kind: string;
      items: number;
      langHint: string | null;
      title: string | null;
      /** Set when the request was redirected. */
      finalUrl: string | null;
      ms: number;
    }
  | {
      feed: GoldenFeed;
      ok: false;
      code: string;
      status: number | null;
      message: string;
      ms: number;
    };

export async function probeFeed(feed: GoldenFeed, options: ProbeOptions): Promise<ProbeResult> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const elapsed = () => Math.max(0, now().getTime() - started);
  const fetched = await safeFetch(feed.url, {
    purpose: 'feed',
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    allowPrivate: options.allowPrivate,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  });
  if (!fetched.ok) {
    return {
      feed,
      ok: false,
      code: fetched.code,
      status: fetched.status ?? null,
      message: fetched.message,
      ms: elapsed(),
    };
  }
  const contentType = fetched.headers['content-type'];
  const decoded = decodeBody(fetched.bodyBytes, contentType);
  if (!decoded.ok) {
    return {
      feed,
      ok: false,
      code: decoded.code,
      status: fetched.status,
      message: decoded.message,
      ms: elapsed(),
    };
  }
  const parsed = await parseFeed(decoded.text, {
    url: fetched.finalUrl,
    contentType,
    now: now(),
  });
  if (!parsed.ok) {
    return {
      feed,
      ok: false,
      code: parsed.code,
      status: fetched.status,
      message: parsed.message,
      ms: elapsed(),
    };
  }
  return {
    feed,
    ok: true,
    status: fetched.status,
    kind: parsed.kind,
    items: parsed.items.length,
    langHint: parsed.feed.langHint,
    title: parsed.feed.title,
    finalUrl: fetched.finalUrl === feed.url ? null : redactFeedUrl(fetched.finalUrl),
    ms: elapsed(),
  };
}

/** Probe every feed, at most `concurrency` at a time; results keep the list's order. */
export async function probeFeeds(
  feeds: readonly GoldenFeed[],
  options: ProbeOptions,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array<ProbeResult>(feeds.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const feed = feeds[index];
      if (feed === undefined) return;
      results[index] = await probeFeed(feed, options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 6, feeds.length) }, () => worker()),
  );
  return results;
}

/** One line per feed and a summary per language. */
export function formatProbeReport(results: readonly ProbeResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const head = `${r.feed.lang}  ${r.feed.category.padEnd(11)}`;
    const tags = r.feed.tags.length > 0 ? `  [${r.feed.tags.join(', ')}]` : '';
    if (r.ok) {
      const lang =
        r.langHint === null
          ? ''
          : r.langHint === r.feed.lang
            ? `, lang ${r.langHint}`
            : `, lang ${r.langHint} (listed as ${r.feed.lang})`;
      const moved = r.finalUrl === null ? '' : `, redirected to ${r.finalUrl}`;
      lines.push(
        `ok    ${head} ${redactFeedUrl(r.feed.url)}  ${r.kind}, ${r.items} items${lang}${moved}, ${r.ms} ms${tags}`,
      );
    } else {
      const status = r.status === null ? '' : ` (HTTP ${r.status})`;
      lines.push(
        `FAIL  ${head} ${redactFeedUrl(r.feed.url)}  ${r.code}${status}: ${r.message}${tags}`,
      );
    }
  }
  const langs = [...new Set(results.map((r) => r.feed.lang))];
  lines.push('');
  for (const lang of langs) {
    const own = results.filter((r) => r.feed.lang === lang);
    const ok = own.filter((r) => r.ok).length;
    lines.push(`${lang}: ${ok}/${own.length} reachable`);
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    failed === 0 ? 'all feeds reachable' : `${failed} feed(s) unreachable or not parseable`,
  );
  return `${lines.join('\n')}\n`;
}
