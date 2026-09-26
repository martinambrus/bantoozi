import { createHash, randomUUID } from 'node:crypto';

import { buildJobIntent } from '@bantoozi/shared';
import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
  type CardFixture,
  type UserFixture,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/tenant.js';
import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from './support/test-db.js';

/**
 * The API-facing SECURITY DEFINER functions of drizzle 0003 (spec 02 §3.5, §6, §8 item 9; PLAN
 * M0-T5), exercised through the real role logins: bookmark archives and exact undo, the shared rate
 * limiter, the card-translation accounting helper and the admin statistics.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const PLATFORM_USER = '00000000-0000-0000-0000-000000000000';

function only<R>(rows: readonly R[]): R {
  const [row, ...rest] = rows;
  if (row === undefined || rest.length > 0) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return row;
}

/** Rows of one statement run by `pool`'s login inside a tenant transaction (`null`: no tenant). */
async function tenantRows<R extends pg.QueryResultRow>(
  pool: pg.Pool,
  userId: string | null,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return asTenant(pool, userId, async (c) => (await c.query<R>(text, values)).rows);
}

/** The SQLSTATE one statement fails with as bantoozi_app inside a tenant transaction. */
const apiError = (userId: string | null, text: string, values: unknown[] = []): Promise<string> =>
  sqlStateOf(tenantRows(ctx.appPool, userId, text, values));

// ── Bookmark helpers ────────────────────────────────────────────────────────────────────────────

type Capture = { snapshot_id: string; capture_status: string; capture_generation: string };
type Cleared = { previous_snapshot_id: string | null; capture_generation: string };
type ReaderState = {
  bookmarked_at: string | null;
  snapshot_id: string | null;
  origin_feed_id: string | null;
  generation: string;
  status: string | null;
  error_code: string | null;
  state_version: string;
};
type Snapshot = {
  id: string;
  article_id: string;
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
  unreferenced_at: Date | null;
};
type Intent = {
  queue: string;
  payload: unknown;
  dedupe_key: string | null;
  user_id: string | null;
  delivered_at: Date | null;
};

// The three helpers, always called by bantoozi_app inside a tenant transaction.
const capture = async (
  userId: string | null,
  articleId: string,
  originFeedId: string | null = null,
) =>
  only(
    await tenantRows<Capture>(
      ctx.appPool,
      userId,
      'SELECT * FROM capture_bookmark_snapshot($1, $2)',
      [articleId, originFeedId],
    ),
  );
const clear = async (userId: string | null, articleId: string) =>
  only(
    await tenantRows<Cleared>(ctx.appPool, userId, 'SELECT * FROM clear_bookmark_snapshot($1)', [
      articleId,
    ]),
  );
const restore = async (userId: string | null, articleId: string, mutationId: string) =>
  only(
    await tenantRows<Capture>(
      ctx.appPool,
      userId,
      'SELECT * FROM restore_bookmark_snapshot($1, $2)',
      [articleId, mutationId],
    ),
  );

/** An expected capture/restore result. */
const bound = (snapshotId: string, status: 'saved' | 'pending', generation: number): Capture => ({
  snapshot_id: snapshotId,
  capture_status: status,
  capture_generation: String(generation),
});
/** An expected clear result. */
const released = (snapshotId: string | null, generation: number): Cleared => ({
  previous_snapshot_id: snapshotId,
  capture_generation: String(generation),
});

/** The reader row's bookmark fields (owner view; bookmarked_at as exact UTC microseconds). */
async function readerState(userId: string, articleId: string): Promise<ReaderState | undefined> {
  const result = await ctx.owner.query<ReaderState>(
    `SELECT to_char(bookmarked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS bookmarked_at,
            bookmark_snapshot_id::text AS snapshot_id, bookmark_origin_feed_id::text AS origin_feed_id,
            bookmark_capture_generation::text AS generation, bookmark_capture_status AS status,
            bookmark_capture_error_code AS error_code, state_version::text AS state_version
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  return result.rows[0];
}

async function snapshot(id: string): Promise<Snapshot> {
  const result = await ctx.owner.query<Snapshot>(
    `SELECT id::text AS id, article_id::text AS article_id, source_revision::text AS source_revision,
            source_url, title, author, published_at, body_text, body_html, content_sha256,
            completeness, completeness_reason, source, extractor_version, unreferenced_at
       FROM article_snapshots WHERE id = $1`,
    [id],
  );
  return only(result.rows);
}

/** Snapshot ids the API role can read in this tenant (policy article_snapshots_saved_read). */
const visibleSnapshots = async (userId: string | null): Promise<string[]> =>
  (
    await tenantRows<{ id: string }>(
      ctx.appPool,
      userId,
      'SELECT id::text AS id FROM article_snapshots ORDER BY id',
    )
  ).map((r) => r.id);

async function captureIntents(articleId: string): Promise<Intent[]> {
  const result = await ctx.owner.query<Intent>(
    `SELECT queue, payload, dedupe_key, user_id::text AS user_id, delivered_at FROM job_outbox
      WHERE queue = 'article.capture-bookmark' AND payload->>'articleId' = $1 ORDER BY id`,
    [articleId],
  );
  return result.rows;
}

const captureDedupeKey = (article: { id: string; contentRevision: string }): string =>
  `{"payload":{"articleId":"${article.id}"},"revision":"${article.contentRevision}"}`;

/** A user subscribed (inference off) to a new feed. */
async function subscribedReader(): Promise<{ user: UserFixture; feedId: string }> {
  const user = await createUser(ctx.owner);
  const feed = await createFeed(ctx.owner);
  await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id });
  return { user, feedId: feed.id };
}

/** The article's stored extracted body (status ok) for `revision`. */
async function setBody(
  articleId: string,
  revision: string,
  body: {
    text: string | null;
    html?: string | null;
    completeness: 'complete' | 'partial';
    reason?: string | null;
    extractor?: string;
  },
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO article_bodies (article_id, article_revision, status, body_text, body_html, completeness,
                                 completeness_reason, extractor_version)
     VALUES ($1, $2, 'ok', $3, $4, $5, $6, $7)
     ON CONFLICT (article_id) DO UPDATE
       SET article_revision = EXCLUDED.article_revision, status = EXCLUDED.status,
           body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html,
           completeness = EXCLUDED.completeness, completeness_reason = EXCLUDED.completeness_reason,
           extractor_version = EXCLUDED.extractor_version, extracted_at = now()`,
    [
      articleId,
      revision,
      body.text,
      body.html ?? null,
      body.completeness,
      body.reason ?? null,
      body.extractor ?? 'readability-test',
    ],
  );
}

