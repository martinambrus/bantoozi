import { createHash } from 'node:crypto';

import {
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  type ArticleFixture,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyMediaSignals,
  FEED_BODY_EXTRACTOR,
  getArticleBody,
  ingestItem,
  MEDIA_RANK_REASON,
  mergeArticles,
  resetArticleAnswers,
  retryTransaction,
  saveExtractionResult,
  upsertArticleBody,
  type ArticleBodyInput,
  type ArticleBodyStatus,
  type ExtractionMediaSignals,
  type ExtractionOutcome,
  type IngestItemInput,
  type IngestItemResult,
  type MediaSignalUpdate,
} from '../../src/ingest/index.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * Media signals (design revision R2; spec 03 §6.4, §7 step 6, §8.1 step 6, §8.4; spec 02 §3;
 * PLAN.md §6 M1-T7) against a real migrated database as the worker role: `has_video` is set by
 * video evidence from any carrier or the page and never goes back to false, `body_image_count`
 * describes the stored body (null for an excerpt-only article), and every change increments
 * `media_revision` and records an incremental rank for the subscribers of every carrier.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let seq = 0;
const next = (): number => {
  seq += 1;
  return seq;
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ── Rows and intents ─────────────────────────────────────────────────────────────────────────

interface MediaRow {
  has_video: boolean | null;
  body_image_count: number | null;
  media_revision: string;
}

async function media(articleId: string): Promise<MediaRow> {
  const result = await ctx.owner.query<MediaRow>(
    `SELECT has_video, body_image_count, media_revision::text AS media_revision
       FROM articles WHERE id = $1`,
    [articleId],
  );
  return result.rows[0]!;
}

/** Set the media columns directly, as an earlier ingestion or extraction left them. */
async function setMedia(
  articleId: string,
  hasVideo: boolean | null,
  bodyImageCount: number | null,
): Promise<void> {
  await ctx.owner.query('UPDATE articles SET has_video = $2, body_image_count = $3 WHERE id = $1', [
    articleId,
    hasVideo,
    bodyImageCount,
  ]);
}

const setState = (articleId: string, state: string) =>
  ctx.owner.query('UPDATE articles SET pipeline_state = $2 WHERE id = $1', [articleId, state]);

async function wordCount(articleId: string): Promise<number | null> {
  const result = await ctx.owner.query<{ word_count: number | null }>(
    'SELECT word_count FROM articles WHERE id = $1',
    [articleId],
  );
  return result.rows[0]!.word_count;
}

const clearOutbox = () => ctx.owner.query('DELETE FROM job_outbox');

async function outboxQueues(): Promise<string[]> {
  const result = await ctx.owner.query<{ queue: string }>(
    'SELECT queue FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
  );
  return result.rows.map((row) => row.queue);
}

type RankPayload = { userId: string; reason: string; full?: boolean };

/** Pending `user.rank` intents with `reason`, sorted by user. */
async function rankIntents(reason: string): Promise<RankPayload[]> {
  const result = await ctx.owner.query<{ payload: RankPayload }>(
    `SELECT payload FROM job_outbox
      WHERE queue = 'user.rank' AND delivered_at IS NULL AND payload->>'reason' = $1
      ORDER BY payload->>'userId'`,
    [reason],
  );
  return result.rows.map((row) => row.payload);
}

/** Incremental media rank intents for `userIds` (spec 03 §6.4 "Re-ranking"). */
const mediaRanks = (...userIds: string[]): RankPayload[] =>
  [...userIds].sort().map((userId) => ({ userId, reason: MEDIA_RANK_REASON }));

/** A user subscribed (inference off) to `feedId`: any subscriber of a carrier is re-ranked. */
async function subscriber(feedId: string): Promise<string> {
  const user = await createUser(ctx.owner);
  await createSubscription(ctx.owner, { userId: user.id, feedId });
  return user.id;
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────

/** A readable page body stored by extraction. */
const page = (text: string, overrides: Partial<ArticleBodyInput> = {}): ArticleBodyInput => ({
  status: 'ok',
  resolvedUrl: 'https://news.example.test/page',
  httpStatus: 200,
  bodyText: text,
  bodyHtml: `<p>${text}</p>`,
  completeness: 'complete',
  completenessReason: null,
  bodyLead: text,
  extractorVersion: 'readability-v1',
  error: null,
  ...overrides,
});

/** A publisher body from the feed, stored as the `feed-v1` fallback (spec 03 §7). */
const feedBody = (text: string, overrides: Partial<ArticleBodyInput> = {}): ArticleBodyInput =>
  page(text, {
    resolvedUrl: null,
    httpStatus: null,
    completeness: 'partial',
    completenessReason: 'feed_content',
    extractorVersion: FEED_BODY_EXTRACTOR,
    ...overrides,
  });

/** The excerpt stored as a linkless article's body when the feed carried no body (worker). */
const excerptOnly = (text: string): ArticleBodyInput =>
  feedBody(text, { bodyHtml: null, completenessReason: 'excerpt_only' });

/** A terminal result without extracted content. */
const empty = (status: ArticleBodyStatus, error: string | null = null): ArticleBodyInput =>
  page('', {
    status,
    httpStatus: null,
    bodyText: null,
    bodyHtml: null,
    bodyLead: null,
    completeness: 'partial',
    completenessReason: 'extraction_failed',
    error,
  });

const storeBody = (articleId: string, revision: string, body: ArticleBodyInput) =>
  ctx.worker.transaction((tx) => upsertArticleBody(tx, articleId, revision, body));

// ── Ingestion ────────────────────────────────────────────────────────────────────────────────

/** A stand-in for spec 03 §6.2: the media signals are not part of the content hash. */
const contentHashOf = (i: Omit<IngestItemInput, 'contentHash'>) =>
  sha([
    i.title,
    i.excerpt,
    i.author,
    [...i.categories].sort(),
    i.url ?? i.canonicalUrl,
    i.feedBody?.bodyText ?? null,
  ]);

const NO_MEDIA = { videoEvidence: false, feedBodyImageCount: null } as const;

/** One normalized item of `feedId` at a fresh URL, without media unless given. */
function item(feedId: string, overrides: Partial<IngestItemInput> = {}): IngestItemInput {
  const n = next();
  const url = `https://news.example.test/media/${n}`;
  const fields: Omit<IngestItemInput, 'contentHash'> = {
    feedId,
    urlKey: url,
    canonicalUrl: url,
    url,
    guid: `media-guid-${n}`,
    title: `Media item ${n}`,
    titleNorm: `media item ${n}`,
    author: null,
    categories: [],
    excerpt: `Summary of media item ${n}`,
    excerptHtml: `<p>Summary of media item ${n}</p>`,
    imageUrl: null,
    publishedAt: hoursAgo(1),
    feedBody: null,
    media: NO_MEDIA,
    ...overrides,
  };
  return { ...fields, contentHash: contentHashOf(fields) };
}

/** The same item refetched or carried by another feed, with `changes` and a matching hash. */
function carry(base: IngestItemInput, changes: Partial<IngestItemInput> = {}): IngestItemInput {
  const { contentHash: _previous, ...fields } = { ...base, ...changes };
  return { ...fields, contentHash: contentHashOf(fields) };
}

const ingest = (input: IngestItemInput): Promise<IngestItemResult> =>
  retryTransaction(ctx.worker, (tx) => ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14 }));

