import { randomUUID } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Transaction } from '../../src/client.js';
import { lockUrlKeys } from '../../src/ingest/articles.js';
import {
  getArticleBody,
  upsertArticleBody,
  type ArticleBodyInput,
} from '../../src/ingest/bodies.js';
import { eligibleInferenceDemand } from '../../src/ingest/demand.js';
import { mergeArticles, type MergeArticlesResult } from '../../src/ingest/merge-articles.js';
import { resetArticleAnswers } from '../../src/ingest/reset.js';
import { workerOutbox } from '../../src/outbox.js';
import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from '../support/test-db.js';

/**
 * The article identity merge (spec 03 §8.4, M1-T7 lane B) against a real migrated database as the
 * worker role: no reader data is lost, deferrals keep both identities, the survivor's reader state
 * is fenced, and concurrent ingests, extractions and stale workers serialize or fail cleanly.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);

/** Minutes before one fixed instant: equal arguments give equal dates for exact expectations. */
function clock(): (minutes: number) => Date {
  const now = Date.now();
  return (minutes) => new Date(now - minutes * 60_000);
}

const body = (overrides: Partial<ArticleBodyInput> = {}): ArticleBodyInput => ({
  status: 'ok',
  resolvedUrl: 'https://news.example.test/a',
  httpStatus: 200,
  bodyText: 'Full text',
  bodyHtml: '<p>Full text</p>',
  completeness: 'complete',
  completenessReason: null,
  bodyLead: 'Full text',
  extractorVersion: 'readability-v1',
  error: null,
  ...overrides,
});

const merge = (
  sourceId: string,
  targetId: string,
  reason: 'redirect' | 'rel_canonical' = 'redirect',
): Promise<MergeArticlesResult> =>
  ctx.worker.transaction((tx) =>
    mergeArticles(tx, workerOutbox(tx), sourceId, targetId, { reason }),
  );

async function clearOutbox(): Promise<void> {
  await ctx.owner.query('DELETE FROM job_outbox');
}

async function outboxIntents(): Promise<
  Array<{ queue: string; payload: Record<string, unknown> }>
> {
  const result = await ctx.owner.query<{ queue: string; payload: Record<string, unknown> }>(
    'SELECT queue, payload FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
  );
  return result.rows;
}

async function articleExists(articleId: string): Promise<boolean> {
  const result = await ctx.owner.query('SELECT 1 FROM articles WHERE id = $1', [articleId]);
  return result.rowCount === 1;
}

/** A reader row with the given columns (owner connection: fixtures bypass RLS and grants). */
async function reader(
  userId: string,
  articleId: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const columns = ['user_id', 'article_id', ...Object.keys(fields)];
  await ctx.owner.query(
    `INSERT INTO user_article (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    [userId, articleId, ...Object.values(fields)],
  );
}

interface ReaderRow {
  state_version: string;
  opened_at: Date | null;
  read_at: Date | null;
  rating: number | null;
  reason: string | null;
  rated_at: Date | null;
  dwell_ms: number | null;
  bookmarked_at: Date | null;
  snapshot_id: string | null;
  origin_feed_id: string | null;
  capture_status: string | null;
  capture_generation: string;
  archived_at: Date | null;
  label_ids: string[];
  label_suggestions: string[];
  feedback_prompted_at: Date | null;
  lane: string;
  tier: number | null;
  p_like: number | null;
  score_source: string;
  rules_fired: string[];
  explain: unknown;
  score_version: string;
  rank_revision: string;
  next_rank_at: Date | null;
  scored_at: Date | null;
}

async function readerRow(userId: string, articleId: string): Promise<ReaderRow | undefined> {
  const result = await ctx.owner.query<ReaderRow>(
    `SELECT state_version::text AS state_version, opened_at, read_at, rating, reason, rated_at,
            dwell_ms, bookmarked_at, bookmark_snapshot_id::text AS snapshot_id,
            bookmark_origin_feed_id::text AS origin_feed_id,
            bookmark_capture_status AS capture_status,
            bookmark_capture_generation::text AS capture_generation, archived_at,
            label_ids::text[] AS label_ids, label_suggestions::text[] AS label_suggestions,
            feedback_prompted_at, lane, tier, p_like, score_source, rules_fired, explain,
            score_version, rank_revision::text AS rank_revision, next_rank_at, scored_at
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  return result.rows[0];
}

/** Defaults of every ranking-cache column (spec 02 §4). */
const CLEARED_CACHE = {
  lane: 'new',
  tier: null,
  p_like: null,
  score_source: 'none',
  rules_fired: [],
  explain: null,
  score_version: '0:0',
  rank_revision: '0',
  next_rank_at: null,
  scored_at: null,
};

interface SnapshotFixture {
  id: string;
  sha: string;
  text: string;
}

/** An immutable snapshot row with the canonical checksum of its content (spec 02 §3.5). */
async function snapshot(
  articleId: string,
  options: {
    revision?: number;
    text?: string;
    sourceUrl?: string;
    completeness?: 'complete' | 'partial';
  } = {},
): Promise<SnapshotFixture> {
  const text = options.text ?? `Saved text ${randomUUID()}`;
  const result = await ctx.owner.query<{ id: string; sha: string }>(
    `INSERT INTO article_snapshots (article_id, source_revision, source_url, title, body_text,
                                    body_html, content_sha256, completeness, source,
                                    extractor_version)
     VALUES ($1, $2, $3::text, 'Saved title', $4::text, $5::text,
             snapshot_content_sha256('Saved title', NULL::text, NULL::timestamptz, $3::text,
                                     $4::text, $5::text),
             $6, 'page', 'readability-v1')
     RETURNING id::text AS id, content_sha256 AS sha`,
    [
      articleId,
      options.revision ?? 1,
      options.sourceUrl ?? 'https://news.example.test/saved',
      text,
      `<p>${text}</p>`,
      options.completeness ?? 'complete',
    ],
  );
  return { ...result.rows[0]!, text };
}

async function snapshotRow(snapshotId: string) {
  const result = await ctx.owner.query<{
    article_id: string;
    sha: string;
    body_text: string;
    unreferenced: boolean;
  }>(
    `SELECT article_id::text AS article_id, content_sha256 AS sha, body_text,
            unreferenced_at IS NOT NULL AS unreferenced
       FROM article_snapshots WHERE id = $1`,
    [snapshotId],
  );
  return result.rows[0];
}

/** A label the user holds (spec 02 §5.2: assignments must name held labels). */
async function heldLabel(userId: string): Promise<string> {
  const card = await createCard(ctx.owner, { kind: 'label' });
  await ctx.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'L')`, [
    userId,
    card.id,
  ]);
  return card.id;
}

async function feedbackEvent(userId: string, articleId: string, kind: string): Promise<string> {
  const result = await ctx.owner.query<{ id: string }>(
    `INSERT INTO feedback_events (user_id, article_id, kind, value)
     VALUES ($1, $2, $3, '{"origin":"test"}') RETURNING id::text AS id`,
    [userId, articleId, kind],
  );
  return result.rows[0]!.id;
}

async function alias(urlKey: string, articleId: string, source: string): Promise<void> {
  await ctx.owner.query(
    'INSERT INTO article_aliases (url_key, article_id, source) VALUES ($1, $2, $3)',
    [urlKey, articleId, source],
  );
}

/** The owner of a key in the shared identity namespace; the `articles` row wins (spec 03 §7). */
async function keyOwner(urlKey: string): Promise<string | null> {
  const result = await ctx.owner.query<{ article_id: string }>(
    `SELECT article_id FROM (
       SELECT 1 AS rank, id::text AS article_id FROM articles WHERE url_key = $1
       UNION ALL
       SELECT 2, article_id::text FROM article_aliases WHERE url_key = $1) x
     ORDER BY rank LIMIT 1`,
    [urlKey],
  );
  return result.rows[0]?.article_id ?? null;
}

/** An offline reader action carrying its expected `state_version`, as the API applies it (§1.1). */
async function offlineRead(
  userId: string,
  articleId: string,
  expectedVersion: string,
): Promise<'ok' | 'STALE_STATE'> {
  return asTenant(ctx.appPool, userId, async (client) => {
    const result = await client.query(
      `UPDATE user_article SET read_at = now(), state_version = state_version + 1
        WHERE user_id = $1 AND article_id = $2 AND state_version = $3`,
      [userId, articleId, expectedVersion],
    );
    return result.rowCount === 1 ? 'ok' : 'STALE_STATE';
  });
}

/** Resolve the article of a url key the way the ingest does, inside its transaction. */
async function resolveKey(tx: Transaction, urlKey: string): Promise<string | null> {
  const result = await tx.execute<{ article_id: string }>(sql`
    SELECT article_id FROM (
      SELECT 1 AS rank, id::text AS article_id FROM articles WHERE url_key = ${urlKey}
      UNION ALL
      SELECT 2, article_id::text FROM article_aliases WHERE url_key = ${urlKey}) x
    ORDER BY rank LIMIT 1`);
  return result.rows[0]?.article_id ?? null;
}

async function backendPid(tx: Transaction): Promise<number> {
  const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return result.rows[0]!.pid;
}

/** Wait until the backend `pid` blocks on a lock (checked as the superuser). */
async function waitForLockWait(pid: () => number | undefined): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const current = pid();
    if (current !== undefined) {
      const result = await ctx.adminPool.query<{ wait_event_type: string | null }>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        [current],
      );
      if (result.rows[0]?.wait_event_type === 'Lock') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the transaction never waited for a lock');
}

function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A selected-analysis request created as its tenant (the insert trigger checks the live grant). */
async function analysisRequest(input: {
  userId: string;
  feedId: string;
  articleId: string;
  revision: string;
}): Promise<string> {
  const id = randomUUID();
  await asTenant(ctx.owner, input.userId, async (client) => {
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       VALUES ($1, $2, $3, $4, $5, 1, '{"article":"frozen"}',
               encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex'))`,
      [id, input.userId, input.feedId, input.articleId, input.revision],
    );
  });
  return id;
}