/** A subscribed reader's saved (complete) bookmark of a new article. */
async function savedBookmark(text = 'Saved body') {
  const reader = await subscribedReader();
  const article = await createArticle(ctx.owner, { feedIds: [reader.feedId] });
  const html = `<p>${text}</p>`;
  await setBody(article.id, article.contentRevision, { text, html, completeness: 'complete' });
  const saved = await capture(reader.user.id, article.id, reader.feedId);
  expect(saved.capture_status).toBe('saved');
  return { ...reader, article, saved };
}

/**
 * snapshot_content_sha256 (0003), recomputed independently: sha256 of the jsonb text of
 * [title, author, UTC date with microseconds, source URL, text, HTML].
 */
function snapshotSha(parts: {
  title: string;
  author: string | null;
  publishedAt: Date | null;
  url: string | null;
  text: string;
  html: string | null;
}): string {
  const date = parts.publishedAt?.toISOString().replace(/Z$/, '000Z') ?? null;
  const values = [parts.title, parts.author, date, parts.url, parts.text, parts.html];
  const json = `[${values.map((v) => (v === null ? 'null' : JSON.stringify(v))).join(', ')}]`;
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

type Receipt = {
  mutationId: string;
  snapshotId: string;
  stateVersion: string;
  before: ReaderState;
};

/**
 * Unbookmark the way the API action does, in one tenant transaction: clear the binding, increment
 * the reader version once, and write the undo receipt plus the ten-minute pin of the released
 * snapshot (`pinSnapshotId` overrides the pinned id, as a buggy or forged repository write would).
 */
async function unbookmarkWithReceipt(
  userId: string,
  articleId: string,
  pinSnapshotId?: string,
): Promise<Receipt> {
  const before = await readerState(userId, articleId);
  if (before === undefined || before.bookmarked_at === null) throw new Error('not bookmarked');
  const prior = {
    bookmarkedAt: before.bookmarked_at,
    originFeedId: before.origin_feed_id,
    captureStatus: before.status,
  };
  const mutationId = randomUUID();
  return asTenant(ctx.appPool, userId, async (c) => {
    const query = async <R extends pg.QueryResultRow>(text: string, values: unknown[]) =>
      (await c.query<R>(text, values)).rows;
    const cleared = only(
      await query<Cleared>('SELECT * FROM clear_bookmark_snapshot($1)', [articleId]),
    );
    if (cleared.previous_snapshot_id === null) throw new Error('no snapshot was released');
    const { state_version: stateVersion } = only(
      await query<{ state_version: string }>(
        `UPDATE user_article SET state_version = state_version + 1
          WHERE user_id = $1 AND article_id = $2 RETURNING state_version::text AS state_version`,
        [userId, articleId],
      ),
    );
    const undo = { kind: 'unbookmark', articleId, stateVersion, prior };
    await query(
      `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, undo, expires_at)
       VALUES ($1, $2, 'sha256:test', 'DELETE /articles/:id/bookmark', 200, '{}', $3,
               now() + interval '7 days')`,
      [userId, mutationId, JSON.stringify(undo)],
    );
    await query(
      `INSERT INTO bookmark_snapshot_pins (user_id, mutation_id, snapshot_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [userId, mutationId, pinSnapshotId ?? cleared.previous_snapshot_id],
    );
    return { mutationId, snapshotId: cleared.previous_snapshot_id, stateVersion, before };
  });
}

describe('role logins', () => {
  it('are the real API and worker roles', async () => {
    const who = async (pool: pg.Pool) =>
      only((await pool.query('SELECT session_user AS s, current_user AS c')).rows);
    expect(await who(ctx.appPool)).toEqual({ s: 'bantoozi_app', c: 'bantoozi_app' });
    expect(await who(ctx.workerPool)).toEqual({ s: 'bantoozi_worker', c: 'bantoozi_worker' });
  });
});

describe('bookmark archive functions (as bantoozi_app)', () => {
  it('capture binds a complete extracted body as a saved snapshot only its tenant can read', async () => {
    const reader = await subscribedReader();
    const publishedAt = new Date('2026-09-20T08:30:00.000Z');
    const url = `https://news.example.test/harbour-${randomUUID()}`;
    const title = 'Harbour "reopens" after the storm';
    const author = 'Jana Nováková';
    const text = 'Full text.\nSecond paragraph with "quotes" and ünïcode.';
    const html = '<p>Full text.</p><p>Second paragraph with &quot;quotes&quot; and ünïcode.</p>';
    const article = await createArticle(ctx.owner, {
      feedIds: [reader.feedId],
      url,
      title,
      author,
      publishedAt,
      excerpt: 'Teaser only.',
    });
    await setBody(article.id, article.contentRevision, {
      text,
      html,
      completeness: 'complete',
      extractor: 'readability-9',
    });
    // Another tenant's archive exists and must stay invisible.
    const other = await subscribedReader();
    const otherArticle = await createArticle(ctx.owner, { feedIds: [other.feedId] });
    const otherSaved = await capture(other.user.id, otherArticle.id);

    // The API path: a withTenant transaction on the bantoozi_app pool.
    const saved = await withTenant(ctx.app, reader.user.id, async (tx) => {
      const result = await tx.execute<Capture>(
        sql`SELECT * FROM capture_bookmark_snapshot(${article.id}::bigint, ${reader.feedId}::bigint)`,
      );
      return only(result.rows);
    });
    expect(saved).toEqual(bound(expect.any(String), 'saved', 1));

    expect(await snapshot(saved.snapshot_id)).toEqual({
      id: saved.snapshot_id,
      article_id: article.id,
      source_revision: article.contentRevision,
      source_url: url,
      title,
      author,
      published_at: publishedAt,
      body_text: text,
      body_html: html,
      content_sha256: snapshotSha({ title, author, publishedAt, url, text, html }),
      completeness: 'complete',
      completeness_reason: null,
      source: 'page',
      extractor_version: 'readability-9',
      unreferenced_at: null,
    });
    expect(await readerState(reader.user.id, article.id)).toEqual({
      bookmarked_at: expect.any(String),
      snapshot_id: saved.snapshot_id,
      origin_feed_id: reader.feedId,
      generation: '1',
      status: 'saved',
      error_code: null,
      // The enclosing API action increments the reader version and appends feedback, not the helper.
      state_version: '0',
    });
    const events = await ctx.owner.query('SELECT 1 FROM feedback_events WHERE user_id = $1', [
      reader.user.id,
    ]);
    expect(events.rowCount).toBe(0);
    expect(await captureIntents(article.id)).toEqual([]);

    // Saved-read policy: own archives only, never another tenant's, nothing without a tenant.
    expect(await visibleSnapshots(reader.user.id)).toEqual([saved.snapshot_id]);
    expect(await visibleSnapshots(other.user.id)).toEqual([otherSaved.snapshot_id]);
    expect(await visibleSnapshots(null)).toEqual([]);
    const readable = await tenantRows(
      ctx.appPool,
      reader.user.id,
      'SELECT body_text, body_html FROM article_snapshots WHERE id = $1',
      [saved.snapshot_id],
    );
    expect(readable).toEqual([{ body_text: text, body_html: html }]);
  });

  it('capture of stored publisher feed text records feed provenance (D-16)', async () => {
    const { user, feedId } = await subscribedReader();
    const article = await createArticle(ctx.owner, { feedIds: [feedId] });
    const text = 'The whole weekly note, as published in the feed.';
    await setBody(article.id, article.contentRevision, {
      text,
      html: `<p>${text}</p>`,
      completeness: 'complete',
      extractor: 'feed-v1',
    });

    const saved = await capture(user.id, article.id, feedId);
    expect(saved).toEqual(bound(expect.any(String), 'saved', 1));
    expect(await snapshot(saved.snapshot_id)).toMatchObject({
      body_text: text,
      completeness: 'complete',
      source: 'feed',
      extractor_version: 'feed-v1',
    });
  });

  it('capture of excerpt-only content binds a partial snapshot and queues one deduplicated capture intent', async () => {
    const { user, feedId } = await subscribedReader();
    const article = await createArticle(ctx.owner, { feedIds: [feedId], excerpt: 'The teaser.' });

    const first = await capture(user.id, article.id, feedId);
    expect(first).toEqual(bound(expect.any(String), 'pending', 1));
    expect(await snapshot(first.snapshot_id)).toMatchObject({
      article_id: article.id,
      source_revision: article.contentRevision,
      body_text: 'The teaser.',
      body_html: null,
      completeness: 'partial',
      completeness_reason: 'excerpt_only',
      source: 'feed',
      extractor_version: 'feed',
      unreferenced_at: null,
    });
    // The partial binding is kept while the local capture is pending (spec 03).
    expect(await readerState(user.id, article.id)).toMatchObject({
      snapshot_id: first.snapshot_id,
      status: 'pending',
      generation: '1',
    });
    const dedupeKey = captureDedupeKey(article);
    // The same fingerprint as a TypeScript producer's intent, so the two coalesce.
    const tsIntent = buildJobIntent(
      'article.capture-bookmark',
      { articleId: article.id },
      { revision: article.contentRevision },
    );
    expect(tsIntent.dedupeKey).toBe(dedupeKey);
    const intent: Intent = {
      queue: 'article.capture-bookmark',
      payload: { articleId: article.id },
      dedupe_key: dedupeKey,
      user_id: user.id,
      delivered_at: null,
    };
    expect(await captureIntents(article.id)).toEqual([intent]);
    const byUser = await ctx.owner.query('SELECT 1 FROM job_outbox WHERE user_id = $1', [user.id]);
    expect(byUser.rowCount).toBe(1);
    // The API role writes intents but never reads the outbox.
    expect(await apiError(user.id, 'SELECT 1 FROM job_outbox')).toBe('42501');

    // Capturing again advances the generation without a second pending intent.
    expect(await capture(user.id, article.id, feedId)).toEqual(
      bound(first.snapshot_id, 'pending', 2),
    );
    expect(await captureIntents(article.id)).toEqual([intent]);

    // Once a complete body is stored, capture binds it and releases the partial snapshot.
    await setBody(article.id, article.contentRevision, {
      text: 'Complete.',
      completeness: 'complete',
    });
    const third = await capture(user.id, article.id);
    expect(third).toEqual(bound(expect.any(String), 'saved', 3));
    expect(third.snapshot_id).not.toBe(first.snapshot_id);
    expect(await snapshot(third.snapshot_id)).toMatchObject({
      body_text: 'Complete.',
      completeness: 'complete',
      source: 'page',
    });
    expect((await snapshot(first.snapshot_id)).unreferenced_at).toBeInstanceOf(Date);
    expect(await readerState(user.id, article.id)).toMatchObject({
      snapshot_id: third.snapshot_id,
      origin_feed_id: feedId,
      status: 'saved',
      generation: '3',
    });
    expect(await captureIntents(article.id)).toEqual([intent]);
  });

  it('capture refuses inaccessible articles and non-carrier origins, and needs an active tenant', async () => {
    const { user, feedId } = await subscribedReader();
    const u = user.id;
    const unsubscribedCarrier = (await createFeed(ctx.owner)).id;
    const subscribedNonCarrier = (await createFeed(ctx.owner)).id;
    await createSubscription(ctx.owner, { userId: u, feedId: subscribedNonCarrier });
    const carried = await createArticle(ctx.owner, { feedIds: [feedId, unsubscribedCarrier] });
    const foreign = await createArticle(ctx.owner, { feedIds: [unsubscribedCarrier] });

    // No subscribed carrier and no own bookmark, or no such article.
    expect(await sqlStateOf(capture(u, foreign.id))).toBe('BZ404');
    expect(await sqlStateOf(capture(u, foreign.id, unsubscribedCarrier))).toBe('BZ404');
    expect(await sqlStateOf(capture(u, '999999999'))).toBe('BZ404');
    // The origin must be a subscribed carrier of this article.
    expect(await sqlStateOf(capture(u, carried.id, unsubscribedCarrier))).toBe('BZ404');
    expect(await sqlStateOf(capture(u, carried.id, subscribedNonCarrier))).toBe('BZ404');
    // No active tenant: none, an unknown user, a soft-deleted account.
    const deleted = await createUser(ctx.owner, { deletedAt: new Date() });
    await createSubscription(ctx.owner, { userId: deleted.id, feedId });
    for (const tenant of [null, randomUUID(), deleted.id]) {
      expect(await sqlStateOf(capture(tenant, carried.id))).toBe('42501');
    }
    expect(await sqlStateOf(clear(null, carried.id))).toBe('42501');
    expect(await sqlStateOf(restore(null, carried.id, randomUUID()))).toBe('42501');
    // Refused calls wrote nothing.
    expect(await readerState(u, foreign.id)).toBeUndefined();
    expect(await readerState(u, carried.id)).toBeUndefined();
    expect(await captureIntents(carried.id)).toEqual([]);

    // Without an explicit origin, the subscribed carrier is the bookmark's source.
    await capture(u, carried.id);
    expect(await readerState(u, carried.id)).toMatchObject({
      origin_feed_id: feedId,
      generation: '1',
    });
  });

  it('clear verifies article access like capture (BZ404 for missing or inaccessible articles)', async () => {
    const { user } = await subscribedReader();
    const foreign = await createArticle(ctx.owner, { feedIds: [(await createFeed(ctx.owner)).id] });
    expect(await sqlStateOf(clear(user.id, foreign.id))).toBe('BZ404');
    expect(await sqlStateOf(clear(user.id, '999999999'))).toBe('BZ404');
    expect(await readerState(user.id, foreign.id)).toBeUndefined();
  });

  it('a later capture from a less complete source keeps the complete saved snapshot', async () => {
    const { user, article, saved } = await savedBookmark('Complete original.');
    // The article is edited and re-extracted behind a paywall.
    await ctx.owner.query(
      'UPDATE articles SET content_revision = content_revision + 1, excerpt = $2 WHERE id = $1',
      [article.id, 'Edited teaser'],
    );
    await setBody(article.id, '2', {
      text: 'Truncated.',
      completeness: 'partial',
      reason: 'paywall',
    });
    expect(await capture(user.id, article.id)).toEqual(bound(saved.snapshot_id, 'saved', 2));
    // The body is purged: only the feed excerpt remains.
    await ctx.owner.query('DELETE FROM article_bodies WHERE article_id = $1', [article.id]);
    expect(await capture(user.id, article.id)).toEqual(bound(saved.snapshot_id, 'saved', 3));

    expect(await snapshot(saved.snapshot_id)).toMatchObject({
      source_revision: '1',
      body_text: 'Complete original.',
      body_html: '<p>Complete original.</p>',
      completeness: 'complete',
      unreferenced_at: null,
    });
    expect(await readerState(user.id, article.id)).toMatchObject({
      snapshot_id: saved.snapshot_id,
      status: 'saved',
      generation: '3',
    });
    expect(await captureIntents(article.id)).toEqual([]);
    expect(await visibleSnapshots(user.id)).toEqual([saved.snapshot_id]);
    // Nothing new was archived for the less complete sources (an unbound row would never be GC'd).
    const rows = await ctx.owner.query('SELECT id FROM article_snapshots WHERE article_id = $1', [
      article.id,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('clear releases the binding and marks the snapshot unreferenced only after its final reference', async () => {
    const feed = await createFeed(ctx.owner);
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: a.id, feedId: feed.id });
    await createSubscription(ctx.owner, { userId: b.id, feedId: feed.id });
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    await setBody(article.id, article.contentRevision, {
      text: 'Shared',
      completeness: 'complete',
    });

    const { snapshot_id: id } = await capture(a.id, article.id);
    // Same article, revision and content: one immutable snapshot row.
    expect((await capture(b.id, article.id)).snapshot_id).toBe(id);

    expect(await clear(a.id, article.id)).toEqual(released(id, 2));
    expect(await readerState(a.id, article.id)).toEqual({
      bookmarked_at: null,
      snapshot_id: null,
      origin_feed_id: null,
      generation: '2',
      status: null,
      error_code: null,
      state_version: '0',
    });
    // B's bookmark still refers to the snapshot.
    expect((await snapshot(id)).unreferenced_at).toBeNull();
    expect(await visibleSnapshots(a.id)).toEqual([]);
    expect(await visibleSnapshots(b.id)).toEqual([id]);
    // Clearing an unbookmarked, accessible article changes nothing.
    expect(await clear(a.id, article.id)).toEqual(released(null, 2));

    // The final reference detaches: the snapshot is marked unreferenced.
    expect(await clear(b.id, article.id)).toEqual(released(id, 2));
    expect((await snapshot(id)).unreferenced_at).toBeInstanceOf(Date);

    // Rebookmarking is a new generation and reattaches the identical snapshot, clearing the mark.
    expect(await capture(a.id, article.id)).toEqual(bound(id, 'saved', 3));
    expect((await snapshot(id)).unreferenced_at).toBeNull();
  });

  it('takes no snapshot id: only the helpers bind snapshots or set a saved status', async () => {
    const signatures = await ctx.appPool.query(
      `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
              (SELECT array_agg(format_type(t, NULL) ORDER BY o)
                 FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, o)) AS types
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('capture_bookmark_snapshot', 'clear_bookmark_snapshot',
                            'restore_bookmark_snapshot')
        ORDER BY p.proname, args`,
    );
    // One definition each (no overload accepting a snapshot id), with only these inputs.
    expect(signatures.rows).toEqual([
      {
        name: 'capture_bookmark_snapshot',
        args: 'p_article_id bigint, p_origin_feed_id bigint',
        types: ['bigint', 'bigint'],
      },
      { name: 'clear_bookmark_snapshot', args: 'p_article_id bigint', types: ['bigint'] },
      {
        name: 'restore_bookmark_snapshot',
        args: 'p_article_id bigint, p_mutation_id uuid',
        types: ['bigint', 'uuid'],
      },
    ]);

    // Direct API writes can neither choose a binding or status nor write archives.
    const { user, feedId, article, saved } = await savedBookmark();
    const other = await createArticle(ctx.owner, { feedIds: [feedId] });
    const denied: [string, unknown[]][] = [
      ['UPDATE user_article SET bookmark_snapshot_id = $1', [saved.snapshot_id]],
      ["UPDATE user_article SET bookmark_capture_status = 'saved'", []],
      ['UPDATE user_article SET bookmark_capture_generation = 0', []],
      ["UPDATE article_snapshots SET body_text = 'forged' WHERE id = $1", [saved.snapshot_id]],
      [
        `INSERT INTO article_snapshots (article_id, source_revision, title, content_sha256,
                                        completeness, source, extractor_version)
         VALUES ($1, 1, 'forged', 'x', 'complete', 'page', 'x')`,
        [other.id],
      ],
    ];
    for (const [text, values] of denied) {
      expect(await apiError(user.id, text, values)).toBe('42501');
    }
    // bookmarked_at alone can neither create nor remove a bookmark (status/binding pair checks).
    expect(
      await apiError(
        user.id,
        'INSERT INTO user_article (user_id, article_id, bookmarked_at) VALUES ($1, $2, now())',
        [user.id, other.id],
      ),
    ).toBe('23514');
    expect(
      await apiError(
        user.id,
        'UPDATE user_article SET bookmarked_at = NULL WHERE article_id = $1',
        [article.id],
      ),
    ).toBe('23514');
    expect(await readerState(user.id, article.id)).toMatchObject({
      snapshot_id: saved.snapshot_id,
      status: 'saved',
      generation: '1',
    });
  });

  it("keeps saved copies per account: invisible to others, surviving another account's deletion and unsubscribe", async () => {
    const feed = await createFeed(ctx.owner);
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: a.id, feedId: feed.id });
    await createSubscription(ctx.owner, { userId: b.id, feedId: feed.id });
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const kept = { text: 'Kept text', html: '<p>Kept text</p>' };
    await setBody(article.id, article.contentRevision, { ...kept, completeness: 'complete' });

    const { snapshot_id: id } = await capture(a.id, article.id);
    // B reads the article through its own subscription, but not A's saved copy or reader row.
    expect(await visibleSnapshots(b.id)).toEqual([]);
    expect(
      await tenantRows(ctx.appPool, b.id, 'SELECT 1 FROM user_article WHERE user_id = $1', [a.id]),
    ).toEqual([]);
    expect((await capture(b.id, article.id)).snapshot_id).toBe(id);

    // Hard account deletion releases A's references; B's saved copy remains.
    await ctx.owner.query('DELETE FROM users WHERE id = $1', [a.id]);
    expect(await readerState(a.id, article.id)).toBeUndefined();
    expect(await readerState(b.id, article.id)).toMatchObject({ snapshot_id: id, status: 'saved' });
    expect(await visibleSnapshots(b.id)).toEqual([id]);
    expect(await snapshot(id)).toMatchObject({
      body_text: kept.text,
      body_html: kept.html,
      completeness: 'complete',
      unreferenced_at: null,
    });

    // B unsubscribes: the owned bookmark still grants access and keeps its origin.
    await ctx.owner.query('DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2', [
      b.id,
      feed.id,
    ]);
    expect(await visibleSnapshots(b.id)).toEqual([id]);
    expect(await capture(b.id, article.id, feed.id)).toEqual(bound(id, 'saved', 2));
    // The referenced archive keeps its article from deletion.
    expect(
      await sqlStateOf(ctx.owner.query('DELETE FROM articles WHERE id = $1', [article.id])),
    ).toBe('23503');
  });
});

describe('exact bookmark undo (restore_bookmark_snapshot as bantoozi_app)', () => {
  it('restores the exact snapshot, bookmark time and origin from the unexpired receipt and pin', async () => {
    const { user, feedId, article, saved } = await savedBookmark();
    const receipt = await unbookmarkWithReceipt(user.id, article.id);
    expect(receipt.snapshotId).toBe(saved.snapshot_id);
    expect(receipt.before).toMatchObject({
      snapshot_id: saved.snapshot_id,
      origin_feed_id: feedId,
      status: 'saved',
      generation: '1',
      state_version: '0',
    });
    expect(receipt.stateVersion).toBe('1');
    // The undo pin is a live reference (attaching it clears the unreferenced marker) and keeps the
    // exact copy readable to its owner through the undo window.
    expect((await snapshot(saved.snapshot_id)).unreferenced_at).toBeNull();
    expect(await visibleSnapshots(user.id)).toEqual([saved.snapshot_id]);

    // The source changes meanwhile: undo restores the original binding, never a fresh capture.
    await ctx.owner.query('UPDATE articles SET content_revision = 2 WHERE id = $1', [article.id]);
    await setBody(article.id, '2', { text: 'Rewritten body', completeness: 'complete' });

    expect(await restore(user.id, article.id, receipt.mutationId)).toEqual(
      bound(saved.snapshot_id, 'saved', 3),
    );
    expect(await readerState(user.id, article.id)).toEqual({
      ...receipt.before,
      generation: '3',
      state_version: receipt.stateVersion,
    });
    expect(await snapshot(saved.snapshot_id)).toMatchObject({
      source_revision: '1',
      body_text: 'Saved body',
      unreferenced_at: null,
    });
    expect(await captureIntents(article.id)).toEqual([]);
    // A receipt applies once: the bookmark is present again.
    expect(await sqlStateOf(restore(user.id, article.id, receipt.mutationId))).toBe('BZ409');
  });

  it('restoring a pending bookmark keeps its partial binding and queues local capture again', async () => {
    const { user, feedId } = await subscribedReader();
    const article = await createArticle(ctx.owner, { feedIds: [feedId], excerpt: 'Teaser' });
    const pending = await capture(user.id, article.id);
    expect(pending.capture_status).toBe('pending');
    // The relay has delivered the first intent.
    await ctx.owner.query(
      `UPDATE job_outbox SET delivered_at = now()
        WHERE queue = 'article.capture-bookmark' AND payload->>'articleId' = $1`,
      [article.id],
    );
    const receipt = await unbookmarkWithReceipt(user.id, article.id);
    expect(await restore(user.id, article.id, receipt.mutationId)).toEqual(
      bound(pending.snapshot_id, 'pending', 3),
    );
    const intents = await captureIntents(article.id);
    expect(intents).toHaveLength(2);
    expect(intents[1]).toEqual({
      queue: 'article.capture-bookmark',
      payload: { articleId: article.id },
      dedupe_key: captureDedupeKey(article),
      user_id: user.id,
      delivered_at: null,
    });
  });

  it('rejects an expired pin (BZ409) and leaves the bookmark cleared', async () => {
    const { user, article } = await savedBookmark();
    const receipt = await unbookmarkWithReceipt(user.id, article.id);
    await ctx.owner.query(
      `UPDATE bookmark_snapshot_pins SET expires_at = now() - interval '1 second'
        WHERE user_id = $1 AND mutation_id = $2`,
      [user.id, receipt.mutationId],
    );
    expect(await sqlStateOf(restore(user.id, article.id, receipt.mutationId))).toBe('BZ409');
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked_at: null,
      snapshot_id: null,
      generation: '2',
    });
    expect(await visibleSnapshots(user.id)).toEqual([]);
  });

  it("rejects unknown, expired, mismatched and other tenants' receipts (BZ404) and pins of another article (BZ409)", async () => {
    const a = await savedBookmark();
    const u = a.user.id;
    // B has its own reader row for the same article (bookmarked and cleared, no receipt).
    const b = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.feedId });
    await capture(b.id, a.article.id);
    await clear(b.id, a.article.id);
    const receipt = await unbookmarkWithReceipt(u, a.article.id);

    expect(await sqlStateOf(restore(u, a.article.id, randomUUID()))).toBe('BZ404');
    expect(await sqlStateOf(restore(b.id, a.article.id, receipt.mutationId))).toBe('BZ404');
    expect(await sqlStateOf(restore(u, '999999999', receipt.mutationId))).toBe('BZ404');

    // A receipt for one article never restores another.
    const second = await createArticle(ctx.owner, { feedIds: [a.feedId] });
    await setBody(second.id, second.contentRevision, { text: 'Second', completeness: 'complete' });
    const secondSaved = await capture(u, second.id);
    const secondReceipt = await unbookmarkWithReceipt(u, second.id);
    expect(await sqlStateOf(restore(u, a.article.id, secondReceipt.mutationId))).toBe('BZ404');
    // An expired receipt.
    await ctx.owner.query(
      `UPDATE api_mutations
          SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        WHERE user_id = $1 AND id = $2`,
      [u, secondReceipt.mutationId],
    );
    expect(await sqlStateOf(restore(u, second.id, secondReceipt.mutationId))).toBe('BZ404');

    // A pin naming another article's snapshot (a guessed id) is never bound.
    const third = await createArticle(ctx.owner, { feedIds: [a.feedId] });
    await setBody(third.id, third.contentRevision, { text: 'Third', completeness: 'complete' });
    await capture(u, third.id);
    const forged = await unbookmarkWithReceipt(u, third.id, secondSaved.snapshot_id);
    expect(await sqlStateOf(restore(u, third.id, forged.mutationId))).toBe('BZ409');
    expect(await readerState(u, third.id)).toMatchObject({
      bookmarked_at: null,
      snapshot_id: null,
    });

    // The refused attempts changed nothing: B stays unbookmarked, A's own receipt still restores.
    expect(await readerState(b.id, a.article.id)).toMatchObject({
      bookmarked_at: null,
      snapshot_id: null,
    });
    expect(await restore(u, a.article.id, receipt.mutationId)).toEqual(
      bound(a.saved.snapshot_id, 'saved', 3),
    );
    expect(await readerState(b.id, a.article.id)).toMatchObject({ bookmarked_at: null });
  });

  it('rejects the undo when the reader state changed since the unbookmark (BZ409)', async () => {
    const { user, article } = await savedBookmark();
    const receipt = await unbookmarkWithReceipt(user.id, article.id);
    // Another device marks the article read: a newer reader version.
    await tenantRows(
      ctx.appPool,
      user.id,
      'UPDATE user_article SET read_at = now(), state_version = state_version + 1 WHERE article_id = $1',
      [article.id],
    );
    expect(await sqlStateOf(restore(user.id, article.id, receipt.mutationId))).toBe('BZ409');
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked_at: null,
      snapshot_id: null,
      generation: '2',
    });
  });

  it('rejects the undo when the article became inaccessible since the unbookmark (BZ409)', async () => {
    const { user, feedId, article } = await savedBookmark();
    const receipt = await unbookmarkWithReceipt(user.id, article.id);
    // The user unsubscribes within the undo window: no carrier and no bookmark grant access now.
    await ctx.owner.query('DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2', [
      user.id,
      feedId,
    ]);
    expect(await sqlStateOf(restore(user.id, article.id, receipt.mutationId))).toBe('BZ409');
    expect(await readerState(user.id, article.id)).toMatchObject({
      bookmarked_at: null,
      snapshot_id: null,
    });
  });
});

