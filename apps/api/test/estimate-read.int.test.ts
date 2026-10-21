import { randomUUID } from 'node:crypto';

import { ExplainSchema } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOUR,
  ago,
  carriedArticle,
  explainJson,
  newReader,
  rank,
  setReader,
  subscribedFeed,
  type Reader,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * EST-4 (visible-learning §3.4-3.5, §4.4 Reading): stored estimate rows (score_source 'estimate',
 * lane new, tier, P) are read as they are stored in a view where inference is not visible: a
 * Training feed lists, counts, badges and marks read the same tier-filtered rows, the detail
 * explains them as estimates, every other not-eligible source stays neutral, and the unscoped
 * lanes do not move.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

interface Item {
  id: string;
  lane: string;
  pLike: number | null;
  tier: number | null;
  topReason: Record<string, unknown> | null;
  analysis: { mode: string; status: string; requestId: string | null };
}

interface Page {
  items: Item[];
  asOf: string;
  datasetVersion: string;
}

interface Counts {
  forYou: number;
  maybe: number;
  everything: number;
  new: number;
  total: number;
  datasetVersion: string;
  asOf: string;
}

async function list(r: Reader, query: Record<string, string>): Promise<Page> {
  const res = await r.api.get('/articles', { query });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Page>();
}

async function counts(r: Reader, query: Record<string, string>): Promise<Counts> {
  const res = await r.api.get('/articles/counts', { query });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Counts>();
}

const sorted = (page: Page) => page.items.map((item) => item.id).sort();

const ESTIMATE_RULES = ['inference_not_requested', 'estimate'];
const TIER_P: Record<number, number> = { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 };

/** A stored estimate ranking: lane new, the tier and P of the word model, rules and explain. */
async function estimateRow(
  r: Reader,
  articleId: string,
  tier: number,
  withBlock = false,
): Promise<void> {
  const p = TIER_P[tier]!;
  await rank(h, r.user.id, articleId, {
    lane: 'new',
    p,
    tier,
    source: 'estimate',
    rulesFired: ESTIMATE_RULES,
    explain: {
      ...explainJson({
        p,
        lane: 'new',
        tier,
        source: 'estimate',
        rules: ESTIMATE_RULES.map((code) => ({ code })),
      }),
      ...(withBlock
        ? {
            estimate: {
              version: 1,
              top: [{ feature: 't:battery', label: 'battery', contribution: 0.8 }],
            },
          }
        : {}),
    },
  });
}