/**
 * Bookmark then unbookmark as the API does (the real SECURITY DEFINER helpers as the app role),
 * writing the undo receipt and pinning exactly the snapshot `clear_bookmark_snapshot` returned
 * (spec 02 §6, spec 08 §5.4).
 */
async function unbookmarkWithUndo(
  userId: string,
  articleId: string,
): Promise<{ mutationId: string; snapshotId: string }> {
  await asTenant(ctx.appPool, userId, async (client) => {
    await client.query('SELECT * FROM capture_bookmark_snapshot($1, NULL)', [articleId]);
    await client.query(
      `UPDATE user_article SET state_version = state_version + 1
        WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
  });
  return asTenant(ctx.appPool, userId, async (client) => {
    const prior = await client.query<{
      bookmarked_at: Date;
      origin: string | null;
      status: string;
    }>(
      `SELECT bookmarked_at, bookmark_origin_feed_id::text AS origin,
              bookmark_capture_status AS status
         FROM user_article WHERE user_id = $1 AND article_id = $2`,
      [userId, articleId],
    );
    const cleared = await client.query<{ id: string }>(
      'SELECT previous_snapshot_id::text AS id FROM clear_bookmark_snapshot($1)',
      [articleId],
    );
    const version = await client.query<{ v: string }>(
      `UPDATE user_article SET state_version = state_version + 1
        WHERE user_id = $1 AND article_id = $2 RETURNING state_version::text AS v`,
      [userId, articleId],
    );
    const mutationId = randomUUID();
    const before = prior.rows[0]!;
    await client.query(
      `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, undo,
                                  expires_at)
       VALUES ($1, $2, 'hash', 'DELETE /articles/:id/bookmark', 200, '{}', $3,
               now() + interval '7 days')`,
      [
        userId,
        mutationId,
        JSON.stringify({
          kind: 'unbookmark',
          articleId,
          stateVersion: version.rows[0]!.v,
          prior: {
            bookmarkedAt: before.bookmarked_at.toISOString(),
            originFeedId: before.origin,
            captureStatus: before.status,
          },
        }),
      ],
    );
    const snapshotId = cleared.rows[0]!.id;
    await client.query(
      `INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [userId, mutationId, snapshotId],
    );
    return { mutationId, snapshotId };
  });
}

/**
 * Two articles carried by their own feeds; the target was seen first. The target is created (and
 * so numbered) first unless `sourceFirst`.
 */
async function pair(
  options: { sourceRevision?: number; targetRevision?: number; sourceFirst?: boolean } = {},
) {
  const fSource = await createFeed(ctx.owner);
  const fTarget = await createFeed(ctx.owner);
  const createTarget = () =>
    createArticle(ctx.owner, {
      feedIds: [fTarget.id],
      firstSeenAt: hoursAgo(5),
      ...(options.targetRevision === undefined ? {} : { contentRevision: options.targetRevision }),
    });
  const createSource = () =>
    createArticle(ctx.owner, {
      feedIds: [fSource.id],
      firstSeenAt: hoursAgo(3),
      ...(options.sourceRevision === undefined ? {} : { contentRevision: options.sourceRevision }),
    });
  if (options.sourceFirst === true) {
    const source = await createSource();
    return { fSource, fTarget, source, target: await createTarget() };
  }
  const target = await createTarget();
  return { fSource, fTarget, source: await createSource(), target };
}

