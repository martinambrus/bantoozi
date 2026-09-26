import { createHash } from 'node:crypto';

import { createCard, createFeed, createSubscription, createUser } from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Transaction } from '../../src/client.js';
import {
  articleSourceFeedId,
  findUrlKeyOwner,
  ingestItem,
  lockUrlKeys,
  type IngestItemInput,
  type IngestItemResult,
} from '../../src/ingest/articles.js';
import {
  FEED_BODY_EXTRACTOR,
  getArticleBody,
  type ArticleBodyInput,
} from '../../src/ingest/bodies.js';
import { retryTransaction } from '../../src/ingest/retry.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * Item ingestion (spec 03 §7, §13; spec 02 §3.3): exact URL and feed-scoped GUID identity, the
 * source-feed rule, stale marking and the url_key lock/retry design, against a real migrated
 * database as the worker role.
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

/** A stand-in for spec 03 §6.2: any change of these inputs changes the hash. */
const contentHashOf = (i: Omit<IngestItemInput, 'contentHash'>) =>
  sha([
    i.title,
    i.excerpt,
    i.author,
    [...i.categories].sort(),
    i.url ?? i.canonicalUrl,
    i.feedBody?.bodyText ?? null,
  ]);

const feedBody = (text: string): ArticleBodyInput => ({
  status: 'ok',
  resolvedUrl: null,
  httpStatus: null,
  bodyText: text,
  bodyHtml: `<p>${text}</p>`,
  completeness: 'complete',
  completenessReason: null,
  bodyLead: text.slice(0, 1_500),
  extractorVersion: FEED_BODY_EXTRACTOR,
  error: null,
});

/** One normalized item of `feedId` at a fresh URL; `contentHash` follows the other fields. */
function item(feedId: string, overrides: Partial<IngestItemInput> = {}): IngestItemInput {
  const n = next();
  const url = `https://news.example.test/items/${n}`;
  const title = overrides.title ?? `Item ${n}`;
  const excerpt = overrides.excerpt === undefined ? `Summary of item ${n}` : overrides.excerpt;
  const fields: Omit<IngestItemInput, 'contentHash'> = {
    feedId,
    urlKey: url,
    canonicalUrl: url,
    url,
    guid: `guid-${n}`,
    title,
    titleNorm: title.toLowerCase(),
    author: null,
    categories: [],
    excerpt,
    excerptHtml: excerpt === null ? null : `<p>${excerpt}</p>`,
    imageUrl: null,
    publishedAt: hoursAgo(1),
    feedBody: null,
    ...overrides,
    // No video evidence; a carried publisher body was examined and has no images (spec 03 §6.4).
    media: overrides.media ?? {
      videoEvidence: false,
      feedBodyImageCount: (overrides.feedBody ?? null) === null ? null : 0,
    },
  };
  return { ...fields, contentHash: overrides.contentHash ?? contentHashOf(fields) };
}

/** The same item carried by another feed (or refetched), with `changes` and a matching hash. */
function carry(base: IngestItemInput, changes: Partial<IngestItemInput> = {}): IngestItemInput {
  const { contentHash: _previous, ...fields } = { ...base, ...changes };
  return { ...fields, contentHash: changes.contentHash ?? contentHashOf(fields) };
}

/** `base` at another URL (a publisher moving an item), keeping everything else. */
function moved(base: IngestItemInput, url: string, keepHash = false): IngestItemInput {
  return carry(base, {
    url,
    urlKey: url,
    canonicalUrl: url,
    ...(keepHash ? { contentHash: base.contentHash } : {}),
  });
}

const ingest = (input: IngestItemInput, maxAgeDays = 14): Promise<IngestItemResult> =>
  retryTransaction(ctx.worker, (tx) => ingestItem(tx, workerOutbox(tx), input, { maxAgeDays }));

interface ArticleRow {
  url: string | null;
  canonical_url: string;
  url_key: string;
  title: string;
  title_norm: string;
  author: string | null;
  categories: string[];
  excerpt: string | null;
  excerpt_html: string | null;
  image_url: string | null;
  published_at: Date | null;
  content_hash: string;
  revision: string;
  pipeline_state: string;
}

