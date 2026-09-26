import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  type ArticleFixture,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Transaction } from '../../src/client.js';
import {
  addArticleAlias,
  FEED_BODY_EXTRACTOR,
  getArticleBody,
  loadArticleForExtraction,
  resetArticleAnswers,
  saveExtractionResult,
  upsertArticleBody,
  type ArticleBodyInput,
  type ArticleBodyStatus,
  type ExtractionOutcome,
} from '../../src/ingest/index.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * Extraction results under revision fencing (spec 03 §8.1 steps 6–8, §2.1; spec 02 §3.3) and
 * redirect/canonical aliases in the global url_key namespace (spec 03 §7 "Concurrency", §8.1
 * steps 4–5), against a real migrated database as the worker role.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const body = (overrides: Partial<ArticleBodyInput> = {}): ArticleBodyInput => ({
  status: 'ok',
  resolvedUrl: 'https://news.example.test/final',
  httpStatus: 200,
  bodyText: 'The full readable text of the article.',
  bodyHtml: '<p>The full readable text of the article.</p>',
  completeness: 'complete',
  completenessReason: null,
  bodyLead: 'The full readable text of the article.',
  extractorVersion: 'readability-v1',
  error: null,
  ...overrides,
});

/** A terminal result without extracted content. */
const empty = (status: ArticleBodyStatus, error: string | null = null): ArticleBodyInput =>
  body({
    status,
    httpStatus: null,
    bodyText: null,
    bodyHtml: null,
    bodyLead: null,
    completeness: 'partial',
    completenessReason: 'extraction_failed',
    error,
  });

const feedBody = (overrides: Partial<ArticleBodyInput> = {}): ArticleBodyInput =>
  body({
    resolvedUrl: null,
    httpStatus: null,
    bodyText: 'Publisher feed body with seven whitespace separated words',
    bodyHtml: '<p>Publisher feed body with seven whitespace separated words</p>',
    bodyLead: 'Publisher feed body',
    extractorVersion: FEED_BODY_EXTRACTOR,
    ...overrides,
  });

const outcome = (
  article: { id: string },
  overrides: Partial<ExtractionOutcome> = {},
): ExtractionOutcome => ({
  articleId: article.id,
  expectedRevision: '1',
  body: body(),
  lang: { lang: 'en', confidence: 0.5 },
  wordCount: 7,
  // Neutral media signals: no evidence and no examined fragment (media tests pass their own).
  media: { videoEvidence: false, bodyImageCount: null, pageBodyExamined: false },
  ...overrides,
});

const save = (o: ExtractionOutcome) =>
  ctx.worker.transaction((tx) => saveExtractionResult(tx, workerOutbox(tx), o));

type ArticleRow = {
  revision: string;
  pipeline_state: string;
  lang: string | null;
  lang_confidence: number | null;
  word_count: number | null;
};

