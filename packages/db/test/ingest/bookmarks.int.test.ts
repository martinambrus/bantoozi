import { createHash } from 'node:crypto';

import {
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  type ArticleFixture,
  type UserFixture,
} from '@bantoozi/testing';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Transaction } from '../../src/client.js';
import {
  completeBookmarkCapture,
  loadCaptureSource,
  resetArticleAnswers,
  upsertArticleBody,
  type CaptureOutcome,
  type CaptureSource,
  type CapturedContent,
} from '../../src/ingest/index.js';
import { workerOutbox } from '../../src/outbox.js';
import { asTenant, setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * The worker side of durable bookmark capture (spec 03 §8.5 steps 3–5, spec 02 §3.5): bookmark
 * state is created by the real API helpers (`capture_bookmark_snapshot`, `clear_bookmark_snapshot`)
 * as bantoozi_app inside tenant transactions; completion runs as the worker role.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

// ── API-side helpers (bantoozi_app, tenant transaction) ──────────────────────────────────────────

type ApiCapture = { snapshot_id: string; capture_status: string; capture_generation: string };

async function apiOne<R extends pg.QueryResultRow>(
  userId: string,
  text: string,
  values: unknown[],
): Promise<R> {
  const rows = await asTenant(
    ctx.appPool,
    userId,
    async (c) => (await c.query<R>(text, values)).rows,
  );
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0]!;
}

/** Bookmark through the API helper (binds available content, pending when absent/partial). */
const bookmark = (userId: string, articleId: string) =>
  apiOne<ApiCapture>(userId, 'SELECT * FROM capture_bookmark_snapshot($1, NULL)', [articleId]);

/** Unbookmark through the API helper (advances the generation, releases the binding). */
const unbookmark = (userId: string, articleId: string) =>
  apiOne<{ previous_snapshot_id: string | null; capture_generation: string }>(
    userId,
    'SELECT * FROM clear_bookmark_snapshot($1)',
    [articleId],
  );

// ── Fixtures and assertions ──────────────────────────────────────────────────────────────────────

/** Users subscribed (inference off) to one feed, and an article it carries. */
async function readersOf(
  count: number,
  article: {
    excerpt?: string | null;
    title?: string;
    author?: string | null;
    publishedAt?: Date;
  } = {},
): Promise<{ users: UserFixture[]; feedId: string; article: ArticleFixture }> {
  const feed = await createFeed(ctx.owner);
  const users: UserFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id });
    users.push(user);
  }
  const created = await createArticle(ctx.owner, {
    feedIds: [feed.id],
    excerpt: 'The teaser.',
    ...article,
  });
  return { users, feedId: feed.id, article: created };
}

type ReaderState = {
  bookmarked: boolean;
  snapshot_id: string | null;
  generation: string;
  status: string | null;
  error_code: string | null;
  state_version: string;
};

