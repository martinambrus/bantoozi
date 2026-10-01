import { describe, expect, it } from 'vitest';

import {
  FEED_CATEGORIES,
  FeedListError,
  feedListMixProblems,
  feedListSummary,
  GOLDEN_LANGS,
  parseFeedList,
  readFeedList,
} from '../src/collection/feed-list.js';
import { DEFAULT_FEED_LIST, resolveRepoPath } from '../src/collection/paths.js';

/** M3a-T2: `apps/eval/data/feeds-golden.txt` and its parser (spec 10 §2.1). */

describe('the golden feed list (spec 10 §2.1)', () => {
  it('has 18–22 feeds per language, every category in every language, Google News and poor excerpts', async () => {
    const feeds = await readFeedList(resolveRepoPath(DEFAULT_FEED_LIST));
    expect(feedListMixProblems(feeds)).toEqual([]);
    const summary = feedListSummary(feeds);
    for (const lang of GOLDEN_LANGS) {
      const own = feeds.filter((f) => f.lang === lang);
      expect(own.length).toBeGreaterThanOrEqual(18);
      expect(own.length).toBeLessThanOrEqual(22);
      expect(Object.keys(summary[lang] ?? {}).sort()).toEqual([...FEED_CATEGORIES].sort());
      // A Google News feed and a poor-excerpt feed in every language, not just somewhere.
      expect(own.some((f) => f.tags.includes('google-news'))).toBe(true);
      expect(own.some((f) => f.tags.includes('poor-excerpts'))).toBe(true);
    }
    for (const feed of feeds) expect(feed.url).toMatch(/^https:\/\//);
    expect(new Set(feeds.map((f) => f.canonicalUrl)).size).toBe(feeds.length);
  });
});

describe('parseFeedList', () => {
  it('parses columns and tags, and ignores comments and blank lines', () => {
    const feeds = parseFeedList(
      [
        '# header',
        '',
        'en  news  https://example.com/feed.xml   # inline comment',
        'sk  local https://example.sk/rss?x=1#frag google-news poor-excerpts',
      ].join('\n'),
    );
    expect(feeds).toEqual([
      {
        line: 3,
        lang: 'en',
        category: 'news',
        url: 'https://example.com/feed.xml',
        canonicalUrl: expect.any(String),
        tags: [],
      },
      {
        line: 4,
        lang: 'sk',
        category: 'local',
        url: 'https://example.sk/rss?x=1',
        canonicalUrl: expect.any(String),
        tags: ['google-news', 'poor-excerpts'],
      },
    ]);
  });

  it('reports every bad line together', () => {
    const text = [
      'de  news  https://example.de/feed', // unknown language
      'en  gossip https://example.com/a', // unknown category
      'en  news  ftp://example.com/feed', // scheme
      'en  news  https://example.com/b shiny', // unknown tag
      'en  news  https://user:pw@example.com/c', // credentials
      'en  news  https://example.com/d',
      'cs  tech  https://EXAMPLE.com/d', // duplicate canonical URL
      'en  news', // missing url
    ].join('\n');
    try {
      parseFeedList(text);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FeedListError);
      const problems = (error as FeedListError).problems;
      expect(problems.map((p) => p.split(':')[0])).toEqual([
        'line 1',
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 7',
        'line 8',
      ]);
      expect(problems[5]).toContain('duplicate of line 6');
    }
  });

  it('refuses private addresses unless allowed (fixture servers in tests)', () => {
    expect(() => parseFeedList('en news http://127.0.0.1:8080/feed.xml')).toThrow(FeedListError);
    expect(
      parseFeedList('en news http://127.0.0.1:8080/feed.xml', { allowPrivate: true }),
    ).toHaveLength(1);
  });

  it('names what a small list misses', () => {
    const feeds = parseFeedList('en news https://example.com/feed\nsk tech https://example.sk/f');
    const problems = feedListMixProblems(feeds);
    expect(problems).toContain('en: 1 feeds (spec 10 §2.1 asks for 18–22)');
    expect(problems).toContain('cs: 0 feeds (spec 10 §2.1 asks for 18–22)');
    expect(problems).toContain('no Google News feed');
    expect(problems).toContain('no feed with poor excerpts');
    expect(problems.some((p) => p.startsWith('en: no tech, science'))).toBe(true);
  });
});
