import { randomUUID } from 'node:crypto';

import { planMinIntervalMap } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eligibleInferenceDemand, type InferenceWitness } from '../../src/ingest/demand.js';
import { resolveLiveFeedId } from '../../src/ingest/feeds.js';
import {
  applyPermanentRedirect,
  mergeFeeds,
  type FeedMergeResult,
  type PermanentRedirectResult,
} from '../../src/ingest/merge-feeds.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, withConnection, type DbTestContext } from '../support/test-db.js';

/**
 * Permanent feed redirects and feed identity merges (M1-T7 lane C; spec 03 §9, spec 02 §3.3–§3.5,
 * §4, §6) against a real migrated database as the worker role.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const byNumber = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

type Mode = 'off' | 'training' | 'active';

async function subscribe(
  userId: string,
  feedId: string,
  options: {
    mode?: Mode;
    version?: number;
    activatedAt?: Date;
    title?: string | null;
    folder?: string | null;
    hidden?: boolean;
    allowDuplicates?: boolean;
    createdAt?: Date;
  } = {},
): Promise<void> {
  const mode = options.mode ?? 'off';
  await ctx.owner.query(
    `INSERT INTO subscriptions (user_id, feed_id, title_override, folder, hidden, allow_duplicates,
                                inference_mode, inference_version, inference_activated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()))`,
    [
      userId,
      feedId,
      options.title ?? null,
      options.folder ?? null,
      options.hidden ?? false,
      options.allowDuplicates ?? false,
      mode,
      options.version ?? (mode === 'off' ? 0 : 1),
      mode === 'active' ? (options.activatedAt ?? new Date()) : null,
      options.createdAt ?? null,
    ],
  );
}

async function carry(
  feedId: string,
  articleId: string,
  guid: string | null,
  firstSeenAt: Date,
): Promise<void> {
  await ctx.owner.query(
    'INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, $3, $4)',
    [feedId, articleId, guid, firstSeenAt],
  );
}

/** A selected-article request created as its tenant (the insert trigger checks authorization). */
async function analysisRequest(input: {
  userId: string;
  feedId: string;
  articleId: string;
  version: number;
  status?: 'pending' | 'running' | 'complete';
}): Promise<string> {
  const id = randomUUID();
  await withConnection(ctx.owner, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.user_id', $1, true)", [input.userId]);
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         VALUES ($1, $2, $3, $4, 1, $5, '{"article":"frozen"}',
                 encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex'))`,
        [id, input.userId, input.feedId, input.articleId, input.version],
      );
      if (input.status === 'running') {
        await client.query(
          `UPDATE analysis_requests SET status = 'running', lease_token = gen_random_uuid(),
                  lease_until = now() + interval '5 minutes', attempts = 1 WHERE id = $1`,
          [id],
        );
      } else if (input.status === 'complete') {
        await client.query(
          `UPDATE analysis_requests SET status = 'complete', result_snapshot = '{"p":0.9}',
                  result_sha = 'result-sha', completed_at = now() - interval '1 day', attempts = 1
            WHERE id = $1`,
          [id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return id;
}

async function refreshBoth(feedIds: readonly string[]): Promise<void> {
  await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    feedIds,
    JSON.stringify(planMinIntervalMap()),
  ]);
  await ctx.workerPool.query('SELECT refresh_feed_cards($1::bigint[])', [feedIds]);
}

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

const redirect = (feedId: string, canonicalUrl: string, fetchUrl = canonicalUrl) =>
  ctx.worker.transaction((tx) =>
    applyPermanentRedirect(tx, workerOutbox(tx), feedId, { canonicalUrl, fetchUrl }),
  );

const merge = (sourceId: string, targetId: string) =>
  ctx.worker.transaction((tx) => mergeFeeds(tx, workerOutbox(tx), sourceId, targetId));

/** Resolve once some session of this database waits for a lock (fails after ~5 s). */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const waiting = await ctx.adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no session started waiting for a lock');
}

async function feedRow(feedId: string) {
  const result = await ctx.owner.query(
    `SELECT url, fetch_url, merged_into_id::text AS merged_into_id, status, etag, last_modified,
            subscriber_count, updated_at
       FROM feeds WHERE id = $1`,
    [feedId],
  );
  return result.rows[0] as {
    url: string;
    fetch_url: string;
    merged_into_id: string | null;
    status: string;
    etag: string | null;
    last_modified: string | null;
    subscriber_count: number;
    updated_at: Date;
  };
}

describe('applyPermanentRedirect without another feed (spec 03 §9)', () => {
  it('renames the canonical URL and fetches the redirect target', async () => {
    const feed = await createFeed(ctx.owner);
    const canonical = `${feed.url.replace('.xml', '')}-moved.xml`;
    const signed = `${canonical}?utm_source=rss&sig=abc`;
    expect(await redirect(feed.id, canonical, signed)).toEqual({
      kind: 'renamed',
      url: canonical,
      fetchUrl: signed,
    });
    expect(await feedRow(feed.id)).toMatchObject({
      url: canonical,
      fetch_url: signed,
      status: 'active',
    });
    // The same redirect again changes nothing; a new fetch URL for the same identity is followed.
    expect(await redirect(feed.id, canonical, signed)).toEqual({ kind: 'unchanged' });
    expect(await redirect(feed.id, canonical, `${canonical}?sig=def`)).toEqual({
      kind: 'renamed',
      url: canonical,
      fetchUrl: `${canonical}?sig=def`,
    });
  });

  it('leaves tombstones and missing feeds alone', async () => {
    const survivor = await createFeed(ctx.owner);
    const tombstone = await createFeed(ctx.owner);
    await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
      tombstone.id,
      survivor.id,
    ]);
    expect(await redirect(tombstone.id, 'https://feeds.example.test/elsewhere.xml')).toEqual({
      kind: 'unchanged',
    });
    expect(await feedRow(tombstone.id)).toMatchObject({ url: tombstone.url });
    expect(await redirect('999999999', 'https://feeds.example.test/nowhere.xml')).toEqual({
      kind: 'unchanged',
    });
  });

  it('merges instead when another feed takes the URL while the rename waits', async () => {
    const feed = await createFeed(ctx.owner);
    const contested = `https://feeds.example.test/contested-${randomUUID()}.xml`;
    const inserter = await ctx.owner.connect();
    try {
      await inserter.query('BEGIN');
      const inserted = await inserter.query<{ id: string }>(
        'INSERT INTO feeds (url, fetch_url) VALUES ($1, $1) RETURNING id::text AS id',
        [contested],
      );
      const pending = redirect(feed.id, contested);
      // Wait until the rename blocks on the uncommitted row's unique index entry.
      await waitForLockWait();
      await inserter.query('COMMIT');
      const result = await pending;
      expect(result).toMatchObject({ kind: 'merged', survivorId: inserted.rows[0]?.id });
      expect(await feedRow(feed.id)).toMatchObject({
        merged_into_id: inserted.rows[0]?.id,
        status: 'dead',
      });
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined);
      inserter.release();
    }
  });
});