async function articleRow(id: string): Promise<ArticleRow> {
  const result = await ctx.owner.query<ArticleRow>(
    `SELECT content_revision::text AS revision, pipeline_state, lang, lang_confidence, word_count
       FROM articles WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

async function outboxQueues(): Promise<string[]> {
  const result = await ctx.owner.query<{ queue: string }>(
    'SELECT queue FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
  );
  return result.rows.map((r) => r.queue);
}

const clearOutbox = () => ctx.owner.query('DELETE FROM job_outbox');

const storeBody = (articleId: string, revision: string, input: ArticleBodyInput) =>
  ctx.worker.transaction((tx) => upsertArticleBody(tx, articleId, revision, input));

const setState = (articleId: string, state: string, lang: string | null = null) =>
  ctx.owner.query('UPDATE articles SET pipeline_state = $2, lang = $3 WHERE id = $1', [
    articleId,
    state,
    lang,
  ]);

/** An article already extracted at revision 1 with `text` as its page body. */
async function extractedArticle(text = 'Original page text.'): Promise<ArticleFixture> {
  const article = await createArticle(ctx.owner);
  const result = await save(
    outcome(article, { body: body({ bodyText: text, bodyHtml: `<p>${text}</p>` }) }),
  );
  expect(result).toMatchObject({ status: 'saved', advanced: true });
  return article;
}

describe('loadArticleForExtraction (spec 03 §8.1)', () => {
  it('returns identity, revision, feed text, carrier language hints and the stored body', async () => {
    const sk = await createFeed(ctx.owner);
    const cs = await createFeed(ctx.owner);
    const sk2 = await createFeed(ctx.owner);
    const none = await createFeed(ctx.owner);
    await ctx.owner.query(`UPDATE feeds SET lang_hint = 'sk' WHERE id = ANY($1::bigint[])`, [
      [sk.id, sk2.id],
    ]);
    await ctx.owner.query(`UPDATE feeds SET lang_hint = 'cs' WHERE id = $1`, [cs.id]);
    const publishedAt = new Date('2026-09-20T08:30:00.000Z');
    const article = await createArticle(ctx.owner, {
      feedIds: [sk.id, cs.id, sk2.id, none.id],
      author: 'Jana',
      publishedAt,
      excerpt: 'Short excerpt',
    });
    // The Czech feed carried it first: it is the source feed, so its hint comes first.
    await ctx.owner.query(
      `UPDATE feed_items SET first_seen_at = now() - make_interval(hours => $3)
        WHERE article_id = $1 AND feed_id = $2`,
      [article.id, cs.id, 5],
    );
    await storeBody(article.id, '1', feedBody());

    const loaded = await loadArticleForExtraction(ctx.worker, article.id);
    expect(loaded).toEqual({
      id: article.id,
      url: expect.stringMatching(/^https:\/\/news\.example\.test\//),
      canonicalUrl: expect.any(String),
      urlKey: article.urlKey,
      revision: '1',
      pipelineState: 'ingested',
      title: expect.any(String),
      excerpt: 'Short excerpt',
      author: 'Jana',
      publishedAt,
      lang: null,
      langConfidence: null,
      carrierLangHints: ['cs', 'sk'],
      body: expect.objectContaining({
        articleRevision: '1',
        extractorVersion: FEED_BODY_EXTRACTOR,
      }),
    });
    expect(await loadArticleForExtraction(ctx.worker, '999999999')).toBeNull();
    const bare = await createArticle(ctx.owner);
    expect(await loadArticleForExtraction(ctx.worker, bare.id)).toMatchObject({
      carrierLangHints: [],
      body: null,
    });
  });
});

describe('saveExtractionResult (spec 03 §8.1 steps 6–8, §2.1)', () => {
  it('advances the pending extraction to extracted for every terminal status', async () => {
    const cases: Array<[ArticleBodyStatus, ArticleBodyInput, number | null]> = [
      ['ok', body(), 7],
      [
        'too_large',
        body({ status: 'too_large', completeness: 'partial', completenessReason: 'truncated' }),
        7,
      ],
      ['skipped', empty('skipped'), 2],
      ['blocked', empty('blocked', 'robots_disallowed'), 2],
      ['not_html', empty('not_html', 'content_type'), null],
      ['failed', empty('failed', 'no_content'), 2],
    ];
    await clearOutbox();
    for (const [status, input, wordCount] of cases) {
      const article = await createArticle(ctx.owner);
      const result = await save(
        outcome(article, { body: input, lang: { lang: 'sk', confidence: 0.25 }, wordCount }),
      );
      expect(result, status).toEqual({
        status: 'saved',
        revision: '1',
        advanced: true,
        reset: false,
      });
      expect(await articleRow(article.id), status).toEqual({
        revision: '1',
        pipeline_state: 'extracted',
        lang: 'sk',
        lang_confidence: 0.25,
        word_count: wordCount,
      });
      expect(await getArticleBody(ctx.worker, article.id), status).toMatchObject({
        articleRevision: '1',
        status,
        bodyText: input.bodyText,
        error: input.error,
      });
    }
    // The next stage is the caller's pipeline.after('extract'): nothing is enqueued here.
    expect(await outboxQueues()).toEqual([]);
  });

  it('discards a result for an older revision: out-of-order results never overwrite a newer one', async () => {
    const article = await createArticle(ctx.owner);
    // A source change advanced the revision while revision 1 was being extracted.
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    const late = outcome(article, { body: body({ bodyText: 'Old revision text' }) });
    expect(await save(late)).toEqual({ status: 'stale_revision', revision: '2' });
    expect(await articleRow(article.id)).toMatchObject({
      revision: '2',
      pipeline_state: 'ingested',
    });
    expect(await getArticleBody(ctx.worker, article.id)).toBeNull();

    const current = outcome(article, {
      expectedRevision: '2',
      body: body({ bodyText: 'Current text' }),
      lang: { lang: 'de', confidence: 0.5 },
    });
    expect(await save(current)).toEqual({
      status: 'saved',
      revision: '2',
      advanced: true,
      reset: false,
    });
    // An even later duplicate of the old job changes nothing.
    expect(await save(late)).toEqual({ status: 'stale_revision', revision: '2' });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Current text',
    });
    expect(await articleRow(article.id)).toMatchObject({ revision: '2', lang: 'de' });
    expect(await save(outcome({ id: '999999999' }))).toEqual({ status: 'missing' });
  });

  it('keeps a stored body with content instead of a later empty result, and still advances', async () => {
    // The feed-v1 fallback of this revision survives a failed page extraction.
    const article = await createArticle(ctx.owner);
    await storeBody(article.id, '1', feedBody());
    const failed = outcome(article, { body: empty('failed', 'timeout'), wordCount: 2 });
    expect(await save(failed)).toEqual({
      status: 'saved',
      revision: '1',
      advanced: true,
      reset: false,
    });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '1',
      status: 'ok',
      extractorVersion: FEED_BODY_EXTRACTOR,
      bodyText: feedBody().bodyText,
    });
    // word_count counts the kept body, not the excerpt the empty result was counted on.
    expect(await articleRow(article.id)).toMatchObject({
      pipeline_state: 'extracted',
      lang: 'en',
      word_count: 8,
    });

    // A later empty re-extraction of the processed revision changes nothing, whatever language
    // it detected without the body.
    const good = await extractedArticle('A good page body.');
    await clearOutbox();
    for (const status of ['failed', 'blocked', 'skipped'] as const) {
      expect(
        await save(outcome(good, { body: empty(status), lang: { lang: 'fr', confidence: 0.1 } })),
      ).toEqual({ status: 'unchanged', revision: '1' });
    }
    expect(await getArticleBody(ctx.worker, good.id)).toMatchObject({
      articleRevision: '1',
      status: 'ok',
      bodyText: 'A good page body.',
    });
    expect(await articleRow(good.id)).toMatchObject({ revision: '1', lang: 'en' });
    expect(await outboxQueues()).toEqual([]);

    // A good body of an older revision stays readable when the new revision's extraction fails,
    // and word_count keeps counting that body rather than the excerpt the result was counted on.
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), good.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(
      await save(outcome(good, { expectedRevision: '2', body: empty('failed'), wordCount: 3 })),
    ).toEqual({ status: 'saved', revision: '2', advanced: true, reset: false });
    expect(await getArticleBody(ctx.worker, good.id)).toMatchObject({
      articleRevision: '1',
      bodyText: 'A good page body.',
    });
    expect(await articleRow(good.id)).toMatchObject({
      revision: '2',
      pipeline_state: 'extracted',
      word_count: 4,
    });
  });

  it('keeps a complete feed body over a partial page result of the same revision', async () => {
    const complete = await createArticle(ctx.owner);
    await storeBody(complete.id, '1', feedBody());
    const teaser = body({
      bodyText: 'Subscribe to read',
      bodyHtml: '<p>Subscribe to read</p>',
      completeness: 'partial',
      completenessReason: 'paywall',
    });
    expect(await save(outcome(complete, { body: teaser, wordCount: 3 }))).toMatchObject({
      status: 'saved',
      advanced: true,
    });
    expect(await getArticleBody(ctx.worker, complete.id)).toMatchObject({
      extractorVersion: FEED_BODY_EXTRACTOR,
      completeness: 'complete',
    });
    expect(await articleRow(complete.id)).toMatchObject({ word_count: 8 });

    // A partial feed body is replaced by the page extraction.
    const partial = await createArticle(ctx.owner);
    await storeBody(partial.id, '1', feedBody({ completeness: 'partial' }));
    await save(outcome(partial, { body: teaser, wordCount: 3 }));
    expect(await getArticleBody(ctx.worker, partial.id)).toMatchObject({
      extractorVersion: 'readability-v1',
      bodyText: 'Subscribe to read',
    });
    expect(await articleRow(partial.id)).toMatchObject({ word_count: 3 });
  });

  it('ignores a duplicate result; an explicit upgrade that changes the body resets once', async () => {
    const feed = await createFeed(ctx.owner);
    const reader = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: reader.id,
      feedId: feed.id,
      mode: 'active',
      activatedAt: hoursAgo(2),
    });
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [reader.id, card.id],
    );
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    expect(
      await save(outcome(article, { body: body({ bodyText: 'Version one.' }) })),
    ).toMatchObject({ status: 'saved', advanced: true });
    // Later stages answered revision 1.
    await setState(article.id, 'matched', 'en');
    const matchSet = await ctx.owner.query<{ sha: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', 'match-extraction-test', repeat('e', 64), '{}') RETURNING sha256 AS sha`,
    );
    await ctx.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, 0.9, 'typesafe', $3, 1, 's', 'c', 'native')`,
      [article.id, card.id, matchSet.rows[0]!.sha],
    );
    await ctx.owner.query(
      `INSERT INTO article_translations (article_id, article_revision, source_sha256, engine,
                                         source_lang, quality)
       VALUES ($1, 1, 'x', 'libretranslate', 'sk', 'ok')`,
      [article.id],
    );
    await clearOutbox();

    const changed = body({ bodyText: 'Version two, corrected.', bodyHtml: '<p>Version two.</p>' });
    // A duplicate or late job for the processed revision is a no-op (spec 03 §2.1).
    expect(await save(outcome(article, { body: changed, wordCount: 3 }))).toEqual({
      status: 'unchanged',
      revision: '1',
    });
    expect(await outboxQueues()).toEqual([]);
    // An explicit upgrade that changes the body resets once.
    expect(await save(outcome(article, { body: changed, wordCount: 3, upgrade: true }))).toEqual({
      status: 'saved',
      revision: '2',
      advanced: true,
      reset: true,
    });
    expect(await articleRow(article.id)).toEqual({
      revision: '2',
      pipeline_state: 'extracted',
      lang: 'en',
      lang_confidence: 0.5,
      word_count: 3,
    });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Version two, corrected.',
    });
    const left = await ctx.owner.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM card_answers WHERE article_id = $1) AS answers,
              (SELECT count(*)::int FROM article_translations WHERE article_id = $1) AS translations`,
      [article.id],
    );
    expect(left.rows[0]).toEqual({ answers: 0, translations: 0 });
    const queue = await ctx.owner.query(
      'SELECT card_id::text, article_revision::text FROM match_queue WHERE article_id = $1',
      [article.id],
    );
    expect(queue.rows).toEqual([{ card_id: card.id, article_revision: '2' }]);
    // Rank intents from the reset only: extraction is never enqueued recursively, and the demand
    // gate is the caller's pipeline.after('extract').
    expect(await outboxQueues()).toEqual(['user.rank']);

    // The same upgrade again changes nothing.
    expect(
      await save(
        outcome(article, { expectedRevision: '2', body: changed, wordCount: 3, upgrade: true }),
      ),
    ).toEqual({ status: 'unchanged', revision: '2' });
  });

  it('reports an identical re-extraction as unchanged without writing', async () => {
    const article = await extractedArticle('Stable text.');
    await setState(article.id, 'enriched', 'en');
    await clearOutbox();
    const before = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(
      await save(
        outcome(article, {
          body: body({ bodyText: 'Stable text.', bodyHtml: '<p>Stable text.</p>' }),
          lang: { lang: 'en', confidence: 0.9 },
        }),
      ),
    ).toEqual({ status: 'unchanged', revision: '1' });
    const after = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(after.rows).toEqual(before.rows);
    expect(await articleRow(article.id)).toMatchObject({
      revision: '1',
      pipeline_state: 'enriched',
      lang_confidence: 0.5,
    });
    expect(await outboxQueues()).toEqual([]);
  });

  it('resets on an upgrade that changes only the language, keeping the body', async () => {
    const article = await extractedArticle('Dobrý deň, toto je článok.');
    const same = body({
      bodyText: 'Dobrý deň, toto je článok.',
      bodyHtml: '<p>Dobrý deň, toto je článok.</p>',
    });
    expect(
      await save(outcome(article, { body: same, lang: { lang: 'sk', confidence: 0.75 } })),
    ).toEqual({ status: 'unchanged', revision: '1' });
    expect(
      await save(
        outcome(article, { body: same, lang: { lang: 'sk', confidence: 0.75 }, upgrade: true }),
      ),
    ).toEqual({ status: 'saved', revision: '2', advanced: true, reset: true });
    expect(await articleRow(article.id)).toMatchObject({
      revision: '2',
      pipeline_state: 'extracted',
      lang: 'sk',
      lang_confidence: 0.75,
    });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Dobrý deň, toto je článok.',
    });
  });

  it('stores the body of a stale article but never lifts it out of stale', async () => {
    const article = await createArticle(ctx.owner);
    await setState(article.id, 'stale');
    await storeBody(article.id, '1', feedBody());
    expect(await save(outcome(article))).toEqual({
      status: 'saved',
      revision: '1',
      advanced: false,
      reset: false,
    });
    expect(await articleRow(article.id)).toMatchObject({
      revision: '1',
      pipeline_state: 'stale',
      lang: 'en',
    });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '1',
      extractorVersion: 'readability-v1',
    });
    expect(await save(outcome(article))).toEqual({ status: 'unchanged', revision: '1' });

    // A changed upgrade resets in the stale-preserving form: no queue rows, still stale.
    const changed = outcome(article, { body: body({ bodyText: 'Edited later.' }), upgrade: true });
    expect(await save(changed)).toEqual({
      status: 'saved',
      revision: '2',
      advanced: false,
      reset: true,
    });
    expect(await articleRow(article.id)).toMatchObject({ revision: '2', pipeline_state: 'stale' });
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Edited later.',
    });
  });

  it('enforces the 10 MiB text + HTML limit before writing anything', async () => {
    const article = await createArticle(ctx.owner);
    const limit = 10 * 1024 * 1024;
    // Two-byte characters: 5 MiB characters are 10 MiB of UTF-8, plus the HTML.
    const tooLarge = body({ bodyText: 'ž'.repeat(limit / 2), bodyHtml: '<p>x</p>' });
    await expect(save(outcome(article, { body: tooLarge }))).rejects.toThrow(/10 MiB/);
    expect(await articleRow(article.id)).toMatchObject({ pipeline_state: 'ingested', lang: null });
    expect(await getArticleBody(ctx.worker, article.id)).toBeNull();

    // Exactly at the limit is stored in full.
    const html = '<p>truncated</p>';
    const atLimit = body({
      status: 'too_large',
      bodyText: 'a'.repeat(limit - html.length),
      bodyHtml: html,
      completeness: 'partial',
      completenessReason: 'truncated',
    });
    expect(await save(outcome(article, { body: atLimit }))).toMatchObject({ status: 'saved' });
    const stored = await ctx.owner.query<{ bytes: number }>(
      `SELECT octet_length(body_text) + octet_length(body_html) AS bytes
         FROM article_bodies WHERE article_id = $1`,
      [article.id],
    );
    expect(stored.rows[0]?.bytes).toBe(limit);

    await expect(save(outcome(article, { lang: { lang: 'en', confidence: 1.5 } }))).rejects.toThrow(
      RangeError,
    );
    await expect(save(outcome(article, { wordCount: -1 }))).rejects.toThrow(RangeError);
    await expect(save(outcome(article, { expectedRevision: 'x' }))).rejects.toThrow(TypeError);
  });
});