async function readerState(userId: string, articleId: string): Promise<ReaderState> {
  const result = await ctx.owner.query<ReaderState>(
    `SELECT bookmarked_at IS NOT NULL AS bookmarked, bookmark_snapshot_id::text AS snapshot_id,
            bookmark_capture_generation::text AS generation, bookmark_capture_status AS status,
            bookmark_capture_error_code AS error_code, state_version::text AS state_version
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  return result.rows[0]!;
}

type SnapshotRow = {
  id: string;
  source_revision: string;
  source_url: string | null;
  title: string;
  author: string | null;
  published_at: Date | null;
  body_text: string;
  body_html: string | null;
  content_sha256: string;
  completeness: string;
  completeness_reason: string | null;
  source: string;
  extractor_version: string;
  unreferenced: boolean;
  /** snapshot_content_sha256 recomputed by the database over the stored values. */
  recomputed_sha: string;
};

async function snapshot(id: string): Promise<SnapshotRow> {
  const result = await ctx.owner.query<SnapshotRow>(
    `SELECT id::text AS id, source_revision::text AS source_revision, source_url, title, author,
            published_at, body_text, body_html, content_sha256, completeness, completeness_reason,
            source, extractor_version, unreferenced_at IS NOT NULL AS unreferenced,
            snapshot_content_sha256(title, author, published_at, source_url, body_text, body_html)
              AS recomputed_sha
       FROM article_snapshots WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

async function snapshotIds(articleId: string): Promise<string[]> {
  const result = await ctx.owner.query<{ id: string }>(
    'SELECT id::text AS id FROM article_snapshots WHERE article_id = $1 ORDER BY id',
    [articleId],
  );
  return result.rows.map((r) => r.id);
}

/**
 * snapshot_content_sha256 (0003), recomputed independently: sha256 of the jsonb text of
 * [title, author, UTC date with microseconds, source URL, text, HTML].
 */
function snapshotSha(c: CapturedContent): string {
  const date = c.publishedAt?.toISOString().replace(/Z$/, '000Z') ?? null;
  const values = [c.title, c.author, date, c.sourceUrl, c.bodyText, c.bodyHtml];
  const json = `[${values.map((v) => (v === null ? 'null' : JSON.stringify(v))).join(', ')}]`;
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

const source = async (articleId: string): Promise<CaptureSource> => {
  const loaded = await loadCaptureSource(ctx.worker, articleId);
  if (loaded === null) throw new Error('article missing');
  return loaded;
};

/** Content frozen from the observed source, as the capture handler does. */
const content = (
  src: CaptureSource,
  overrides: Partial<CapturedContent> = {},
): CapturedContent => ({
  sourceRevision: src.revision,
  sourceUrl: src.url,
  title: src.title,
  author: src.author,
  publishedAt: src.publishedAt,
  bodyText: 'The complete article text.\n\nSecond paragraph.',
  bodyHtml: '<p>The complete article text.</p><p>Second paragraph.</p>',
  completeness: 'complete',
  completenessReason: null,
  source: 'page',
  extractorVersion: 'readability-test',
  ...overrides,
});

const complete = (
  src: CaptureSource,
  outcome: CaptureOutcome,
  generations = src.pending.map(({ userId, generation }) => ({ userId, generation })),
  observedRevision = src.revision,
) =>
  ctx.worker.transaction((tx: Transaction) =>
    completeBookmarkCapture(tx, {
      articleId: src.articleId,
      observedRevision,
      generations,
      outcome,
    }),
  );

const captured = (c: CapturedContent): CaptureOutcome => ({ status: 'captured', content: c });

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

describe('loadCaptureSource (spec 03 §8.5 step 3)', () => {
  it('returns the pending generations with the stored content to prefer before any fetch', async () => {
    const publishedAt = new Date('2026-09-21T07:15:30.000Z');
    const { users, feedId, article } = await readersOf(3, { author: 'Autor', publishedAt });
    const [pending, saved, deleted] = users as [UserFixture, UserFixture, UserFixture];
    const partial = await bookmark(pending.id, article.id);
    expect(partial.capture_status).toBe('pending');
    await bookmark(deleted.id, article.id);
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.id]);
    // Another reader's bookmark of an article with a complete body is saved, not pending.
    const other = await createArticle(ctx.owner, { feedIds: [feedId] });
    await ctx.worker.transaction((tx) =>
      upsertArticleBody(tx, other.id, '1', {
        status: 'ok',
        resolvedUrl: null,
        httpStatus: 200,
        bodyText: 'Complete body',
        bodyHtml: null,
        completeness: 'complete',
        completenessReason: null,
        bodyLead: 'Complete body',
        extractorVersion: 'readability-test',
        error: null,
      }),
    );
    expect((await bookmark(saved.id, other.id)).capture_status).toBe('saved');

    expect(await loadCaptureSource(ctx.worker, article.id)).toEqual({
      articleId: article.id,
      revision: '1',
      url: expect.stringMatching(/^https:\/\/news\.example\.test\//),
      title: expect.any(String),
      author: 'Autor',
      publishedAt,
      excerpt: 'The teaser.',
      excerptHtml: null,
      body: null,
      pending: [
        {
          userId: pending.id,
          generation: '1',
          snapshotId: partial.snapshot_id,
          snapshotCompleteness: 'partial',
          originFeedId: feedId,
        },
      ],
    });
    expect((await source(other.id)).pending).toEqual([]);
    expect((await source(other.id)).body).toMatchObject({
      articleRevision: '1',
      bodyText: 'Complete body',
    });
    expect(await loadCaptureSource(ctx.worker, '999999999')).toBeNull();
  });
});

describe('completeBookmarkCapture (spec 03 §8.5 steps 4–5)', () => {
  it('binds a complete capture as saved and releases the partial excerpt snapshot', async () => {
    const { users, article } = await readersOf(1, { author: 'Mária Nováková' });
    const user = users[0]!;
    const pending = await bookmark(user.id, article.id);
    const src = await source(article.id);
    const c = content(src);

    expect(await complete(src, captured(c))).toEqual({
      bound: 1,
      skipped: 0,
      revisionChanged: false,
    });
    const state = await readerState(user.id, article.id);
    expect(state).toEqual({
      bookmarked: true,
      snapshot_id: expect.any(String),
      generation: '1',
      status: 'saved',
      error_code: null,
      // Completion never touches reader state versions or feedback (worker-only binding).
      state_version: '0',
    });
    expect(state.snapshot_id).not.toBe(pending.snapshot_id);
    const saved = await snapshot(state.snapshot_id!);
    expect(saved).toEqual({
      id: state.snapshot_id,
      source_revision: '1',
      source_url: c.sourceUrl,
      title: c.title,
      author: 'Mária Nováková',
      published_at: null,
      body_text: c.bodyText,
      body_html: c.bodyHtml,
      content_sha256: snapshotSha(c),
      completeness: 'complete',
      completeness_reason: null,
      source: 'page',
      extractor_version: 'readability-test',
      unreferenced: false,
      recomputed_sha: snapshotSha(c),
    });
    // The replaced excerpt snapshot lost its final reference.
    expect((await snapshot(pending.snapshot_id)).unreferenced).toBe(true);

    // A duplicate job for the completed generation changes nothing.
    expect(await complete(src, captured(content(src, { bodyText: 'Other text' })))).toEqual({
      bound: 0,
      skipped: 1,
      revisionChanged: false,
    });
    expect(await readerState(user.id, article.id)).toEqual(state);
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id, state.snapshot_id]);
  });

  it('binds a teaser as a partial snapshot', async () => {
    const { users, article } = await readersOf(1);
    const user = users[0]!;
    await bookmark(user.id, article.id);
    const src = await source(article.id);
    const teaser = content(src, {
      bodyText: 'Only the first paragraph is free.',
      bodyHtml: '<p>Only the first paragraph is free.</p>',
      completeness: 'partial',
      completenessReason: 'paywall',
    });
    expect(await complete(src, captured(teaser))).toMatchObject({ bound: 1, skipped: 0 });
    const state = await readerState(user.id, article.id);
    expect(state).toMatchObject({ bookmarked: true, status: 'partial', error_code: null });
    expect(await snapshot(state.snapshot_id!)).toMatchObject({
      body_text: 'Only the first paragraph is free.',
      completeness: 'partial',
      completeness_reason: 'paywall',
    });
  });

  it('keeps the bookmark on failure and never fabricates text', async () => {
    // No readable content at all: the API bound an empty excerpt snapshot.
    const { users, article } = await readersOf(1, { excerpt: null });
    const user = users[0]!;
    const pending = await bookmark(user.id, article.id);
    const src = await source(article.id);
    expect(await complete(src, { status: 'failed', errorCode: 'robots_disallowed' })).toMatchObject(
      { bound: 1, skipped: 0 },
    );
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked: true,
      snapshot_id: pending.snapshot_id,
      status: 'failed',
      error_code: 'robots_disallowed',
    });
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id]);
    expect(await snapshot(pending.snapshot_id)).toMatchObject({
      body_text: '',
      unreferenced: false,
    });

    // With a readable teaser already bound, a failed attempt cannot improve it: terminal partial
    // (spec 03 §8.5 step 1), the bounded error code kept as its reason.
    const teaser = await readersOf(1);
    const reader = teaser.users[0]!;
    const bound = await bookmark(reader.id, teaser.article.id);
    const teaserSrc = await source(teaser.article.id);
    const longCode = `http_error ${'x'.repeat(100)} https://example.test/?q=secret`;
    expect(await complete(teaserSrc, { status: 'failed', errorCode: longCode })).toMatchObject({
      bound: 1,
    });
    const state = await readerState(reader.id, teaser.article.id);
    expect(state).toMatchObject({
      bookmarked: true,
      snapshot_id: bound.snapshot_id,
      status: 'partial',
    });
    expect(state.error_code).toMatch(/^http_error_x+$/);
    expect(state.error_code).toHaveLength(64);
  });

  it('binds nothing when the reader unbookmarked during the capture', async () => {
    const { users, article } = await readersOf(1);
    const user = users[0]!;
    const pending = await bookmark(user.id, article.id);
    const src = await source(article.id);
    await unbookmark(user.id, article.id);

    expect(await complete(src, captured(content(src)))).toEqual({
      bound: 0,
      skipped: 1,
      revisionChanged: false,
    });
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked: false,
      snapshot_id: null,
      status: null,
      generation: '2',
    });
    // Nothing new was archived for the stale job (an unbound row would never be collected).
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id]);
    expect(await complete(src, { status: 'failed', errorCode: 'timeout' })).toMatchObject({
      bound: 0,
    });
    expect((await readerState(user.id, article.id)).bookmarked).toBe(false);
  });

  it('does not bind an old generation after a rebookmark during the capture', async () => {
    const { users, article } = await readersOf(1);
    const user = users[0]!;
    await bookmark(user.id, article.id);
    const old = await source(article.id);
    await unbookmark(user.id, article.id);
    const again = await bookmark(user.id, article.id);
    expect(again).toMatchObject({ capture_status: 'pending', capture_generation: '3' });

    expect(await complete(old, captured(content(old)))).toMatchObject({ bound: 0, skipped: 1 });
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked: true,
      snapshot_id: again.snapshot_id,
      status: 'pending',
      generation: '3',
    });
    // The current generation completes normally.
    const current = await source(article.id);
    expect(current.pending.map((p) => p.generation)).toEqual(['3']);
    expect(await complete(current, captured(content(current)))).toMatchObject({ bound: 1 });
    expect(await readerState(user.id, article.id)).toMatchObject({
      status: 'saved',
      generation: '3',
    });
  });

  it('binds nothing when the source revision changed, keeping the existing content', async () => {
    const { users, article } = await readersOf(1);
    const user = users[0]!;
    const pending = await bookmark(user.id, article.id);
    const src = await source(article.id);
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(await complete(src, captured(content(src)))).toEqual({
      bound: 0,
      skipped: 1,
      revisionChanged: true,
    });
    expect(await readerState(user.id, article.id)).toMatchObject({
      snapshot_id: pending.snapshot_id,
      status: 'pending',
    });
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id]);
    // Content must be frozen from the observed revision.
    const retry = await source(article.id);
    expect(retry.revision).toBe('2');
    await expect(
      complete(retry, captured(content(retry, { sourceRevision: '1' }))),
    ).rejects.toThrow(TypeError);
    expect(await complete(retry, captured(content(retry)))).toMatchObject({ bound: 1 });
    expect(await snapshot((await readerState(user.id, article.id)).snapshot_id!)).toMatchObject({
      source_revision: '2',
    });
  });

  it('lets two readers of one article share one snapshot row', async () => {
    const { users, article } = await readersOf(2);
    const [a, b] = users as [UserFixture, UserFixture];
    await bookmark(a.id, article.id);
    await bookmark(b.id, article.id);
    const src = await source(article.id);
    expect(src.pending).toHaveLength(2);
    expect(await complete(src, captured(content(src)))).toMatchObject({ bound: 2, skipped: 0 });
    const stateA = await readerState(a.id, article.id);
    const stateB = await readerState(b.id, article.id);
    expect(stateA.snapshot_id).not.toBeNull();
    expect(stateB.snapshot_id).toBe(stateA.snapshot_id);

    // Separate completions of identical content reuse the same immutable row.
    const other = await readersOf(2);
    const [c, d] = other.users as [UserFixture, UserFixture];
    await bookmark(c.id, other.article.id);
    await bookmark(d.id, other.article.id);
    const otherSrc = await source(other.article.id);
    const frozen = content(otherSrc);
    for (const pending of otherSrc.pending) {
      await complete(otherSrc, captured(frozen), [pending]);
    }
    const stateC = await readerState(c.id, other.article.id);
    expect(stateC.status).toBe('saved');
    expect((await readerState(d.id, other.article.id)).snapshot_id).toBe(stateC.snapshot_id);
    // One shared excerpt snapshot (both API bookmarks) and one shared full capture.
    expect(await snapshotIds(other.article.id)).toHaveLength(2);
  });

  it('binds a complete capture identical to a partial feed snapshot to its own complete row (D-19)', async () => {
    // A linked item's full feed text is stored as a partial feed-v1 body until the page is read,
    // so an API bookmark before extraction archives it as a partial snapshot.
    const { users, feedId, article } = await readersOf(2);
    const [first, second] = users as [UserFixture, UserFixture];
    const text = 'The complete article text.\n\nSecond paragraph.';
    const html = '<p>The complete article text.</p><p>Second paragraph.</p>';
    await ctx.worker.transaction((tx) =>
      upsertArticleBody(tx, article.id, '1', {
        status: 'ok',
        resolvedUrl: null,
        httpStatus: null,
        bodyText: text,
        bodyHtml: html,
        completeness: 'partial',
        completenessReason: 'feed_content',
        bodyLead: text,
        extractorVersion: 'feed-v1',
        error: null,
      }),
    );
    const feedCapture = await bookmark(first.id, article.id);
    expect(feedCapture.capture_status).toBe('pending');
    expect((await bookmark(second.id, article.id)).snapshot_id).toBe(feedCapture.snapshot_id);
    const partial = await snapshot(feedCapture.snapshot_id);
    expect(partial).toMatchObject({ completeness: 'partial', source: 'feed', body_text: text });

    // The page capture is byte-identical to the feed text, and complete.
    const src = await source(article.id);
    const page = content(src, { bodyText: text, bodyHtml: html });
    expect(snapshotSha(page)).toBe(partial.content_sha256);
    const firstPending = src.pending.filter((p) => p.userId === first.id);
    expect(await complete(src, captured(page), firstPending)).toMatchObject({ bound: 1 });

    const saved = await readerState(first.id, article.id);
    expect(saved).toMatchObject({ status: 'saved' });
    expect(saved.snapshot_id).not.toBe(partial.id);
    expect(await snapshot(saved.snapshot_id!)).toMatchObject({
      completeness: 'complete',
      source: 'page',
      content_sha256: partial.content_sha256,
    });
    // The other reader keeps the partial row until its own capture completes.
    expect(await readerState(second.id, article.id)).toMatchObject({
      status: 'pending',
      snapshot_id: partial.id,
    });
    expect(await snapshotIds(article.id)).toEqual([partial.id, saved.snapshot_id]);

    // A later API bookmark of the now complete source shares the complete row.
    await ctx.worker.transaction((tx) =>
      upsertArticleBody(tx, article.id, '1', {
        status: 'ok',
        resolvedUrl: src.url,
        httpStatus: 200,
        bodyText: text,
        bodyHtml: html,
        completeness: 'complete',
        completenessReason: null,
        bodyLead: text,
        extractorVersion: 'readability-test',
        error: null,
      }),
    );
    const third = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: third.id, feedId });
    const rebound = await bookmark(third.id, article.id);
    expect(rebound).toMatchObject({ capture_status: 'saved', snapshot_id: saved.snapshot_id });
  });

  it('reattaches an unreferenced identical snapshot, clearing its marker', async () => {
    const { users, article } = await readersOf(2);
    const [a, b] = users as [UserFixture, UserFixture];
    await bookmark(a.id, article.id);
    const first = await source(article.id);
    await complete(first, captured(content(first)));
    const saved = (await readerState(a.id, article.id)).snapshot_id!;
    // The final reference detaches: the snapshot waits for garbage collection.
    await unbookmark(a.id, article.id);
    expect((await snapshot(saved)).unreferenced).toBe(true);

    const excerpt = await bookmark(b.id, article.id);
    const second = await source(article.id);
    expect(await complete(second, captured(content(second)))).toMatchObject({ bound: 1 });
    // The identical capture reuses the row and attaches it again; the excerpt is released.
    expect(await readerState(b.id, article.id)).toMatchObject({
      snapshot_id: saved,
      status: 'saved',
    });
    expect((await snapshot(saved)).unreferenced).toBe(false);
    expect((await snapshot(excerpt.snapshot_id)).unreferenced).toBe(true);
  });

  it('completes a pending generation without any binding', async () => {
    const { users, article } = await readersOf(2, { excerpt: null });
    const [a, b] = users as [UserFixture, UserFixture];
    await bookmark(a.id, article.id);
    await bookmark(b.id, article.id);
    // A pending generation may carry no snapshot (the table allows it, e.g. after a merge).
    await ctx.owner.query(
      'UPDATE user_article SET bookmark_snapshot_id = NULL WHERE article_id = $1',
      [article.id],
    );
    const src = await source(article.id);
    expect(src.pending.map((p) => p.snapshotId)).toEqual([null, null]);
    const [pa, pb] = src.pending as [(typeof src.pending)[number], (typeof src.pending)[number]];
    expect(await complete(src, { status: 'failed', errorCode: 'timeout' }, [pa])).toMatchObject({
      bound: 1,
      skipped: 0,
    });
    expect(await readerState(pa.userId, article.id)).toMatchObject({
      bookmarked: true,
      snapshot_id: null,
      status: 'failed',
      error_code: 'timeout',
    });
    expect(await complete(src, captured(content(src)), [pb])).toMatchObject({ bound: 1 });
    expect(await readerState(pb.userId, article.id)).toMatchObject({
      snapshot_id: expect.any(String),
      status: 'saved',
    });
    expect([a.id, b.id].sort()).toEqual([pa.userId, pb.userId]);
  });

  it('never replaces a bound complete snapshot with a partial or failed capture', async () => {
    const { users, article } = await readersOf(1);
    const user = users[0]!;
    await bookmark(user.id, article.id);
    const src = await source(article.id);
    await complete(src, captured(content(src)));
    const saved = await readerState(user.id, article.id);
    expect(saved.status).toBe('saved');

    // A late duplicate with a teaser: the generation is no longer pending.
    const teaser = content(src, { bodyText: 'Teaser', bodyHtml: null, completeness: 'partial' });
    expect(await complete(src, captured(teaser))).toMatchObject({ bound: 0, skipped: 1 });
    expect(await readerState(user.id, article.id)).toEqual(saved);

    // Even a pending generation keeps its bound complete snapshot (as an exact undo of a pending
    // bookmark may restore it): a teaser or a failure completes it as saved.
    await ctx.owner.query(
      `UPDATE user_article SET bookmark_capture_status = 'pending'
        WHERE user_id = $1 AND article_id = $2`,
      [user.id, article.id],
    );
    const before = await snapshotIds(article.id);
    expect(await complete(src, captured(teaser))).toMatchObject({ bound: 1 });
    expect(await readerState(user.id, article.id)).toEqual(saved);
    await ctx.owner.query(
      `UPDATE user_article SET bookmark_capture_status = 'pending'
        WHERE user_id = $1 AND article_id = $2`,
      [user.id, article.id],
    );
    expect(await complete(src, { status: 'failed', errorCode: 'timeout' })).toMatchObject({
      bound: 1,
    });
    expect(await readerState(user.id, article.id)).toEqual(saved);
    expect(await snapshotIds(article.id)).toEqual(before);
  });

  it('stores 100k+ characters of text and HTML without truncation, checksummed exactly', async () => {
    const publishedAt = new Date('2026-09-22T10:11:12.345Z');
    const { users, article } = await readersOf(1, { author: 'Ľubomír', publishedAt });
    const user = users[0]!;
    await bookmark(user.id, article.id);
    const src = await source(article.id);
    const paragraph = 'Žltý kôň úpel ďábelské ódy — “quotes”, emoji 📰 and plain ASCII. ';
    const paragraphs = Array.from({ length: 2_000 }, (_, i) => `${i}: ${paragraph}`);
    const text = paragraphs.join('\n\n');
    const html = paragraphs.map((p) => `<p>${p}</p>`).join('');
    expect(text.length).toBeGreaterThan(100_000);
    const c = content(src, { bodyText: text, bodyHtml: html });
    expect(await complete(src, captured(c))).toMatchObject({ bound: 1 });
    const stored = await snapshot((await readerState(user.id, article.id)).snapshot_id!);
    expect(stored.body_text).toBe(text);
    expect(stored.body_html).toBe(html);
    expect(stored.published_at).toEqual(publishedAt);
    expect(stored.content_sha256).toBe(stored.recomputed_sha);
    expect(stored.content_sha256).toBe(snapshotSha(c));
  });

  it('rejects content above 10 MiB before writing and never archives blank content', async () => {
    const { users, article } = await readersOf(1, { excerpt: null });
    const user = users[0]!;
    const pending = await bookmark(user.id, article.id);
    const src = await source(article.id);
    const huge = content(src, { bodyText: 'a'.repeat(10 * 1024 * 1024), bodyHtml: '<p>a</p>' });
    await expect(complete(src, captured(huge))).rejects.toThrow(/10 MiB/);
    expect(await readerState(user.id, article.id)).toMatchObject({ status: 'pending' });
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id]);
    // "Captured" whitespace is no readable content: an honest failure, no empty archive.
    const blank = content(src, { bodyText: '  \n ', bodyHtml: null });
    expect(await complete(src, captured(blank))).toMatchObject({ bound: 1 });
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked: true,
      snapshot_id: pending.snapshot_id,
      status: 'failed',
      error_code: 'no_content',
    });
    expect(await snapshotIds(article.id)).toEqual([pending.snapshot_id]);
    // A vanished article completes nothing.
    const gone = { ...src, articleId: '999999999' };
    expect(await complete(gone, { status: 'failed', errorCode: 'gone' })).toEqual({
      bound: 0,
      skipped: 1,
      revisionChanged: false,
    });
  });

  it('serializes with a concurrent API bookmark of the same article', async () => {
    const { users, article } = await readersOf(2);
    const [a, b] = users as [UserFixture, UserFixture];
    await bookmark(a.id, article.id);
    const src = await source(article.id);
    let release!: () => void;
    let completed!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (completed = resolve));
    const worker = ctx.worker.transaction(async (tx) => {
      const result = await completeBookmarkCapture(tx, {
        articleId: src.articleId,
        observedRevision: src.revision,
        generations: src.pending,
        outcome: captured(content(src)),
      });
      completed();
      await gate;
      return result;
    });
    await ready;
    // The API helper waits for the completion's article lock instead of interleaving with it.
    const api = bookmark(b.id, article.id);
    for (let i = 0; ; i += 1) {
      const waiting = await ctx.adminPool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND usename = 'bantoozi_app'`,
      );
      if ((waiting.rowCount ?? 0) > 0) break;
      if (i > 200) throw new Error('the API bookmark did not wait for the article lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    expect(await worker).toMatchObject({ bound: 1 });
    expect(await api).toMatchObject({ capture_status: 'pending', capture_generation: '1' });
    expect((await readerState(a.id, article.id)).status).toBe('saved');
    expect((await readerState(b.id, article.id)).status).toBe('pending');
  });
});
