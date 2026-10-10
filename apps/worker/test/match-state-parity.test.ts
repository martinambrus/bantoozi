import type { ClassificationArticle, TranslationRow } from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import { enrichStateSha256, matchStateSha256 } from '@bantoozi/questions';
import { selectBestTranslation } from '@bantoozi/translate';
import { describe, expect, it } from 'vitest';

import type { ClassificationConfig } from '../src/classify/config.js';
import { buildState, modelInput } from '../src/classify/model-input.js';

type LanguageModes = ClassificationConfig['languageModes'];

/**
 * The API's match-state hash (`matchFingerprintFor` in apps/api/src/services/analysis.ts) must equal
 * the rank handler's (`buildState(modelInput(...), 'match')` in rank/items.ts), or every captured
 * answer silently stops matching. `matchFingerprintFor` reads the database, so its argument mapping
 * is reproduced here verbatim from the loaded article and translation rows.
 */
const REVISION = '7';

function article(lang: string | null): ClassificationArticle {
  return {
    id: 'a1',
    revision: REVISION,
    pipelineState: 'ready',
    title: 'Pôvodný titulok',
    titleNorm: 'povodny titulok',
    author: 'Autor',
    categories: ['news', 'tech'],
    excerpt: 'Pôvodný výťažok',
    lang,
    wordCount: 420,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: null,
    storyClusterId: null,
    clusterSetId: null,
    enrichEngine: null,
    bodyLead: 'Pôvodný úvod článku.',
    feed: {
      id: 'f1',
      title: 'Feed',
      siteUrl: 'https://www.example.sk/news',
      url: 'https://feeds.example.sk/rss',
      fetchOptions: {},
    },
  };
}

function row(over: Partial<TranslationRow>): TranslationRow {
  return {
    articleId: 'a1',
    articleRevision: REVISION,
    sourceSha256: 'sha',
    engine: 'libretranslate',
    model: null,
    sourceLang: 'sk',
    title: 'Original headline',
    excerpt: 'Original excerpt',
    bodyLead: 'Original lead.',
    quality: 'ok',
    qualityDetail: {},
    createdAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function config(languageModes: LanguageModes): ClassificationConfig {
  return {
    enrich: null,
    match: null,
    cluster: null,
    cardTextMode: 'as_written',
    languageModes,
    prefilterEnabled: false,
  } as ClassificationConfig;
}

/** The API side: `matchFingerprintFor`'s argument mapping into `matchStateSha256`. */
function apiHash(
  a: ClassificationArticle,
  rows: readonly TranslationRow[],
  languageModes: LanguageModes,
): string {
  const feed = a.feed;
  return matchStateSha256(
    {
      title: a.title,
      author: a.author,
      categories: a.categories,
      excerpt: a.excerpt,
      bodyLead: a.bodyLead,
      wordCount: a.wordCount,
      lang: a.lang,
      feed: {
        title: feed?.title ?? null,
        site:
          feed === null ? null : (registrableDomain(feed.siteUrl) ?? registrableDomain(feed.url)),
      },
    },
    languageModes,
    selectBestTranslation(rows, a.revision),
  );
}

function workerHash(
  a: ClassificationArticle,
  rows: readonly TranslationRow[],
  languageModes: LanguageModes,
): string {
  return buildState(modelInput(a, rows, config(languageModes)), 'match').sha256;
}

describe('match-state hash parity between API and worker', () => {
  it('native mode without a translation', () => {
    const a = article('sk');
    expect(apiHash(a, [], { sk: 'native' })).toBe(workerHash(a, [], { sk: 'native' }));
  });

  it('translate mode with a usable best translation', () => {
    const a = article('sk');
    const modes: LanguageModes = { sk: 'translate' };
    const rows = [
      row({ quality: 'weak', title: 'Weak headline' }),
      row({ engine: 'ollama', quality: 'ok', title: 'Best headline' }),
    ];
    const native = workerHash(a, [], modes);
    expect(workerHash(a, rows, modes)).not.toBe(native);
    expect(apiHash(a, rows, modes)).toBe(workerHash(a, rows, modes));
  });

  it('translate mode with an unusable or absent translation falls back to native', () => {
    const a = article('sk');
    const modes: LanguageModes = { sk: 'translate' };
    const native = workerHash(a, [], { sk: 'native' });
    const cases: TranslationRow[][] = [
      [],
      [row({ quality: 'fail' })],
      [row({ quality: 'weak', title: null })],
      [row({ articleRevision: '6' })],
    ];
    for (const rows of cases) {
      expect(apiHash(a, rows, modes)).toBe(workerHash(a, rows, modes));
      expect(apiHash(a, rows, modes)).toBe(native);
    }
  });

  it('native language ignores an existing translation row', () => {
    const a = article('sk');
    const rows = [row({})];
    for (const modes of [{ sk: 'native' }, {}] as LanguageModes[]) {
      expect(apiHash(a, rows, modes)).toBe(workerHash(a, rows, modes));
      expect(apiHash(a, rows, modes)).toBe(workerHash(a, [], modes));
    }
    const unknown = article(null);
    expect(apiHash(unknown, rows, { sk: 'translate' })).toBe(
      workerHash(unknown, rows, { sk: 'translate' }),
    );
  });
});

/** The API's enrich-state hash (`matchFingerprintFor`) against the enrich handler's `buildState`. */
function apiEnrichHash(
  a: ClassificationArticle,
  rows: readonly TranslationRow[],
  languageModes: LanguageModes,
): string {
  const feed = a.feed;
  return enrichStateSha256(
    {
      title: a.title,
      author: a.author,
      categories: a.categories,
      excerpt: a.excerpt,
      bodyLead: a.bodyLead,
      wordCount: a.wordCount,
      lang: a.lang,
      feed: {
        title: feed?.title ?? null,
        site:
          feed === null ? null : (registrableDomain(feed.siteUrl) ?? registrableDomain(feed.url)),
      },
    },
    languageModes,
    selectBestTranslation(rows, a.revision),
  );
}

const workerEnrichHash = (
  a: ClassificationArticle,
  rows: readonly TranslationRow[],
  languageModes: LanguageModes,
): string => buildState(modelInput(a, rows, config(languageModes)), 'enrich').sha256;

describe('enrich-state hash parity between API and worker', () => {
  it('native mode, translate mode and unusable translations', () => {
    const a = article('sk');
    const usable = [row({ engine: 'ollama', quality: 'ok', title: 'Best headline' })];
    const cases: [readonly TranslationRow[], LanguageModes][] = [
      [[], { sk: 'native' }],
      [usable, { sk: 'native' }],
      [usable, { sk: 'translate' }],
      [[], { sk: 'translate' }],
      [[row({ quality: 'fail' })], { sk: 'translate' }],
      [[row({ articleRevision: '6' })], { sk: 'translate' }],
    ];
    for (const [rows, modes] of cases) {
      expect(apiEnrichHash(a, rows, modes)).toBe(workerEnrichHash(a, rows, modes));
    }
    expect(workerEnrichHash(a, usable, { sk: 'translate' })).not.toBe(
      workerEnrichHash(a, [], { sk: 'native' }),
    );
  });

  it('an unknown language is native', () => {
    const unknown = article(null);
    const rows = [row({})];
    expect(apiEnrichHash(unknown, rows, { sk: 'translate' })).toBe(
      workerEnrichHash(unknown, rows, { sk: 'translate' }),
    );
  });
});