describe('addArticleAlias (spec 03 §7 "Concurrency", §8.1 steps 4–5)', () => {
  const key = (name: string) =>
    `news.example.test/alias/${name}-${Math.random().toString(16).slice(2)}`;

  async function aliasRows(articleId: string) {
    const result = await ctx.owner.query<{ url_key: string; source: string }>(
      'SELECT url_key, source FROM article_aliases WHERE article_id = $1 ORDER BY url_key',
      [articleId],
    );
    return result.rows;
  }

  /** Keys naming one article in `articles` and another in `article_aliases`. */
  async function crossTableConflicts(): Promise<number> {
    const result = await ctx.owner.query(
      `SELECT 1 FROM articles a JOIN article_aliases al ON al.url_key = a.url_key
        WHERE al.article_id <> a.id`,
    );
    return result.rowCount ?? 0;
  }

  const alias = (articleId: string, urlKey: string, source: 'redirect' | 'rel_canonical') =>
    ctx.worker.transaction((tx) => addArticleAlias(tx, articleId, urlKey, source));

  it('adds a new key, finds existing ones and reports another owner without writing', async () => {
    const a = await createArticle(ctx.owner);
    const b = await createArticle(ctx.owner);
    const redirected = key('redirected');
    expect(await alias(a.id, redirected, 'redirect')).toEqual({ status: 'added' });
    expect(await alias(a.id, redirected, 'rel_canonical')).toEqual({ status: 'exists' });
    expect(await alias(a.id, a.urlKey, 'rel_canonical')).toEqual({ status: 'exists' });
    expect(await aliasRows(a.id)).toEqual([{ url_key: redirected, source: 'redirect' }]);

    // Another article's canonical key or alias: the caller merges (§8.4); nothing is written.
    const bAlias = key('b-alias');
    expect(await alias(b.id, bAlias, 'redirect')).toEqual({ status: 'added' });
    expect(await alias(a.id, b.urlKey, 'redirect')).toEqual({
      status: 'owned_by_other',
      ownerId: b.id,
    });
    expect(await alias(a.id, bAlias, 'rel_canonical')).toEqual({
      status: 'owned_by_other',
      ownerId: b.id,
    });
    expect(await aliasRows(a.id)).toEqual([{ url_key: redirected, source: 'redirect' }]);
    expect(await aliasRows(b.id)).toEqual([{ url_key: bAlias, source: 'redirect' }]);
    expect(await alias('999999999', key('gone'), 'redirect')).toEqual({ status: 'missing' });
    expect(await crossTableConflicts()).toBe(0);
  });

  /** Wait until some backend waits for an advisory lock (the url_key lock). */
  async function untilAdvisoryWait(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const waiting = await ctx.adminPool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      if ((waiting.rowCount ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no backend waited for the url_key lock');
  }

  /** A worker transaction that runs `fn`, then stays open until released. */
  function held<T>(fn: (tx: Transaction) => Promise<T>) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (started = resolve));
    const done = ctx.worker.transaction(async (tx) => {
      const result = await fn(tx);
      started();
      await gate;
      return result;
    });
    return { ready, release, done };
  }

  it('serializes concurrent claims of one key under the url_key lock, across both tables', async () => {
    const a = await createArticle(ctx.owner);
    const b = await createArticle(ctx.owner);
    const contested = key('contested');
    const first = held((tx) => addArticleAlias(tx, a.id, contested, 'redirect'));
    await first.ready;
    const second = alias(b.id, contested, 'rel_canonical');
    await untilAdvisoryWait();
    first.release();
    expect(await first.done).toEqual({ status: 'added' });
    expect(await second).toEqual({ status: 'owned_by_other', ownerId: a.id });

    // Ingestion inserting an article under the same lock wins the key: the alias rechecks
    // `articles` and never names another article for it.
    const ingested = `news.example.test/alias/ingested-${Math.random().toString(16).slice(2)}`;
    const ingest = held(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('url_key:' || ${ingested}::text, 0))`,
      );
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash)
        VALUES (${`https://${ingested}`}, ${`https://${ingested}`}, ${ingested}, 'Ingested',
                'ingested', repeat('0', 64))
        RETURNING id::text AS id`);
      return inserted.rows[0]!.id;
    });
    await ingest.ready;
    const late = alias(a.id, ingested, 'redirect');
    await untilAdvisoryWait();
    ingest.release();
    const ownerId = await ingest.done;
    expect(await late).toEqual({ status: 'owned_by_other', ownerId });
    expect(await aliasRows(a.id)).toEqual([{ url_key: contested, source: 'redirect' }]);

    // The article's own identity keys are locked in the same sorted batch, before its row: an
    // ingestion holding one of them (here an alias of A) is waited for first.
    const own = held(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('url_key:' || ${contested}::text, 0))`,
      );
    });
    await own.ready;
    const next = key('next');
    const waiting = alias(a.id, next, 'rel_canonical');
    await untilAdvisoryWait();
    own.release();
    await own.done;
    expect(await waiting).toEqual({ status: 'added' });
    expect(await aliasRows(a.id)).toEqual(
      [
        { url_key: contested, source: 'redirect' },
        { url_key: next, source: 'rel_canonical' },
      ].sort((x, y) => (x.url_key < y.url_key ? -1 : 1)),
    );
    expect(await crossTableConflicts()).toBe(0);
  });
});