describe('rate_limit_hit (as bantoozi_app)', () => {
  type Hit = { allowed: boolean; retry_after_s: number };
  const hit = async (key: string | null, windowS: number | null, max: number | null) =>
    only(
      (
        await ctx.appPool.query<Hit>('SELECT * FROM rate_limit_hit($1, $2, $3)', [
          key,
          windowS,
          max,
        ])
      ).rows,
    );
  const allowed: Hit = { allowed: true, retry_after_s: 0 };
  const newKey = () => `test:${randomUUID()}`;
  /** Move a bucket's window start into the past (as elapsed time would). */
  const age = (key: string, seconds: number) =>
    ctx.owner.query(
      'UPDATE rate_limit_buckets SET window_start = window_start - make_interval(secs => $2) WHERE key = $1',
      [key, seconds],
    );

  it('allows p_max hits per window, then reports the remaining window', async () => {
    const key = newKey();
    for (let i = 0; i < 3; i += 1) expect(await hit(key, 60, 3)).toEqual(allowed);
    const blocked = await hit(key, 60, 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_s).toBeGreaterThanOrEqual(1);
    expect(blocked.retry_after_s).toBeLessThanOrEqual(60);
    // Keys are independent.
    expect(await hit(newKey(), 60, 3)).toEqual(allowed);
    // Later in the same window the hint shrinks to what is left of it.
    await age(key, 50);
    const later = await hit(key, 60, 3);
    expect(later.allowed).toBe(false);
    expect(later.retry_after_s).toBeGreaterThanOrEqual(1);
    expect(later.retry_after_s).toBeLessThanOrEqual(10);
  });

  it('starts a new window once the old one has ended', async () => {
    const key = newKey();
    expect(await hit(key, 60, 1)).toEqual(allowed);
    expect((await hit(key, 60, 1)).allowed).toBe(false);
    await age(key, 60);
    expect(await hit(key, 60, 1)).toEqual(allowed);
    const bucket = await ctx.owner.query(
      `SELECT hits, window_start > now() - interval '30 seconds' AS fresh
         FROM rate_limit_buckets WHERE key = $1`,
      [key],
    );
    expect(bucket.rows).toEqual([{ hits: 1, fresh: true }]);
    expect((await hit(key, 60, 1)).allowed).toBe(false);
  });

  it('rejects invalid arguments (22023)', async () => {
    const invalid: [string | null, number | null, number | null][] = [
      [null, 60, 1],
      ['', 60, 1],
      ['k'.repeat(513), 60, 1],
      ['k', null, 1],
      ['k', 0, 1],
      ['k', 604_801, 1],
      ['k', 60, null],
      ['k', 60, 0],
    ];
    for (const [key, windowS, max] of invalid) {
      expect(await sqlStateOf(hit(key, windowS, max))).toBe('22023');
    }
    // The bounds themselves are accepted.
    expect(await hit(newKey().padEnd(512, 'k'), 604_800, 1)).toEqual(allowed);
  });

  it('is executable only by the API role, which has no direct bucket privilege', async () => {
    const worker = ctx.workerPool.query("SELECT * FROM rate_limit_hit('k', 60, 1)");
    expect(await sqlStateOf(worker)).toBe('42501');
    for (const statement of [
      'SELECT * FROM rate_limit_buckets',
      "INSERT INTO rate_limit_buckets (key, window_start, hits) VALUES ('x', now(), 1)",
      'UPDATE rate_limit_buckets SET hits = 1',
      'DELETE FROM rate_limit_buckets',
    ]) {
      expect(await sqlStateOf(ctx.appPool.query(statement))).toBe('42501');
    }
  });
});

