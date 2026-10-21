import { ExplainSchema, type ArticleListItem } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  articleContexts,
  countArticles,
  getArticleDetail,
  listArticlePage,
  loadArticleItems,
  type ArticleListSort,
  type ArticleScope,
  type ArticleViewInput,
} from '../src/api/articles.js';
import { withTenant } from '../src/tenant.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * Stored word estimates in the reader views (visible-learning §3.4, §4.4 Reading, spec 06 §6.4): a
 * row whose stored source is `estimate` shows its P and tier in every view, never wins a story over
 * an analysed member, and moves the digests of the views that list it; every other row that is not
 * eligible in its view stays neutral and an explicit hide rule keeps its precedence.
 */

const ANCHOR = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SCORE_VERSION = 'sv:est';
const at = (offsetMs: number): Date => new Date(ANCHOR.getTime() + offsetMs);

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

interface Reader {
  id: string;
}

const newReader = async (): Promise<Reader> => ({ id: (await createUser(ctx.owner)).id });

async function feed(
  reader: Reader,
  mode: 'off' | 'training' | 'active',
  options: { allowDuplicates?: boolean } = {},
): Promise<string> {
  const created = await createFeed(ctx.owner);
  await ctx.owner.query(
    `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version,
                                inference_activated_at, allow_duplicates)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      reader.id,
      created.id,
      mode,
      mode === 'off' ? 0 : 1,
      mode === 'active' ? at(-30 * DAY) : null,
      options.allowDuplicates ?? false,
    ],
  );
  return created.id;
}

/** An article carried by `feedId`, arriving `hoursAgo` hours before the anchor. */
async function article(feedId: string, hoursAgo: number): Promise<string> {
  const created = await createArticle(ctx.owner, {
    feedIds: [feedId],
    firstSeenAt: at(-hoursAgo * HOUR),
  });
  await ctx.owner.query(`UPDATE articles SET pipeline_state = 'enriched' WHERE id = $1`, [
    created.id,
  ]);
  return created.id;
}

async function cluster(articleIds: readonly string[]): Promise<void> {
  const created = await ctx.owner.query<{ id: string }>(
    `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, $2) RETURNING id::text AS id`,
    [articleIds[0], articleIds.length],
  );
  await ctx.owner.query(`UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`, [
    created.rows[0]!.id,
    articleIds,
  ]);
}

interface ExplainOptions {
  source: 'cards' | 'estimate' | 'none';
  p: number | null;
  tier: number | null;
  lane: string;
  rules?: { code: string }[];
  withInference?: boolean;
}

const ESTIMATE_BLOCK = {
  version: 3,
  top: [
    { feature: 't:glacier', label: 'glacier', contribution: 0.9 },
    { feature: 't:coupon', label: 'coupon', contribution: -0.6 },
  ],
};

function explainOf(options: ExplainOptions): Record<string, unknown> {
  return {
    v: 1,
    inputs: {
      contentRevision: '1',
      mediaRevision: '0',
      rankRevision: '0',
      contextSha: 'a'.repeat(64),
    },
    source: options.source,
    p: options.p,
    lane: options.lane,
    tier: options.tier,
    cards: options.withInference
      ? [{ id: '7', title: 'Mountains', strength: 'like', p: 0.8, engine: 'jev' }]
      : [],
    ...(options.withInference
      ? {
          facets: {
            contentType: { choice: 'news', p: 0.9 },
            topic: { l1: 'science', p: 0.7 },
            depth: 0.5,
            clickbait: 0.1,
            promotional: 0.1,
            timeSensitive: 0.4,
            evergreen: 0.3,
          },
          model: { version: 2, top: [{ feature: 'f:x', label: 'x', contribution: 0.2 }] },
        }
      : {}),
    ...(options.source === 'estimate' ? { estimate: ESTIMATE_BLOCK } : {}),
    rules: options.rules ?? [],
  };
}

interface Stored {
  lane: 'new' | 'for_you' | 'maybe' | 'everything' | 'hidden';
  p: number | null;
  tier: number | null;
  source: 'cards' | 'estimate' | 'none';
  rules?: string[];
  explain?: Record<string, unknown> | null;
  labelSuggestions?: string[];
  readAt?: Date | null;
}

async function store(reader: Reader, articleId: string, row: Stored): Promise<void> {
  const explain =
    row.explain === undefined
      ? explainOf({
          source: row.source,
          p: row.p,
          tier: row.tier,
          lane: row.lane,
          rules: (row.rules ?? []).map((code) => ({ code })),
        })
      : row.explain;
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, p_like, tier, score_source, rules_fired,
                               explain, score_version, rank_revision, scored_at, label_suggestions,
                               read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
             (SELECT rank_revision FROM users WHERE id = $1), now(), $10::bigint[], $11)
     ON CONFLICT (user_id, article_id) DO UPDATE
       SET lane = EXCLUDED.lane, p_like = EXCLUDED.p_like, tier = EXCLUDED.tier,
           score_source = EXCLUDED.score_source, rules_fired = EXCLUDED.rules_fired,
           explain = EXCLUDED.explain, score_version = EXCLUDED.score_version,
           label_suggestions = EXCLUDED.label_suggestions, read_at = EXCLUDED.read_at`,
    [
      reader.id,
      articleId,
      row.lane,
      row.p,
      row.tier,
      row.source,
      row.rules ?? [],
      explain === null ? null : JSON.stringify(explain),
      SCORE_VERSION,
      row.labelSuggestions ?? [],
      row.readAt ?? null,
    ],
  );
}

