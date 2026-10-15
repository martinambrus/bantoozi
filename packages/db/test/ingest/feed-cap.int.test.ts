import { createHash } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enrichRecoveryPage } from '../../src/classify/degraded.js';
import { backfillPage } from '../../src/classify/backfill.js';
import { authorizedCarrierFeed } from '../../src/classify/cluster.js';
import { reprocessWindowPage } from '../../src/classify/reprocess.js';
import { isInferenceAuthorized } from '../../src/engine/authorization.js';
import {
  ingestItem,
  type IngestItemInput,
  type IngestItemOptions,
} from '../../src/ingest/articles.js';
import { newCarrierDemand } from '../../src/ingest/carriers.js';
import { automaticCardDemand, eligibleInferenceDemand } from '../../src/ingest/demand.js';
import { mergeArticles } from '../../src/ingest/merge-articles.js';
import { mergeFeeds } from '../../src/ingest/merge-feeds.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * D-251 per-feed daily cap on automatic analysis (owner-approved 2026-10-15), database layer.
 *
 * Names the build must add (this harness fixes them):
 * - `IngestItemOptions.autoAnalysisDailyCap: number | null` (null = unlimited; the worker passes the
 *   live setting `engine.auto_analysis_daily_cap`);
 * - column `feed_items.over_cap_limit integer NULL`: NULL = admitted, else the cap in force when
 *   the arrival was skipped (0 for cap 0);
 * - admission is claimed atomically inside `ingestItem` when the insert creates a feed_items row
 *   that an active, non-deleted subscription activated at/before it admits for a non-stale article
 *   whose article is not already analysed (pipeline_state enriched or matched). Paced: by the end
 *   of UTC hour h the feed has admitted at most floor(cap * (h + 1) / 24) arrivals of that UTC day.
 *
 * Every automatic-demand site must exclude an over-cap arrival; the last describe is the guard.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let seq = 0;
const next = (): number => (seq += 1);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function inputFor(
  feedId: string,
  url = `https://news.example.test/cap/${next()}`,
): IngestItemInput {
  return {
    feedId,
    urlKey: url,
    canonicalUrl: url,
    url,
    guid: `g-${next()}`,
    title: `Cap article ${url}`,
    titleNorm: `cap article ${url}`,
    author: null,
    categories: [],
    excerpt: 'Excerpt',
    excerptHtml: null,
    imageUrl: null,
    publishedAt: hoursAgo(2),
    contentHash: sha(url),
    feedBody: null,
    media: { videoEvidence: false, feedBodyImageCount: null },
    linkEnclosureType: null,
  };
}

/** The clock of the cap's UTC day and hour: fixed, so the paced allowance does not depend on when the suite runs. */
const at = (hour: number, minute = 30) => new Date(Date.UTC(2026, 9, 15, hour, minute));
let clock = at(9);

async function ingest(
  input: IngestItemInput,
  cap: number | null,
): Promise<{ articleId: string; newAssociation: boolean }> {
  const options = {
    maxAgeDays: 14,
    linkKey: (url: string) => url,
    autoAnalysisDailyCap: cap,
    now: clock,
  } as IngestItemOptions;
  const result = await ctx.worker.transaction((tx) =>
    ingestItem(tx, workerOutbox(tx), input, options),
  );
  return { articleId: result.articleId, newAssociation: result.newAssociation };
}

