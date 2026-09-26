import { describe, expect, it } from 'vitest';

import {
  STATE_LIMITS,
  UNKNOWN_LANGUAGE_NAME,
  buildArticleState,
  buildSuggestState,
  effectiveStateVariant,
  lengthBucket,
  stateLanguageName,
  stateSha256,
  type ArticleStateInput,
} from '../src/index.js';
import { clipAtWordBoundary, cleanText, codePointLength } from '../src/text.js';

const INPUT: ArticleStateInput = {
  title: 'Vláda schválila nový zákon',
  author: 'Ján Novák',
  categories: ['Politika', 'Slovensko'],
  excerpt: 'Vláda na dnešnom rokovaní schválila návrh zákona.',
  bodyLead: 'Vláda na dnešnom rokovaní schválila návrh zákona o energetike.',
  wordCount: 420,
  lang: 'sk',
  feed: { title: 'Denník N', site: 'dennikn.sk' },
};

const TRANSLATION = {
  title: 'Government approves a new law',
  excerpt: 'At today’s meeting the government approved the draft law.',
  bodyLead: 'At today’s meeting the government approved the draft energy law.',
};

const words = (count: number, word = 'word') => Array.from({ length: count }, () => word).join(' ');

describe('buildArticleState (spec 05 §3.1)', () => {
  it('builds the native state in the documented shape and order', () => {
    const state = buildArticleState(INPUT, 'native', { call: 'enrich' });
    expect(state).toEqual({
      article: {
        title: 'Vláda schválila nový zákon',
        feed: { title: 'Denník N', site: 'dennikn.sk' },
        author: 'Ján Novák',
        categories: ['Politika', 'Slovensko'],
        excerpt: 'Vláda na dnešnom rokovaní schválila návrh zákona.',
        body_lead: 'Vláda na dnešnom rokovaní schválila návrh zákona o energetike.',
        length: 'medium',
        language: 'Slovak',
      },
    });
    expect(Object.keys(state.article)).toEqual([
      'title',
      'feed',
      'author',
      'categories',
      'excerpt',
      'body_lead',
      'length',
      'language',
    ]);
  });

  it('builds the translated state with the original title and the translated language', () => {
    const state = buildArticleState({ ...INPUT, translation: TRANSLATION }, 'translated', {
      call: 'match',
    });
    expect(state).toEqual({
      article: {
        title: 'Government approves a new law',
        original_title: 'Vláda schválila nový zákon',
        feed: { title: 'Denník N', site: 'dennikn.sk' },
        author: 'Ján Novák',
        categories: ['Politika', 'Slovensko'],
        excerpt: 'At today’s meeting the government approved the draft law.',
        body_lead: 'At today’s meeting the government approved the draft energy law.',
        length: 'medium',
        language: 'Slovak (machine-translated to English)',
      },
    });
    expect(Object.keys(state.article).slice(0, 2)).toEqual(['title', 'original_title']);
  });

  it('needs a translation with a title for the translated variant', () => {
    expect(() => buildArticleState(INPUT, 'translated', { call: 'enrich' })).toThrow(TypeError);
    expect(() =>
      buildArticleState({ ...INPUT, translation: { ...TRANSLATION, title: ' ' } }, 'translated', {
        call: 'enrich',
      }),
    ).toThrow(/translation with a title/);
    expect(effectiveStateVariant('translated', TRANSLATION)).toBe('translated');
    expect(effectiveStateVariant('translated', null)).toBe('native');
    expect(effectiveStateVariant('translated', undefined)).toBe('native');
    expect(effectiveStateVariant('translated', { ...TRANSLATION, title: null })).toBe('native');
    expect(effectiveStateVariant('native', TRANSLATION)).toBe('native');
  });

  it('cuts the excerpt at a word boundary within 600 characters', () => {
    const excerpt = words(200, 'slovo'); // 1,199 characters
    const state = buildArticleState({ ...INPUT, excerpt }, 'native', { call: 'enrich' });
    const cut = state.article.excerpt ?? '';
    expect(codePointLength(cut)).toBeLessThanOrEqual(STATE_LIMITS.excerpt);
    expect(cut.endsWith('slovo')).toBe(true);
    expect(excerpt.startsWith(cut)).toBe(true);
    expect(codePointLength(cut)).toBe(599); // 100 words of 5 letters and 99 spaces
  });

  it('bounds the body lead at 1,500 characters for Call A and 1,000 for Call B', () => {
    const bodyLead = words(300, 'lead'); // 1,499 characters
    const enrich = buildArticleState({ ...INPUT, bodyLead }, 'native', { call: 'enrich' });
    const match = buildArticleState({ ...INPUT, bodyLead }, 'native', { call: 'match' });
    expect(enrich.article.body_lead).toBe(bodyLead);
    expect(codePointLength(match.article.body_lead ?? '')).toBeLessThanOrEqual(1000);
    expect(match.article.body_lead?.endsWith('lead')).toBe(true);
    const translated = buildArticleState(
      { ...INPUT, translation: { ...TRANSLATION, bodyLead } },
      'translated',
      { call: 'match' },
    );
    expect(translated.article.body_lead).toBe(match.article.body_lead);
  });

  it('bounds title, author, categories and feed fields', () => {
    const long = 'x'.repeat(400);
    const state = buildArticleState(
      {
        ...INPUT,
        title: long,
        author: long,
        feed: { title: long, site: long },
        categories: [...Array.from({ length: 10 }, (_, i) => `Category ${i}`), long],
      },
      'native',
      { call: 'enrich' },
    );
    expect(codePointLength(state.article.title)).toBe(STATE_LIMITS.title);
    expect(codePointLength(state.article.author ?? '')).toBe(STATE_LIMITS.author);
    expect(codePointLength(state.article.feed.title ?? '')).toBe(STATE_LIMITS.feedTitle);
    expect(codePointLength(state.article.feed.site ?? '')).toBe(STATE_LIMITS.feedSite);
    expect(state.article.categories).toHaveLength(STATE_LIMITS.maxCategories);
  });

  it('cleans whitespace, drops blank values and duplicate categories', () => {
    const state = buildArticleState(
      {
        ...INPUT,
        title: '  Line\none \t two ',
        author: '   ',
        excerpt: '',
        bodyLead: null,
        categories: ['News', ' news ', '', 'Tech\n', 'NEWS'],
        feed: { title: null, site: null },
      },
      'native',
      { call: 'enrich' },
    );
    expect(state.article).toMatchObject({
      title: 'Line one two',
      author: null,
      excerpt: null,
      body_lead: null,
      categories: ['News', 'Tech'],
      feed: { title: null, site: null },
    });
  });

  it('maps word counts to length buckets', () => {
    expect(lengthBucket(null)).toBe('unknown');
    expect(lengthBucket(-1)).toBe('unknown');
    expect(lengthBucket(Number.NaN)).toBe('unknown');
    expect(lengthBucket(0)).toBe('short');
    expect(lengthBucket(149)).toBe('short');
    expect(lengthBucket(150)).toBe('medium');
    expect(lengthBucket(599)).toBe('medium');
    expect(lengthBucket(600)).toBe('long');
    expect(lengthBucket(1499)).toBe('long');
    expect(lengthBucket(1500)).toBe('very_long');
    expect(
      buildArticleState({ ...INPUT, wordCount: null }, 'native', { call: 'match' }).article.length,
    ).toBe('unknown');
  });

  it('names the language in English', () => {
    expect(stateLanguageName('sk')).toBe('Slovak');
    expect(stateLanguageName('cs-CZ')).toBe('Czech');
    expect(stateLanguageName('EN')).toBe('English');
    expect(stateLanguageName('und')).toBe(UNKNOWN_LANGUAGE_NAME);
    expect(stateLanguageName(null)).toBe('Unknown');
    expect(stateLanguageName('xx')).toBe('Unknown');
    const unknown = buildArticleState({ ...INPUT, lang: null }, 'native', { call: 'enrich' });
    expect(unknown.article.language).toBe('Unknown');
  });

  it('hashes the exact state independently of key order', () => {
    const state = buildArticleState(INPUT, 'native', { call: 'enrich' });
    const reordered = { article: Object.fromEntries(Object.entries(state.article).reverse()) };
    expect(stateSha256(reordered)).toBe(stateSha256(state));
    expect(stateSha256(buildArticleState(INPUT, 'native', { call: 'match' }))).toBe(
      stateSha256(state),
    );
    const longer = { ...INPUT, bodyLead: words(300, 'lead') };
    expect(stateSha256(buildArticleState(longer, 'native', { call: 'match' }))).not.toBe(
      stateSha256(buildArticleState(longer, 'native', { call: 'enrich' })),
    );
  });
});