describe('mergeArticles (spec 03 §8.4)', () => {
  it('merges two articles without losing reader data', async () => {
    const ago = clock();
    const { fSource, fTarget, source, target } = await pair();
    const fBoth = await createFeed(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       VALUES ($1, $2, 'both-source-guid', $4), ($1, $3, NULL, $5)`,
      [fBoth.id, source.id, target.id, ago(360), ago(240)],
    );
    const a = await createUser(ctx.owner); // rows on both articles
    const b = await createUser(ctx.owner); // a row on the source only
    const c = await createUser(ctx.owner); // a row on the target only
    const d = await createUser(ctx.owner); // a subscriber without rows
    const f = await createUser(ctx.owner); // ratings with the same rated_at
    const gone = await createUser(ctx.owner, { deletedAt: new Date() });
    await createSubscription(ctx.owner, { userId: a.id, feedId: fSource.id });
    await createSubscription(ctx.owner, { userId: a.id, feedId: fTarget.id });
    await createSubscription(ctx.owner, { userId: b.id, feedId: fSource.id });
    await createSubscription(ctx.owner, { userId: c.id, feedId: fTarget.id });
    await createSubscription(ctx.owner, { userId: d.id, feedId: fBoth.id });

    const [l1, l2, l3] = [await heldLabel(a.id), await heldLabel(a.id), await heldLabel(a.id)];
    const sA = await snapshot(source.id);
    const sB = await snapshot(source.id, { completeness: 'partial' });
    await reader(a.id, source.id, {
      state_version: 3,
      opened_at: ago(20),
      read_at: ago(15),
      rating: 1,
      rated_at: ago(10),
      dwell_ms: 5000,
      archived_at: ago(5),
      label_ids: [l1],
      label_suggestions: [l3],
      bookmarked_at: ago(30),
      bookmark_snapshot_id: sA.id,
      bookmark_origin_feed_id: fSource.id,
      bookmark_capture_status: 'saved',
      bookmark_capture_generation: 2,
      feedback_prompted_at: ago(12),
    });
    await reader(a.id, target.id, {
      state_version: 7,
      opened_at: ago(40),
      rating: -1,
      reason: 'clickbait',
      rated_at: ago(35),
      dwell_ms: 9000,
      label_ids: [l2],
      label_suggestions: [l1],
      bookmark_capture_generation: 5,
      lane: 'for_you',
      p_like: 0.7,
      rank_revision: 3,
    });
    await reader(b.id, source.id, {
      state_version: 2,
      rating: -1,
      reason: 'seen',
      rated_at: ago(50),
      bookmarked_at: ago(45),
      bookmark_snapshot_id: sB.id,
      bookmark_origin_feed_id: fSource.id,
      bookmark_capture_status: 'pending',
      bookmark_capture_generation: 1,
      lane: 'maybe',
    });
    await reader(c.id, target.id, {
      state_version: 4,
      read_at: ago(60),
      lane: 'for_you',
      tier: 2,
      p_like: 0.8,
      score_source: 'cards',
      rules_fired: ['boost_feed'],
      explain: '{"inputs":{}}',
      score_version: '1:1',
      rank_revision: 5,
      next_rank_at: ago(-60),
      scored_at: ago(1),
    });
    const tie = ago(25);
    await reader(f.id, source.id, { state_version: 1, rating: -1, reason: 'promo', rated_at: tie });
    await reader(f.id, target.id, { state_version: 1, rating: 1, rated_at: tie });
    await reader(gone.id, source.id, { state_version: 6, read_at: ago(90) });

    const events = [
      await feedbackEvent(a.id, source.id, 'rate'),
      await feedbackEvent(a.id, source.id, 'bookmark'),
      await feedbackEvent(a.id, target.id, 'open'),
      await feedbackEvent(b.id, source.id, 'rate'),
    ];
    await alias(`m.${source.urlKey}`, source.id, 'feed_link');
    await alias(`amp.${source.urlKey}`, source.id, 'redirect');
    await clearOutbox();

    const result = await merge(source.id, target.id);
    expect(result).toEqual({
      status: 'merged',
      survivorId: target.id,
      sourceId: source.id,
      revision: '2',
      movedFeedIds: [fSource.id],
      affectedUserIds: [a.id, b.id, c.id, d.id, f.id].sort(),
    });
    expect(await articleExists(source.id)).toBe(false);

    // Collision: union labels, latest rating/open/read, max dwell, unarchived, earliest bookmark.
    expect(await readerRow(a.id, target.id)).toMatchObject({
      state_version: '8',
      opened_at: ago(20),
      read_at: ago(15),
      rating: 1,
      reason: null,
      rated_at: ago(10),
      dwell_ms: 9000,
      archived_at: null,
      label_ids: [l2, l1],
      label_suggestions: [l3],
      bookmarked_at: ago(30),
      snapshot_id: sA.id,
      origin_feed_id: fSource.id,
      capture_status: 'saved',
      capture_generation: '6',
      feedback_prompted_at: ago(12),
      ...CLEARED_CACHE,
    });
    // A moved source-only row keeps its state and advances past its input version.
    expect(await readerRow(b.id, target.id)).toMatchObject({
      state_version: '3',
      rating: -1,
      reason: 'seen',
      bookmarked_at: ago(45),
      snapshot_id: sB.id,
      capture_status: 'pending',
      capture_generation: '2',
      ...CLEARED_CACHE,
    });
    // A target-only row keeps its reader state and version; only its ranking cache is cleared.
    expect(await readerRow(c.id, target.id)).toMatchObject({
      state_version: '4',
      read_at: ago(60),
      ...CLEARED_CACHE,
    });
    // Equal rated_at: the target's rating wins.
    expect(await readerRow(f.id, target.id)).toMatchObject({
      state_version: '2',
      rating: 1,
      reason: null,
    });
    // A deleted account's row is preserved too (it is purged with the account, not by a merge).
    expect(await readerRow(gone.id, target.id)).toMatchObject({ state_version: '7' });
    const leftOnSource = await ctx.owner.query('SELECT 1 FROM user_article WHERE article_id = $1', [
      source.id,
    ]);
    expect(leftOnSource.rowCount).toBe(0);

    // Every feedback event now names the survivor.
    const repointed = await ctx.owner.query<{ id: string; article_id: string }>(
      `SELECT id::text AS id, article_id::text AS article_id FROM feedback_events
        WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [events],
    );
    expect(repointed.rows).toEqual(events.map((id) => ({ id, article_id: target.id })));

    // Aliases moved; every former key resolves to the survivor.
    const aliases = await ctx.owner.query<{ url_key: string; source: string }>(
      'SELECT url_key, source FROM article_aliases WHERE article_id = $1 ORDER BY url_key',
      [target.id],
    );
    expect(aliases.rows).toEqual(
      [
        { url_key: `amp.${source.urlKey}`, source: 'redirect' },
        { url_key: `m.${source.urlKey}`, source: 'feed_link' },
        { url_key: source.urlKey, source: 'redirect' },
      ].sort((x, y) => (x.url_key < y.url_key ? -1 : 1)),
    );
    for (const key of [source.urlKey, `m.${source.urlKey}`, `amp.${source.urlKey}`]) {
      expect(await keyOwner(key)).toBe(target.id);
    }

    // Associations: the source-only feed moved; the shared feed keeps its earliest first-seen time
    // and the GUID of that association.
    const items = await ctx.owner.query<{ feed_id: string; guid: string | null; seen: Date }>(
      `SELECT feed_id::text AS feed_id, guid, first_seen_at AS seen FROM feed_items
        WHERE article_id = $1 ORDER BY feed_id`,
      [target.id],
    );
    expect(items.rows.map((row) => row.feed_id)).toEqual(
      [fSource.id, fTarget.id, fBoth.id].sort((x, y) => Number(x) - Number(y)),
    );
    const both = items.rows.find((row) => row.feed_id === fBoth.id);
    expect(both?.guid).toBe('both-source-guid');
    expect(both?.seen).toEqual(ago(360));

    // Snapshots relocated byte for byte; bindings kept.
    for (const saved of [sA, sB]) {
      expect(await snapshotRow(saved.id)).toEqual({
        article_id: target.id,
        sha: saved.sha,
        body_text: saved.text,
        unreferenced: false,
      });
    }

    // A full rank for every active affected user and a local capture for the pending bookmark.
    const intents = await outboxIntents();
    const fullRanks = intents
      .filter((i) => i.queue === 'user.rank' && i.payload['full'] === true)
      .map((i) => i.payload);
    expect(fullRanks).toEqual(
      [a.id, b.id, c.id, d.id, f.id].sort().map((userId) => ({
        userId,
        reason: 'merge',
        full: true,
      })),
    );
    expect(intents.filter((i) => i.queue === 'article.capture-bookmark')).toEqual([
      { queue: 'article.capture-bookmark', payload: { articleId: target.id } },
    ]);
  });

  it('advances the survivor row past both inputs, so offline actions get STALE_STATE', async () => {
    // Here the source has the lower id, so it is locked first.
    const { source, target } = await pair({ sourceFirst: true });
    expect(BigInt(source.id)).toBeLessThan(BigInt(target.id));
    const collided = await createUser(ctx.owner);
    const moved = await createUser(ctx.owner);
    await reader(collided.id, source.id, { state_version: 3 });
    await reader(collided.id, target.id, { state_version: 7 });
    await reader(moved.id, source.id, { state_version: 2 });

    await merge(source.id, target.id);

    // Actions prepared against either pre-merge version are stale; the merged version applies.
    for (const version of ['3', '7']) {
      expect(await offlineRead(collided.id, target.id, version)).toBe('STALE_STATE');
    }
    expect(await offlineRead(collided.id, target.id, '8')).toBe('ok');
    expect(await offlineRead(moved.id, target.id, '2')).toBe('STALE_STATE');
    expect(await offlineRead(moved.id, target.id, '3')).toBe('ok');
  });

  it('keeps a valid target body and drops both articles’ translations', async () => {
    const { source, target } = await pair();
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'extracted', lang = 'en' WHERE id = ANY($1::bigint[])`,
      [[source.id, target.id]],
    );
    await ctx.worker.transaction(async (tx) => {
      await upsertArticleBody(tx, target.id, '1', body({ bodyText: 'Target body' }));
      await upsertArticleBody(tx, source.id, '1', body({ bodyText: 'Source body' }));
    });
    await ctx.owner.query(
      `INSERT INTO article_translations (article_id, article_revision, source_sha256, engine,
                                         source_lang, quality)
       VALUES ($1, 1, 'x', 'libretranslate', 'sk', 'ok'), ($2, 1, 'y', 'libretranslate', 'sk', 'ok')`,
      [source.id, target.id],
    );

    const result = await merge(source.id, target.id);
    expect(result).toMatchObject({ status: 'merged', revision: '2' });
    expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Target body',
    });
    const state = await ctx.owner.query(
      `SELECT pipeline_state, lang,
              (SELECT count(*)::int FROM article_translations WHERE article_id = $1) AS translations,
              (SELECT count(*)::int FROM article_bodies WHERE article_id = $2) AS source_bodies
         FROM articles WHERE id = $1`,
      [target.id, source.id],
    );
    expect(state.rows[0]).toEqual({
      pipeline_state: 'extracted',
      lang: 'en',
      translations: 0,
      source_bodies: 0,
    });
  });

  it('takes a valid source body only when the target lacks a successful extraction', async () => {
    const { source, target } = await pair({ sourceRevision: 2 });
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'extracted', lang = 'en', word_count = 3 WHERE id = $1`,
      [target.id],
    );
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'extracted', lang = 'sk', lang_confidence = 0.9,
                           word_count = 42 WHERE id = $1`,
      [source.id],
    );
    await ctx.worker.transaction(async (tx) => {
      await upsertArticleBody(
        tx,
        target.id,
        '1',
        body({ status: 'failed', bodyText: null, bodyHtml: null, bodyLead: null, error: 'x' }),
      );
      await upsertArticleBody(
        tx,
        source.id,
        '2',
        body({ bodyText: 'Source body', resolvedUrl: 'https://publisher.example.test/story' }),
      );
    });

    const result = await merge(source.id, target.id);
    // The survivor's revision first rises to the source's (2), then the reset increments it.
    expect(result).toMatchObject({ status: 'merged', revision: '3' });
    expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({
      articleRevision: '3',
      status: 'ok',
      bodyText: 'Source body',
      resolvedUrl: 'https://publisher.example.test/story',
    });
    const state = await ctx.owner.query(
      `SELECT pipeline_state, lang, word_count, url_key FROM articles WHERE id = $1`,
      [target.id],
    );
    expect(state.rows[0]).toEqual({
      pipeline_state: 'extracted',
      lang: 'sk',
      word_count: 42,
      url_key: target.urlKey,
    });
  });

  it('sends a survivor without a completed extraction back to extraction', async () => {
    const { source, target } = await pair();
    // The source carries a valid feed body but its page extraction had not run yet.
    await ctx.worker.transaction((tx) =>
      upsertArticleBody(
        tx,
        source.id,
        '1',
        body({ bodyText: 'Feed body', extractorVersion: 'feed-v1', resolvedUrl: null }),
      ),
    );
    const result = await merge(source.id, target.id);
    expect(result).toMatchObject({ status: 'merged', revision: '2' });
    expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'Feed body',
      extractorVersion: 'feed-v1',
    });
    const state = await ctx.owner.query('SELECT pipeline_state FROM articles WHERE id = $1', [
      target.id,
    ]);
    expect(state.rows[0]).toEqual({ pipeline_state: 'ingested' });
  });

  it('repoints completed selections intact and cancels pending and running ones', async () => {
    // The source is at revision 3, the target at 2: without the revision floor the survivor would
    // reach 3 and the repointed request (frozen at the source's revision 3) would authorize it.
    const { fSource, fTarget, source, target } = await pair({
      sourceRevision: 3,
      targetRevision: 2,
    });
    const u = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: u.id, feedId: fSource.id, mode: 'training' });
    await createSubscription(ctx.owner, { userId: u.id, feedId: fTarget.id, mode: 'training' });
    const complete = await analysisRequest({
      userId: u.id,
      feedId: fSource.id,
      articleId: source.id,
      revision: '3',
    });
    const pending = await analysisRequest({
      userId: u.id,
      feedId: fSource.id,
      articleId: source.id,
      revision: '3',
    });
    const running = await analysisRequest({
      userId: u.id,
      feedId: fSource.id,
      articleId: source.id,
      revision: '3',
    });
    const targets = await analysisRequest({
      userId: u.id,
      feedId: fTarget.id,
      articleId: target.id,
      revision: '2',
    });
    await ctx.owner.query(
      `UPDATE analysis_requests SET status = 'complete', result_snapshot = '{"facets":1}',
              result_sha = 'r', completed_at = now() - interval '1 hour', attempts = 1
        WHERE id = $1`,
      [complete],
    );
    await ctx.owner.query(
      `UPDATE analysis_requests SET status = 'running', lease_token = gen_random_uuid(),
              lease_until = now() + interval '5 minutes', attempts = 1
        WHERE id = $1`,
      [running],
    );

    const result = await merge(source.id, target.id);
    expect(result).toMatchObject({ status: 'merged', revision: '4' });

    const rows = await ctx.owner.query(
      `SELECT id::text AS id, article_id::text AS article_id, article_revision::text AS revision,
              status, lease_token IS NOT NULL AS leased, completed_at IS NOT NULL AS completed,
              last_error_code, result_snapshot, input_snapshot, attempts
         FROM analysis_requests WHERE user_id = $1`,
      [u.id],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(complete)).toMatchObject({
      article_id: target.id,
      revision: '3',
      status: 'complete',
      completed: true,
      last_error_code: null,
      result_snapshot: { facets: 1 },
      input_snapshot: { article: 'frozen' },
      attempts: 1,
    });
    for (const cancelled of [pending, running]) {
      expect(byId.get(cancelled)).toMatchObject({
        article_id: target.id,
        status: 'cancelled',
        leased: false,
        completed: true,
        last_error_code: 'merged',
      });
    }
    // The survivor's own selection is untouched (its revision is simply no longer current).
    expect(byId.get(targets)).toMatchObject({ article_id: target.id, status: 'pending' });
    // No repointed selection authorizes inference on the survivor's new content.
    expect(await eligibleInferenceDemand(ctx.worker, target.id)).toEqual([]);
  });

  it('moves match work with the minimum priority, oldest queue time and maximum attempts', async () => {
    const ago = clock();
    const { fSource, source, target } = await pair();
    const u = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: u.id,
      feedId: fSource.id,
      mode: 'active',
      activatedAt: hoursAgo(4),
    });
    const [c1, c2, c3] = [
      await createCard(ctx.owner),
      await createCard(ctx.owner),
      await createCard(ctx.owner),
    ];
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like'), ($1, $3, 'love')`,
      [u.id, c1.id, c2.id],
    );
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'enriched' WHERE id = ANY($1::bigint[])`,
      [[source.id, target.id]],
    );
    const insertQueue = (
      articleId: string,
      cardId: string,
      row: { priority: number; attempts: number; enqueuedAt: Date; leased?: boolean },
    ) =>
      ctx.owner.query(
        `INSERT INTO match_queue (article_id, card_id, article_revision, priority, attempts,
                                  enqueued_at, lease_token, lease_until, last_error)
         VALUES ($1, $2, 1, $3, $4::smallint, $5,
                 CASE WHEN $6::boolean THEN gen_random_uuid() END,
                 CASE WHEN $6::boolean THEN now() + interval '1 minute' END,
                 CASE WHEN $4::smallint > 0 THEN 'timeout' END)`,
        [articleId, cardId, row.priority, row.attempts, row.enqueuedAt, row.leased === true],
      );
    await insertQueue(source.id, c1.id, {
      priority: 3,
      attempts: 1,
      enqueuedAt: ago(30),
      leased: true,
    });
    await insertQueue(source.id, c2.id, { priority: 7, attempts: 0, enqueuedAt: ago(10) });
    await insertQueue(source.id, c3.id, { priority: 2, attempts: 0, enqueuedAt: ago(40) });
    await insertQueue(target.id, c1.id, { priority: 6, attempts: 4, enqueuedAt: ago(5) });

    const result = await merge(source.id, target.id);
    expect(result).toMatchObject({ status: 'merged', revision: '2' });
    const queue = await ctx.owner.query<{
      card_id: string;
      revision: string;
      priority: number;
      attempts: number;
      enqueued_at: Date;
      leased: boolean;
      last_error: string | null;
    }>(
      `SELECT card_id::text AS card_id, article_revision::text AS revision, priority, attempts,
              enqueued_at, lease_token IS NOT NULL AS leased, last_error
         FROM match_queue WHERE article_id = $1 ORDER BY card_id`,
      [target.id],
    );
    expect(queue.rows).toEqual(
      [
        {
          card_id: c1.id,
          revision: '2',
          priority: 3,
          attempts: 4,
          enqueued_at: ago(30),
          leased: false,
          last_error: 'timeout',
        },
        {
          card_id: c2.id,
          revision: '2',
          priority: 5,
          attempts: 0,
          enqueued_at: ago(10),
          leased: false,
          last_error: null,
        },
      ].sort((x, y) => Number(x.card_id) - Number(y.card_id)),
    );
    // The unadmitted card (nobody holds it) is not carried to the new revision.
    const left = await ctx.owner.query('SELECT 1 FROM match_queue WHERE card_id = $1', [c3.id]);
    expect(left.rowCount).toBe(0);
  });

  it('reconciles the story clusters of both articles', async () => {
    const { fSource, fTarget, source, target } = await pair();
    const x = await createArticle(ctx.owner, { feedIds: [fSource.id], firstSeenAt: hoursAgo(2) });
    const y = await createArticle(ctx.owner, { feedIds: [fTarget.id], firstSeenAt: hoursAgo(1) });
    const cluster = async (rep: string, members: string[]) => {
      const created = await ctx.owner.query<{ id: string }>(
        `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2)
         RETURNING id::text AS id`,
        [rep, members.length],
      );
      const id = created.rows[0]!.id;
      await ctx.owner.query(
        'UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])',
        [id, members],
      );
      return id;
    };
    const sourceCluster = await cluster(source.id, [source.id, x.id]);
    const targetCluster = await cluster(target.id, [target.id, y.id]);

    await merge(source.id, target.id);
    const clusters = await ctx.owner.query(
      `SELECT id::text AS id, size, representative_article_id::text AS rep
         FROM story_clusters WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[sourceCluster, targetCluster]],
    );
    expect(clusters.rows).toEqual([
      { id: sourceCluster, size: 1, rep: x.id },
      { id: targetCluster, size: 1, rep: y.id },
    ]);
    const survivor = await ctx.owner.query('SELECT story_cluster_id FROM articles WHERE id = $1', [
      target.id,
    ]);
    expect(survivor.rows[0]).toEqual({ story_cluster_id: null });
  });

  it('keeps the earliest bookmark and its snapshot when both saved identical content', async () => {
    const ago = clock();
    const { source, target } = await pair();
    const u = await createUser(ctx.owner);
    const early = await snapshot(source.id, { text: 'Same saved story', revision: 1 });
    const late = await snapshot(target.id, { text: 'Same saved story', revision: 2 });
    expect(early.sha).toBe(late.sha);
    await reader(u.id, source.id, {
      state_version: 1,
      bookmarked_at: ago(50),
      bookmark_snapshot_id: early.id,
      bookmark_capture_status: 'saved',
    });
    await reader(u.id, target.id, {
      state_version: 1,
      bookmarked_at: ago(20),
      bookmark_snapshot_id: late.id,
      bookmark_capture_status: 'saved',
    });

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    expect(await readerRow(u.id, target.id)).toMatchObject({
      bookmarked_at: ago(50),
      snapshot_id: early.id,
      capture_status: 'saved',
    });
    // The other copy is identical and now unreferenced (garbage collection may reclaim it later).
    expect(await snapshotRow(early.id)).toMatchObject({
      article_id: target.id,
      unreferenced: false,
    });
    expect(await snapshotRow(late.id)).toMatchObject({ article_id: target.id, unreferenced: true });
  });

  it('keeps the complete binding over an earlier partial one of identical content (D-19)', async () => {
    const ago = clock();
    const { source, target } = await pair();
    const u = await createUser(ctx.owner);
    const teaser = await snapshot(source.id, {
      text: 'Same story',
      revision: 1,
      completeness: 'partial',
    });
    const full = await snapshot(target.id, { text: 'Same story', revision: 1 });
    expect(teaser.sha).toBe(full.sha);
    await reader(u.id, source.id, {
      state_version: 1,
      bookmarked_at: ago(50),
      bookmark_snapshot_id: teaser.id,
      bookmark_capture_status: 'partial',
    });
    await reader(u.id, target.id, {
      state_version: 1,
      bookmarked_at: ago(20),
      bookmark_snapshot_id: full.id,
      bookmark_capture_status: 'saved',
    });

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    // The earliest bookmark time survives, but the binding stays the saved full archive.
    expect(await readerRow(u.id, target.id)).toMatchObject({
      bookmarked_at: ago(50),
      snapshot_id: full.id,
      capture_status: 'saved',
    });
    expect(await snapshotRow(full.id)).toMatchObject({ unreferenced: false });
    expect(await snapshotRow(teaser.id)).toMatchObject({
      article_id: target.id,
      unreferenced: true,
    });
  });

  it('shares storage for identical snapshots of the same revision', async () => {
    const { source, target } = await pair();
    const v = await createUser(ctx.owner);
    const w = await createUser(ctx.owner);
    const fromSource = await snapshot(source.id, { text: 'Twin', revision: 1 });
    const fromTarget = await snapshot(target.id, { text: 'Twin', revision: 1 });
    await reader(v.id, source.id, {
      bookmarked_at: minutesAgo(5),
      bookmark_snapshot_id: fromSource.id,
      bookmark_capture_status: 'saved',
    });
    await reader(w.id, target.id, {
      bookmarked_at: minutesAgo(6),
      bookmark_snapshot_id: fromTarget.id,
      bookmark_capture_status: 'saved',
    });

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    expect(await readerRow(v.id, target.id)).toMatchObject({ snapshot_id: fromTarget.id });
    expect(await readerRow(w.id, target.id)).toMatchObject({ snapshot_id: fromTarget.id });
    expect(await snapshotRow(fromSource.id)).toBeUndefined();
    expect(await snapshotRow(fromTarget.id)).toEqual({
      article_id: target.id,
      sha: fromSource.sha,
      body_text: 'Twin',
      unreferenced: false,
    });
  });

  it('keeps a complete twin of a partial snapshot as its own row (D-19)', async () => {
    const { source, target } = await pair();
    const v = await createUser(ctx.owner);
    const w = await createUser(ctx.owner);
    const full = await snapshot(source.id, { text: 'Twin text', revision: 1 });
    const teaser = await snapshot(target.id, {
      text: 'Twin text',
      revision: 1,
      completeness: 'partial',
    });
    expect(full.sha).toBe(teaser.sha);
    await reader(v.id, source.id, {
      bookmarked_at: minutesAgo(5),
      bookmark_snapshot_id: full.id,
      bookmark_capture_status: 'saved',
    });
    await reader(w.id, target.id, {
      bookmarked_at: minutesAgo(6),
      bookmark_snapshot_id: teaser.id,
      bookmark_capture_status: 'partial',
    });

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    // Identical content, but a saved complete binding is never folded into the partial row.
    expect(await readerRow(v.id, target.id)).toMatchObject({
      snapshot_id: full.id,
      capture_status: 'saved',
    });
    expect(await readerRow(w.id, target.id)).toMatchObject({ snapshot_id: teaser.id });
    expect(await snapshotRow(full.id)).toMatchObject({
      article_id: target.id,
      unreferenced: false,
    });
    expect(await snapshotRow(teaser.id)).toMatchObject({
      article_id: target.id,
      unreferenced: false,
    });
  });

  it('defers when one user saved different snapshots of both articles', async () => {
    const { source, target } = await pair();
    const u = await createUser(ctx.owner);
    const one = await snapshot(source.id, { text: 'Version one' });
    const two = await snapshot(target.id, { text: 'Version two' });
    await reader(u.id, source.id, {
      state_version: 2,
      bookmarked_at: minutesAgo(9),
      bookmark_snapshot_id: one.id,
      bookmark_capture_status: 'saved',
    });
    await reader(u.id, target.id, {
      state_version: 5,
      bookmarked_at: minutesAgo(8),
      bookmark_snapshot_id: two.id,
      bookmark_capture_status: 'saved',
    });

    expect(await merge(source.id, target.id)).toEqual({
      status: 'deferred',
      survivorId: target.id,
      sourceId: source.id,
      reason: 'snapshot_conflict',
    });
    // Nothing changed: both identities and both saved versions remain.
    expect(await articleExists(source.id)).toBe(true);
    expect(await readerRow(u.id, source.id)).toMatchObject({
      state_version: '2',
      snapshot_id: one.id,
    });
    expect(await readerRow(u.id, target.id)).toMatchObject({
      state_version: '5',
      snapshot_id: two.id,
    });
    expect(await snapshotRow(one.id)).toMatchObject({ article_id: source.id });
  });

  it('defers while evaluation data references either article (simulated M3a schema)', async () => {
    const { source, target } = await pair();
    await ctx.owner.query('CREATE SCHEMA eval');
    try {
      await ctx.owner.query(`
        CREATE TABLE eval.sample (dataset_version text NOT NULL,
          article_id bigint NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
          PRIMARY KEY (dataset_version, article_id));
        CREATE TABLE eval.ratings (rater_id bigint NOT NULL,
          article_id bigint REFERENCES articles(id) ON DELETE RESTRICT,
          rating smallint NOT NULL, PRIMARY KEY (rater_id, article_id));
        GRANT USAGE ON SCHEMA eval TO bantoozi_worker;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA eval TO bantoozi_worker;`);
      const expected = {
        status: 'deferred',
        survivorId: target.id,
        sourceId: source.id,
        reason: 'eval_reference',
      };
      await ctx.owner.query(`INSERT INTO eval.sample VALUES ('golden-v1', $1)`, [source.id]);
      expect(await merge(source.id, target.id)).toEqual(expected);
      await ctx.owner.query('DELETE FROM eval.sample');
      // A golden label of the target defers too: it must not be silently rewritten.
      await ctx.owner.query('INSERT INTO eval.ratings VALUES (1, $1, 1)', [target.id]);
      expect(await merge(source.id, target.id)).toEqual(expected);
      expect(await articleExists(source.id)).toBe(true);
      await ctx.owner.query('DELETE FROM eval.ratings');
      expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    } finally {
      await ctx.owner.query('DROP SCHEMA eval CASCADE');
    }
  });

  describe('Undo pins (spec 08 §5.4)', () => {
    it('defer while an unexpired pin protects a source snapshot, then merge once it expired', async () => {
      const { fSource, source, target } = await pair();
      const u = await createUser(ctx.owner);
      await createSubscription(ctx.owner, { userId: u.id, feedId: fSource.id });
      const { mutationId, snapshotId } = await unbookmarkWithUndo(u.id, source.id);

      expect(await merge(source.id, target.id)).toEqual({
        status: 'deferred',
        survivorId: target.id,
        sourceId: source.id,
        reason: 'undo_pin',
      });
      // Exact undo is still possible on the untouched source.
      const restoredEarly = await asTenant(ctx.appPool, u.id, async (client) => {
        await client.query('SAVEPOINT before_restore');
        const restored = await client.query<{ id: string }>(
          'SELECT snapshot_id::text AS id FROM restore_bookmark_snapshot($1, $2)',
          [source.id, mutationId],
        );
        await client.query('ROLLBACK TO SAVEPOINT before_restore');
        return restored.rows[0]?.id;
      });
      expect(restoredEarly).toBe(snapshotId);

      await ctx.owner.query(
        `UPDATE bookmark_snapshot_pins SET expires_at = now() - interval '1 second'
          WHERE mutation_id = $1`,
        [mutationId],
      );
      expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
      expect(await snapshotRow(snapshotId)).toMatchObject({ article_id: target.id });
    });

    it('defer for a target pin whose owner also has a source row (its version would move)', async () => {
      const { fSource, fTarget, source, target } = await pair();
      const u = await createUser(ctx.owner);
      await createSubscription(ctx.owner, { userId: u.id, feedId: fSource.id });
      await createSubscription(ctx.owner, { userId: u.id, feedId: fTarget.id });
      await unbookmarkWithUndo(u.id, target.id);
      await reader(u.id, source.id, { state_version: 1, read_at: minutesAgo(3) });

      expect(await merge(source.id, target.id)).toMatchObject({
        status: 'deferred',
        reason: 'undo_pin',
      });
      expect(await articleExists(source.id)).toBe(true);
    });

    it('keep exact Undo of a target-only reader: restore works after the merge', async () => {
      const { fTarget, source, target } = await pair();
      const other = await createUser(ctx.owner);
      await reader(other.id, source.id, { state_version: 4, rating: 1, rated_at: minutesAgo(2) });
      const u = await createUser(ctx.owner);
      await createSubscription(ctx.owner, { userId: u.id, feedId: fTarget.id });
      const { mutationId, snapshotId } = await unbookmarkWithUndo(u.id, target.id);
      const before = await readerRow(u.id, target.id);

      expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
      expect(await readerRow(u.id, target.id)).toMatchObject({
        state_version: before?.state_version,
      });
      const restored = await asTenant(ctx.appPool, u.id, (client) =>
        client.query<{ id: string; status: string }>(
          `SELECT snapshot_id::text AS id, capture_status AS status
             FROM restore_bookmark_snapshot($1, $2)`,
          [target.id, mutationId],
        ),
      );
      expect(restored.rows[0]?.id).toBe(snapshotId);
      expect(await readerRow(u.id, target.id)).toMatchObject({ snapshot_id: snapshotId });
      expect(await readerRow(other.id, target.id)).toMatchObject({ state_version: '5', rating: 1 });
    });
  });

  it('never lets a stale worker recreate the source or overwrite the survivor', async () => {
    const { source, target } = await pair();
    const card = await createCard(ctx.owner);
    const question = await ctx.owner.query<{ sha: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', $1, $2, '{}') RETURNING sha256 AS sha`,
      [`match-merge-${randomUUID()}`, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    );
    const result = await merge(source.id, target.id);
    expect(result).toMatchObject({ status: 'merged', revision: '2' });

    // A late job of the source finds nothing to reset and cannot write derivatives for it.
    await ctx.worker.transaction(async (tx) => {
      expect(
        await resetArticleAnswers(tx, workerOutbox(tx), source.id, {
          reason: 'source_changed',
          nextState: 'ingested',
        }),
      ).toEqual({ status: 'missing' });
    });
    expect(
      await sqlStateOf(
        ctx.worker.transaction((tx) => upsertArticleBody(tx, source.id, '1', body())),
      ),
    ).toBe('23503');
    expect(
      await sqlStateOf(
        ctx.workerPool.query(
          `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha,
                                     article_revision, state_sha256, card_input_sha256,
                                     state_variant)
           VALUES ($1, $2, 0.5, 'typesafe', $3, 1, 's', 'c', 'native')`,
          [source.id, card.id, question.rows[0]!.sha],
        ),
      ),
    ).toBe('23503');
    // A late extraction of the survivor prepared against its old revision is rejected.
    const late = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), target.id, {
        reason: 'body_changed',
        nextState: 'extracted',
        installBody: body({ bodyText: 'Stale body' }),
        expectedRevision: '1',
      }),
    );
    expect(late).toEqual({ status: 'stale_revision', revision: '2' });
    expect(await getArticleBody(ctx.worker, target.id)).toBeNull();
    expect(await articleExists(source.id)).toBe(false);
    // An old job's url still resolves to the survivor.
    expect(await keyOwner(source.urlKey)).toBe(target.id);
  });

  it('returns noop for the same article and for missing articles', async () => {
    const { source, target } = await pair();
    expect(await merge(source.id, source.id)).toEqual({ status: 'noop', reason: 'same_article' });
    expect(await merge('999999999', target.id)).toEqual({ status: 'noop', reason: 'missing' });
    expect(await merge(source.id, '999999999')).toEqual({ status: 'noop', reason: 'missing' });
    expect(await articleExists(source.id)).toBe(true);
    // Merging an already merged article again is a noop too (a duplicate job).
    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    expect(await merge(source.id, target.id)).toEqual({ status: 'noop', reason: 'missing' });
  });

  it('enforces the cross-table identity invariant', async () => {
    const { source, target } = await pair();
    // A broken alias of the source naming the target's own key is dropped, never moved.
    await alias(target.urlKey, source.id, 'near_duplicate');
    expect(await merge(source.id, target.id, 'rel_canonical')).toMatchObject({
      status: 'merged',
    });
    const keys = await ctx.owner.query<{ url_key: string; source: string }>(
      'SELECT url_key, source FROM article_aliases WHERE article_id = $1',
      [target.id],
    );
    expect(keys.rows).toEqual([{ url_key: source.urlKey, source: 'rel_canonical' }]);

    // A source key already aliased to a third article aborts the merge; nothing changes.
    const next = await pair();
    const third = await createArticle(ctx.owner);
    await ctx.owner.query('DELETE FROM article_aliases WHERE url_key = $1', [next.source.urlKey]);
    await alias(next.source.urlKey, third.id, 'redirect');
    await expect(merge(next.source.id, next.target.id)).rejects.toThrow(/alias of article/);
    expect(await articleExists(next.source.id)).toBe(true);
  });

  it('keeps a stale survivor stale and queues no match work', async () => {
    const { fSource, source, target } = await pair();
    const u = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: u.id,
      feedId: fSource.id,
      mode: 'active',
      activatedAt: hoursAgo(4),
    });
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [u.id, card.id],
    );
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'enriched' WHERE id = $1`, [
      source.id,
    ]);
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [
      target.id,
    ]);
    await ctx.owner.query(
      'INSERT INTO match_queue (article_id, card_id, article_revision) VALUES ($1, $2, 1)',
      [source.id, card.id],
    );
    await clearOutbox();

    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged', revision: '2' });
    const state = await ctx.owner.query(
      `SELECT pipeline_state,
              (SELECT count(*)::int FROM match_queue WHERE article_id = $1) AS queued
         FROM articles WHERE id = $1`,
      [target.id],
    );
    expect(state.rows[0]).toEqual({ pipeline_state: 'stale', queued: 0 });
    // Its readers are still re-ranked: a stale article needs no paid stage to be readable.
    const fullRanks = (await outboxIntents()).filter(
      (i) => i.queue === 'user.rank' && i.payload['full'] === true,
    );
    expect(fullRanks.map((i) => i.payload['userId'])).toEqual([u.id]);
  });

  it('keeps provider audit rows, detached from the retired identity', async () => {
    const { source, target } = await pair();
    const call = await ctx.owner.query<{ id: string }>(
      `INSERT INTO engine_calls (engine, kind, article_id, logical_request_id, article_revision,
                                 status, cost_usd)
       VALUES ('typesafe', 'enrich', $1, gen_random_uuid(), 1, 'ok', 0.001)
       RETURNING id::text AS id`,
      [source.id],
    );
    expect(await merge(source.id, target.id)).toMatchObject({ status: 'merged' });
    const audit = await ctx.owner.query(
      `SELECT article_id, article_revision::text AS revision, cost_usd::text AS cost
         FROM engine_calls WHERE id = $1`,
      [call.rows[0]!.id],
    );
    expect(audit.rows).toEqual([{ article_id: null, revision: '1', cost: '0.00100000' }]);
  });

  it('merges inside the extraction transaction that already locked the key and the source', async () => {
    const { fSource, source, target } = await pair();
    const u = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: u.id, feedId: fSource.id });
    await reader(u.id, source.id, { state_version: 1, read_at: minutesAgo(1) });
    const result = await ctx.worker.transaction(async (tx) => {
      // The alias check of spec 03 §8.1 step 4: the resolved key's lock, then the source row.
      await lockUrlKeys(tx, [target.urlKey]);
      await tx.execute(
        sql`SELECT 1 FROM articles WHERE id = ${source.id}::bigint FOR NO KEY UPDATE`,
      );
      expect(await resolveKey(tx, target.urlKey)).toBe(target.id);
      return mergeArticles(tx, workerOutbox(tx), source.id, target.id, { reason: 'redirect' });
    });
    expect(result).toMatchObject({
      status: 'merged',
      movedFeedIds: [fSource.id],
      affectedUserIds: [u.id],
    });
    expect(await readerRow(u.id, target.id)).toMatchObject({ state_version: '2' });
  });

  describe('concurrency (spec 03 §7 "Concurrency")', () => {
    /** An ingest of `urlKey` under the identity lock protocol: lock, resolve, associate. */
    async function ingestKey(
      tx: Transaction,
      feedId: string,
      urlKey: string,
    ): Promise<string | null> {
      await lockUrlKeys(tx, [urlKey]);
      const owner = await resolveKey(tx, urlKey);
      if (owner === null) return null;
      await tx.execute(sql`
        INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
        VALUES (${feedId}::bigint, ${owner}::bigint, 'late-guid', statement_timestamp())
        ON CONFLICT (feed_id, article_id) DO NOTHING`);
      return owner;
    }

    it('a merge waits for an ingest holding the source key, then moves its new association', async () => {
      const { fSource, source, target } = await pair();
      const late = await createFeed(ctx.owner);
      const held = signal();
      const release = signal();
      const ingest = ctx.worker.transaction(async (tx) => {
        const owner = await ingestKey(tx, late.id, source.urlKey);
        held.resolve();
        await release.promise;
        return owner;
      });
      await held.promise;
      let mergePid: number | undefined;
      const merging = ctx.worker.transaction(async (tx) => {
        mergePid = await backendPid(tx);
        return mergeArticles(tx, workerOutbox(tx), source.id, target.id, { reason: 'redirect' });
      });
      await waitForLockWait(() => mergePid);
      release.resolve();
      expect(await ingest).toBe(source.id);
      const result = await merging;
      expect(result).toMatchObject({ status: 'merged', movedFeedIds: [fSource.id, late.id] });
      const carriers = await ctx.owner.query(
        'SELECT article_id::text AS article_id FROM feed_items WHERE feed_id = $1',
        [late.id],
      );
      expect(carriers.rows).toEqual([{ article_id: target.id }]);
    });

    it('an ingest of the source key waits for the merge and resolves it to the survivor', async () => {
      const { source, target } = await pair();
      const late = await createFeed(ctx.owner);
      const merged = signal<MergeArticlesResult>();
      const release = signal();
      const merging = ctx.worker.transaction(async (tx) => {
        const result = await mergeArticles(tx, workerOutbox(tx), source.id, target.id, {
          reason: 'redirect',
        });
        merged.resolve(result);
        await release.promise;
        return result;
      });
      expect(await merged.promise).toMatchObject({ status: 'merged' });
      let ingestPid: number | undefined;
      const ingest = ctx.worker.transaction(async (tx) => {
        ingestPid = await backendPid(tx);
        return ingestKey(tx, late.id, source.urlKey);
      });
      await waitForLockWait(() => ingestPid);
      release.resolve();
      await merging;
      expect(await ingest).toBe(target.id);
      expect(await articleExists(source.id)).toBe(false);
    });

    it('a merge waits for an in-flight extraction of the target and keeps its newer body', async () => {
      const { source, target } = await pair();
      await ctx.owner.query(`UPDATE articles SET pipeline_state = 'extracted' WHERE id = $1`, [
        source.id,
      ]);
      await ctx.worker.transaction((tx) =>
        upsertArticleBody(tx, source.id, '1', body({ bodyText: 'Source body' })),
      );
      const held = signal();
      const release = signal();
      const extraction = ctx.worker.transaction(async (tx) => {
        const reset = await resetArticleAnswers(tx, workerOutbox(tx), target.id, {
          reason: 'body_changed',
          nextState: 'extracted',
          installBody: body({ bodyText: 'Fresh target body' }),
        });
        held.resolve();
        await release.promise;
        return reset;
      });
      await held.promise;
      let mergePid: number | undefined;
      const merging = ctx.worker.transaction(async (tx) => {
        mergePid = await backendPid(tx);
        return mergeArticles(tx, workerOutbox(tx), source.id, target.id, { reason: 'redirect' });
      });
      await waitForLockWait(() => mergePid);
      release.resolve();
      expect(await extraction).toMatchObject({ status: 'reset', revision: '2' });
      expect(await merging).toMatchObject({ status: 'merged', revision: '3' });
      // The merge rechecked the target under its lock: the extraction's body is the valid one.
      expect(await getArticleBody(ctx.worker, target.id)).toMatchObject({
        articleRevision: '3',
        bodyText: 'Fresh target body',
      });
      // The source's in-flight extraction then finds its article gone and cannot recreate it.
      expect(
        await sqlStateOf(
          ctx.worker.transaction((tx) => upsertArticleBody(tx, source.id, '1', body())),
        ),
      ).toBe('23503');
    });
  });
});