/** A feed with one active reader (activated an hour ago) holding one interest card. */
async function activeFeed(): Promise<{ feedId: string; userId: string; cardId: string }> {
  const feed = await createFeed(ctx.owner);
  const user = await createUser(ctx.owner);
  await createSubscription(ctx.owner, {
    userId: user.id,
    feedId: feed.id,
    mode: 'active',
    activatedAt: hoursAgo(1),
  });
  const card = await createCard(ctx.owner, { kind: 'interest' });
  await ctx.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $2, 'like', NULL)`,
    [user.id, card.id],
  );
  return { feedId: feed.id, userId: user.id, cardId: card.id };
}

const automaticWitnesses = async (articleId: string) =>
  (await eligibleInferenceDemand(ctx.worker, articleId)).filter((w) => w.kind === 'automatic');

/** Run `body` with the cap's clock at `hour` (UTC) of a fixed day. */
async function withStableHour(body: (hour: number) => Promise<void>, hour = 9): Promise<void> {
  clock = at(hour);
  await body(hour);
}

const allowance = (cap: number, hour: number) => Math.floor((cap * (hour + 1)) / 24);

async function overCapLimit(feedId: string, articleId: string): Promise<number | null> {
  const r = await ctx.owner.query<{ v: number | null }>(
    `SELECT over_cap_limit AS v FROM feed_items WHERE feed_id = $1 AND article_id = $2`,
    [feedId, articleId],
  );
  return r.rows[0]!.v;
}

describe('paced per-feed admission at ingest (D-251)', () => {
  it('admits at most floor(cap * (hour + 1) / 24) arrivals of the UTC day and no automatic analysis for the rest', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const f = await activeFeed();
      const ids: string[] = [];
      for (let i = 0; i < room + 3; i += 1)
        ids.push((await ingest(inputFor(f.feedId), cap)).articleId);

      const admitted: boolean[] = [];
      for (const id of ids) admitted.push((await automaticWitnesses(id)).length === 1);
      // The first arrivals take the slots, in arrival order; the rest get nothing.
      expect(admitted.filter(Boolean)).toHaveLength(room);
      expect(admitted).toEqual(ids.map((_, i) => i < room));
    });
  });

  it('records the cap in force on every over-cap arrival and leaves admitted ones unmarked', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const f = await activeFeed();
      const ids: string[] = [];
      for (let i = 0; i < room + 2; i += 1)
        ids.push((await ingest(inputFor(f.feedId), cap)).articleId);
      const marks = await Promise.all(ids.map((id) => overCapLimit(f.feedId, id)));
      expect(marks).toEqual(ids.map((_, i) => (i < room ? null : cap)));
    });
  });

  it('counts per feed: a second feed has its own allowance', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const a = await activeFeed();
      const b = await activeFeed();
      const aIds: string[] = [];
      for (let i = 0; i < room + 2; i += 1)
        aIds.push((await ingest(inputFor(a.feedId), cap)).articleId);
      expect(await automaticWitnesses(aIds[room + 1]!)).toEqual([]);
      const own: string[] = [];
      for (let i = 0; i < room; i += 1) own.push((await ingest(inputFor(b.feedId), cap)).articleId);
      for (const id of own) expect(await automaticWitnesses(id)).toHaveLength(1);
    });
  });

  it('shares the allowance between the subscribers of a feed', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const f = await activeFeed();
      const second = await createUser(ctx.owner);
      await createSubscription(ctx.owner, {
        userId: second.id,
        feedId: f.feedId,
        mode: 'active',
        activatedAt: hoursAgo(1),
      });
      const ids: string[] = [];
      for (let i = 0; i < room + 1; i += 1)
        ids.push((await ingest(inputFor(f.feedId), cap)).articleId);
      // Two subscribers still cost one slot per arrival.
      expect(
        await Promise.all(ids.map(async (id) => (await automaticWitnesses(id)).length)),
      ).toEqual(ids.map((_, i) => (i < room ? 2 : 0)));
    });
  });

  it('cap 0 admits nothing (the mark is 0) and null admits everything', async () => {
    const zero = await activeFeed();
    const none = await ingest(inputFor(zero.feedId), 0);
    expect(await automaticWitnesses(none.articleId)).toEqual([]);
    expect(await overCapLimit(zero.feedId, none.articleId)).toBe(0);

    const open = await activeFeed();
    for (let i = 0; i < 30; i += 1) {
      const { articleId } = await ingest(inputFor(open.feedId), null);
      expect(await automaticWitnesses(articleId)).toHaveLength(1);
      expect(await overCapLimit(open.feedId, articleId)).toBeNull();
    }
  });

  it('takes no slot for an arrival no subscription admits (training, off, stale)', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const feed = await createFeed(ctx.owner);
      const user = await createUser(ctx.owner);
      await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id, mode: 'training' });
      // Not admitted by anyone: neither a slot nor a mark.
      for (let i = 0; i < room + 3; i += 1) await ingest(inputFor(feed.id), cap);
      // A stale arrival of an active feed takes none either.
      const active = await activeFeed();
      for (let i = 0; i < room + 3; i += 1) {
        const stale = { ...inputFor(active.feedId), publishedAt: hoursAgo(24 * 40) };
        await ingest(stale, cap);
      }
      // The whole allowance is still there for real arrivals.
      const fresh: string[] = [];
      for (let i = 0; i < room + 1; i += 1) {
        fresh.push((await ingest(inputFor(active.feedId), cap)).articleId);
      }
      const admitted = await Promise.all(
        fresh.map(async (id) => (await automaticWitnesses(id)).length),
      );
      expect(admitted).toEqual(fresh.map((_, i) => (i < room ? 1 : 0)));
    });
  });

  it('takes no slot for an article that is already analysed through another feed', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const quiet = await createFeed(ctx.owner);
      const f = await activeFeed();

      // Already enriched through a feed nobody analyses on: arriving on `f` costs no slot.
      const analysedIds: string[] = [];
      for (let i = 0; i < room + 2; i += 1) {
        const input = inputFor(quiet.id);
        const { articleId } = await ingest(input, cap);
        await ctx.owner.query(`UPDATE articles SET pipeline_state = 'enriched' WHERE id = $1`, [
          articleId,
        ]);
        const carried = await ingest(
          { ...inputFor(f.feedId, input.canonicalUrl), guid: null },
          cap,
        );
        expect(carried).toMatchObject({ articleId, newAssociation: true });
        analysedIds.push(articleId);
      }
      for (const id of analysedIds) expect(await automaticWitnesses(id)).toHaveLength(1);

      // ... so the feed's whole allowance is left for fresh arrivals, and not one more.
      const fresh: string[] = [];
      for (let i = 0; i < room + 2; i += 1)
        fresh.push((await ingest(inputFor(f.feedId), cap)).articleId);
      const admitted = await Promise.all(
        fresh.map(async (id) => (await automaticWitnesses(id)).length === 1),
      );
      expect(admitted).toEqual(fresh.map((_, i) => i < room));
    });
  });

  it('takes no slot for an extracted article whose current analysis is reusable (analysis.process on another feed, D-252)', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const quiet = await createFeed(ctx.owner);
      const f = await activeFeed();
      const kept = await ctx.owner.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM settings WHERE key IN ('question_sets.active', 'engine.model_pin')`,
      );
      const set = await ctx.owner.query<{ id: string }>(
        `INSERT INTO question_sets (kind, version, sha256, definition)
         VALUES ('enrich', $1, $2, '{}') RETURNING id::text AS id`,
        [`enrich-cap-${next()}`, sha(['enrich-cap', next()])],
      );
      const setId = set.rows[0]!.id;
      await ctx.owner.query(
        `INSERT INTO settings (key, value) VALUES ('question_sets.active', $1::jsonb), ('engine.model_pin', $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify({ enrich: setId }), JSON.stringify({ model: 'jev-cap' })],
      );
      try {
        // Exhaust today's allowance on fresh arrivals.
        for (let i = 0; i < room; i += 1) await ingest(inputFor(f.feedId), cap);
        const counter = () =>
          ctx.owner
            .query<{ n: number }>(
              `SELECT coalesce(sum(admitted), 0)::int AS n FROM feed_auto_admissions WHERE feed_id = $1`,
              [f.feedId],
            )
            .then((r) => r.rows[0]!.n);
        expect(await counter()).toBe(room);

        const arrive = async (withFacets: boolean) => {
          const input = inputFor(quiet.id);
          const { articleId } = await ingest(input, cap);
          await ctx.owner.query(`UPDATE articles SET pipeline_state = 'extracted' WHERE id = $1`, [
            articleId,
          ]);
          if (withFacets)
            await ctx.owner.query(
              `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256,
                                           engine, model, state_variant, answers, features)
               SELECT id, $2, content_revision, 's', 'typesafe', 'jev-cap', 'native', '{}', '{}'
                 FROM articles WHERE id = $1`,
              [articleId, setId],
            );
          await ingest({ ...inputFor(f.feedId, input.canonicalUrl), guid: null }, cap);
          return articleId;
        };

        const reusable = await arrive(true);
        expect(await overCapLimit(f.feedId, reusable)).toBeNull();
        expect(await counter()).toBe(room);

        // Negative control: the same state without current facets is over cap.
        const bare = await arrive(false);
        expect(await overCapLimit(f.feedId, bare)).toBe(cap);
        expect(await counter()).toBe(room);
      } finally {
        await ctx.owner.query(
          `DELETE FROM settings WHERE key IN ('question_sets.active', 'engine.model_pin')`,
        );
        for (const row of kept.rows)
          await ctx.owner.query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [
            row.key,
            JSON.stringify(row.value),
          ]);
      }
    });
  });

  it('a retried arrival whose transaction rolled back does not consume a slot', async () => {
    await withStableHour(async (hour) => {
      const cap = 24;
      const room = allowance(cap, hour);
      const f = await activeFeed();
      for (let i = 0; i < room; i += 1) {
        const options = {
          maxAgeDays: 14,
          linkKey: (u: string) => u,
          autoAnalysisDailyCap: cap,
          now: clock,
        } as IngestItemOptions;
        await expect(
          ctx.worker.transaction(async (tx) => {
            await ingestItem(tx, workerOutbox(tx), inputFor(f.feedId), options);
            throw new Error('rolled back');
          }),
        ).rejects.toThrow('rolled back');
      }
      const ids: string[] = [];
      for (let i = 0; i < room + 1; i += 1)
        ids.push((await ingest(inputFor(f.feedId), cap)).articleId);
      const admitted = await Promise.all(
        ids.map(async (id) => (await automaticWitnesses(id)).length),
      );
      expect(admitted).toEqual(ids.map((_, i) => (i < room ? 1 : 0)));
    });
  });
});

describe('the unused allowance carries forward across hours (D-251)', () => {
  it('cap 24: one admission at 00:xx, none more in that hour, then up to 6 by 05:xx', async () => {
    const cap = 24;
    const f = await activeFeed();
    const admittedAt = async (hour: number, count: number): Promise<boolean[]> => {
      clock = at(hour);
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1)
        ids.push((await ingest(inputFor(f.feedId), cap)).articleId);
      return Promise.all(ids.map(async (id) => (await automaticWitnesses(id)).length === 1));
    };
    expect(await admittedAt(0, 1)).toEqual([true]);
    expect(await admittedAt(0, 2)).toEqual([false, false]);
    expect(await admittedAt(5, 7)).toEqual([true, true, true, true, true, false, false]);
    const total = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feed_items WHERE feed_id = $1 AND over_cap_limit IS NULL`,
      [f.feedId],
    );
    expect(total.rows[0]!.n).toBe(allowance(cap, 5));
  });

  it('a new UTC day starts a new allowance', async () => {
    const cap = 24;
    const f = await activeFeed();
    clock = at(0);
    expect(
      await automaticWitnesses((await ingest(inputFor(f.feedId), cap)).articleId),
    ).toHaveLength(1);
    const second = (await ingest(inputFor(f.feedId), cap)).articleId;
    expect(await automaticWitnesses(second)).toEqual([]);
    clock = new Date(Date.UTC(2026, 9, 16, 0, 30));
    const next = (await ingest(inputFor(f.feedId), cap)).articleId;
    expect(await automaticWitnesses(next)).toHaveLength(1);
  });
});