async function feedItemCount(articleId: string): Promise<number> {
  const result = await ctx.owner.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM feed_items WHERE article_id = $1',
    [articleId],
  );
  return result.rows[0]!.n;
}

// ── Extraction and merges ────────────────────────────────────────────────────────────────────

/** No evidence and no examined fragment. */
const UNEXAMINED: ExtractionMediaSignals = {
  videoEvidence: false,
  bodyImageCount: null,
  pageBodyExamined: false,
};

/** A Readability fragment examined without video evidence, with `images` in-body images. */
const examined = (images: number, videoEvidence = false): ExtractionMediaSignals => ({
  videoEvidence,
  bodyImageCount: images,
  pageBodyExamined: true,
});

const outcome = (
  article: { id: string },
  overrides: Partial<ExtractionOutcome> = {},
): ExtractionOutcome => ({
  articleId: article.id,
  expectedRevision: '1',
  body: page('The readable page text.'),
  lang: { lang: 'en', confidence: 0.5 },
  wordCount: 4,
  media: UNEXAMINED,
  ...overrides,
});

const save = (o: ExtractionOutcome) =>
  ctx.worker.transaction((tx) => saveExtractionResult(tx, workerOutbox(tx), o));

/** An article already extracted at revision 1 with a page body of `images` in-body images. */
async function extractedArticle(text: string, images: number): Promise<ArticleFixture> {
  const article = await createArticle(ctx.owner);
  expect(await save(outcome(article, { body: page(text), media: examined(images) }))).toMatchObject(
    { status: 'saved', advanced: true },
  );
  return article;
}

const merge = (sourceId: string, targetId: string) =>
  ctx.worker.transaction((tx) =>
    mergeArticles(tx, workerOutbox(tx), sourceId, targetId, { reason: 'redirect' }),
  );