async function articleRow(id: string): Promise<ArticleRow> {
  const result = await ctx.owner.query<ArticleRow>(
    `SELECT url, canonical_url, url_key, title, title_norm, author, categories, excerpt, excerpt_html,
            image_url, published_at, content_hash, content_revision::text AS revision, pipeline_state
       FROM articles WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

async function associations(
  articleId: string,
): Promise<Array<{ feed: string; guid: string | null }>> {
  const result = await ctx.owner.query<{ feed: string; guid: string | null }>(
    'SELECT feed_id::text AS feed, guid FROM feed_items WHERE article_id = $1 ORDER BY feed_id',
    [articleId],
  );
  return result.rows;
}

/** How many identity rows name `urlKey`: articles plus aliases (the invariant allows one). */
async function keyRows(urlKey: string): Promise<{ articles: number; aliases: number }> {
  const result = await ctx.owner.query<{ articles: number; aliases: number }>(
    `SELECT (SELECT count(*)::int FROM articles WHERE url_key = $1) AS articles,
            (SELECT count(*)::int FROM article_aliases WHERE url_key = $1) AS aliases`,
    [urlKey],
  );
  return result.rows[0]!;
}

async function outboxIntents(): Promise<
  Array<{ queue: string; payload: Record<string, unknown> }>
> {
  const result = await ctx.owner.query<{ queue: string; payload: Record<string, unknown> }>(
    'SELECT queue, payload FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
  );
  return result.rows;
}

async function clearOutbox(): Promise<void> {
  await ctx.owner.query('DELETE FROM job_outbox');
}

async function questionSet(kind: 'enrich' | 'match'): Promise<{ id: string; sha: string }> {
  const digest = sha([kind, next()]);
  const result = await ctx.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ($1, $2, $3, '{}') RETURNING id::text AS id`,
    [kind, `${kind}-test-${digest.slice(0, 12)}`, digest],
  );
  return { id: result.rows[0]!.id, sha: digest };
}

/** Current facets and a primary card answer at the article's revision 1; state `matched`. */
async function answer(articleId: string, cardId: string): Promise<void> {
  const enrich = await questionSet('enrich');
  const match = await questionSet('match');
  await ctx.owner.query(
    `UPDATE articles SET pipeline_state = 'matched', enrich_engine = 'typesafe' WHERE id = $1`,
    [articleId],
  );
  await ctx.owner.query(
    `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256, engine,
                                 state_variant, answers, features)
     VALUES ($1, $2, 1, 's', 'typesafe', 'native', '{}', '{}')`,
    [articleId, enrich.id],
  );
  await ctx.owner.query(
    `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                               state_sha256, card_input_sha256, state_variant)
     VALUES ($1, $2, 0.9, 'typesafe', $3, 1, 's', 'c', 'native')`,
    [articleId, cardId, match.sha],
  );
}

/** A promise every party awaits until all parties arrived (two transactions started together). */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

interface Traced<T> {
  result: Promise<T>;
  /** The backend pid of the (latest) attempt's connection. */
  pid: Promise<number>;
  attempts: () => number;
}

/** `fn` in a retried worker transaction, started now, that first announces its backend pid. */
function traced<T>(fn: (tx: Transaction) => Promise<T>): Traced<T> {
  let attempts = 0;
  let announce: (pid: number) => void = () => undefined;
  const pid = new Promise<number>((resolve) => {
    announce = resolve;
  });
  const result = retryTransaction(ctx.worker, async (tx) => {
    attempts += 1;
    const self = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    announce(self.rows[0]!.pid);
    return fn(tx);
  });
  // The test awaits `result`; a failure before that must not be an unhandled rejection.
  result.catch(() => undefined);
  return { result, pid, attempts: () => attempts };
}

const tracedIngest = (input: IngestItemInput): Traced<IngestItemResult> =>
  traced((tx) => ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14 }));