describe('every automatic-demand site excludes an over-cap arrival (D-251)', () => {
  /** The same reader and card, one article admitted (cap null) and one over cap (cap 0). */
  async function pair() {
    const f = await activeFeed();
    const admitted = (await ingest(inputFor(f.feedId), null)).articleId;
    const capped = (await ingest(inputFor(f.feedId), 0)).articleId;
    return { ...f, admitted, capped };
  }
  const since = () => hoursAgo(3).toISOString();

  it('eligibleInferenceDemand and automaticCardDemand', async () => {
    const p = await pair();
    expect(await automaticWitnesses(p.admitted)).toHaveLength(1);
    expect(await automaticWitnesses(p.capped)).toEqual([]);
    expect(await automaticCardDemand(ctx.worker, p.admitted)).toEqual([p.cardId]);
    expect(await automaticCardDemand(ctx.worker, p.capped)).toEqual([]);
    expect(await automaticCardDemand(ctx.worker, p.capped, { feedId: p.feedId })).toEqual([]);
  });

  it('newCarrierDemand creates no demand and queues no cards', async () => {
    const p = await pair();
    expect(await newCarrierDemand(ctx.worker, p.admitted, p.feedId)).toMatchObject({
      createsDemand: true,
      missingCardIds: [p.cardId],
    });
    expect(await newCarrierDemand(ctx.worker, p.capped, p.feedId)).toMatchObject({
      createsDemand: false,
      missingCardIds: [],
    });
  });

  it('router admission (isInferenceAuthorized) refuses the automatic witness', async () => {
    const p = await pair();
    const authorization = (articleId: string) => ({
      type: 'article' as const,
      articleId,
      articleRevision: '1',
      witnesses: [
        { kind: 'automatic' as const, userId: p.userId, feedId: p.feedId, inferenceVersion: '1' },
      ],
    });
    expect(await isInferenceAuthorized(ctx.worker, authorization(p.admitted))).toBe(true);
    expect(await isInferenceAuthorized(ctx.worker, authorization(p.capped))).toBe(false);
  });

  it('degraded recovery, reprocess and backfill leave it out', async () => {
    const p = await pair();
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'degraded' WHERE id = ANY($1)`, [
      [p.admitted, p.capped],
    ]);
    const recovery = await enrichRecoveryPage(ctx.worker, {
      windowDays: 7,
      limit: 100,
      enrichSetId: null,
    });
    const recovered = recovery.map((r) => r.articleId);
    expect(recovered).toContain(p.admitted);
    expect(recovered).not.toContain(p.capped);

    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'enriched' WHERE id = ANY($1)`, [
      [p.admitted, p.capped],
    ]);
    const window = await reprocessWindowPage(ctx.worker, {
      since: since(),
      limit: 100,
      states: ['enriched'],
      enrichSetId: null,
    });
    expect(window.map((r) => r.articleId)).toContain(p.admitted);
    expect(window.map((r) => r.articleId)).not.toContain(p.capped);

    const backfill = await backfillPage(ctx.worker, {
      userId: p.userId,
      snapshotAt: new Date(Date.now() + 60_000),
      windowDays: 1,
    });
    expect(backfill.map((r) => r.articleId)).toContain(p.admitted);
    expect(backfill.map((r) => r.articleId)).not.toContain(p.capped);
  });

  it('the cluster fold names no authorized carrier for it', async () => {
    const p = await pair();
    expect(await authorizedCarrierFeed(ctx.worker, p.admitted)).toMatchObject({ feedId: p.feedId });
    expect(await authorizedCarrierFeed(ctx.worker, p.capped)).toBeNull();
  });

  it('a selected request still authorizes a capped article (explicit selection is never capped)', async () => {
    const p = await pair();
    // A pending selected request of the reader for the capped article (created as the tenant).
    const client = await ctx.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [p.userId]);
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         VALUES (gen_random_uuid(), $1, $2, $3, 1, 1, '{"article":"frozen"}',
                 encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex'))`,
        [p.userId, p.feedId, p.capped],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const witnesses = await eligibleInferenceDemand(ctx.worker, p.capped);
    expect(witnesses.map((w) => w.kind)).toEqual(['manual']);
  });
});