/** Two articles with their own carrier and one subscriber each; the target was seen first. */
async function pair(options: { targetRevision?: number } = {}) {
  const fTarget = await createFeed(ctx.owner);
  const fSource = await createFeed(ctx.owner);
  const target = await createArticle(ctx.owner, {
    feedIds: [fTarget.id],
    firstSeenAt: hoursAgo(5),
    ...(options.targetRevision === undefined ? {} : { contentRevision: options.targetRevision }),
  });
  const source = await createArticle(ctx.owner, {
    feedIds: [fSource.id],
    firstSeenAt: hoursAgo(3),
  });
  return {
    source,
    target,
    sourceReader: await subscriber(fSource.id),
    targetReader: await subscriber(fTarget.id),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

describe('applyMediaSignals (spec 03 §6.4 "Re-ranking")', () => {
  const apply = (articleId: string, update: MediaSignalUpdate) =>
    ctx.worker.transaction(async (tx) => {
      // Callers hold the article row FOR UPDATE before any write.
      await tx.execute(sql`SELECT 1 FROM articles WHERE id = ${articleId}::bigint FOR UPDATE`);
      return applyMediaSignals(tx, workerOutbox(tx), articleId, update);
    });

  it('increments media_revision once per changing write and ranks the subscribers of every carrier', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const ux = await subscriber(x.id);
    const uy = await subscriber(y.id);
    const gone = await createUser(ctx.owner, { deletedAt: hoursAgo(1) });
    await createSubscription(ctx.owner, { userId: gone.id, feedId: y.id });
    const article = await createArticle(ctx.owner, { feedIds: [x.id, y.id] });
    await clearOutbox();

    // Both values change in one write: one revision, one incremental rank per active subscriber.
    expect(await apply(article.id, { hasVideo: true, bodyImageCount: 3 })).toEqual({
      status: 'changed',
      signals: { hasVideo: true, bodyImageCount: 3, mediaRevision: '1' },
      rankedUserIds: [ux, uy].sort(),
    });
    expect(await media(article.id)).toEqual({
      has_video: true,
      body_image_count: 3,
      media_revision: '1',
    });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(ux, uy));
    expect(await outboxQueues()).toEqual(['user.rank', 'user.rank']);

    // The same values again: nothing is written or recorded.
    await clearOutbox();
    const before = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(await apply(article.id, { hasVideo: true, bodyImageCount: 3 })).toEqual({
      status: 'unchanged',
      signals: { hasVideo: true, bodyImageCount: 3, mediaRevision: '1' },
    });
    expect(await apply(article.id, {})).toMatchObject({ status: 'unchanged' });
    const after = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(after.rows).toEqual(before.rows);
    expect(await outboxQueues()).toEqual([]);
  });

  it('keeps has_video monotonic: false only fills an unknown value, nothing returns it to false', async () => {
    const article = await createArticle(ctx.owner);
    expect(await media(article.id)).toEqual({
      has_video: null,
      body_image_count: null,
      media_revision: '0',
    });
    // null → false counts as a change (IS DISTINCT FROM).
    expect(await apply(article.id, { hasVideo: false })).toMatchObject({
      status: 'changed',
      signals: { hasVideo: false, mediaRevision: '1' },
    });
    expect(await apply(article.id, { hasVideo: false })).toMatchObject({ status: 'unchanged' });
    expect(await apply(article.id, { hasVideo: true })).toMatchObject({
      status: 'changed',
      signals: { hasVideo: true, mediaRevision: '2' },
    });
    expect(await apply(article.id, { hasVideo: false })).toMatchObject({
      status: 'unchanged',
      signals: { hasVideo: true, mediaRevision: '2' },
    });
    // The count follows the stored body: null → 0 and back are changes.
    expect(await apply(article.id, { bodyImageCount: null })).toMatchObject({
      status: 'unchanged',
    });
    expect(await apply(article.id, { bodyImageCount: 0 })).toMatchObject({
      status: 'changed',
      signals: { hasVideo: true, bodyImageCount: 0, mediaRevision: '3' },
    });
    expect(await apply(article.id, { bodyImageCount: null })).toMatchObject({
      status: 'changed',
      signals: { hasVideo: true, bodyImageCount: null, mediaRevision: '4' },
    });
    // An article without carriers ranks nobody.
    expect(await apply(article.id, { bodyImageCount: 2 })).toMatchObject({ rankedUserIds: [] });
  });

  it('rejects invalid values before writing and reports a missing article', async () => {
    const article = await createArticle(ctx.owner);
    await expect(apply(article.id, { bodyImageCount: -1 })).rejects.toThrow(RangeError);
    await expect(apply(article.id, { bodyImageCount: 1.5 })).rejects.toThrow(RangeError);
    await expect(apply(article.id, { bodyImageCount: 2 ** 31 })).rejects.toThrow(RangeError);
    expect(await media(article.id)).toMatchObject({ body_image_count: null, media_revision: '0' });
    expect(await apply('999999999', { hasVideo: true })).toEqual({ status: 'missing' });
  });
});