/** Wait until backend `pid` is blocked on a heavyweight lock (advisory, row or transaction). */
async function waitForLockWait(pid: Promise<number>): Promise<void> {
  const backend = await pid;
  for (let i = 0; i < 400; i += 1) {
    const activity = await ctx.adminPool.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [backend],
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${backend} never waited on a lock`);
}

interface OpenTransaction {
  client: pg.PoolClient;
  /** Ends the transaction once; later calls are no-ops. */
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

const openTransactions: OpenTransaction[] = [];

/**
 * A transaction on a separate worker connection that stays open while the test drives another
 * one: a concurrent writer that skips the url_key lock, or a merge holding article rows. Rolled
 * back after each test unless the test committed it.
 */
async function openTransaction(): Promise<OpenTransaction> {
  const client = await ctx.workerPool.connect();
  await client.query('BEGIN');
  let open = true;
  const finish = async (command: 'COMMIT' | 'ROLLBACK') => {
    if (!open) return;
    open = false;
    try {
      await client.query(command);
    } finally {
      client.release();
    }
  };
  const transaction = {
    client,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
  openTransactions.push(transaction);
  return transaction;
}

afterEach(async () => {
  await Promise.all(openTransactions.splice(0).map((t) => t.rollback()));
});

describe('ingestItem: new articles (spec 03 §7 steps 5–6)', () => {
  it('inserts a fresh article with its first association and records no stage work', async () => {
    const feed = await createFeed(ctx.owner);
    const input = item(feed.id, {
      author: 'A. Writer',
      categories: ['Tech', 'Science'],
      imageUrl: 'https://img.example.test/1.png',
      publishedAt: daysAgo(2),
    });
    await clearOutbox();
    const result = await ingest(input);
    expect(result).toEqual({
      articleId: expect.stringMatching(/^[1-9][0-9]*$/),
      outcome: 'inserted',
      revision: '1',
      pipelineState: 'ingested',
      newAssociation: true,
      contentChanged: false,
      needsExtraction: true,
    });
    expect(await articleRow(result.articleId)).toEqual({
      url: input.url,
      canonical_url: input.canonicalUrl,
      url_key: input.urlKey,
      title: input.title,
      title_norm: input.titleNorm,
      author: 'A. Writer',
      categories: ['Tech', 'Science'],
      excerpt: input.excerpt,
      excerpt_html: input.excerptHtml,
      image_url: 'https://img.example.test/1.png',
      published_at: input.publishedAt,
      content_hash: input.contentHash,
      revision: '1',
      pipeline_state: 'ingested',
    });
    expect(await associations(result.articleId)).toEqual([{ feed: feed.id, guid: input.guid }]);
    expect(await getArticleBody(ctx.worker, result.articleId)).toBeNull();
    // The worker pipeline records extraction (and the new-carrier ranks), never the repository.
    expect(await outboxIntents()).toEqual([]);
  });

  it('marks an item published before the age window stale, and an undated item fresh', async () => {
    const feed = await createFeed(ctx.owner);
    const old = await ingest(item(feed.id, { publishedAt: daysAgo(15) }));
    expect(old).toMatchObject({
      outcome: 'inserted',
      pipelineState: 'stale',
      newAssociation: true,
      needsExtraction: false,
    });
    expect((await articleRow(old.articleId)).pipeline_state).toBe('stale');
    const recent = await ingest(item(feed.id, { publishedAt: daysAgo(13) }));
    expect(recent).toMatchObject({ pipelineState: 'ingested', needsExtraction: true });
    // An unknown publication time is never replaced by the fetch time, and is not stale.
    const undated = await ingest(item(feed.id, { publishedAt: null }));
    expect(undated).toMatchObject({ pipelineState: 'ingested', needsExtraction: true });
    expect((await articleRow(undated.articleId)).published_at).toBeNull();
    // The window is INGEST_MAX_AGE_DAYS.
    const wider = await ingest(item(feed.id, { publishedAt: daysAgo(15) }), 30);
    expect(wider).toMatchObject({ pipelineState: 'ingested', needsExtraction: true });
  });

  it('stores a carried publisher body as the feed-v1 fallback at revision 1', async () => {
    const feed = await createFeed(ctx.owner);
    const result = await ingest(item(feed.id, { feedBody: feedBody('The whole story.') }));
    expect(await getArticleBody(ctx.worker, result.articleId)).toMatchObject({
      articleRevision: '1',
      status: 'ok',
      extractorVersion: 'feed-v1',
      bodyText: 'The whole story.',
      bodyHtml: '<p>The whole story.</p>',
      completeness: 'complete',
    });
    // A stale item keeps its feed body too: stored and readable, only inference is skipped.
    const stale = await ingest(
      item(feed.id, { publishedAt: daysAgo(40), feedBody: feedBody('Old story.') }),
    );
    expect(stale.pipelineState).toBe('stale');
    expect(await getArticleBody(ctx.worker, stale.articleId)).toMatchObject({
      articleRevision: '1',
      bodyText: 'Old story.',
    });
  });

  it('keys a linkless item by its feed-scoped URN and stores no link', async () => {
    const feed = await createFeed(ctx.owner);
    const urn = `urn:bantoozi:${feed.id}:${sha('opaque-id-1')}`;
    const input = item(feed.id, {
      url: null,
      urlKey: urn,
      canonicalUrl: urn,
      guid: 'opaque-id-1',
      feedBody: feedBody('Only the feed carries this text.'),
    });
    const first = await ingest(input);
    expect(first).toMatchObject({ outcome: 'inserted', needsExtraction: true });
    expect(await articleRow(first.articleId)).toMatchObject({
      url: null,
      canonical_url: urn,
      url_key: urn,
    });
    expect(await getArticleBody(ctx.worker, first.articleId)).toMatchObject({
      extractorVersion: 'feed-v1',
      bodyText: 'Only the feed carries this text.',
    });
    const again = await ingest(input);
    expect(again).toMatchObject({
      articleId: first.articleId,
      outcome: 'existing',
      newAssociation: false,
      contentChanged: false,
      needsExtraction: false,
    });
  });
});

describe('ingestItem: exact identity and the source feed (spec 03 §7 step 2)', () => {
  it('associates a second feed carrying the same URL instead of inserting another article', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const original = item(x.id);
    const first = await ingest(original);
    const syndicated = carry(original, {
      feedId: y.id,
      guid: 'y-guid',
      excerpt: 'A different summary',
    });
    const second = await ingest(syndicated);
    expect(second).toEqual({
      articleId: first.articleId,
      outcome: 'existing',
      revision: '1',
      pipelineState: 'ingested',
      newAssociation: true,
      contentChanged: false,
      needsExtraction: false,
    });
    expect(await keyRows(original.urlKey)).toEqual({ articles: 1, aliases: 0 });
    expect(await associations(first.articleId)).toEqual([
      { feed: x.id, guid: original.guid },
      { feed: y.id, guid: 'y-guid' },
    ]);
    // Refetching either feed is not a new association.
    expect(await ingest(syndicated)).toMatchObject({ outcome: 'existing', newAssociation: false });
    expect(await ingest(original)).toMatchObject({ outcome: 'existing', newAssociation: false });
    expect(await articleSourceFeedId(ctx.worker, first.articleId)).toBe(x.id);
  });

  it('lets only the source feed update the shared inputs, resetting answers once', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const reader = await createUser(ctx.owner);
    const offReader = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: reader.id,
      feedId: x.id,
      mode: 'active',
      activatedAt: hoursAgo(1),
    });
    await createSubscription(ctx.owner, { userId: offReader.id, feedId: y.id, mode: 'off' });
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [reader.id, card.id],
    );
    const original = item(x.id, { feedBody: feedBody('First body.') });
    const created = await ingest(original);
    const articleId = created.articleId;

    // A later syndicated summary from a non-source feed is never stored and never invalidates.
    const syndicated = carry(original, {
      feedId: y.id,
      guid: 'syndicated',
      title: 'Aggregator headline',
      titleNorm: 'aggregator headline',
      excerpt: 'Aggregator summary',
      excerptHtml: '<p>Aggregator summary</p>',
    });
    expect(await ingest(syndicated)).toMatchObject({
      outcome: 'existing',
      newAssociation: true,
      contentChanged: false,
      needsExtraction: false,
      revision: '1',
    });
    expect(await ingest(syndicated)).toMatchObject({ contentChanged: false, revision: '1' });
    expect(await articleRow(articleId)).toMatchObject({
      title: original.title,
      excerpt: original.excerpt,
      content_hash: original.contentHash,
      revision: '1',
    });

    await answer(articleId, card.id);
    await clearOutbox();
    const corrected = carry(original, {
      title: 'Corrected title',
      titleNorm: 'corrected title',
      author: 'Editor',
      categories: ['World'],
      excerpt: 'Corrected summary',
      excerptHtml: '<p>Corrected summary</p>',
      imageUrl: 'https://img.example.test/corrected.png',
      publishedAt: hoursAgo(2),
      feedBody: feedBody('Corrected body.'),
    });
    const changed = await ingest(corrected);
    expect(changed).toEqual({
      articleId,
      outcome: 'existing',
      revision: '2',
      pipelineState: 'ingested',
      newAssociation: false,
      contentChanged: true,
      needsExtraction: true,
    });
    expect(await articleRow(articleId)).toEqual({
      url: original.url,
      canonical_url: original.canonicalUrl,
      url_key: original.urlKey,
      title: 'Corrected title',
      title_norm: 'corrected title',
      author: 'Editor',
      categories: ['World'],
      excerpt: 'Corrected summary',
      excerpt_html: '<p>Corrected summary</p>',
      image_url: 'https://img.example.test/corrected.png',
      published_at: corrected.publishedAt,
      content_hash: corrected.contentHash,
      revision: '2',
      pipeline_state: 'ingested',
    });
    // The old answers are gone; the admitted card is queued at the new revision.
    const derived = await ctx.owner.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM article_facets WHERE article_id = $1) AS facets,
              (SELECT count(*)::int FROM card_answers WHERE article_id = $1) AS answers`,
      [articleId],
    );
    expect(derived.rows[0]).toEqual({ facets: 0, answers: 0 });
    const queue = await ctx.owner.query(
      'SELECT card_id::text AS card, article_revision::text AS revision FROM match_queue WHERE article_id = $1',
      [articleId],
    );
    expect(queue.rows).toEqual([{ card: card.id, revision: '2' }]);
    // The carried feed body is installed at the new revision, not left stale.
    expect(await getArticleBody(ctx.worker, articleId)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Corrected body.',
      extractorVersion: 'feed-v1',
    });
    // Only rank intents: extraction for revision 2 is recorded by the worker pipeline.
    expect((await outboxIntents()).map((i) => [i.queue, i.payload])).toEqual(
      [reader.id, offReader.id]
        .sort()
        .map((userId) => ['user.rank', { userId, reason: 'source_changed' }]),
    );

    // An identical refetch never resets again.
    expect(await ingest(corrected)).toMatchObject({ contentChanged: false, revision: '2' });
    expect(await ingest(syndicated)).toMatchObject({ contentChanged: false, revision: '2' });
  });

  it('breaks a first-seen tie by the lower feed id', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    expect(BigInt(x.id) < BigInt(y.id)).toBe(true);
    const original = item(x.id);
    const { articleId } = await ingest(original);
    await ingest(carry(original, { feedId: y.id, guid: 'y' }));
    await ctx.owner.query(
      `UPDATE feed_items SET first_seen_at = '2026-01-01T00:00:00Z' WHERE article_id = $1`,
      [articleId],
    );
    expect(await articleSourceFeedId(ctx.worker, articleId)).toBe(x.id);
    const fromY = carry(original, { feedId: y.id, guid: 'y', excerpt: 'Edited by Y' });
    expect(await ingest(fromY)).toMatchObject({ contentChanged: false, revision: '1' });
    // The earliest carrier wins over the lower id.
    await ctx.owner.query(
      `UPDATE feed_items SET first_seen_at = '2025-12-31T23:59:00Z' WHERE article_id = $1 AND feed_id = $2`,
      [articleId, y.id],
    );
    expect(await articleSourceFeedId(ctx.worker, articleId)).toBe(y.id);
    expect(await ingest(fromY)).toMatchObject({ contentChanged: true, revision: '2' });
    expect((await articleRow(articleId)).excerpt).toBe('Edited by Y');
  });

  it('keeps a stale article stale on a source change and queues no work', async () => {
    const feed = await createFeed(ctx.owner);
    const reader = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: reader.id,
      feedId: feed.id,
      mode: 'active',
      activatedAt: hoursAgo(1),
    });
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [reader.id, card.id],
    );
    const original = item(feed.id, { publishedAt: daysAgo(30) });
    const created = await ingest(original);
    expect(created.pipelineState).toBe('stale');
    await clearOutbox();
    const changed = await ingest(carry(original, { excerpt: 'A publisher correction' }));
    expect(changed).toEqual({
      articleId: created.articleId,
      outcome: 'existing',
      revision: '2',
      pipelineState: 'stale',
      newAssociation: false,
      contentChanged: true,
      needsExtraction: false,
    });
    expect((await articleRow(created.articleId)).excerpt).toBe('A publisher correction');
    const queue = await ctx.owner.query('SELECT 1 FROM match_queue WHERE article_id = $1', [
      created.articleId,
    ]);
    expect(queue.rowCount).toBe(0);
    expect((await outboxIntents()).map((i) => [i.queue, i.payload])).toEqual([
      ['user.rank', { userId: reader.id, reason: 'source_changed' }],
    ]);
  });
});

