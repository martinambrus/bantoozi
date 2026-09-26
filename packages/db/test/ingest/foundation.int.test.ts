import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeSubscriberIds,
  automaticCardDemand,
  carrierSubscriberIds,
  eligibleInferenceDemand,
  getArticleBody,
  hasInferenceDemand,
  reconcileClusters,
  recordRankIntents,
  resetArticleAnswers,
  upsertArticleBody,
  upsertMatchQueue,
  type ArticleBodyInput,
} from '../../src/ingest/index.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, sqlStateOf, withConnection, type DbTestContext } from '../support/test-db.js';

/**
 * The ingestion foundation (M1-T7): the single inference-demand contract (spec 03 §1.1, spec 05
 * §1.1), `resetArticleAnswers` (spec 05 §5.6), match-queue upserts (spec 05 §5.3–§5.4) and cluster
 * bookkeeping, against a real migrated database as the worker role.
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
  const sha = `${kind}-${Math.random().toString(16).slice(2)}`.padEnd(64, '0');
  const result = await ctx.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ($1, $2, $3, '{}') RETURNING id::text AS id`,
    [kind, `${kind}-test-${sha.slice(0, 12)}`, sha],
  );
  return { id: result.rows[0]!.id, sha };
}

/** Two readers of one feed: A active (activated two hours ago), B off. */
async function twoReaders(options: { activatedHoursAgo?: number } = {}) {
  const feed = await createFeed(ctx.owner);
  const a = await createUser(ctx.owner);
  const b = await createUser(ctx.owner);
  await createSubscription(ctx.owner, {
    userId: a.id,
    feedId: feed.id,
    mode: 'active',
    activatedAt: hoursAgo(options.activatedHoursAgo ?? 2),
  });
  await createSubscription(ctx.owner, { userId: b.id, feedId: feed.id, mode: 'off' });
  return { feed, a, b };
}

describe('eligibleInferenceDemand (spec 03 §1.1, spec 05 §1.1)', () => {
  it('admits an active subscription for arrivals at/after activation only', async () => {
    const { feed, a } = await twoReaders();
    const fresh = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const before = await createArticle(ctx.owner, { feedIds: [feed.id], firstSeenAt: hoursAgo(3) });
    const witnesses = await eligibleInferenceDemand(ctx.worker, fresh.id);
    expect(witnesses).toEqual([
      { kind: 'automatic', userId: a.id, feedId: feed.id, inferenceVersion: '1' },
    ]);
    // Activation is prospective: an item that arrived before it creates no automatic demand.
    expect(await hasInferenceDemand(ctx.worker, before.id)).toBe(false);
  });

  it('gives off and training subscriptions no automatic demand', async () => {
    const feed = await createFeed(ctx.owner);
    const off = await createUser(ctx.owner);
    const training = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: off.id, feedId: feed.id, mode: 'off' });
    await createSubscription(ctx.owner, { userId: training.id, feedId: feed.id, mode: 'training' });
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    expect(await eligibleInferenceDemand(ctx.worker, article.id)).toEqual([]);
  });

  it('ignores deleted accounts and stale articles', async () => {
    const { feed, a } = await twoReaders();
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const stale = await createArticle(ctx.owner, { feedIds: [feed.id] });
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [stale.id]);
    expect(await hasInferenceDemand(ctx.worker, stale.id)).toBe(false);
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [a.id]);
    expect(await hasInferenceDemand(ctx.worker, article.id)).toBe(false);
  });

  it('admits a current selected request of a training subscription, and nothing else', async () => {
    const feed = await createFeed(ctx.owner);
    const t = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: t.id, feedId: feed.id, mode: 'training' });
    const selected = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const sibling = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const requestId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    await withConnection(ctx.owner, async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [t.id]);
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         VALUES ($1, $2, $3, $4, 1, 1, '{"article":"frozen"}',
                 encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex'))`,
        [requestId, t.id, feed.id, selected.id],
      );
      await client.query('COMMIT');
    });
    expect(await eligibleInferenceDemand(ctx.worker, selected.id)).toEqual([
      { kind: 'manual', analysisRequestId: requestId },
    ]);
    // Training a selected article does not process its siblings.
    expect(await hasInferenceDemand(ctx.worker, sibling.id)).toBe(false);
    // New content needs a new selection: the old one no longer authorizes the article.
    await ctx.owner.query('UPDATE articles SET content_revision = 2 WHERE id = $1', [selected.id]);
    expect(await hasInferenceDemand(ctx.worker, selected.id)).toBe(false);
    await ctx.owner.query('UPDATE articles SET content_revision = 1 WHERE id = $1', [selected.id]);
    // Outside the 180-day selection window the request authorizes nothing.
    await ctx.owner.query(
      `UPDATE analysis_requests SET status = 'cancelled', completed_at = now() WHERE id = $1`,
      [requestId],
    );
    expect(await hasInferenceDemand(ctx.worker, selected.id)).toBe(false);
  });

  it('builds the automatic card union from scopes, labels and live cards', async () => {
    const { feed, a, b } = await twoReaders();
    const other = await createFeed(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: a.id,
      feedId: other.id,
      mode: 'active',
      activatedAt: hoursAgo(2),
    });
    const everywhere = await createCard(ctx.owner);
    const scopedHere = await createCard(ctx.owner);
    const scopedElsewhere = await createCard(ctx.owner);
    const retired = await createCard(ctx.owner);
    const label = await createCard(ctx.owner, { kind: 'label' });
    const offUsersCard = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES
         ($1, $2, 'like', NULL), ($1, $3, 'love', $6), ($1, $4, 'like', $7), ($1, $5, 'never', NULL),
         ($8, $9, 'like', NULL)`,
      [
        a.id,
        everywhere.id,
        scopedHere.id,
        scopedElsewhere.id,
        retired.id,
        feed.id,
        other.id,
        b.id,
        offUsersCard.id,
      ],
    );
    await ctx.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'L')`, [
      a.id,
      label.id,
    ]);
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [
      retired.id,
    ]);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const cards = await automaticCardDemand(ctx.worker, article.id);
    expect(cards.sort()).toEqual([everywhere.id, scopedHere.id, label.id].sort());
    // Restricted to another carrier: this article has none there.
    expect(await automaticCardDemand(ctx.worker, article.id, { feedId: other.id })).toEqual([]);
  });

  it('lists active subscribers of feeds and carriers', async () => {
    const { feed, a, b } = await twoReaders();
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    expect(await activeSubscriberIds(ctx.worker, [feed.id])).toEqual([a.id, b.id].sort());
    expect(await carrierSubscriberIds(ctx.worker, article.id)).toEqual([a.id, b.id].sort());
    expect(await activeSubscriberIds(ctx.worker, [])).toEqual([]);
  });
});