describe('ingestItem media signals (spec 03 §7 step 6)', () => {
  it('T7: a new article starts with the item’s signals; the count needs a stored body', async () => {
    const feed = await createFeed(ctx.owner);
    await subscriber(feed.id);
    await clearOutbox();
    const cases: Array<[string, Partial<IngestItemInput>, Omit<MediaRow, 'media_revision'>]> = [
      [
        'video evidence without a body',
        { media: { videoEvidence: true, feedBodyImageCount: null } },
        { has_video: true, body_image_count: null },
      ],
      [
        'an examined feed body without evidence',
        {
          feedBody: feedBody('A publisher body.'),
          media: { videoEvidence: false, feedBodyImageCount: 2 },
        },
        { has_video: false, body_image_count: 2 },
      ],
      ['an excerpt only', {}, { has_video: null, body_image_count: null }],
      [
        'evidence and a feed body',
        {
          feedBody: feedBody('A video post.'),
          media: { videoEvidence: true, feedBodyImageCount: 4 },
        },
        { has_video: true, body_image_count: 4 },
      ],
      [
        // Examined for video, but only images and no text: nothing is stored as the body.
        'an examined body that is not stored',
        { media: { videoEvidence: false, feedBodyImageCount: 3 } },
        { has_video: false, body_image_count: null },
      ],
      [
        'a stale item with a feed body',
        {
          publishedAt: daysAgo(30),
          feedBody: feedBody('An old body.'),
          media: { videoEvidence: false, feedBodyImageCount: 1 },
        },
        { has_video: false, body_image_count: 1 },
      ],
    ];
    for (const [name, overrides, expected] of cases) {
      const result = await ingest(item(feed.id, overrides));
      expect(result.outcome, name).toBe('inserted');
      expect(await media(result.articleId), name).toEqual({ ...expected, media_revision: '0' });
    }
    // No media rank for a new article: the new-carrier continuation ranks the feed's subscribers.
    expect(await outboxQueues()).toEqual([]);
  });

  it('T7: video evidence from any carrier sets has_video, and nothing sets it back to false', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const ux = await subscriber(x.id);
    const uy = await subscriber(y.id);
    const original = item(x.id, {
      feedBody: feedBody('The publisher body.'),
      media: { videoEvidence: false, feedBodyImageCount: 1 },
    });
    const { articleId } = await ingest(original);
    expect(await media(articleId)).toEqual({
      has_video: false,
      body_image_count: 1,
      media_revision: '0',
    });

    // Y is not the source feed; its item's video enclosure still counts.
    await clearOutbox();
    const fromY = carry(original, {
      feedId: y.id,
      guid: `y-${next()}`,
      media: { videoEvidence: true, feedBodyImageCount: 1 },
    });
    expect(await ingest(fromY)).toMatchObject({
      articleId,
      outcome: 'existing',
      newAssociation: true,
      contentChanged: false,
    });
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: 1,
      media_revision: '1',
    });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(ux, uy));

    // Items without evidence never set it back: an unchanged refetch, a source correction with a
    // new body (whose count is stored), and a page extraction without evidence.
    await clearOutbox();
    expect(await ingest(original)).toMatchObject({ contentChanged: false, newAssociation: false });
    expect(await media(articleId)).toMatchObject({ has_video: true, media_revision: '1' });
    expect(await outboxQueues()).toEqual([]);
    const corrected = carry(original, {
      excerpt: 'A corrected summary',
      feedBody: feedBody('The corrected publisher body.'),
      media: { videoEvidence: false, feedBodyImageCount: 3 },
    });
    expect(await ingest(corrected)).toMatchObject({ contentChanged: true, revision: '2' });
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: 3,
      media_revision: '2',
    });
    expect(
      await save(
        outcome(
          { id: articleId },
          { expectedRevision: '2', body: page('Page'), media: examined(0) },
        ),
      ),
    ).toMatchObject({ status: 'saved', advanced: true });
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: 0,
      media_revision: '3',
    });
  });

  it('T7: a repeat fetch adding only video evidence (same content_hash, no new feed_items row) increments media_revision once and ranks the subscribers of every carrier', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const ux = await subscriber(x.id);
    const uy = await subscriber(y.id);
    const original = item(x.id);
    const { articleId } = await ingest(original);
    await ingest(carry(original, { feedId: y.id, guid: `y-${next()}` }));
    expect(await feedItemCount(articleId)).toBe(2);
    expect(await media(articleId)).toEqual({
      has_video: null,
      body_image_count: null,
      media_revision: '0',
    });
    await clearOutbox();

    // The source feed now carries a video enclosure; nothing else about the item changed.
    const withVideo = carry(original, { media: { videoEvidence: true, feedBodyImageCount: null } });
    expect(withVideo.contentHash).toBe(original.contentHash);
    expect(await ingest(withVideo)).toEqual({
      articleId,
      outcome: 'existing',
      revision: '1',
      pipelineState: 'ingested',
      newAssociation: false,
      contentChanged: false,
      needsExtraction: false,
    });
    expect(await feedItemCount(articleId)).toBe(2);
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: null,
      media_revision: '1',
    });
    // Incremental ranks (no `full`) for the subscribers of both carriers, and nothing else.
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(ux, uy));
    expect(await outboxQueues()).toEqual(['user.rank', 'user.rank']);
  });

  it('T7: a repeat fetch storing the same media values records neither a media revision nor a rank', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    await subscriber(x.id);
    await subscriber(y.id);
    const original = item(x.id, {
      feedBody: feedBody('A video post with pictures.'),
      media: { videoEvidence: true, feedBodyImageCount: 2 },
    });
    const { articleId } = await ingest(original);
    await ingest(carry(original, { feedId: y.id, guid: `y-${next()}` }));
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: 2,
      media_revision: '0',
    });
    await clearOutbox();
    const before = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      articleId,
    ]);

    // The same item again, from either carrier, with or without the evidence.
    for (const repeat of [
      original,
      carry(original, { feedId: y.id, guid: `y-other-${next()}` }),
      carry(original, { media: { videoEvidence: false, feedBodyImageCount: 2 } }),
    ]) {
      expect(await ingest(repeat)).toMatchObject({
        articleId,
        newAssociation: false,
        contentChanged: false,
      });
    }
    expect(await media(articleId)).toEqual({
      has_video: true,
      body_image_count: 2,
      media_revision: '0',
    });
    expect(await outboxQueues()).toEqual([]);
    const after = await ctx.owner.query('SELECT updated_at FROM articles WHERE id = $1', [
      articleId,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  it('stores the count of a publisher body a source update installs, and keeps it otherwise', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const ux = await subscriber(x.id);
    const original = item(x.id, {
      feedBody: feedBody('The first body.'),
      media: { videoEvidence: false, feedBodyImageCount: 3 },
    });
    const { articleId } = await ingest(original);
    await clearOutbox();

    const updated = carry(original, {
      excerpt: 'An edited summary',
      feedBody: feedBody('The second body.'),
      media: { videoEvidence: false, feedBodyImageCount: 5 },
    });
    expect(await ingest(updated)).toMatchObject({ contentChanged: true, revision: '2' });
    expect(await getArticleBody(ctx.worker, articleId)).toMatchObject({
      articleRevision: '2',
      bodyText: 'The second body.',
    });
    expect(await media(articleId)).toEqual({
      has_video: false,
      body_image_count: 5,
      media_revision: '1',
    });
    // The reset's rank and the media rank (the outbox keeps both; delivery debounces per user).
    expect(await rankIntents('source_changed')).toEqual([{ userId: ux, reason: 'source_changed' }]);
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(ux));

    // A non-source carrier's body is never stored, so its count never applies.
    await ingest(
      carry(updated, {
        feedId: y.id,
        guid: `y-${next()}`,
        feedBody: feedBody('A syndicated body.'),
        media: { videoEvidence: false, feedBodyImageCount: 9 },
      }),
    );
    expect(await media(articleId)).toMatchObject({ body_image_count: 5, media_revision: '1' });

    // Without a body in the update the stored body stays readable at its old revision: its count
    // still describes it.
    const dropped = carry(updated, {
      excerpt: 'Edited again',
      feedBody: null,
      media: { videoEvidence: false, feedBodyImageCount: null },
    });
    expect(await ingest(dropped)).toMatchObject({ contentChanged: true, revision: '3' });
    expect(await getArticleBody(ctx.worker, articleId)).toMatchObject({
      articleRevision: '2',
      bodyText: 'The second body.',
    });
    expect(await media(articleId)).toEqual({
      has_video: false,
      body_image_count: 5,
      media_revision: '1',
    });

    // A new body with the same count is no media change.
    await clearOutbox();
    const same = carry(dropped, {
      excerpt: 'Edited a third time',
      feedBody: feedBody('The third body.'),
      media: { videoEvidence: false, feedBodyImageCount: 5 },
    });
    expect(await ingest(same)).toMatchObject({ contentChanged: true, revision: '4' });
    expect(await media(articleId)).toMatchObject({ body_image_count: 5, media_revision: '1' });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual([]);
  });

  it('rejects invalid media inputs before writing', async () => {
    const feed = await createFeed(ctx.owner);
    const bad = item(feed.id, { media: { videoEvidence: false, feedBodyImageCount: -1 } });
    await expect(ingest(bad)).rejects.toThrow(RangeError);
    const result = await ctx.owner.query('SELECT 1 FROM articles WHERE url_key = $1', [bad.urlKey]);
    expect(result.rowCount).toBe(0);
  });
});