describe('ingestItem: feed-scoped GUID identity (spec 03 §7 step 3)', () => {
  it('keeps identity when a feed changes an item URL but not its GUID', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const original = item(x.id, { guid: `stable-${next()}` });
    const first = await ingest(original);
    const newUrl = `https://news.example.test/renamed/${next()}`;
    const relinked = moved(original, newUrl);
    const second = await ingest(relinked);
    // The link is a model input (spec 03 §6.2): the source's changed hash resets once.
    expect(second).toEqual({
      articleId: first.articleId,
      outcome: 'guid_alias',
      revision: '2',
      pipelineState: 'ingested',
      newAssociation: false,
      contentChanged: true,
      needsExtraction: true,
    });
    expect(await keyRows(newUrl)).toEqual({ articles: 0, aliases: 1 });
    const alias = await ctx.owner.query(
      'SELECT article_id::text AS article, source FROM article_aliases WHERE url_key = $1',
      [newUrl],
    );
    expect(alias.rows).toEqual([{ article: first.articleId, source: 'feed_link' }]);
    expect(await findUrlKeyOwner(ctx.worker, newUrl)).toEqual({
      articleId: first.articleId,
      via: 'alias',
    });
    // The identity key stays; the navigable link follows the source, so extraction fetches it.
    expect(await articleRow(first.articleId)).toMatchObject({
      url_key: original.urlKey,
      url: newUrl,
    });
    expect(await associations(first.articleId)).toEqual([{ feed: x.id, guid: original.guid }]);
    // The alias now resolves the new URL exactly, from this feed and from any other.
    expect(await ingest(relinked)).toMatchObject({
      articleId: first.articleId,
      outcome: 'existing',
      newAssociation: false,
      contentChanged: false,
    });
    expect(await ingest(carry(relinked, { feedId: y.id, guid: null }))).toMatchObject({
      articleId: first.articleId,
      outcome: 'existing',
      newAssociation: true,
    });
  });

  it('retains the URL owner on an identity conflict and never takes another article’s GUID', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const a = await ingest(item(y.id, { guid: 'y-a' }));
    const urlA = (await articleRow(a.articleId)).url_key;
    const reused = `reused-${next()}`;
    const bItem = item(x.id, { guid: reused });
    const b = await ingest(bItem);
    // Feed x now publishes article A's URL with the GUID it already uses for B.
    const conflicting = item(x.id, { url: urlA, urlKey: urlA, canonicalUrl: urlA, guid: reused });
    const result = await ingest(conflicting);
    expect(result).toEqual({
      articleId: a.articleId,
      outcome: 'identity_conflict',
      revision: '1',
      pipelineState: 'ingested',
      newAssociation: true,
      contentChanged: false,
      needsExtraction: false,
    });
    expect(await associations(a.articleId)).toEqual([
      { feed: x.id, guid: null },
      { feed: y.id, guid: 'y-a' },
    ]);
    expect(await associations(b.articleId)).toEqual([{ feed: x.id, guid: reused }]);
    expect(await keyRows(urlA)).toEqual({ articles: 1, aliases: 0 });
    expect(await keyRows(bItem.urlKey)).toEqual({ articles: 1, aliases: 0 });
    // Repeating the conflict changes nothing.
    expect(await ingest(conflicting)).toMatchObject({
      articleId: a.articleId,
      outcome: 'identity_conflict',
      newAssociation: false,
    });
    expect(await associations(a.articleId)).toEqual([
      { feed: x.id, guid: null },
      { feed: y.id, guid: 'y-a' },
    ]);
  });

  it('keeps the first non-null GUID of a feed/article pair', async () => {
    const feed = await createFeed(ctx.owner);
    const base = item(feed.id, { guid: null });
    const { articleId } = await ingest(base);
    expect(await associations(articleId)).toEqual([{ feed: feed.id, guid: null }]);
    const first = `first-${next()}`;
    const second = `second-${next()}`;
    expect(await ingest(carry(base, { guid: first }))).toMatchObject({
      articleId,
      outcome: 'existing',
      newAssociation: false,
    });
    expect(await associations(articleId)).toEqual([{ feed: feed.id, guid: first }]);
    expect(await ingest(carry(base, { guid: second }))).toMatchObject({
      articleId,
      outcome: 'existing',
    });
    expect(await associations(articleId)).toEqual([{ feed: feed.id, guid: first }]);
    const alternate = await ctx.owner.query('SELECT 1 FROM feed_items WHERE guid = $1', [second]);
    expect(alternate.rowCount).toBe(0);
  });
});