describe('applyPermanentRedirect onto an existing feed: the identity merge (spec 03 §9)', () => {
  // Fixture ids, filled by beforeAll: feeds, users, articles, cards and analysis requests.
  type Ids<K extends string> = Record<K, string>;
  const f = {} as Record<'source' | 'target', { id: string; url: string }>;
  const u = {} as Ids<'off' | 'active' | 'dup' | 'dup2' | 'target' | 'prefOnly'>;
  const a = {} as Ids<
    'onlySource' | 'both' | 'bothGuids' | 'clash' | 'established' | 'recentOnTarget' | 'saved'
  >;
  const c = {} as Ids<'active' | 'dup' | 'target' | 'shared'>;
  const r = {} as Ids<'complete' | 'running' | 'targetPending' | 'untouched'>;
  const at = {
    activeActivated: daysAgo(10),
    dupSourceActivated: daysAgo(5),
    dupTargetActivated: daysAgo(2),
    dup2TargetActivated: daysAgo(20),
    targetActivated: daysAgo(30),
    onlySource: daysAgo(3),
    bothSource: daysAgo(4),
    bothTarget: daysAgo(1),
    bothGuidsSource: daysAgo(1),
    bothGuidsTarget: daysAgo(2),
    clash: daysAgo(3),
    established: daysAgo(6),
    recent: hoursAgo(6),
    saved: daysAgo(9),
  };
  let result: PermanentRedirectResult;
  let merged: FeedMergeResult;
  let demandBefore: InferenceWitness[];
  let targetFetchUrl: string;

  beforeAll(async () => {
    const source = await createFeed(ctx.owner);
    const target = await createFeed(ctx.owner);
    f.source = source;
    f.target = target;
    await ctx.owner.query(
      `UPDATE feeds SET etag = 'W/"s1"', last_modified = 'Mon, 21 Sep 2026 10:00:00 GMT' WHERE id = $1`,
      [source.id],
    );
    targetFetchUrl = target.url;

    for (const key of ['off', 'active', 'dup', 'dup2', 'target', 'prefOnly'] as const) {
      u[key] = (await createUser(ctx.owner)).id;
    }
    await subscribe(u.off, source.id, {
      mode: 'off',
      title: 'My source',
      folder: 'News',
      hidden: true,
      allowDuplicates: true,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    await subscribe(u.active, source.id, {
      mode: 'active',
      version: 3,
      activatedAt: at.activeActivated,
    });
    await subscribe(u.dup, source.id, {
      mode: 'active',
      version: 2,
      activatedAt: at.dupSourceActivated,
      title: 'Source title',
      folder: 'Source folder',
      hidden: true,
      allowDuplicates: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
    await subscribe(u.dup, target.id, {
      mode: 'active',
      version: 4,
      activatedAt: at.dupTargetActivated,
      title: 'Target title',
      folder: 'Target folder',
      hidden: false,
      allowDuplicates: false,
      createdAt: new Date('2025-06-01T00:00:00Z'),
    });
    await subscribe(u.dup2, source.id, {
      mode: 'training',
      version: 1,
      hidden: false,
      createdAt: new Date('2025-03-01T00:00:00Z'),
    });
    await subscribe(u.dup2, target.id, {
      mode: 'active',
      version: 1,
      activatedAt: at.dup2TargetActivated,
      hidden: true,
      createdAt: new Date('2025-02-01T00:00:00Z'),
    });
    await subscribe(u.target, target.id, {
      mode: 'active',
      version: 1,
      activatedAt: at.targetActivated,
    });

    // Cards: scoped to the source (must survive the subscription move), unscoped and shared.
    for (const key of ['active', 'dup', 'target', 'shared'] as const) {
      c[key] = (await createCard(ctx.owner)).id;
    }
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES
         ($1, $2, 'like', $9), ($3, $4, 'love', $9), ($5, $6, 'like', NULL),
         ($1, $7, 'like', NULL), ($3, $7, 'like', NULL), ($8, $6, 'like', NULL)`,
      [u.active, c.active, u.dup, c.dup, u.target, c.target, c.shared, u.dup2, source.id],
    );

    // Items: source-only, carried by both (with and without GUIDs), a GUID clash, target-only.
    for (const key of [
      'onlySource',
      'both',
      'bothGuids',
      'clash',
      'established',
      'recentOnTarget',
      'saved',
    ] as const) {
      a[key] = (await createArticle(ctx.owner)).id;
    }
    await carry(source.id, a.onlySource, 'g-only', at.onlySource);
    await carry(source.id, a.both, 'g-both', at.bothSource);
    await carry(target.id, a.both, null, at.bothTarget);
    await carry(source.id, a.bothGuids, 'g-source', at.bothGuidsSource);
    await carry(target.id, a.bothGuids, 'g-target', at.bothGuidsTarget);
    await carry(source.id, a.clash, 'g-clash', at.clash);
    await carry(target.id, a.established, 'g-clash', at.established);
    await carry(target.id, a.recentOnTarget, 'g-recent', at.recent);
    await carry(source.id, a.saved, 'g-saved', at.saved);

    // Rules: a duplicate after re-pointing, a boost, and a keyword that merely looks like an id.
    await ctx.owner.query(
      `INSERT INTO user_rules (user_id, kind, value, expires_at) VALUES
         ($1, 'block_feed', $3, now() + interval '3 days'), ($1, 'block_feed', $4, NULL),
         ($2, 'boost_feed', $3, NULL), ($2, 'mute_keyword', $3, NULL)`,
      [u.dup, u.off, source.id, target.id],
    );

    // Image preferences: conflicts resolve to the stricter explicit choice.
    await ctx.owner.query(
      `INSERT INTO user_feed_preferences (user_id, feed_id, image_policy) VALUES
         ($1, $6, 'block'), ($1, $7, 'allow'), ($2, $6, 'allow'), ($3, $7, 'block'),
         ($4, $6, 'inherit'), ($4, $7, 'allow'), ($5, $6, 'block')`,
      [u.dup, u.off, u.target, u.dup2, u.prefOnly, source.id, target.id],
    );

    // A bookmark saved from the source.
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status,
                                 bookmark_origin_feed_id)
       VALUES ($1, $2, now(), 'pending', $3), ($4, $2, now(), 'pending', $3)`,
      [u.off, a.saved, source.id, u.prefOnly],
    );

    // Selected-article requests: history, a live lease, an old target generation, a bystander.
    r.complete = await analysisRequest({
      userId: u.dup2,
      feedId: source.id,
      articleId: a.onlySource,
      version: 1,
      status: 'complete',
    });
    r.running = await analysisRequest({
      userId: u.dup2,
      feedId: source.id,
      articleId: a.both,
      version: 1,
      status: 'running',
    });
    r.targetPending = await analysisRequest({
      userId: u.dup,
      feedId: target.id,
      articleId: a.recentOnTarget,
      version: 4,
    });
    r.untouched = await analysisRequest({
      userId: u.target,
      feedId: target.id,
      articleId: a.recentOnTarget,
      version: 1,
    });

    await refreshBoth([source.id, target.id]);
    demandBefore = await eligibleInferenceDemand(ctx.worker, a.onlySource);
    await clearOutbox();

    result = await redirect(source.id, target.url, `${target.url}?utm_source=redirect`);
    if (result.kind !== 'merged') throw new Error(`expected a merge, got ${result.kind}`);
    merged = result;
  });

  it('reports the survivor, the new associations, the affected users and GUID conflicts', () => {
    expect(merged.survivorId).toBe(f.target.id);
    expect(merged.movedArticleIds).toEqual([a.onlySource, a.clash, a.saved].sort(byNumber));
    expect(merged.affectedUserIds).toEqual([u.off, u.active, u.dup, u.dup2, u.target].sort());
    expect(merged.guidConflicts).toEqual([
      { guid: 'g-clash', keptArticleId: a.established, movedArticleId: a.clash },
    ]);
  });

  it('retires the source as a dead tombstone without validators', async () => {
    const source = await feedRow(f.source.id);
    expect(source).toMatchObject({
      merged_into_id: f.target.id,
      status: 'dead',
      etag: null,
      last_modified: null,
      subscriber_count: 0,
    });
    expect(await resolveLiveFeedId(ctx.worker, f.source.id)).toBe(f.target.id);
    // The survivor keeps its own identity and fetch URL.
    expect(await feedRow(f.target.id)).toMatchObject({
      url: f.target.url,
      fetch_url: targetFetchUrl,
      status: 'active',
      merged_into_id: null,
    });
  });

  it('moves and merges subscriptions without enabling inference', async () => {
    const rows = await ctx.owner.query(
      `SELECT user_id::text AS user_id, feed_id::text AS feed_id, title_override, folder, hidden,
              allow_duplicates, inference_mode, inference_version::int AS version,
              inference_activated_at, created_at
         FROM subscriptions WHERE feed_id = ANY($1::bigint[]) ORDER BY user_id`,
      [[f.source.id, f.target.id]],
    );
    const byUser = new Map(rows.rows.map((row) => [row.user_id as string, row]));
    expect(rows.rows.every((row) => row.feed_id === f.target.id)).toBe(true);
    expect(rows.rows).toHaveLength(5);
    const mergeTime = (await feedRow(f.source.id)).updated_at;

    // Source-only off: moved with its settings and a new version.
    expect(byUser.get(u.off)).toMatchObject({
      title_override: 'My source',
      folder: 'News',
      hidden: true,
      allow_duplicates: true,
      inference_mode: 'off',
      version: 1,
      inference_activated_at: null,
      created_at: new Date('2025-01-01T00:00:00Z'),
    });
    // Source-only active: a new version and a new activation boundary at the merge.
    expect(byUser.get(u.active)).toMatchObject({
      inference_mode: 'active',
      version: 4,
      inference_activated_at: mergeTime,
    });
    // Duplicates: target title/folder, earliest creation, hidden AND, duplicates OR, the more
    // restrictive mode, the later activation and a version beyond both.
    expect(byUser.get(u.dup)).toMatchObject({
      title_override: 'Target title',
      folder: 'Target folder',
      hidden: false,
      allow_duplicates: true,
      inference_mode: 'active',
      version: 5,
      inference_activated_at: at.dupTargetActivated,
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    expect(byUser.get(u.dup2)).toMatchObject({
      hidden: false,
      inference_mode: 'training',
      version: 2,
      inference_activated_at: null,
      created_at: new Date('2025-02-01T00:00:00Z'),
    });
    expect(byUser.get(u.target)).toMatchObject({ inference_mode: 'active', version: 1 });
  });

  it('restarts a moved activation: earlier items create no automatic demand for it', async () => {
    // Before the merge, the active source subscriber had automatic demand for its source item,
    // and the training subscriber's selected request authorized it too.
    expect(demandBefore).toEqual(
      expect.arrayContaining([
        { kind: 'automatic', userId: u.active, feedId: f.source.id, inferenceVersion: '3' },
        { kind: 'manual', analysisRequestId: r.complete },
      ]),
    );
    const automaticUsers = (witnesses: InferenceWitness[]) =>
      witnesses
        .filter((w) => w.kind === 'automatic')
        .map((w) => (w.kind === 'automatic' ? w.userId : ''))
        .sort();
    // The target's item that arrived before the merge: not for the moved subscription.
    const recent = await eligibleInferenceDemand(ctx.worker, a.recentOnTarget);
    expect(automaticUsers(recent)).toEqual([u.dup, u.target].sort());
    expect(recent).toContainEqual({ kind: 'manual', analysisRequestId: r.untouched });
    // A moved item that arrived before the merge is history for the moved subscription; the
    // old generation's selection no longer authorizes anything.
    expect(await eligibleInferenceDemand(ctx.worker, a.onlySource)).toEqual([
      { kind: 'automatic', userId: u.target, feedId: f.target.id, inferenceVersion: '1' },
    ]);
  });

  it('keeps and re-points scoped cards, and refreshes feed_cards and subscriber counts', async () => {
    const cards = await ctx.owner.query(
      `SELECT user_id::text AS user_id, card_id::text AS card_id, scope_feed_id::text AS scope
         FROM user_cards WHERE card_id = ANY($1::bigint[]) ORDER BY user_id, card_id`,
      [[c.active, c.dup]],
    );
    expect(cards.rows).toEqual(
      expect.arrayContaining([
        { user_id: u.active, card_id: c.active, scope: f.target.id },
        { user_id: u.dup, card_id: c.dup, scope: f.target.id },
      ]),
    );
    expect(cards.rows).toHaveLength(2);
    const feedCards = await ctx.owner.query(
      `SELECT feed_id::text AS feed_id, card_id::text AS card_id, holders FROM feed_cards
        WHERE feed_id = ANY($1::bigint[]) ORDER BY card_id`,
      [[f.source.id, f.target.id]],
    );
    expect(feedCards.rows).toEqual(
      [
        { feed_id: f.target.id, card_id: c.active, holders: 1 },
        { feed_id: f.target.id, card_id: c.dup, holders: 1 },
        { feed_id: f.target.id, card_id: c.target, holders: 1 },
        { feed_id: f.target.id, card_id: c.shared, holders: 2 },
      ].sort((x, y) => byNumber(x.card_id, y.card_id)),
    );
    expect(await feedRow(f.target.id)).toMatchObject({ subscriber_count: 5 });
  });

  it('re-points and deduplicates feed rules', async () => {
    const rules = await ctx.owner.query(
      `SELECT user_id::text AS user_id, kind, value, expires_at IS NULL AS permanent
         FROM user_rules WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, kind`,
      [[u.dup, u.off]],
    );
    expect(rules.rows).toEqual(
      expect.arrayContaining([
        { user_id: u.dup, kind: 'block_feed', value: f.target.id, permanent: true },
        { user_id: u.off, kind: 'boost_feed', value: f.target.id, permanent: true },
        { user_id: u.off, kind: 'mute_keyword', value: f.source.id, permanent: true },
      ]),
    );
    expect(rules.rows).toHaveLength(3);
  });

  it('remaps image preferences (block over allow over inherit) and bookmark origins', async () => {
    const prefs = await ctx.owner.query(
      `SELECT user_id::text AS user_id, feed_id::text AS feed_id, image_policy
         FROM user_feed_preferences WHERE feed_id = ANY($1::bigint[])`,
      [[f.source.id, f.target.id]],
    );
    expect(prefs.rows).toHaveLength(5);
    expect(prefs.rows).toEqual(
      expect.arrayContaining([
        { user_id: u.dup, feed_id: f.target.id, image_policy: 'block' },
        { user_id: u.off, feed_id: f.target.id, image_policy: 'allow' },
        { user_id: u.target, feed_id: f.target.id, image_policy: 'block' },
        { user_id: u.dup2, feed_id: f.target.id, image_policy: 'allow' },
        { user_id: u.prefOnly, feed_id: f.target.id, image_policy: 'block' },
      ]),
    );
    const bookmarks = await ctx.owner.query(
      `SELECT user_id::text AS user_id, bookmark_origin_feed_id::text AS origin
         FROM user_article WHERE article_id = $1 ORDER BY user_id`,
      [a.saved],
    );
    expect(bookmarks.rows).toEqual(
      [u.off, u.prefOnly].sort().map((userId) => ({ user_id: userId, origin: f.target.id })),
    );
  });

  it('moves selected requests, keeps completed history and cancels old generations', async () => {
    const requests = await ctx.owner.query(
      `SELECT id::text AS id, feed_id::text AS feed_id, status, lease_token, lease_until,
              completed_at IS NOT NULL AS finished, last_error_code, result_sha,
              completed_at < now() - interval '12 hours' AS old_completion
         FROM analysis_requests WHERE id = ANY($1::uuid[])`,
      [[r.complete, r.running, r.targetPending, r.untouched]],
    );
    const byId = new Map(requests.rows.map((row) => [row.id as string, row]));
    expect(byId.get(r.complete)).toMatchObject({
      feed_id: f.target.id,
      status: 'complete',
      result_sha: 'result-sha',
      last_error_code: null,
      old_completion: true,
    });
    for (const id of [r.running, r.targetPending]) {
      expect(byId.get(id)).toMatchObject({
        feed_id: f.target.id,
        status: 'cancelled',
        lease_token: null,
        lease_until: null,
        finished: true,
        last_error_code: 'feed_merged',
      });
    }
    expect(byId.get(r.untouched)).toMatchObject({ feed_id: f.target.id, status: 'pending' });
  });

  it('moves feed items: new associations, duplicates and GUID conflicts', async () => {
    const items = await ctx.owner.query(
      `SELECT article_id::text AS article_id, feed_id::text AS feed_id, guid, first_seen_at
         FROM feed_items WHERE feed_id = ANY($1::bigint[]) ORDER BY article_id`,
      [[f.source.id, f.target.id]],
    );
    expect(items.rows.every((row) => row.feed_id === f.target.id)).toBe(true);
    const byArticle = new Map(items.rows.map((row) => [row.article_id as string, row]));
    expect(items.rows).toHaveLength(7);
    // A new association keeps its arrival time and GUID.
    expect(byArticle.get(a.onlySource)).toMatchObject({
      guid: 'g-only',
      first_seen_at: at.onlySource,
    });
    expect(byArticle.get(a.saved)).toMatchObject({ guid: 'g-saved', first_seen_at: at.saved });
    // A duplicate keeps the earliest arrival and adopts the source GUID when it had none.
    expect(byArticle.get(a.both)).toMatchObject({ guid: 'g-both', first_seen_at: at.bothSource });
    // The first non-null GUID of the pair stays.
    expect(byArticle.get(a.bothGuids)).toMatchObject({
      guid: 'g-target',
      first_seen_at: at.bothGuidsTarget,
    });
    // A clash keeps both articles; only the survivor's established mapping keeps the GUID.
    expect(byArticle.get(a.clash)).toMatchObject({ guid: null, first_seen_at: at.clash });
    expect(byArticle.get(a.established)).toMatchObject({
      guid: 'g-clash',
      first_seen_at: at.established,
    });
    expect(byArticle.get(a.recentOnTarget)).toMatchObject({
      guid: 'g-recent',
      first_seen_at: at.recent,
    });
  });

  it('records a full rank for every affected subscriber', async () => {
    const intents = await outboxIntents();
    expect(intents).toEqual(
      [u.off, u.active, u.dup, u.dup2, u.target].sort().map((userId) => ({
        queue: 'user.rank',
        payload: { userId, reason: 'feed_merge', full: true },
      })),
    );
    const revisions = await ctx.owner.query(
      `SELECT id::text AS id, rank_revision::int AS rev FROM users WHERE id = ANY($1::uuid[])`,
      [Object.values(u)],
    );
    const rev = new Map(revisions.rows.map((row) => [row.id as string, row.rev as number]));
    for (const userId of [u.off, u.active, u.dup, u.dup2, u.target])
      expect(rev.get(userId)).toBe(1);
    expect(rev.get(u.prefOnly)).toBe(0);
  });

  it('is idempotent: a second call recreates nothing', async () => {
    const snapshot = async () =>
      (
        await ctx.owner.query(
          `SELECT user_id::text, feed_id::text, inference_mode, inference_version::text,
                  inference_activated_at, hidden, allow_duplicates, title_override, folder, created_at
             FROM subscriptions WHERE feed_id = ANY($1::bigint[]) ORDER BY user_id, feed_id`,
          [[f.source.id, f.target.id]],
        )
      ).rows;
    const before = await snapshot();
    await clearOutbox();
    expect(await merge(f.source.id, f.target.id)).toEqual({
      survivorId: f.target.id,
      movedArticleIds: [],
      affectedUserIds: [],
      guidConflicts: [],
    });
    expect(await redirect(f.source.id, f.target.url)).toEqual({ kind: 'unchanged' });
    expect(await snapshot()).toEqual(before);
    expect(await outboxIntents()).toEqual([]);
  });
});

describe('mergeFeeds chains and guards (spec 03 §9, spec 02 §3.3)', () => {
  it('merges into the live root of a retired owner of the URL', async () => {
    const feed = await createFeed(ctx.owner);
    const retired = await createFeed(ctx.owner);
    const root = await createFeed(ctx.owner);
    await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
      retired.id,
      root.id,
    ]);
    const reader = await createUser(ctx.owner);
    await subscribe(reader.id, feed.id);
    const item = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const outcome = await redirect(feed.id, retired.url);
    expect(outcome).toMatchObject({
      kind: 'merged',
      survivorId: root.id,
      movedArticleIds: [item.id],
      affectedUserIds: [reader.id],
    });
    expect(await resolveLiveFeedId(ctx.worker, feed.id)).toBe(root.id);
    const sub = await ctx.owner.query(
      'SELECT feed_id::text AS feed_id FROM subscriptions WHERE user_id = $1',
      [reader.id],
    );
    expect(sub.rows).toEqual([{ feed_id: root.id }]);
  });

  it('only follows the redirect when the URL belongs to a feed already merged into this one', async () => {
    const feed = await createFeed(ctx.owner);
    const retired = await createFeed(ctx.owner);
    await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
      retired.id,
      feed.id,
    ]);
    const fetchUrl = `${retired.url}?sig=1`;
    expect(await redirect(feed.id, retired.url, fetchUrl)).toEqual({
      kind: 'renamed',
      url: feed.url,
      fetchUrl,
    });
    expect(await feedRow(feed.id)).toMatchObject({ url: feed.url, fetch_url: fetchUrl });
    expect(await redirect(feed.id, retired.url, fetchUrl)).toEqual({ kind: 'unchanged' });
  });

  it('never merges a feed into itself or into its own tombstone, and rejects missing feeds', async () => {
    const feed = await createFeed(ctx.owner);
    const retired = await createFeed(ctx.owner);
    await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
      retired.id,
      feed.id,
    ]);
    await expect(merge(feed.id, feed.id)).rejects.toThrow(/itself/);
    await expect(merge(feed.id, retired.id)).rejects.toThrow(/itself/);
    await expect(merge('999999999', feed.id)).rejects.toThrow(/does not exist/);
    await expect(merge(feed.id, '999999999')).rejects.toThrow(/missing/);
    expect(await feedRow(feed.id)).toMatchObject({ status: 'active', merged_into_id: null });
  });

  it('follows a target that was retired while the merge waited for its locks', async () => {
    const source = await createFeed(ctx.owner);
    const target = await createFeed(ctx.owner);
    const root = await createFeed(ctx.owner);
    const reader = await createUser(ctx.owner);
    const rootReader = await createUser(ctx.owner);
    await subscribe(reader.id, source.id);
    await subscribe(rootReader.id, root.id);
    // Hold the reader's row so the merge stops after resolving the target, before its feed locks.
    const blocker = await ctx.owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [reader.id]);
      const pending = merge(source.id, target.id);
      await waitForLockWait();
      await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
        target.id,
        root.id,
      ]);
      await blocker.query('COMMIT');
      const outcome = await pending;
      expect(outcome.survivorId).toBe(root.id);
      // The root's subscriber was not known before the feed locks; it is locked and ranked too.
      expect(outcome.affectedUserIds).toEqual([reader.id, rootReader.id].sort());
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(await feedRow(source.id)).toMatchObject({ merged_into_id: root.id, status: 'dead' });
    const subs = await ctx.owner.query(
      `SELECT user_id::text AS user_id FROM subscriptions WHERE feed_id = $1 ORDER BY user_id`,
      [root.id],
    );
    expect(subs.rows.map((row) => row.user_id)).toEqual([reader.id, rootReader.id].sort());
  });

  it('re-points eval rater feeds when the eval schema exists', async () => {
    const source = await createFeed(ctx.owner);
    const target = await createFeed(ctx.owner);
    await ctx.adminPool.query(`
      CREATE SCHEMA eval;
      CREATE TABLE eval.raters (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
      CREATE TABLE eval.rater_feeds (
        rater_id bigint REFERENCES eval.raters(id) ON DELETE CASCADE,
        feed_id bigint REFERENCES feeds(id) ON DELETE RESTRICT,
        PRIMARY KEY (rater_id, feed_id));
      GRANT USAGE ON SCHEMA eval TO bantoozi_worker;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA eval TO bantoozi_worker;`);
    try {
      const raters = await ctx.adminPool.query<{ id: string }>(
        `INSERT INTO eval.raters (name) VALUES ('one'), ('two') RETURNING id::text AS id`,
      );
      const [one, two] = raters.rows.map((row) => row.id);
      await ctx.adminPool.query(
        `INSERT INTO eval.rater_feeds (rater_id, feed_id) VALUES ($1, $3), ($2, $3), ($2, $4)`,
        [one, two, source.id, target.id],
      );
      await merge(source.id, target.id);
      const rows = await ctx.adminPool.query(
        `SELECT rater_id::text AS rater_id, feed_id::text AS feed_id FROM eval.rater_feeds
          ORDER BY rater_id, feed_id`,
      );
      expect(rows.rows).toEqual([
        { rater_id: one, feed_id: target.id },
        { rater_id: two, feed_id: target.id },
      ]);
    } finally {
      await ctx.adminPool.query('DROP SCHEMA eval CASCADE');
    }
  });
});