describe('saveExtractionResult media signals (spec 03 §8.1 step 6)', () => {
  it('stores the page body’s count and marks an examined page without evidence false', async () => {
    const feed = await createFeed(ctx.owner);
    const reader = await subscriber(feed.id);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    await clearOutbox();
    expect(
      await save(outcome(article, { body: page('A page with pictures.'), media: examined(3) })),
    ).toEqual({ status: 'saved', revision: '1', advanced: true, reset: false });
    expect(await media(article.id)).toEqual({
      has_video: false,
      body_image_count: 3,
      media_revision: '1',
    });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(reader));
  });

  it('T7: the count comes from the same body as word_count, also when a feed body is kept', async () => {
    // A complete publisher body outranks a partial page teaser: the kept body keeps its count, and
    // the examined page without evidence makes an unknown has_video false.
    const text = 'Complete publisher text of six words';
    const kept = await createArticle(ctx.owner);
    await storeBody(
      kept.id,
      '1',
      feedBody(text, { completeness: 'complete', completenessReason: null }),
    );
    await setMedia(kept.id, null, 2);
    const teaser = page('Subscribe to read', {
      completeness: 'partial',
      completenessReason: 'paywall',
    });
    expect(
      await save(outcome(kept, { body: teaser, wordCount: 3, media: examined(7) })),
    ).toMatchObject({ status: 'saved', advanced: true });
    expect(await getArticleBody(ctx.worker, kept.id)).toMatchObject({
      extractorVersion: FEED_BODY_EXTRACTOR,
      bodyText: text,
    });
    expect(await wordCount(kept.id)).toBe(6);
    expect(await media(kept.id)).toEqual({
      has_video: false,
      body_image_count: 2,
      media_revision: '1',
    });

    // A failed extraction over a feed body keeps the feed count; the stored feed body was
    // examined at ingestion, so an unknown has_video becomes false.
    const failed = await createArticle(ctx.owner);
    await storeBody(failed.id, '1', feedBody(text));
    await setMedia(failed.id, null, 4);
    expect(
      await save(outcome(failed, { body: empty('failed', 'timeout'), wordCount: 2 })),
    ).toMatchObject({ status: 'saved', advanced: true });
    expect(await getArticleBody(ctx.worker, failed.id)).toMatchObject({ bodyText: text });
    expect(await wordCount(failed.id)).toBe(6);
    expect(await media(failed.id)).toEqual({
      has_video: false,
      body_image_count: 4,
      media_revision: '1',
    });

    // A failed extraction of a newer revision keeps the older revision's page body: the word count
    // and the image count both keep describing that body, not the excerpt.
    const older = await extractedArticle(text, 5);
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), older.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(
      await save(
        outcome(older, { expectedRevision: '2', body: empty('failed', 'timeout'), wordCount: 2 }),
      ),
    ).toMatchObject({ status: 'saved', revision: '2', advanced: true });
    expect(await getArticleBody(ctx.worker, older.id)).toMatchObject({
      articleRevision: '1',
      bodyText: text,
    });
    expect(await wordCount(older.id)).toBe(6);
    expect(await media(older.id)).toMatchObject({ has_video: false, body_image_count: 5 });

    // A partial feed body replaced by the page: the page's count.
    const replaced = await createArticle(ctx.owner);
    await storeBody(replaced.id, '1', feedBody(text));
    await setMedia(replaced.id, false, 4);
    expect(
      await save(outcome(replaced, { body: page('Two words'), wordCount: 2, media: examined(1) })),
    ).toMatchObject({ status: 'saved' });
    expect(await wordCount(replaced.id)).toBe(2);
    expect(await media(replaced.id)).toEqual({
      has_video: false,
      body_image_count: 1,
      media_revision: '1',
    });
  });

  it('T7: an excerpt-only article has no count, and a re-stored feed body keeps its count', async () => {
    // A publisher body of revision 1, then a source update without a body (revision 2): the
    // linkless article's extraction stores its excerpt, which is no body.
    const linkless = await createArticle(ctx.owner);
    await storeBody(linkless.id, '1', feedBody('The old publisher body.'));
    await setMedia(linkless.id, null, 4);
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), linkless.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(
      await save(
        outcome(linkless, {
          expectedRevision: '2',
          body: excerptOnly('Only the summary'),
          wordCount: 3,
        }),
      ),
    ).toMatchObject({ status: 'saved', revision: '2' });
    expect(await getArticleBody(ctx.worker, linkless.id)).toMatchObject({
      articleRevision: '2',
      completenessReason: 'excerpt_only',
    });
    // The excerpt proves nothing about video either: has_video stays unknown.
    expect(await media(linkless.id)).toEqual({
      has_video: null,
      body_image_count: null,
      media_revision: '1',
    });

    // A linkless article whose extraction re-stores its publisher body keeps the ingest count.
    const restored = await createArticle(ctx.owner);
    const publisher = feedBody('The publisher body, stored at ingestion.', {
      completeness: 'complete',
      completenessReason: null,
    });
    await storeBody(restored.id, '1', publisher);
    await setMedia(restored.id, null, 4);
    expect(await save(outcome(restored, { body: publisher, wordCount: 6 }))).toMatchObject({
      status: 'saved',
    });
    expect(await media(restored.id)).toEqual({
      has_video: false,
      body_image_count: 4,
      media_revision: '1',
    });
  });

  it('T7: page evidence or a skipped video-host URL sets true, and nothing sets it back', async () => {
    const withVideo = await createArticle(ctx.owner);
    expect(
      await save(
        outcome(withVideo, { body: page('A page with a player.'), media: examined(1, true) }),
      ),
    ).toMatchObject({ status: 'saved' });
    expect(await media(withVideo.id)).toEqual({
      has_video: true,
      body_image_count: 1,
      media_revision: '1',
    });
    // An explicit upgrade installing a changed body without evidence keeps true; the count follows
    // the installed body.
    expect(
      await save(
        outcome(withVideo, { body: page('A changed page.'), upgrade: true, media: examined(4) }),
      ),
    ).toMatchObject({ status: 'saved', revision: '2', reset: true });
    expect(await media(withVideo.id)).toEqual({
      has_video: true,
      body_image_count: 4,
      media_revision: '2',
    });

    // A URL skipped for its video host (spec 03 §8.1 step 1) is evidence; no body, no count.
    const skipped = await createArticle(ctx.owner);
    expect(
      await save(
        outcome(skipped, {
          body: empty('skipped'),
          wordCount: 2,
          media: { videoEvidence: true, bodyImageCount: null, pageBodyExamined: false },
        }),
      ),
    ).toMatchObject({ status: 'saved', advanced: true });
    expect(await media(skipped.id)).toEqual({
      has_video: true,
      body_image_count: null,
      media_revision: '1',
    });
  });

  it('leaves has_video unknown when nothing was examined, and the count null without a body', async () => {
    const feed = await createFeed(ctx.owner);
    await subscriber(feed.id);
    for (const status of ['blocked', 'not_html', 'failed'] as const) {
      const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
      await clearOutbox();
      expect(
        await save(outcome(article, { body: empty(status), wordCount: 2 })),
        status,
      ).toMatchObject({ status: 'saved', advanced: true });
      expect(await media(article.id), status).toEqual({
        has_video: null,
        body_image_count: null,
        media_revision: '0',
      });
      expect(await rankIntents(MEDIA_RANK_REASON), status).toEqual([]);
    }
  });

  it('applies the rules in the stale branch and the stale-preserving upgrade', async () => {
    const article = await createArticle(ctx.owner);
    await setState(article.id, 'stale');
    await storeBody(article.id, '1', feedBody('The stale publisher body.'));
    await setMedia(article.id, null, 2);
    expect(
      await save(outcome(article, { body: page('The stale page.'), media: examined(5) })),
    ).toEqual({ status: 'saved', revision: '1', advanced: false, reset: false });
    expect(await media(article.id)).toEqual({
      has_video: false,
      body_image_count: 5,
      media_revision: '1',
    });
    expect(
      await save(
        outcome(article, {
          body: page('An edited stale page.'),
          upgrade: true,
          media: examined(0, true),
        }),
      ),
    ).toEqual({ status: 'saved', revision: '2', advanced: false, reset: true });
    expect(await media(article.id)).toEqual({
      has_video: true,
      body_image_count: 0,
      media_revision: '2',
    });
    const state = await ctx.owner.query('SELECT pipeline_state FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(state.rows[0]).toEqual({ pipeline_state: 'stale' });
  });

  it('keeps the count on a language-only upgrade, which still applies video evidence', async () => {
    const article = await extractedArticle('Version two of the page.', 6);
    expect(await media(article.id)).toEqual({
      has_video: false,
      body_image_count: 6,
      media_revision: '1',
    });
    expect(
      await save(
        outcome(article, {
          body: page('Version two of the page.'),
          lang: { lang: 'sk', confidence: 0.75 },
          upgrade: true,
          media: examined(9, true),
        }),
      ),
    ).toEqual({ status: 'saved', revision: '2', advanced: true, reset: true });
    expect(await media(article.id)).toEqual({
      has_video: true,
      body_image_count: 6,
      media_revision: '2',
    });
  });

  it('writes no media signals for unchanged, stale_revision and missing results', async () => {
    const article = await extractedArticle('Stable page text.', 2);
    const before = await media(article.id);
    expect(before).toEqual({ has_video: false, body_image_count: 2, media_revision: '1' });
    // A duplicate or late job for the processed revision.
    expect(
      await save(outcome(article, { body: page('Other text.'), media: examined(8, true) })),
    ).toEqual({ status: 'unchanged', revision: '1' });
    expect(await media(article.id)).toEqual(before);
    // A result for an older revision.
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(await save(outcome(article, { media: examined(8, true) }))).toEqual({
      status: 'stale_revision',
      revision: '2',
    });
    expect(await media(article.id)).toEqual(before);
    expect(await save(outcome({ id: '999999999' }, { media: examined(8, true) }))).toEqual({
      status: 'missing',
    });
  });

  it('rejects inconsistent media signals before writing', async () => {
    const article = await createArticle(ctx.owner);
    const invalid: ExtractionMediaSignals[] = [
      { videoEvidence: false, bodyImageCount: 3, pageBodyExamined: false },
      { videoEvidence: false, bodyImageCount: -1, pageBodyExamined: true },
    ];
    for (const signals of invalid) {
      await expect(save(outcome(article, { media: signals }))).rejects.toThrow(RangeError);
    }
    expect(await getArticleBody(ctx.worker, article.id)).toBeNull();
    expect(await media(article.id)).toMatchObject({ media_revision: '0' });
  });
});