describe('ingestItem: long GUIDs (spec 03 §6, D-15)', () => {
  it('keeps GUIDs of up to 4,096 characters unique per feed', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const long = `urn:long:${'g'.repeat(4_087)}`;
    expect(long).toHaveLength(4_096);
    const first = await ingest(item(x.id, { guid: long }));
    expect(first.outcome).toBe('inserted');
    // GUIDs are feed-scoped: another feed may use the same identifier for its own article.
    expect((await ingest(item(y.id, { guid: long }))).outcome).toBe('inserted');
    // The same feed moving the item keeps its identity through the long GUID.
    const again = await ingest(
      moved(item(x.id, { guid: long }), `https://news.example.test/moved/${next()}`),
    );
    expect(again).toMatchObject({ articleId: first.articleId, outcome: 'guid_alias' });
  });
});

describe('ingestItem: near-duplicates are never merged (spec 03 §7 step 4)', () => {
  it('stores distinct URLs with equal generic titles, empty excerpts or shared images apart', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const logo = 'https://img.example.test/site-logo.png';
    const publishedAt = hoursAgo(3);
    const untitled = { title: '(untitled)', titleNorm: 'untitled', excerpt: null, guid: null };
    const u1 = await ingest(item(x.id, { ...untitled, imageUrl: logo, publishedAt }));
    const u2 = await ingest(item(x.id, { ...untitled, imageUrl: logo, publishedAt }));
    const same = {
      title: 'Breaking news',
      titleNorm: 'breaking news',
      excerpt: 'Live updates follow.',
      imageUrl: logo,
      publishedAt,
    };
    const b1 = await ingest(item(x.id, same));
    const b2 = await ingest(item(x.id, same));
    const b3 = await ingest(item(y.id, same));
    const results = [u1, u2, b1, b2, b3];
    expect(results.map((r) => r.outcome)).toEqual(Array(5).fill('inserted'));
    expect(new Set(results.map((r) => r.articleId)).size).toBe(5);
    const aliases = await ctx.owner.query(
      'SELECT 1 FROM article_aliases WHERE article_id = ANY($1::bigint[])',
      [results.map((r) => r.articleId)],
    );
    expect(aliases.rowCount).toBe(0);
  });
});