const estimate = (p: number, tier: number, extra: Partial<Stored> = {}): Stored => ({
  lane: 'new',
  p,
  tier,
  source: 'estimate',
  rules: ['estimate'],
  ...extra,
});

async function setEstimateP(reader: Reader, articleId: string, p: number, tier?: number) {
  await ctx.owner.query(
    `UPDATE user_article SET p_like = $3, tier = coalesce($4::smallint, tier)
      WHERE user_id = $1 AND article_id = $2`,
    [reader.id, articleId, p, tier ?? null],
  );
}

/** A live selected analysis request: the article becomes eligible in its Training feed's views. */
async function select(reader: Reader, feedId: string, articleId: string): Promise<void> {
  const client = await ctx.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [reader.id]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha, created_at)
       SELECT gen_random_uuid(), $1, $2, a.id, a.content_revision, s.inference_version,
              '{}'::jsonb, encode(sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'hex'),
              now() - interval '1 day'
         FROM articles a JOIN subscriptions s ON s.user_id = $1 AND s.feed_id = $2
        WHERE a.id = $3`,
      [reader.id, feedId, articleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const view = (
  scope: ArticleScope,
  lane: ArticleViewInput['lane'],
  extra: Partial<ArticleViewInput> = {},
): ArticleViewInput => ({
  scope,
  lane,
  status: 'all',
  minTier: 0,
  asOf: ANCHOR,
  scoreVersion: SCORE_VERSION,
  ...extra,
});

async function list(
  reader: Reader,
  input: ArticleViewInput,
  options: { sort?: ArticleListSort; limit?: number } = {},
) {
  return withTenant(ctx.app, reader.id, (tx) =>
    listArticlePage(tx, {
      ...input,
      sort: options.sort ?? (input.lane === 'for_you' ? 'score' : 'date'),
      limit: options.limit ?? 50,
      after: null,
    }),
  );
}

const idsOf = async (
  reader: Reader,
  input: ArticleViewInput,
  options: { sort?: ArticleListSort } = {},
): Promise<string[]> => (await list(reader, input, options)).rows.map((row) => row.articleId);

const counts = (reader: Reader, scope: ArticleScope = {}, minTier = 0) =>
  withTenant(ctx.app, reader.id, (tx) =>
    countArticles(tx, { scope, status: 'all', minTier, asOf: ANCHOR, scoreVersion: SCORE_VERSION }),
  );

async function items(
  reader: Reader,
  articleIds: string[],
  sourceFeedId?: string,
): Promise<Map<string, ArticleListItem>> {
  return withTenant(ctx.app, reader.id, async (tx) => {
    const contexts = await articleContexts(tx, articleIds, { sourceFeedId });
    const loaded = await loadArticleItems(tx, contexts, { loadRemoteImages: false });
    return new Map(loaded.map((item) => [item.id, item]));
  });
}

const detail = (reader: Reader, articleId: string, sourceFeedId?: string) =>
  withTenant(ctx.app, reader.id, (tx) =>
    getArticleDetail(tx, { articleId, sourceFeedId, savedView: false, loadRemoteImages: false }),
  );

// ── C4: the story fold ─────────────────────────────────────────────────────────────────────────

describe('the story fold ignores estimate P', () => {
  it('an estimate with a higher P never takes a story from an analysed member', async () => {
    const reader = await newReader();
    const active = await feed(reader, 'active');
    const analysed = await article(active, 6);
    const estimated = await article(active, 2);
    await cluster([analysed, estimated]);
    await store(reader, analysed, {
      lane: 'maybe',
      p: 0.55,
      tier: 3,
      source: 'cards',
    });
    await store(reader, estimated, estimate(0.9, 5));

    expect(await idsOf(reader, view({}, 'maybe'))).toEqual([analysed]);
    expect(await idsOf(reader, view({}, 'new'))).toEqual([]);
    const all = await list(reader, view({}, 'all'));
    expect(all.rows.map((row) => row.articleId)).toEqual([analysed]);
    expect(all.rows[0]!.cluster?.size).toBe(2);
    const lanes = await counts(reader);
    expect([lanes.maybe, lanes.new, lanes.total]).toEqual([1, 0, 1]);
  });

  it('a story of estimates and an unscored member keeps the earliest arrival as its representative', async () => {
    const reader = await newReader();
    const active = await feed(reader, 'active');
    const unscored = await article(active, 8);
    const first = await article(active, 5);
    const second = await article(active, 3);
    await cluster([unscored, first, second]);
    await store(reader, unscored, { lane: 'new', p: null, tier: null, source: 'none' });
    await store(reader, first, estimate(0.4, 2));
    await store(reader, second, estimate(0.95, 5));

    const all = await list(reader, view({}, 'all'));
    expect(all.rows.map((row) => row.articleId)).toEqual([unscored]);
    expect(all.rows[0]!.cluster?.size).toBe(3);
    expect((await counts(reader)).new).toBe(1);
  });

  it('between analysed members the higher P still takes the story (pins existing behaviour)', async () => {
    const reader = await newReader();
    const active = await feed(reader, 'active');
    const low = await article(active, 6);
    const high = await article(active, 2);
    await cluster([low, high]);
    await store(reader, low, { lane: 'maybe', p: 0.45, tier: 2, source: 'cards' });
    await store(reader, high, { lane: 'for_you', p: 0.8, tier: 4, source: 'cards' });

    expect(await idsOf(reader, view({}, 'for_you'))).toEqual([high]);
    expect(await idsOf(reader, view({}, 'maybe'))).toEqual([]);
  });

  it('estimates in a Training feed are never folded (pins existing behaviour)', async () => {
    const reader = await newReader();
    const training = await feed(reader, 'training');
    const one = await article(training, 6);
    const two = await article(training, 2);
    await cluster([one, two]);
    await store(reader, one, estimate(0.5, 3));
    await store(reader, two, estimate(0.7, 4));

    const all = await list(reader, view({ feedId: training }, 'all'));
    expect(all.rows.map((row) => row.articleId).sort()).toEqual([one, two].sort());
    expect(all.rows.every((row) => row.cluster === null)).toBe(true);
  });
});

// ── C5: neutral stays neutral ──────────────────────────────────────────────────────────────────

describe('a view that cannot infer shows a stored estimate and nothing else', () => {
  async function world(mode: 'off' | 'training') {
    const reader = await newReader();
    const feedId = await feed(reader, mode);
    const label = await createCard(ctx.owner, { kind: 'label', visibility: 'public' });
    await ctx.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, 'Glaciers')`,
      [reader.id, label.id],
    );
    const rows = {
      cards: await article(feedId, 10),
      estimate: await article(feedId, 8),
      hidden: await article(feedId, 6),
      hiddenEstimate: await article(feedId, 5),
      unscored: await article(feedId, 4),
    };
    await store(reader, rows.cards, {
      lane: 'for_you',
      p: 0.8,
      tier: 4,
      source: 'cards',
      labelSuggestions: [label.id],
      explain: explainOf({
        source: 'cards',
        p: 0.8,
        tier: 4,
        lane: 'for_you',
        withInference: true,
      }),
    });
    await store(reader, rows.estimate, {
      ...estimate(0.7, 4, { labelSuggestions: [label.id] }),
      explain: explainOf({
        source: 'estimate',
        p: 0.7,
        tier: 4,
        lane: 'new',
        rules: [{ code: 'estimate' }],
        withInference: true,
      }),
    });
    await store(reader, rows.hidden, {
      lane: 'hidden',
      p: null,
      tier: null,
      source: 'none',
      rules: ['mute_keyword:glacier'],
      explain: explainOf({
        source: 'none',
        p: null,
        tier: null,
        lane: 'hidden',
        rules: [{ code: 'mute_keyword:glacier' }],
      }),
    });
    await store(reader, rows.hiddenEstimate, {
      lane: 'hidden',
      p: 0.6,
      tier: 3,
      source: 'estimate',
      rules: ['mute_keyword:glacier'],
    });
    await store(reader, rows.unscored, { lane: 'new', p: null, tier: null, source: 'none' });
    return { reader, feedId, rows };
  }

  it.each(['off', 'training'] as const)(
    'a stored cards row stays neutral and an estimate row keeps its lane, P and tier in a %s feed',
    async (mode) => {
      const { reader, feedId, rows } = await world(mode);
      const byId = await items(reader, Object.values(rows), feedId);

      const cards = byId.get(rows.cards)!;
      expect([cards.lane, cards.tier, cards.pLike, cards.topReason]).toEqual([
        'new',
        null,
        null,
        null,
      ]);
      expect(cards.labelSuggestions).toEqual([]);

      const estimated = byId.get(rows.estimate)!;
      expect(estimated.lane).toBe('new');
      expect(estimated.tier).toBe(4);
      expect(estimated.pLike).toBeCloseTo(0.7, 5);
      expect(estimated.labelSuggestions).toEqual([]);
      expect(estimated.topReason).toBeNull();
      expect(estimated.analysis.status).toBe('not_requested');

      const unscored = byId.get(rows.unscored)!;
      expect([unscored.lane, unscored.tier, unscored.pLike]).toEqual(['new', null, null]);
    },
  );

  it('a row hidden by a rule stays hidden and carries no P, even when its source is estimate', async () => {
    const { reader, feedId, rows } = await world('training');
    const byId = await items(reader, [rows.hidden, rows.hiddenEstimate], feedId);
    for (const id of [rows.hidden, rows.hiddenEstimate]) {
      const item = byId.get(id)!;
      expect([item.lane, item.tier, item.pLike]).toEqual(['hidden', null, null]);
    }
    expect((await detail(reader, rows.hiddenEstimate, feedId))!.explain?.rules).toEqual([
      { code: 'mute_keyword:glacier' },
    ]);
  });

  it('the detail explanation of an estimate row has no cards, facets or model', async () => {
    const { reader, feedId, rows } = await world('off');
    const open = await detail(reader, rows.estimate, feedId);
    const explain = open!.explain!;
    expect(ExplainSchema.safeParse(explain).success).toBe(true);
    expect(explain.source).toBe('estimate');
    expect(explain.cards).toEqual([]);
    expect(explain.facets).toBeUndefined();
    expect(explain.model).toBeUndefined();
    expect(explain.decidingCardId).toBeUndefined();
    expect(explain.rules).toEqual([{ code: 'inference_not_requested' }, { code: 'estimate' }]);
    expect(explain.estimate).toEqual(ESTIMATE_BLOCK);
    expect(explain.p).toBeCloseTo(0.7, 5);
    expect(explain.tier).toBe(4);
    expect(explain.lane).toBe('new');
    expect(open!.pLike).toBeCloseTo(0.7, 5);
  });

  it('the detail explanation of a cards row stays the neutral one', async () => {
    const { reader, feedId, rows } = await world('off');
    const explain = (await detail(reader, rows.cards, feedId))!.explain!;
    expect(explain.source).toBe('none');
    expect([explain.p, explain.tier, explain.lane]).toEqual([null, null, 'new']);
    expect(explain.cards).toEqual([]);
    expect(explain.facets).toBeUndefined();
    expect(explain.model).toBeUndefined();
    expect(explain.estimate).toBeUndefined();
    expect(explain.rules).toEqual([{ code: 'inference_not_requested' }]);
  });

  it('an estimate row without a usable stored explanation still shows its P and tier', async () => {
    const reader = await newReader();
    const feedId = await feed(reader, 'training');
    const missing = await article(feedId, 6);
    const foreign = await article(feedId, 4);
    await store(reader, missing, { ...estimate(0.55, 3), explain: null });
    await store(reader, foreign, {
      ...estimate(0.35, 2),
      explain: explainOf({ source: 'cards', p: 0.35, tier: 2, lane: 'new', withInference: true }),
    });
    const byId = await items(reader, [missing, foreign], feedId);
    expect(byId.get(missing)!.tier).toBe(3);
    expect(byId.get(foreign)!.tier).toBe(2);
    expect((await detail(reader, missing, feedId))!.explain).toBeNull();
    expect((await detail(reader, foreign, feedId))!.explain).toBeNull();
  });

  it('an estimate row in a view that can infer keeps its stored explanation (pins existing behaviour)', async () => {
    const reader = await newReader();
    const active = await feed(reader, 'active');
    const waiting = await article(active, 3);
    await store(reader, waiting, {
      ...estimate(0.62, 3),
      explain: explainOf({
        source: 'estimate',
        p: 0.62,
        tier: 3,
        lane: 'new',
        rules: [{ code: 'estimate' }],
        withInference: true,
      }),
    });
    const explain = (await detail(reader, waiting, active))!.explain!;
    expect(explain.rules).toEqual([{ code: 'estimate' }]);
    expect(explain.cards).toHaveLength(1);
    expect(explain.facets).toBeDefined();
  });
});