describe('text helpers', () => {
  it('clips at a word boundary, or hard when one word is too long', () => {
    expect(clipAtWordBoundary('short text', 20)).toBe('short text');
    expect(clipAtWordBoundary('alpha beta gamma', 9)).toBe('alpha');
    expect(clipAtWordBoundary('alpha beta gamma', 10)).toBe('alpha beta');
    expect(clipAtWordBoundary('alpha beta gamma', 11)).toBe('alpha beta');
    expect(clipAtWordBoundary('alpha beta gamma', 0)).toBe('');
    expect(clipAtWordBoundary('x'.repeat(200), 100)).toBe('x'.repeat(100));
    expect(clipAtWordBoundary(`a ${'x'.repeat(150)}`, 100)).toBe(`a ${'x'.repeat(98)}`);
    expect(clipAtWordBoundary('😀😀😀 😀😀', 4)).toBe('😀😀😀');
    expect(cleanText(' a  b\n\nc ')).toBe('a b c');
    expect(cleanText('é')).toBe('é');
  });
});

describe('buildSuggestState (spec 05 §7 step 4)', () => {
  it('keeps at most five articles in order, excerpts ≤ 300', () => {
    const articles = Array.from({ length: 7 }, (_, i) => ({
      title: `Liked ${i}`,
      excerpt: i === 0 ? words(100, 'lorem') : null,
    }));
    const state = buildSuggestState(articles);
    expect(state.liked_articles.map((article) => article.title)).toEqual([
      'Liked 0',
      'Liked 1',
      'Liked 2',
      'Liked 3',
      'Liked 4',
    ]);
    expect(codePointLength(state.liked_articles[0]?.excerpt ?? '')).toBeLessThanOrEqual(300);
    expect(state.liked_articles[1]?.excerpt).toBeNull();
  });
});