describe('ingestItem: concurrency (spec 03 §7 "Concurrency", §13)', () => {
  it('turns two feeds inserting the same URL at once into one article with two associations', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    for (let round = 0; round < 6; round += 1) {
      const original = item(x.id);
      const other = carry(original, { feedId: y.id, guid: `y-${next()}` });
      const arrive = barrier(2);
      const run = (input: IngestItemInput) =>
        retryTransaction(ctx.worker, async (tx) => {
          await tx.execute(sql`SELECT 1`);
          await arrive();
          return ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14 });
        });
      const results = await Promise.all([run(original), run(other)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['existing', 'inserted']);
      expect(results.every((r) => r.newAssociation)).toBe(true);
      expect(results[0]!.articleId).toBe(results[1]!.articleId);
      expect(await keyRows(original.urlKey)).toEqual({ articles: 1, aliases: 0 });
      expect(await associations(results[0]!.articleId)).toEqual([
        { feed: x.id, guid: original.guid },
        { feed: y.id, guid: other.guid },
      ]);
    }
  });

  it('never lets one key name an article in articles and another in article_aliases', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    for (let round = 0; round < 6; round += 1) {
      const original = item(x.id, { guid: `g-${next()}` });
      const a = await ingest(original);
      const newUrl = `https://news.example.test/raced/${next()}`;
      // Feed x moves its item to the new URL (GUID path → alias) while feed y publishes that URL
      // as a new item (insert path).
      const viaGuid = moved(original, newUrl, true);
      const viaUrl = item(y.id, { url: newUrl, urlKey: newUrl, canonicalUrl: newUrl });
      const arrive = barrier(2);
      const run = (input: IngestItemInput) =>
        retryTransaction(ctx.worker, async (tx) => {
          await tx.execute(sql`SELECT 1`);
          await arrive();
          return ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14 });
        });
      const [fromX, fromY] = await Promise.all([run(viaGuid), run(viaUrl)]);
      const rows = await keyRows(newUrl);
      expect(rows.articles + rows.aliases).toBe(1);
      // Whichever committed first owns the key, and the other resolved to the same article.
      expect(fromX!.articleId).toBe(fromY!.articleId);
      if (rows.aliases === 1) {
        expect([fromX!.outcome, fromY!.outcome]).toEqual(['guid_alias', 'existing']);
        expect(fromX!.articleId).toBe(a.articleId);
      } else {
        expect([fromX!.outcome, fromY!.outcome]).toEqual(['identity_conflict', 'inserted']);
      }
    }
  });

  it('re-runs the whole item after a unique conflict with a writer that skipped the key lock', async () => {
    const feed = await createFeed(ctx.owner);
    const input = item(feed.id);
    const rogue = await openTransaction();
    const inserted = await rogue.client.query<{ id: string }>(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash)
       VALUES ($1, $1, $1, $2, $3, $4) RETURNING id::text AS id`,
      [input.urlKey, input.title, input.titleNorm, input.contentHash],
    );
    const rogueId = inserted.rows[0]!.id;
    const run = tracedIngest(input);
    // Attempt 1 saw no committed owner and now blocks on the uncommitted duplicate key.
    await waitForLockWait(run.pid);
    await rogue.commit();
    const result = await run.result;
    expect(run.attempts()).toBe(2);
    expect(result).toEqual({
      articleId: rogueId,
      outcome: 'existing',
      revision: '1',
      pipelineState: 'ingested',
      newAssociation: true,
      contentChanged: false,
      needsExtraction: false,
    });
    expect(await keyRows(input.urlKey)).toEqual({ articles: 1, aliases: 0 });
    expect(await associations(rogueId)).toEqual([{ feed: feed.id, guid: input.guid }]);
  });

  it('re-runs after a concurrent alias insert and keeps that alias instead of dropping the key', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const original = item(x.id, { guid: `g-${next()}` });
    const a = await ingest(original);
    const c = await ingest(item(y.id));
    const newUrl = `https://news.example.test/redirected/${next()}`;
    const redirect = await openTransaction();
    await redirect.client.query(
      `INSERT INTO article_aliases (url_key, article_id, source) VALUES ($1, $2, 'redirect')`,
      [newUrl, c.articleId],
    );
    const run = tracedIngest(moved(original, newUrl, true));
    // Attempt 1 resolved the GUID to A and blocks on its guarded alias insert for the same key.
    await waitForLockWait(run.pid);
    await redirect.commit();
    const result = await run.result;
    expect(run.attempts()).toBe(2);
    // The retry sees the committed alias: its owner C keeps the URL and A keeps its GUID.
    expect(result).toMatchObject({
      articleId: c.articleId,
      outcome: 'identity_conflict',
      newAssociation: true,
    });
    const alias = await ctx.owner.query(
      'SELECT article_id::text AS article, source FROM article_aliases WHERE url_key = $1',
      [newUrl],
    );
    expect(alias.rows).toEqual([{ article: c.articleId, source: 'redirect' }]);
    expect(await associations(a.articleId)).toEqual([{ feed: x.id, guid: original.guid }]);
    expect(await associations(c.articleId)).toContainEqual({ feed: x.id, guid: null });
  });

  it('resolves to the survivor when the article is merged away while the item waits for it', async () => {
    const x = await createFeed(ctx.owner);
    const y = await createFeed(ctx.owner);
    const aItem = item(y.id);
    const a = await ingest(aItem);
    const b = await ingest(item(y.id));
    // A merge of A into B (spec 03 §8.4) locks both rows, deletes A and points A's key at B.
    const merge = await openTransaction();
    await merge.client.query(
      'SELECT id FROM articles WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [[a.articleId, b.articleId]],
    );
    const run = tracedIngest(carry(aItem, { feedId: x.id, guid: 'x-a' }));
    await waitForLockWait(run.pid);
    await merge.client.query('DELETE FROM articles WHERE id = $1', [a.articleId]);
    await merge.client.query(
      `INSERT INTO article_aliases (url_key, article_id, source) VALUES ($1, $2, 'redirect')`,
      [aItem.urlKey, b.articleId],
    );
    await merge.commit();
    const result = await run.result;
    // Identity was resolved again inside the same transaction: no retry was needed.
    expect(run.attempts()).toBe(1);
    expect(result).toMatchObject({
      articleId: b.articleId,
      outcome: 'existing',
      newAssociation: true,
    });
    expect(await associations(b.articleId)).toContainEqual({ feed: x.id, guid: 'x-a' });
    expect(await keyRows(aItem.urlKey)).toEqual({ articles: 0, aliases: 1 });
  });
});