// ── C6: score order ────────────────────────────────────────────────────────────────────────────

describe('score order in a Training feed view', () => {
  async function world() {
    const reader = await newReader();
    const feedId = await feed(reader, 'training');
    const rows = {
      unscored: await article(feedId, 1),
      low: await article(feedId, 2),
      analysed: await article(feedId, 3),
      high: await article(feedId, 4),
      mid: await article(feedId, 5),
    };
    await store(reader, rows.unscored, { lane: 'new', p: null, tier: null, source: 'none' });
    await store(reader, rows.low, estimate(0.5, 3));
    await store(reader, rows.analysed, { lane: 'maybe', p: 0.6, tier: 3, source: 'cards' });
    await select(reader, feedId, rows.analysed);
    await store(reader, rows.high, estimate(0.9, 5));
    await store(reader, rows.mid, estimate(0.7, 4));
    return { reader, feedId, rows };
  }

  it('estimates interleave with an analysed row by P and unscored rows come last', async () => {
    const { reader, feedId, rows } = await world();
    const order = await idsOf(reader, view({ feedId }, 'all'), { sort: 'score' });
    expect(order).toEqual([rows.high, rows.mid, rows.analysed, rows.low, rows.unscored]);
  });

  it('a page size of one walks the whole order without duplicates or gaps', async () => {
    const { reader, feedId, rows } = await world();
    const input = view({ feedId }, 'all');
    const walked: string[] = [];
    let after = null as Awaited<ReturnType<typeof list>>['nextKey'];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await withTenant(ctx.app, reader.id, (tx) =>
        listArticlePage(tx, { ...input, sort: 'score', limit: 1, after }),
      );
      walked.push(...page.rows.map((row) => row.articleId));
      after = page.nextKey;
      if (after === null) break;
    }
    expect(walked).toEqual([rows.high, rows.mid, rows.analysed, rows.low, rows.unscored]);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('the cursor of an estimate row carries its P', async () => {
    const { reader, feedId } = await world();
    const page = await list(reader, view({ feedId }, 'all'), { sort: 'score', limit: 1 });
    expect(page.nextKey?.k1).toBeCloseTo(0.9, 5);
  });

  it('a P that moves between two pages changes the dataset version the cursor is checked against', async () => {
    const { reader, feedId, rows } = await world();
    const input = view({ feedId }, 'all');
    const first = await list(reader, input, { sort: 'score', limit: 1 });
    expect(first.nextKey).not.toBeNull();
    await setEstimateP(reader, rows.mid, 0.72);
    const second = await withTenant(ctx.app, reader.id, (tx) =>
      listArticlePage(tx, { ...input, sort: 'score', limit: 1, after: first.nextKey }),
    );
    expect(second.datasetVersion).not.toBe(first.datasetVersion);
  });

  it('the global New lane stays in date order with and without the estimates', async () => {
    const { reader, rows } = await world();
    const withEstimates = await idsOf(reader, view({}, 'new'));
    expect(withEstimates).toEqual([rows.unscored, rows.low, rows.high, rows.mid]);
    await ctx.owner.query(
      `UPDATE user_article SET score_source = 'none', p_like = NULL, tier = NULL
        WHERE user_id = $1 AND score_source = 'estimate'`,
      [reader.id],
    );
    expect(await idsOf(reader, view({}, 'new'))).toEqual(withEstimates);
  });
});

// ── C7: digest sensitivity ─────────────────────────────────────────────────────────────────────

describe('which dataset versions follow an estimate P', () => {
  async function world() {
    const reader = await newReader();
    const training = await feed(reader, 'training');
    const active = await feed(reader, 'active');
    const rows = {
      est: await article(training, 4),
      other: await article(training, 3),
      forYou: await article(active, 6),
      maybe: await article(active, 5),
      everything: await article(active, 2),
    };
    await store(reader, rows.est, estimate(0.7, 4));
    await store(reader, rows.other, estimate(0.3, 2));
    await store(reader, rows.forYou, { lane: 'for_you', p: 0.9, tier: 5, source: 'cards' });
    await store(reader, rows.maybe, { lane: 'maybe', p: 0.5, tier: 3, source: 'cards' });
    await store(reader, rows.everything, { lane: 'everything', p: 0.2, tier: 1, source: 'cards' });
    return { reader, training, rows };
  }

  async function digests(reader: Reader, training: string) {
    const version = async (scope: ArticleScope, lane: ArticleViewInput['lane']) => {
      const page = await list(reader, view(scope, lane, { status: 'unread' }));
      return { version: page.datasetVersion, rows: page.rows.length };
    };
    return {
      trainingAll: await version({ feedId: training }, 'all'),
      newLane: await version({}, 'new'),
      forYou: await version({}, 'for_you'),
      maybe: await version({}, 'maybe'),
      everything: await version({}, 'everything'),
      counts: (
        await withTenant(ctx.app, reader.id, (tx) =>
          countArticles(tx, {
            scope: {},
            status: 'unread',
            minTier: 0,
            asOf: ANCHOR,
            scoreVersion: SCORE_VERSION,
          }),
        )
      ).datasetVersion,
    };
  }

  it('the Training feed view, the New lane and the counts follow the P; For you, Maybe and Everything do not', async () => {
    const { reader, training, rows } = await world();
    const before = await digests(reader, training);
    for (const lane of ['forYou', 'maybe', 'everything'] as const) {
      expect(before[lane].rows).toBe(1);
    }
    expect(before.newLane.rows).toBe(2);

    await setEstimateP(reader, rows.est, 0.72);
    const after = await digests(reader, training);

    expect(after.trainingAll.version).not.toBe(before.trainingAll.version);
    expect(after.newLane.version).not.toBe(before.newLane.version);
    expect(after.counts).not.toBe(before.counts);
    expect(after.forYou.version).toBe(before.forYou.version);
    expect(after.maybe.version).toBe(before.maybe.version);
    expect(after.everything.version).toBe(before.everything.version);
  });

  it('a tier that moves with the P is part of the same digests', async () => {
    const { reader, training, rows } = await world();
    const before = await digests(reader, training);
    await setEstimateP(reader, rows.est, 0.7, 5);
    const after = await digests(reader, training);
    expect(after.trainingAll.version).not.toBe(before.trainingAll.version);
    expect(after.newLane.version).not.toBe(before.newLane.version);
  });

  it('an analysed P still moves its own lane (control)', async () => {
    const { reader, training, rows } = await world();
    const before = await digests(reader, training);
    await ctx.owner.query(
      `UPDATE user_article SET p_like = 0.91 WHERE user_id = $1 AND article_id = $2`,
      [reader.id, rows.forYou],
    );
    const after = await digests(reader, training);
    expect(after.forYou.version).not.toBe(before.forYou.version);
    expect(after.maybe.version).toBe(before.maybe.version);
  });
});