describe('mergeArticles media signals (spec 03 §8.4)', () => {
  it('keeps the target body’s count, and has_video is true when either article has it', async () => {
    const { source, target, sourceReader, targetReader } = await pair();
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'extracted', lang = 'en' WHERE id = ANY($1::bigint[])`,
      [[source.id, target.id]],
    );
    await storeBody(target.id, '1', page('Target body'));
    await storeBody(source.id, '1', page('Source body'));
    await setMedia(target.id, false, 2);
    await setMedia(source.id, true, 7);
    await clearOutbox();

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged', revision: '2' });
    expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({ bodyText: 'Target body' });
    expect(await media(target.id)).toEqual({
      has_video: true,
      body_image_count: 2,
      media_revision: '1',
    });
    // The subscribers of every carrier, the moved one included (next to the merge's full ranks).
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(mediaRanks(sourceReader, targetReader));
    expect((await rankIntents('merge')).filter((p) => p.full === true)).toHaveLength(2);
  });

  it('moves the source body’s count when the source body is taken; false wins over unknown', async () => {
    const { source, target } = await pair();
    await setState(source.id, 'extracted');
    await storeBody(target.id, '1', empty('failed', 'timeout'));
    await storeBody(source.id, '1', page('Source body'));
    await setMedia(target.id, false, null);
    await setMedia(source.id, null, 7);

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({ bodyText: 'Source body' });
    expect(await media(target.id)).toEqual({
      has_video: false,
      body_image_count: 7,
      media_revision: '1',
    });
  });

  it('keeps the target’s own row and count without a valid body, and null without one', async () => {
    // The target's page body is of an older revision (not valid), and the source has none: the
    // target's row stays readable, and its count with it.
    const old = await pair({ targetRevision: 2 });
    await storeBody(old.target.id, '1', page('Older target body'));
    await setMedia(old.target.id, null, 4);
    expect(await merge(old.source.id, old.target.id)).toMatchObject({ status: 'merged' });
    expect(await getArticleBody(ctx.worker, old.target.id)).toMatchObject({
      bodyText: 'Older target body',
    });
    expect(await media(old.target.id)).toEqual({
      has_video: null,
      body_image_count: 4,
      media_revision: '0',
    });

    // The source's body is of an older revision and goes with the source: no body is kept, so no
    // count; the source's false still makes the unknown target false.
    const none = await pair();
    await ctx.owner.query('UPDATE articles SET content_revision = 2 WHERE id = $1', [
      none.source.id,
    ]);
    await storeBody(none.source.id, '1', page('Stale source body'));
    await setMedia(none.source.id, false, 3);
    await clearOutbox();
    expect(await merge(none.source.id, none.target.id)).toMatchObject({ status: 'merged' });
    expect(await getArticleBody(ctx.worker, none.target.id)).toBeNull();
    expect(await media(none.target.id)).toEqual({
      has_video: false,
      body_image_count: null,
      media_revision: '1',
    });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual(
      mediaRanks(none.sourceReader, none.targetReader),
    );

    // Both unknown and no body: nothing changes, nothing is ranked for media.
    const unknown = await pair();
    await clearOutbox();
    expect(await merge(unknown.source.id, unknown.target.id)).toMatchObject({ status: 'merged' });
    expect(await media(unknown.target.id)).toEqual({
      has_video: null,
      body_image_count: null,
      media_revision: '0',
    });
    expect(await rankIntents(MEDIA_RANK_REASON)).toEqual([]);
  });
});