describe('lockUrlKeys and findUrlKeyOwner (spec 02 §3.3)', () => {
  it('takes the documented per-key locks in lexical order and holds them until commit', async () => {
    const first = `https://news.example.test/locked/${next()}`;
    const second = `${first}/z`;
    // Whoever holds the first key in order blocks the waiter before it takes any lock; whoever
    // holds the second finds the waiter already holding the first.
    for (const [held, heldByWaiter] of [
      [first, 0],
      [second, 1],
    ] as const) {
      const holder = await openTransaction();
      await holder.client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('url_key:' || $1::text, 0))`,
        [held],
      );
      const waiter = traced((tx) => lockUrlKeys(tx, [second, first, second]));
      await waitForLockWait(waiter.pid);
      const granted = await ctx.adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted`,
        [await waiter.pid],
      );
      expect(granted.rows[0]!.n).toBe(heldByWaiter);
      await holder.commit();
      await waiter.result;
      expect(waiter.attempts()).toBe(1);
    }
  });

  it('names the owner of a key in either identity table', async () => {
    const feed = await createFeed(ctx.owner);
    const input = item(feed.id);
    const { articleId } = await ingest(input);
    expect(await findUrlKeyOwner(ctx.worker, input.urlKey)).toEqual({
      articleId,
      via: 'article',
    });
    expect(await findUrlKeyOwner(ctx.worker, `${input.urlKey}/unknown`)).toBeNull();
    await ctx.owner.query(
      `INSERT INTO article_aliases (url_key, article_id, source) VALUES ($1, $2, 'redirect')`,
      [`${input.urlKey}/amp`, articleId],
    );
    expect(await findUrlKeyOwner(ctx.worker, `${input.urlKey}/amp`)).toEqual({
      articleId,
      via: 'alias',
    });
  });
});
