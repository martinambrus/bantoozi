import { normalizeText } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { isDryRunDatabaseName } from '@bantoozi/db';

import {
  cardTranslations,
  generateCorpus,
  PERSONAS,
  rateSynthetic,
  TOPIC_BY_ID,
  TOPICS,
  type TopicId,
} from '../src/dryrun/synthetic.js';

/**
 * M3a-T8: the synthetic corpus and hidden rater model of `eval dry-run`. The fake TypeSafe matches
 * a card when a ≥ 4-character token of its interest occurs in the title or excerpt, so the texts
 * must never share a token with another topic's cards, and every translation must name its topic.
 */

const tokens = (text: string) =>
  new Set(
    normalizeText(text)
      .split(' ')
      .filter((t) => [...t].length >= 4),
  );

const cardTokens = new Map<TopicId, Set<string>>();
for (const topic of TOPICS) cardTokens.set(topic.id, tokens(topic.cardEn));
for (const persona of PERSONAS) {
  for (const card of persona.cards) {
    const set = cardTokens.get(card.topic) ?? new Set<string>();
    for (const t of tokens(card.interest)) set.add(t);
    cardTokens.set(card.topic, set);
  }
}
const shares = (a: Set<string>, b: Set<string>) => [...a].some((t) => b.has(t));

const now = new Date('2026-10-01T12:00:00Z');
const corpus = generateCorpus({ seed: 's', perLang: 160, feedsPerLang: 12, now, days: 30 });

describe('dry-run synthetic corpus', () => {
  it('is deterministic per seed and covers en/sk/cs over every topic', () => {
    expect(generateCorpus({ seed: 's', perLang: 160, feedsPerLang: 12, now, days: 30 })).toEqual(
      corpus,
    );
    expect(
      generateCorpus({ seed: 't', perLang: 160, feedsPerLang: 12, now, days: 30 }).articles.map(
        (a) => a.title,
      ),
    ).not.toEqual(corpus.articles.map((a) => a.title));
    expect(corpus.feeds).toHaveLength(36);
    for (const lang of ['en', 'sk', 'cs']) {
      const list = corpus.articles.filter((a) => a.lang === lang);
      expect(list).toHaveLength(160);
      expect(new Set(list.map((a) => a.topic)).size).toBe(TOPICS.length);
      expect(new Set(list.map((a) => a.feedKey)).size).toBe(12);
    }
    expect(new Set(corpus.articles.map((a) => a.title)).size).toBe(corpus.articles.length);
    expect(new Set(corpus.articles.map((a) => a.url)).size).toBe(corpus.articles.length);
    for (const a of corpus.articles) {
      expect(a.publishedAt.getTime()).toBeLessThan(now.getTime());
      expect(a.publishedAt.getTime()).toBeGreaterThan(now.getTime() - 31 * 86_400_000);
    }
  });

  it('never shares a card token with another topic, natively or translated', () => {
    for (const article of corpus.articles) {
      for (const text of [
        `${article.title} ${article.excerpt}`,
        `${article.titleEn} ${article.excerptEn}`,
      ]) {
        const seen = tokens(text);
        for (const [topic, set] of cardTokens) {
          if (topic === article.topic) continue;
          expect(shares(seen, set), `${article.title} vs ${topic}`).toBe(false);
        }
      }
      // The English text always names its own topic; anchored texts match natively too.
      const own = cardTokens.get(article.topic)!;
      expect(shares(tokens(`${article.titleEn} ${article.excerptEn}`), own)).toBe(true);
      if (article.anchored) {
        expect(shares(tokens(`${article.title} ${article.excerpt}`), own)).toBe(true);
      }
    }
    // Some Slovak/Czech articles match only through their translation.
    expect(corpus.articles.some((a) => a.lang !== 'en' && !a.anchored)).toBe(true);
    for (const feed of corpus.feeds) {
      for (const set of cardTokens.values()) expect(shares(tokens(feed.title), set)).toBe(false);
    }
  });

  it('maps every non-English title, excerpt and card to English for the fake LibreTranslate', () => {
    for (const a of corpus.articles.filter((x) => x.lang !== 'en')) {
      expect(corpus.translations[a.title]).toBe(a.titleEn);
      expect(corpus.translations[a.excerpt]).toBe(a.excerptEn);
    }
    const cards = cardTranslations();
    expect(Object.keys(cards).length).toBeGreaterThan(0);
    for (const [sk, english] of Object.entries(cards)) {
      expect(sk).not.toBe(english);
    }
  });
});

describe('hidden rater model', () => {
  it('four distinct participants whose likes follow their topic preferences', () => {
    expect(PERSONAS).toHaveLength(4);
    expect(new Set(PERSONAS.map((p) => p.key)).size).toBe(4);
    for (const persona of PERSONAS) {
      const rated = corpus.articles
        .filter((a) => persona.langs.some((l) => l === a.lang))
        .map((a) => ({ a, r: rateSynthetic('s', persona, a) }));
      const rate = (pred: (topic: TopicId) => boolean) => {
        const list = rated.filter(({ a }) => pred(a.topic));
        return list.filter(({ r }) => r.rating === 1).length / list.length;
      };
      const liked = (t: TopicId) => (persona.likes[t] ?? 0) >= 0.5;
      expect(rate(liked)).toBeGreaterThan(0.55);
      expect(rate((t) => !liked(t))).toBeLessThan(0.2);
      // Every card names a topic the persona has a view on; never-cards a disliked one.
      for (const card of persona.cards) {
        expect(TOPIC_BY_ID.has(card.topic)).toBe(true);
        expect(card.strength === 'never').toBe((persona.likes[card.topic] ?? 0) < 0.5);
      }
      expect(rateSynthetic('s', persona, corpus.articles[0]!)).toEqual(
        rateSynthetic('s', persona, corpus.articles[0]!),
      );
      for (const { r } of rated) {
        expect(r.rating === 1 ? r.reason === null : r.reason !== null).toBe(true);
      }
    }
  });

  it('only dry-run database names are accepted', () => {
    expect(isDryRunDatabaseName('bantoozi_eval_dryrun')).toBe(true);
    expect(isDryRunDatabaseName('bantoozi_eval_dryrun_t1a2b')).toBe(true);
    for (const bad of [
      'bantoozi',
      'bantoozi_dev',
      'bantoozi_eval_dryrunx',
      'postgres',
      'bantoozi_eval_dryrun_"x',
    ]) {
      expect(isDryRunDatabaseName(bad)).toBe(false);
    }
  });
});