/** A pending selected request, inserted as its tenant (the insert trigger checks it). */
async function selectArticle(userId: string, feedId: string, articleId: string): Promise<string> {
  const id = randomUUID();
  const client = await h.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, '{"article":"frozen"}',
              encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex')
         FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
        WHERE a.id = $4`,
      [id, userId, feedId, articleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

interface World {
  r: Reader;
  feed: string;
  est: Record<1 | 2 | 3 | 4 | 5, string>;
  unscored: string;
  cards4: string;
  readEst5: string;
}

/** A Training feed at feedMinTier 3 holding the C3 rows. */
async function trainingWorld(): Promise<World> {
  const r = await newReader(h, { feedMinTier: 3 });
  const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
  const article = (hoursAgo: number) =>
    carriedArticle(h, [feed], { arrival: ago(hoursAgo * HOUR) });
  const est = {
    1: await article(10),
    2: await article(9),
    3: await article(8),
    4: await article(7),
    5: await article(6),
  } as const;
  for (const tier of [1, 2, 3, 4, 5] as const) await estimateRow(r, est[tier], tier);
  const unscored = await article(5);
  await rank(h, r.user.id, unscored, { lane: 'new', p: null, tier: null });
  const cards4 = await article(4);
  await selectArticle(r.user.id, feed, cards4);
  await rank(h, r.user.id, cards4, { lane: 'maybe', p: 0.8, tier: 4 });
  const readEst5 = await article(3);
  await estimateRow(r, readEst5, 5);
  await setReader(h, r.user.id, readEst5, { readAt: ago(HOUR) });
  return { r, feed, est, unscored, cards4, readEst5 };
}

describe('a Training feed reads its stored estimates', () => {
  it('lists the estimate rows of tier 3 and up with the selected analysed row, and no lower tier', async () => {
    const w = await trainingWorld();
    const page = await list(w.r, { lane: 'all', feedId: w.feed, minTier: '3', status: 'unread' });
    expect(sorted(page)).toEqual([w.est[3], w.est[4], w.est[5], w.cards4].sort());
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(w.est[3])).toMatchObject({ lane: 'new', tier: 3, pLike: TIER_P[3] });
    expect(byId.get(w.est[5])).toMatchObject({ lane: 'new', tier: 5, pLike: TIER_P[5] });
    expect(byId.get(w.cards4)).toMatchObject({ lane: 'maybe', tier: 4, pLike: 0.8 });
  });

  it('also lists the read estimate row when read rows are asked for', async () => {
    const w = await trainingWorld();
    const page = await list(w.r, { lane: 'all', feedId: w.feed, minTier: '3', status: 'all' });
    expect(sorted(page)).toEqual([w.est[3], w.est[4], w.est[5], w.cards4, w.readEst5].sort());
  });

  it('lists the lower estimate tiers and the unscored row at minTier 1', async () => {
    const w = await trainingWorld();
    const page = await list(w.r, { lane: 'all', feedId: w.feed, minTier: '1', status: 'unread' });
    expect(sorted(page)).toEqual(
      [w.est[1], w.est[2], w.est[3], w.est[4], w.est[5], w.unscored, w.cards4].sort(),
    );
    const unscored = page.items.find((item) => item.id === w.unscored);
    expect(unscored).toMatchObject({ lane: 'new', tier: null, pLike: null });
  });

  it('reports not_requested analysis and no top reason on estimate rows', async () => {
    const w = await trainingWorld();
    const page = await list(w.r, { lane: 'all', feedId: w.feed, minTier: '3', status: 'unread' });
    for (const id of [w.est[3], w.est[4], w.est[5]]) {
      const item = page.items.find((candidate) => candidate.id === id)!;
      expect(item.analysis).toMatchObject({ mode: 'training', status: 'not_requested' });
      expect(item.topReason).toBeNull();
    }
  });

  it('counts the same rows as the list: total 4 and new 3', async () => {
    const w = await trainingWorld();
    const query = { feedId: w.feed, minTier: '3', status: 'unread' };
    const page = await list(w.r, { lane: 'all', ...query });
    const total = await counts(w.r, { ...query, asOf: page.asOf });
    expect(total).toMatchObject({ total: 4, new: 3, maybe: 1, forYou: 0, everything: 0 });
    expect(total.datasetVersion).toBe(page.datasetVersion);
  });

  it('shows the same four rows in the GET /subscriptions badge', async () => {
    const w = await trainingWorld();
    const subscriptions = (await w.r.api.get('/subscriptions')).json<
      {
        feed: { id: string };
        unread: { forYou: number; maybe: number; everything: number; new: number };
      }[]
    >();
    const row = subscriptions.find((s) => s.feed.id === w.feed)!;
    expect(row.unread.forYou + row.unread.maybe + row.unread.everything + row.unread.new).toBe(4);
  });

  it('marks read exactly the unread rows the list shows, using the counts dataset version', async () => {
    const w = await trainingWorld();
    const total = await counts(w.r, { feedId: w.feed, minTier: '3', status: 'unread' });
    const res = await w.r.api.post(`/subscriptions/${w.feed}/mark-read`, {
      olderThan: total.asOf,
      datasetVersion: total.datasetVersion,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ count: 4 });
    const read = await h.owner.query<{ article_id: string }>(
      `SELECT article_id::text FROM user_article WHERE user_id = $1 AND read_at IS NOT NULL`,
      [w.r.user.id],
    );
    expect(read.rows.map((row) => row.article_id).sort()).toEqual(
      [w.est[3], w.est[4], w.est[5], w.cards4, w.readEst5].sort(),
    );
  });
});

describe('estimates never move the unscoped lanes', () => {
  it('keeps For you, Maybe, Everything, New and the lane counts the same with and without the estimate rows', async () => {
    const r = await newReader(h, { feedMinTier: 3 });
    const active = await subscribedFeed(h, r.user.id, { mode: 'active' });
    const training = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const analysed = {
      for_you: await carriedArticle(h, [active], { arrival: ago(9 * HOUR) }),
      maybe: await carriedArticle(h, [active], { arrival: ago(8 * HOUR) }),
      everything: await carriedArticle(h, [active], { arrival: ago(7 * HOUR) }),
    } as const;
    await rank(h, r.user.id, analysed.for_you, { lane: 'for_you', p: 0.9, tier: 5 });
    await rank(h, r.user.id, analysed.maybe, { lane: 'maybe', p: 0.55, tier: 3 });
    await rank(h, r.user.id, analysed.everything, { lane: 'everything', p: 0.2, tier: 1 });
    const overlaid: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await carriedArticle(h, [training], { arrival: ago((6 - i) * HOUR) });
      await rank(h, r.user.id, id, { lane: 'new', p: null, tier: null });
      overlaid.push(id);
    }
    const unscoredActive = await carriedArticle(h, [active], { arrival: ago(HOUR) });
    await rank(h, r.user.id, unscoredActive, { lane: 'new', p: null, tier: null });

    const views = ['for_you', 'maybe', 'everything', 'new', 'all'] as const;
    const capture = async () => {
      const lists: Record<string, string[]> = {};
      const laneOf: Record<string, string> = {};
      for (const lane of views) {
        for (const minTier of ['1', '3']) {
          const page = await list(r, { lane, minTier, status: 'unread' });
          lists[`${lane}@${minTier}`] = page.items.map((item) => item.id);
          for (const item of page.items) laneOf[`${lane}@${minTier}:${item.id}`] = item.lane;
        }
      }
      const c = await counts(r, { status: 'unread' });
      return {
        lists,
        laneOf,
        counts: {
          forYou: c.forYou,
          maybe: c.maybe,
          everything: c.everything,
          new: c.new,
          total: c.total,
        },
      };
    };

    const before = await capture();
    expect(before.lists['new@1']).toHaveLength(6);
    for (const [i, id] of overlaid.entries()) await estimateRow(r, id, i + 1);
    const after = await capture();
    expect(after).toEqual(before);
  });
});

describe('the detail explains an estimate row and keeps other sources neutral', () => {
  it('returns source estimate, no cards, no facets or model, the estimate rules and a valid explain', async () => {
    const w = await trainingWorld();
    const res = await w.r.api.get(`/articles/${w.est[4]}`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json();
    const explain = ExplainSchema.parse(detail.explain);
    expect(explain).toMatchObject({
      source: 'estimate',
      lane: 'new',
      tier: 4,
      p: TIER_P[4],
      cards: [],
    });
    expect(explain.facets).toBeUndefined();
    expect(explain.model).toBeUndefined();
    expect(explain.rules.map((rule) => rule.code)).toEqual(ESTIMATE_RULES);
    expect(detail.topReason).toBeNull();
    expect(detail).toMatchObject({ lane: 'new', tier: 4, pLike: TIER_P[4] });
  });

  it('carries the stored estimate block into the detail explain', async () => {
    const w = await trainingWorld();
    await estimateRow(w.r, w.est[4], 4, true);
    const detail = (await w.r.api.get(`/articles/${w.est[4]}`)).json();
    expect(ExplainSchema.parse(detail.explain).estimate).toEqual({
      version: 1,
      top: [{ feature: 't:battery', label: 'battery', contribution: 0.8 }],
    });
  });

  it('keeps a stored cards row neutral in a Training view, in the list and the detail', async () => {
    const r = await newReader(h, { feedMinTier: 1 });
    const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const neutral = await carriedArticle(h, [feed], { arrival: ago(2 * HOUR) });
    await rank(h, r.user.id, neutral, {
      lane: 'for_you',
      p: 0.9,
      tier: 5,
      explain: {
        ...explainJson({ p: 0.9, lane: 'for_you', tier: 5, source: 'cards' }),
        facets: {
          contentType: { choice: 'news', p: 0.5 },
          topic: { l1: 'tech', p: 0.5 },
          depth: 0.5,
          clickbait: 0.1,
          promotional: 0.1,
          timeSensitive: 0.5,
          evergreen: 0.5,
        },
      },
    });
    const estimated = await carriedArticle(h, [feed], { arrival: ago(HOUR) });
    await estimateRow(r, estimated, 5);

    const page = await list(r, { lane: 'all', feedId: feed, minTier: '1' });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(neutral)).toMatchObject({ lane: 'new', tier: null, pLike: null });
    expect(byId.has(estimated)).toBe(true);

    const detail = (await r.api.get(`/articles/${neutral}`)).json();
    expect(detail).toMatchObject({ lane: 'new', tier: null, pLike: null });
    const explain = ExplainSchema.parse(detail.explain);
    expect(explain).toMatchObject({ source: 'none', p: null, tier: null, cards: [] });
    expect(explain.facets).toBeUndefined();
    expect(explain.rules.map((rule) => rule.code)).toEqual(['inference_not_requested']);
  });

  it('does not list or count a stored cards row of a Training view at a minimum tier, only the estimate row', async () => {
    const r = await newReader(h, { feedMinTier: 3 });
    const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const neutral = await carriedArticle(h, [feed], { arrival: ago(2 * HOUR) });
    await rank(h, r.user.id, neutral, { lane: 'for_you', p: 0.9, tier: 5 });
    const estimated = await carriedArticle(h, [feed], { arrival: ago(HOUR) });
    await estimateRow(r, estimated, 4);
    const query = { lane: 'all', feedId: feed, minTier: '3', status: 'unread' };
    const page = await list(r, query);
    expect(sorted(page)).toEqual([estimated]);
    const total = await counts(r, {
      feedId: feed,
      minTier: '3',
      status: 'unread',
      asOf: page.asOf,
    });
    expect(total).toMatchObject({ total: 1, new: 1, forYou: 0, maybe: 0, everything: 0 });
    const lower = await list(r, { ...query, minTier: '1' });
    expect(sorted(lower)).toEqual([neutral, estimated].sort());
  });

  it('shows an estimate row beside a neutral cards row in the same Training view with its tier and P', async () => {
    const r = await newReader(h, { feedMinTier: 1 });
    const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const neutral = await carriedArticle(h, [feed], { arrival: ago(2 * HOUR) });
    await rank(h, r.user.id, neutral, { lane: 'for_you', p: 0.9, tier: 5 });
    const estimated = await carriedArticle(h, [feed], { arrival: ago(HOUR) });
    await estimateRow(r, estimated, 5);
    const page = await list(r, { lane: 'all', feedId: feed, minTier: '1' });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(neutral)).toMatchObject({ lane: 'new', tier: null, pLike: null });
    expect(byId.get(estimated)).toMatchObject({ lane: 'new', tier: 5, pLike: TIER_P[5] });
  });
});