describe('upsertMatchQueue (spec 05 §5.3–§5.4)', () => {
  it('promotes priority, keeps live work at the same revision and resets older revisions', async () => {
    const article = await createArticle(ctx.owner);
    const c1 = await createCard(ctx.owner);
    const c2 = await createCard(ctx.owner);
    await ctx.worker.transaction((tx) =>
      upsertMatchQueue(tx, {
        articleId: article.id,
        revision: '1',
        cardIds: [c1.id, c2.id],
        priority: 6,
      }),
    );
    await ctx.owner.query(
      `UPDATE match_queue SET lease_token = gen_random_uuid(), lease_until = now() + interval '1 minute',
              attempts = 2, last_error = 'x' WHERE article_id = $1`,
      [article.id],
    );
    // Same revision, another requester: priority promoted, live lease and attempts untouched.
    await ctx.worker.transaction((tx) =>
      upsertMatchQueue(tx, { articleId: article.id, revision: '1', cardIds: [c1.id], priority: 2 }),
    );
    // A newer revision resets progress.
    await ctx.worker.transaction((tx) =>
      upsertMatchQueue(tx, { articleId: article.id, revision: '2', cardIds: [c2.id] }),
    );
    // A late producer still holding revision 1 never moves the newer row back.
    await ctx.worker.transaction((tx) =>
      upsertMatchQueue(tx, { articleId: article.id, revision: '1', cardIds: [c2.id], priority: 1 }),
    );
    const rows = await ctx.owner.query<{
      card_id: string;
      article_revision: string;
      priority: number;
      leased: boolean;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT card_id::text, article_revision::text, priority, lease_token IS NOT NULL AS leased,
              attempts, last_error FROM match_queue WHERE article_id = $1 ORDER BY card_id`,
      [article.id],
    );
    expect(rows.rows).toEqual([
      {
        card_id: c1.id,
        article_revision: '1',
        priority: 2,
        leased: true,
        attempts: 2,
        last_error: 'x',
      },
      {
        card_id: c2.id,
        article_revision: '2',
        priority: 5,
        leased: false,
        attempts: 0,
        last_error: null,
      },
    ]);
  });
});

describe('resetArticleAnswers (spec 05 §5.6)', () => {
  async function answeredArticle() {
    const { feed, a, b } = await twoReaders();
    const card = await createCard(ctx.owner);
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [a.id, card.id],
    );
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const enrich = await questionSet('enrich');
    const match = await questionSet('match');
    await ctx.owner.query(
      `UPDATE articles SET pipeline_state = 'matched', enrich_engine = 'typesafe', lang = 'en' WHERE id = $1`,
      [article.id],
    );
    await ctx.owner.query(
      `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256, engine,
                                   state_variant, answers, features)
       VALUES ($1, $2, 1, 's', 'typesafe', 'native', '{}', '{}')`,
      [article.id, enrich.id],
    );
    await ctx.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, 0.9, 'typesafe', $3, 1, 's', 'c', 'native')`,
      [article.id, card.id, match.sha],
    );
    await ctx.owner.query(
      `INSERT INTO article_translations (article_id, article_revision, source_sha256, engine,
                                         source_lang, quality)
       VALUES ($1, 1, 'x', 'libretranslate', 'sk', 'ok')`,
      [article.id],
    );
    await ctx.worker.transaction((tx) => upsertArticleBody(tx, article.id, '1', body()));
    return { feed, a, b, card, article };
  }

  it('advances the revision, drops old answers, queues the admitted union and ranks readers', async () => {
    const { a, b, card, article } = await answeredArticle();
    await clearOutbox();
    const result = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(result).toMatchObject({
      status: 'reset',
      previousRevision: '1',
      revision: '2',
      pipelineState: 'ingested',
      stale: false,
      admittedCardIds: [card.id],
      rankedUserIds: [a.id, b.id].sort(),
    });
    const counts = await ctx.owner.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM article_facets WHERE article_id = $1) AS facets,
              (SELECT count(*)::int FROM card_answers WHERE article_id = $1) AS answers,
              (SELECT count(*)::int FROM article_translations WHERE article_id = $1) AS translations`,
      [article.id],
    );
    expect(counts.rows[0]).toEqual({ facets: 0, answers: 0, translations: 0 });
    const art = await ctx.owner.query(
      'SELECT content_revision::text AS rev, pipeline_state, enrich_engine FROM articles WHERE id = $1',
      [article.id],
    );
    expect(art.rows[0]).toEqual({ rev: '2', pipeline_state: 'ingested', enrich_engine: null });
    // The old body stays readable at its old revision until extraction replaces it.
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({ articleRevision: '1' });
    const queue = await ctx.owner.query(
      'SELECT card_id::text, article_revision::text FROM match_queue WHERE article_id = $1',
      [article.id],
    );
    expect(queue.rows).toEqual([{ card_id: card.id, article_revision: '2' }]);
    // Rank intents only: next-stage work is recorded by the worker pipeline, never here.
    const intents = await outboxIntents();
    expect(intents.map((i) => i.queue)).toEqual(['user.rank', 'user.rank']);
    expect(intents.map((i) => i.payload['userId']).sort()).toEqual([a.id, b.id].sort());
  });

  it('installs a triggering body at the new revision, or keeps the current one', async () => {
    const { article } = await answeredArticle();
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'body_changed',
        nextState: 'extracted',
        installBody: body({ bodyText: 'New text' }),
      }),
    );
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '2',
      bodyText: 'New text',
    });
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'lang_changed',
        nextState: 'extracted',
        keepBody: true,
      }),
    );
    expect(await getArticleBody(ctx.worker, article.id)).toMatchObject({
      articleRevision: '3',
      bodyText: 'New text',
    });
  });

  it('keeps a stale article stale: no queue rows, rank intents only', async () => {
    const { a, b, article } = await answeredArticle();
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [
      article.id,
    ]);
    await ctx.owner.query(
      `INSERT INTO match_queue (article_id, card_id, article_revision)
       SELECT $1, card_id, 1 FROM card_answers WHERE article_id = $1`,
      [article.id],
    );
    await clearOutbox();
    const result = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    expect(result).toMatchObject({ status: 'reset', stale: true, pipelineState: 'stale' });
    const queue = await ctx.owner.query('SELECT 1 FROM match_queue WHERE article_id = $1', [
      article.id,
    ]);
    expect(queue.rowCount).toBe(0);
    expect((await outboxIntents()).map((i) => [i.queue, i.payload['userId']])).toEqual(
      [a.id, b.id].sort().map((id) => ['user.rank', id]),
    );
    // An explicit reprocess may lift it (spec 05 §5.6).
    const lifted = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'reprocess',
        nextState: 'ingested',
        explicitReprocess: true,
      }),
    );
    expect(lifted).toMatchObject({ stale: false, pipelineState: 'ingested' });
  });

  it('leaves the story cluster and reconciles its size and representative', async () => {
    const { feed, article } = await answeredArticle();
    const sibling = await createArticle(ctx.owner, {
      feedIds: [feed.id],
      firstSeenAt: hoursAgo(1),
    });
    const cluster = await ctx.owner.query<{ id: string }>(
      `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, 2) RETURNING id::text AS id`,
      [article.id],
    );
    const clusterId = cluster.rows[0]!.id;
    await ctx.owner.query(
      'UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])',
      [clusterId, [article.id, sibling.id]],
    );
    await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'source_changed',
        nextState: 'ingested',
      }),
    );
    const row = await ctx.owner.query(
      'SELECT size, representative_article_id::text AS rep FROM story_clusters WHERE id = $1',
      [clusterId],
    );
    expect(row.rows[0]).toEqual({ size: 1, rep: sibling.id });
    const art = await ctx.owner.query('SELECT story_cluster_id FROM articles WHERE id = $1', [
      article.id,
    ]);
    expect(art.rows[0]).toEqual({ story_cluster_id: null });
    // Removing the last member empties the cluster; it is kept for housekeeping.
    await ctx.owner.query('UPDATE articles SET story_cluster_id = NULL WHERE id = $1', [
      sibling.id,
    ]);
    await ctx.worker.transaction((tx) => reconcileClusters(tx, [clusterId, null]));
    const empty = await ctx.owner.query(
      'SELECT size, representative_article_id AS rep FROM story_clusters WHERE id = $1',
      [clusterId],
    );
    expect(empty.rows[0]).toEqual({ size: 0, rep: null });
  });

  it('reports a missing article and an unexpected revision without changing anything', async () => {
    const missing = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), '999999999', {
        reason: 'x',
        nextState: 'ingested',
      }),
    );
    expect(missing).toEqual({ status: 'missing' });
    const { article } = await answeredArticle();
    const stale = await ctx.worker.transaction((tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), article.id, {
        reason: 'x',
        nextState: 'ingested',
        expectedRevision: '7',
      }),
    );
    expect(stale).toEqual({ status: 'stale_revision', revision: '1' });
  });
});

describe('recordRankIntents (spec 06 §7)', () => {
  it('invalidates the users’ rank revision for a full rank only', async () => {
    const u = await createUser(ctx.owner);
    await clearOutbox();
    await ctx.worker.transaction((tx) =>
      recordRankIntents(tx, workerOutbox(tx), [u.id, u.id], { reason: 'ingest' }),
    );
    await ctx.worker.transaction((tx) =>
      recordRankIntents(tx, workerOutbox(tx), [u.id], { reason: 'merge', full: true }),
    );
    const rev = await ctx.owner.query('SELECT rank_revision::text AS r FROM users WHERE id = $1', [
      u.id,
    ]);
    expect(rev.rows[0]).toEqual({ r: '1' });
    expect((await outboxIntents()).map((i) => i.payload)).toEqual([
      { userId: u.id, reason: 'ingest' },
      { userId: u.id, reason: 'merge', full: true },
    ]);
  });
});

describe('subscriptions_inference_guard after migration 0009 (D-13)', () => {
  it('lets the worker advance a merged generation without a mode change, never the API role', async () => {
    const { feed, a } = await twoReaders();
    await ctx.workerPool.query(
      `UPDATE subscriptions SET inference_version = 5, inference_activated_at = now() - interval '1 hour'
        WHERE user_id = $1 AND feed_id = $2`,
      [a.id, feed.id],
    );
    const row = await ctx.owner.query(
      'SELECT inference_version::text AS v FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [a.id, feed.id],
    );
    expect(row.rows[0]).toEqual({ v: '5' });
    // Never a future activation boundary.
    expect(
      await sqlStateOf(
        ctx.workerPool.query(
          `UPDATE subscriptions SET inference_version = 6, inference_activated_at = now() + interval '1 day'
            WHERE user_id = $1 AND feed_id = $2`,
          [a.id, feed.id],
        ),
      ),
    ).toBe('23514');
    // A same-mode version bump by the API role is still rejected.
    expect(
      await sqlStateOf(
        withConnection(ctx.appPool, async (client) => {
          await client.query('BEGIN');
          try {
            await client.query("SELECT set_config('app.user_id', $1, true)", [a.id]);
            await client.query(
              'UPDATE subscriptions SET inference_version = 9 WHERE user_id = $1 AND feed_id = $2',
              [a.id, feed.id],
            );
          } finally {
            await client.query('ROLLBACK');
          }
        }),
      ),
    ).toBe('23514');
  });
});