describe('record_card_translation (tenant accounting helper)', () => {
  type Args = [string | null, number | null, number | null, string | null, string | null];
  const record = (pool: pg.Pool, userId: string | null, args: Args) =>
    tenantRows(pool, userId, 'SELECT record_card_translation($1, $2, $3, $4, $5)', args);

  type Call = {
    engine: string;
    kind: string;
    model: string | null;
    article_id: string | null;
    card_ids: string[] | null;
    reservation_id: string | null;
    user_id: string | null;
    n_questions: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: string;
    billing: string;
    latency_ms: number | null;
    attempts: number;
    status: string;
    error: string | null;
  };
  const calls = async (logicalRequestId: string): Promise<Call[]> =>
    (
      await ctx.owner.query<Call>(
        `SELECT engine, kind, model, article_id::text AS article_id, card_ids::text[] AS card_ids,
                reservation_id::text AS reservation_id, user_id::text AS user_id, n_questions,
                input_tokens, output_tokens, cost_usd::text AS cost_usd, billing, latency_ms,
                attempts, status, error
           FROM engine_calls WHERE logical_request_id = $1 ORDER BY attempts`,
        [logicalRequestId],
      )
    ).rows;
  /** Today's (UTC) libretranslate usage of `userId`. */
  const usage = async (userId: string) =>
    (
      await ctx.owner.query(
        `SELECT calls, cost_usd::text AS cost_usd FROM usage_daily
          WHERE user_id = $1 AND engine = 'libretranslate' AND kind = 'translate'
            AND day = (now() AT TIME ZONE 'UTC')::date`,
        [userId],
      )
    ).rows;
  const counted = (n: number) => [{ calls: n, cost_usd: '0.00000000' }];

  it('records one zero-cost audit row and one usage call per logical request attempt', async () => {
    const user = await createUser(ctx.owner);
    const logical = randomUUID();
    await record(ctx.appPool, user.id, [logical, 1, 120, 'ok', null]);
    const first: Call = {
      engine: 'libretranslate',
      kind: 'translate',
      model: null,
      article_id: null,
      card_ids: null,
      reservation_id: null,
      user_id: user.id,
      n_questions: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: '0.00000000',
      billing: 'known',
      latency_ms: 120,
      attempts: 1,
      status: 'ok',
      error: null,
    };
    expect(await calls(logical)).toEqual([first]);
    expect(await usage(user.id)).toEqual(counted(1));

    // A duplicate of the same logical request/attempt changes nothing.
    await record(ctx.appPool, user.id, [logical, 1, 999, 'error', 'timeout']);
    expect(await calls(logical)).toEqual([first]);
    expect(await usage(user.id)).toEqual(counted(1));

    // A second attempt is its own audit row and counts again.
    await record(ctx.appPool, user.id, [logical, 2, 450, 'error', 'http_5xx']);
    expect(await calls(logical)).toEqual([
      first,
      { ...first, latency_ms: 450, attempts: 2, status: 'error', error: 'http_5xx' },
    ]);
    expect(await usage(user.id)).toEqual(counted(2));
  });

  it('validates status, error code, attempt, latency and request id (22023)', async () => {
    const user = await createUser(ctx.owner);
    const invalid: Args[] = [
      [randomUUID(), 1, 10, 'bogus', null],
      [randomUUID(), 1, 10, null, null],
      [randomUUID(), 1, 10, 'ok', 'timeout'],
      [randomUUID(), 1, 10, 'error', 'connect ECONNREFUSED 10.0.0.7:5000'],
      [randomUUID(), 0, 10, 'ok', null],
      [randomUUID(), 11, 10, 'ok', null],
      [randomUUID(), null, 10, 'ok', null],
      [randomUUID(), 1, -1, 'ok', null],
      [randomUUID(), 1, 600_001, 'ok', null],
      [randomUUID(), 1, null, 'ok', null],
      [null, 1, 10, 'ok', null],
    ];
    for (const args of invalid) {
      expect(await sqlStateOf(record(ctx.appPool, user.id, args))).toBe('22023');
    }
    expect(await usage(user.id)).toEqual([]);
  });

  it('requires an active tenant (42501), and the audit table stays private', async () => {
    const user = await createUser(ctx.owner);
    const deleted = await createUser(ctx.owner, { deletedAt: new Date() });
    for (const tenant of [null, randomUUID(), deleted.id]) {
      const args: Args = [randomUUID(), 1, 10, 'ok', null];
      expect(await sqlStateOf(record(ctx.appPool, tenant, args))).toBe('42501');
    }
    expect(await apiError(user.id, 'SELECT * FROM engine_calls')).toBe('42501');
    expect(
      await apiError(
        user.id,
        `INSERT INTO engine_calls (engine, kind, logical_request_id, status)
         VALUES ('libretranslate', 'translate', gen_random_uuid(), 'ok')`,
      ),
    ).toBe('42501');
    expect(await usage(deleted.id)).toEqual([]);
  });

  it('is callable by the worker role inside a tenant context', async () => {
    const user = await createUser(ctx.owner);
    const logical = randomUUID();
    await record(ctx.workerPool, user.id, [logical, 1, 80, 'timeout', 'timeout']);
    expect(await calls(logical)).toEqual([
      expect.objectContaining({
        user_id: user.id,
        engine: 'libretranslate',
        kind: 'translate',
        cost_usd: '0.00000000',
        status: 'timeout',
        error: 'timeout',
      }),
    ]);
    expect(await usage(user.id)).toEqual(counted(1));
    const args: Args = [randomUUID(), 1, 80, 'ok', null];
    expect(await sqlStateOf(record(ctx.workerPool, null, args))).toBe('42501');
  });
});

