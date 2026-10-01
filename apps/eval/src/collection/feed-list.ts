import { readFile } from 'node:fs/promises';

import { validateFeedUrl } from '@bantoozi/feeds';
import { z } from 'zod';

/**
 * The golden feed list (spec 10 §2.1, `apps/eval/data/feeds-golden.txt`): one feed per line,
 * `<lang> <category> <url> [tag …]`, `#` comments. The format is documented in the file itself;
 * this module parses it with zod and checks the mix the spec asks for (18–22 feeds per language,
 * the seven categories, a Google News feed and a feed with poor excerpts).
 */

export const GOLDEN_LANGS = ['en', 'sk', 'cs'] as const;
export type GoldenLang = (typeof GOLDEN_LANGS)[number];

export const FEED_CATEGORIES = [
  'news',
  'tech',
  'science',
  'sport',
  'lifestyle',
  'local',
  'classifieds',
] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

export const FEED_TAGS = [
  'google-news',
  'poor-excerpts',
  'bot-sensitive',
  'legacy-charset',
] as const;
export type FeedTag = (typeof FEED_TAGS)[number];

/** Spec 10 §2.1: 18–22 feeds for each language. */
export const FEEDS_PER_LANG = { min: 18, max: 22 } as const;

export interface GoldenFeed {
  /** 1-based line number in the file (for messages). */
  line: number;
  lang: GoldenLang;
  category: FeedCategory;
  /** The URL as written (the fetch URL). */
  url: string;
  /** The canonical feed identity (`feeds.url`, spec 03 §5). */
  canonicalUrl: string;
  tags: FeedTag[];
}

const LineSchema = z.object({
  lang: z.enum(GOLDEN_LANGS),
  category: z.enum(FEED_CATEGORIES),
  url: z.url({ protocol: /^https?$/ }),
  tags: z.array(z.enum(FEED_TAGS)).max(FEED_TAGS.length),
});

export class FeedListError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid golden feed list:\n  - ${problems.join('\n  - ')}`);
    this.name = 'FeedListError';
    this.problems = problems;
  }
}

/** Remove a comment: `#` at the start of the line or after whitespace (URLs may contain `#`). */
function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line);
  return match === null ? line : line.slice(0, match.index);
}

/**
 * Parse the list. Every problem (syntax, an unknown language/category/tag, an invalid URL, a
 * duplicate canonical URL) is collected and reported together. `allowPrivate` lets fixture lists
 * point at a local server (tests; `FETCH_ALLOW_PRIVATE`).
 */
export function parseFeedList(
  text: string,
  options: { allowPrivate?: boolean } = {},
): GoldenFeed[] {
  const feeds: GoldenFeed[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const content = stripComment(raw).trim();
    if (content === '') return;
    const [lang, category, url, ...tags] = content.split(/\s+/);
    const parsed = LineSchema.safeParse({ lang, category, url, tags });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'line'}: ${i.message}`);
      problems.push(`line ${line}: ${issues.join('; ')}`);
      return;
    }
    if (new Set(parsed.data.tags).size !== parsed.data.tags.length) {
      problems.push(`line ${line}: duplicate tag`);
      return;
    }
    const checked = validateFeedUrl(
      parsed.data.url,
      options.allowPrivate === true ? { allowPrivate: true } : {},
    );
    if (!checked.ok) {
      problems.push(`line ${line}: url rejected (${checked.reason})`);
      return;
    }
    const earlier = seen.get(checked.canonicalUrl);
    if (earlier !== undefined) {
      problems.push(`line ${line}: duplicate of line ${earlier}`);
      return;
    }
    seen.set(checked.canonicalUrl, line);
    feeds.push({
      line,
      lang: parsed.data.lang,
      category: parsed.data.category,
      url: checked.fetchUrl,
      canonicalUrl: checked.canonicalUrl,
      tags: parsed.data.tags,
    });
  });
  if (problems.length > 0) throw new FeedListError(problems);
  if (feeds.length === 0) throw new FeedListError(['the list has no feeds']);
  return feeds;
}

export async function readFeedList(
  path: string,
  options: { allowPrivate?: boolean } = {},
): Promise<GoldenFeed[]> {
  return parseFeedList(await readFile(path, 'utf8'), options);
}

/**
 * The spec 10 §2.1 mix requirements the list does not meet (empty when it meets them all): 18–22
 * feeds per language, every category in every language, at least one Google News feed and at
 * least one feed with poor excerpts. Fixture lists in tests are smaller, so this is a check, not a
 * parse error.
 */
export function feedListMixProblems(feeds: readonly GoldenFeed[]): string[] {
  const problems: string[] = [];
  for (const lang of GOLDEN_LANGS) {
    const own = feeds.filter((f) => f.lang === lang);
    if (own.length < FEEDS_PER_LANG.min || own.length > FEEDS_PER_LANG.max) {
      problems.push(
        `${lang}: ${own.length} feeds (spec 10 §2.1 asks for ${FEEDS_PER_LANG.min}–${FEEDS_PER_LANG.max})`,
      );
    }
    const missing = FEED_CATEGORIES.filter((c) => !own.some((f) => f.category === c));
    if (missing.length > 0) problems.push(`${lang}: no ${missing.join(', ')} feed`);
  }
  if (!feeds.some((f) => f.tags.includes('google-news'))) problems.push('no Google News feed');
  if (!feeds.some((f) => f.tags.includes('poor-excerpts'))) {
    problems.push('no feed with poor excerpts');
  }
  return problems;
}

/** Feed counts per language and category (for the dry-run summary). */
export function feedListSummary(
  feeds: readonly GoldenFeed[],
): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};
  for (const feed of feeds) {
    const byCategory = (summary[feed.lang] ??= {});
    byCategory[feed.category] = (byCategory[feed.category] ?? 0) + 1;
  }
  return summary;
}