describe('merges keep an admitted duplicate admitted (D-251)', () => {
  async function articleOn(feedId: string, overCap: number | null) {
    const article = await createArticle(ctx.owner, { feedIds: [feedId], firstSeenAt: hoursAgo(1) });
    await ctx.owner.query(
      `UPDATE feed_items SET over_cap_limit = $3 WHERE feed_id = $1 AND article_id = $2`,
      [feedId, article.id, overCap],
    );
    return article;
  }

  it.each([
    ['source over cap, target admitted', 1000, null],
    ['source admitted, target over cap', null, 1000],
  ] as const)('mergeArticles: %s', async (_name, sourceCap, targetCap) => {
    const f = await activeFeed();
    const source = await articleOn(f.feedId, sourceCap);
    const target = await articleOn(f.feedId, targetCap);
    const result = await ctx.worker.transaction((tx) =>
      mergeArticles(tx, workerOutbox(tx), source.id, target.id, { reason: 'redirect' }),
    );
    expect(result.status).toBe('merged');
    expect(await overCapLimit(f.feedId, target.id)).toBeNull();
    expect(await automaticWitnesses(target.id)).toHaveLength(1);
  });

  it('mergeArticles: a carrier only the source had keeps its mark', async () => {
    const f = await activeFeed();
    const g = await activeFeed();
    const source = await articleOn(g.feedId, 1000);
    const target = await articleOn(f.feedId, null);
    await ctx.worker.transaction((tx) =>
      mergeArticles(tx, workerOutbox(tx), source.id, target.id, { reason: 'redirect' }),
    );
    expect(await overCapLimit(g.feedId, target.id)).toBe(1000);
  });

  it.each([
    ['source row over cap, target row admitted', 1000, null],
    ['source row admitted, target row over cap', null, 1000],
  ] as const)('mergeFeeds: %s', async (_name, sourceCap, targetCap) => {
    const source = await createFeed(ctx.owner);
    const target = await createFeed(ctx.owner);
    const user = await createUser(ctx.owner);
    await createSubscription(ctx.owner, {
      userId: user.id,
      feedId: target.id,
      mode: 'active',
      activatedAt: hoursAgo(2),
    });
    const article = await createArticle(ctx.owner, {
      feedIds: [source.id, target.id],
      firstSeenAt: hoursAgo(1),
    });
    await ctx.owner.query(
      `UPDATE feed_items SET over_cap_limit = $3 WHERE feed_id = $1 AND article_id = $2`,
      [source.id, article.id, sourceCap],
    );
    await ctx.owner.query(
      `UPDATE feed_items SET over_cap_limit = $3 WHERE feed_id = $1 AND article_id = $2`,
      [target.id, article.id, targetCap],
    );
    await ctx.worker.transaction((tx) => mergeFeeds(tx, workerOutbox(tx), source.id, target.id));
    expect(await overCapLimit(target.id, article.id)).toBeNull();
    expect(await automaticWitnesses(article.id)).toHaveLength(1);
  });
});