describe('admin statistics functions', () => {
  type Holder = { card_id: string; holders: number };
  type Attribution = { user_id: string; direct_usd: string; shared_usd: string };

  const cardHolders = (pool: pg.Pool, userId: string | null, cardIds: string[]) =>
    tenantRows<Holder>(
      pool,
      userId,
      `SELECT h.card_id::text AS card_id, h.holders FROM admin_card_holders($1::bigint[]) h
        ORDER BY h.card_id`,
      [cardIds],
    );
  const attribution = (pool: pg.Pool, userId: string | null, days: number | null) =>
    tenantRows<Attribution>(
      pool,
      userId,
      `SELECT a.user_id::text AS user_id, a.direct_usd::text AS direct_usd,
              a.shared_usd::text AS shared_usd
         FROM admin_usage_attribution($1) a ORDER BY a.user_id`,
      [days],
    );

  let admin: UserFixture;
  let deletedAdmin: UserFixture;
  let member: UserFixture;
  let u1: UserFixture;
  let u2: UserFixture;
  let u3: UserFixture;
  let c1: CardFixture;
  let c2: CardFixture;
  let c3: CardFixture;
  let l1: CardFixture;
  let feedId: string;

  beforeAll(async () => {
    admin = await createUser(ctx.owner, { role: 'admin' });
    deletedAdmin = await createUser(ctx.owner, { role: 'admin', deletedAt: new Date() });
    member = await createUser(ctx.owner);
    u1 = await createUser(ctx.owner);
    u2 = await createUser(ctx.owner);
    u3 = await createUser(ctx.owner, { deletedAt: new Date() });
    feedId = (await createFeed(ctx.owner)).id;
    for (const u of [u1, u2, u3]) {
      await createSubscription(ctx.owner, { userId: u.id, feedId, mode: 'active' });
    }
    c1 = await createCard(ctx.owner);
    c2 = await createCard(ctx.owner);
    c3 = await createCard(ctx.owner);
    l1 = await createCard(ctx.owner, { kind: 'label' });
    // Holdings: c1 by u1, u2 and the soft-deleted u3; c2 by u2 (scoped to the feed); label l1 by u1, u2.
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id)
       VALUES ($1, $4, 'like', NULL), ($2, $4, 'love', NULL), ($3, $4, 'like', NULL),
              ($2, $5, 'must', $6)`,
      [u1.id, u2.id, u3.id, c1.id, c2.id, feedId],
    );
    await ctx.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $3, 'Later'), ($2, $3, 'Later')`,
      [u1.id, u2.id, l1.id],
    );
    await ctx.workerPool.query('SELECT refresh_feed_cards($1::bigint[])', [[feedId]]);
    // usage_daily: direct user rows, platform match rows (one 45 days old) and a platform non-match
    // row that is never shared.
    await ctx.owner.query(
      `INSERT INTO usage_daily (day, user_id, engine, kind, calls, cost_usd)
       SELECT (now() AT TIME ZONE 'UTC')::date - v.age, v.user_id::uuid, v.engine, v.kind, 1, v.cost
         FROM (VALUES (0, $1, 'typesafe', 'enrich', 0.25), (3, $1, 'llm', 'suggest', 0.5),
                      (40, $1, 'llm', 'suggest', 10), (0, $2, 'typesafe', 'suggest', 0.1),
                      (0, $3, 'typesafe', 'match', 1.2), (2, $3, 'llm', 'match', 0.3),
                      (45, $3, 'typesafe', 'match', 9), (0, $3, 'typesafe', 'enrich', 5))
              AS v(age, user_id, engine, kind, cost)`,
      [u1.id, u2.id, PLATFORM_USER],
    );
  });

  it('admin_context_allowed is not executable by the API role', async () => {
    expect(await sqlStateOf(ctx.appPool.query('SELECT admin_context_allowed()'))).toBe('42501');
    expect(await apiError(admin.id, 'SELECT admin_context_allowed()')).toBe('42501');
  });

  it('return no rows to a non-admin, deleted-admin or tenant-less API session', async () => {
    for (const tenant of [member.id, u1.id, deletedAdmin.id, null]) {
      expect(await cardHolders(ctx.appPool, tenant, [c1.id, l1.id])).toEqual([]);
      expect(await attribution(ctx.appPool, tenant, 30)).toEqual([]);
    }
  });

  it('admin_card_holders counts active interest and label holders for an admin tenant and the worker', async () => {
    // The soft-deleted holder's row exists but is not counted.
    const held = await ctx.owner.query('SELECT 1 FROM user_cards WHERE card_id = $1', [c1.id]);
    expect(held.rowCount).toBe(3);
    const expected: Holder[] = [
      { card_id: c1.id, holders: 2 },
      { card_id: c2.id, holders: 1 },
      { card_id: c3.id, holders: 0 },
      { card_id: l1.id, holders: 2 },
    ];
    const ids = [c1.id, c2.id, c3.id, l1.id];
    expect(await cardHolders(ctx.appPool, admin.id, ids)).toEqual(expected);
    expect(await cardHolders(ctx.workerPool, null, ids)).toEqual(expected);
  });

  it('admin_usage_attribution splits direct and shared cost for an admin tenant and the worker', async () => {
    const cards = await ctx.owner.query(
      'SELECT card_id::text AS card_id, holders FROM feed_cards WHERE feed_id = $1 ORDER BY card_id',
      [feedId],
    );
    expect(cards.rows).toEqual([
      { card_id: c1.id, holders: 2 },
      { card_id: c2.id, holders: 1 },
      { card_id: l1.id, holders: 2 },
    ]);
    const total = await ctx.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM feed_cards');
    const n = total.rows[0]?.n ?? 0;
    // Σ 1/holders over each user's (feed, card) holdings: u1 ½ + ½, u2 ½ + 1 + ½.
    const shares: Record<string, number> = { [u1.id]: 1, [u2.id]: 2 };

    const check = async (days: number, direct: [string, string], platformMatchUsd: number) => {
      const rows = await attribution(ctx.appPool, admin.id, days);
      expect(await attribution(ctx.workerPool, null, days)).toEqual(rows);
      const ours = rows.filter((r) => [u1.id, u2.id, u3.id].includes(r.user_id));
      expect(ours.map((r) => r.user_id).sort()).toEqual([u1.id, u2.id].sort());
      for (const row of ours) {
        expect(row.direct_usd).toBe(row.user_id === u1.id ? direct[0] : direct[1]);
        const share = shares[row.user_id] ?? 0;
        expect(Number(row.shared_usd)).toBeCloseTo((share * platformMatchUsd) / n, 10);
      }
      // The platform match cost is split completely among the current active holders.
      const sharedTotal = rows.reduce((sum, r) => sum + Number(r.shared_usd), 0);
      expect(sharedTotal).toBeCloseTo(platformMatchUsd, 10);
    };
    await check(30, ['0.75000000', '0.10000000'], 1.5);
    await check(1, ['0.25000000', '0.10000000'], 1.2);
    await check(366, ['10.75000000', '0.10000000'], 10.5);
  });

  it('admin_usage_attribution returns no rows for an invalid p_days', async () => {
    for (const days of [0, -1, 367, null]) {
      expect(await attribution(ctx.workerPool, null, days)).toEqual([]);
      expect(await attribution(ctx.appPool, admin.id, days)).toEqual([]);
    }
  });
});

describe('function catalog', () => {
  it('SECURITY DEFINER owner functions with a fixed search path, no PUBLIC execute and the spec grants', async () => {
    const grants: Record<string, { app: boolean; worker: boolean }> = {
      'capture_bookmark_snapshot(bigint,bigint)': { app: true, worker: false },
      'clear_bookmark_snapshot(bigint)': { app: true, worker: false },
      'restore_bookmark_snapshot(bigint,uuid)': { app: true, worker: false },
      'rate_limit_hit(text,integer,integer)': { app: true, worker: false },
      'record_card_translation(uuid,integer,integer,text,text)': { app: true, worker: true },
      'admin_card_holders(bigint[])': { app: true, worker: true },
      'admin_usage_attribution(integer)': { app: true, worker: true },
      'admin_context_allowed()': { app: false, worker: false },
    };
    const result = await ctx.owner.query(
      `SELECT f AS fn, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
              p.proconfig AS config, has_function_privilege('public', f, 'EXECUTE') AS public,
              has_function_privilege('bantoozi_app', f, 'EXECUTE') AS app,
              has_function_privilege('bantoozi_worker', f, 'EXECUTE') AS worker
         FROM unnest($1::text[]) AS f JOIN pg_proc p ON p.oid = f::regprocedure
        ORDER BY f COLLATE "C"`,
      [Object.keys(grants)],
    );
    expect(result.rows).toEqual(
      Object.entries(grants)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([fn, roles]) => ({
          fn,
          definer: true,
          owner: 'bantoozi_owner',
          config: ['search_path=pg_catalog, public, pg_temp'],
          public: false,
          ...roles,
        })),
    );
  });
});
