import { createHash } from 'node:crypto';

import {
  createDatabase,
  ingestItem,
  seedQuestionSets,
  workerOutbox,
  type IngestItemInput,
} from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ago,
  carriedArticle,
  newReader,
  subscribedFeed,
  DAY,
  type Reader,
} from './support/article-fixtures.js';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * D-251 per-feed daily cap on automatic analysis, API layer (owner-approved 2026-10-15).
 *
 * Names the build must add: `feed_items.over_cap_limit integer NULL` (NULL = admitted, else the cap
 * in force when the arrival was skipped); `ArticleAnalysis.overDailyCap: number | null`; the env
 * default AUTO_ANALYSIS_DAILY_CAP / runtime setting `engine.auto_analysis_daily_cap`; the
 * `autoAnalysisDailyCap` option of `ingestItem`.
 *
 * - The reader list keeps `analysis.status: 'not_requested'` for an over-cap arrival and adds
 *   `analysis.overDailyCap: <cap>` (null otherwise); a combined view where another carrier admitted
 *   the article shows it as eligible (status `pending`, overDailyCap null).
 * - Explicit selection is never capped.
 * - D-238: rating a capped article consumes a slot of the same feed/day allowance; when none is
 *   left the rating is saved and no analysis request is created.
 */

const CAP = 24;
const HOUR = 9;
let h: ApiHarness;

/**
 * The API clock for the allowance: it runs with real time, shifted to read 09:30 UTC (the cap's
 * hour) tomorrow when the suite starts, so the paced allowance never depends on the hour the suite
 * runs in and every article the suite creates is already in the past for the reader's view.
 */
const nineThirty = new Date(Date.now() + 24 * 3_600_000);
nineThirty.setUTCHours(HOUR, 30, 0, 0);
const clockOffsetMs = nineThirty.getTime() - Date.now();
const apiNow = () => new Date(Date.now() + clockOffsetMs);

async function seedActiveQuestionSets(): Promise<void> {
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );
}

beforeAll(async () => {
  h = await createApiHarness({
    env: { AUTO_ANALYSIS_DAILY_CAP: String(CAP) },
    clock: { now: apiNow },
  });
  await seedActiveQuestionSets();
});

afterAll(async () => {
  await h.close();
});

interface Item {
  id: string;
  analysis: {
    mode: string;
    status: string;
    requestId: string | null;
    overDailyCap?: number | null;
  };
}

async function list(r: Reader, query: Record<string, string> = {}): Promise<Item[]> {
  const res = await r.api.get('/articles', { query: { lane: 'new', ...query } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: Item[] }>().items;
}

const markCapped = (feedId: string, articleId: string, cap = 1000) =>
  h.owner.query(
    `UPDATE feed_items SET over_cap_limit = $3 WHERE feed_id = $1 AND article_id = $2`,
    [feedId, articleId, cap],
  );

describe('reader list: the over-cap hint', () => {
  it('keeps not_requested and adds overDailyCap for an over-cap arrival', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const capped = await carriedArticle(h, [feed]);
    const normal = await carriedArticle(h, [feed]);
    await markCapped(feed, capped, 1000);

    const items = await list(r, { feedId: feed });
    const byId = new Map(items.map((i) => [i.id, i.analysis]));
    expect(byId.get(capped)).toEqual({
      mode: 'active',
      status: 'not_requested',
      requestId: null,
      overDailyCap: 1000,
    });
    expect(byId.get(normal)).toEqual({
      mode: 'active',
      status: 'pending',
      requestId: null,
      overDailyCap: null,
    });
  });

  it('shows it as eligible in a combined view where another carrier admitted it', async () => {
    const r = await newReader(h);
    const a = await subscribedFeed(h, r.user.id);
    const b = await subscribedFeed(h, r.user.id);
    const article = await carriedArticle(h, [a, b]);
    await markCapped(a, article);

    const combined = (await list(r)).find((i) => i.id === article);
    expect(combined?.analysis).toEqual({
      mode: 'active',
      status: 'pending',
      requestId: null,
      overDailyCap: null,
    });
    // The feed that capped it shows the hint on its own view.
    const own = (await list(r, { feedId: a })).find((i) => i.id === article);
    expect(own?.analysis).toMatchObject({ status: 'not_requested', overDailyCap: 1000 });
  });

  it('a card or label subscription keeps working: other analysis states carry overDailyCap null', async () => {
    const r = await newReader(h);
    const training = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const article = await carriedArticle(h, [training]);
    const item = (await list(r, { feedId: training })).find((i) => i.id === article);
    expect(item?.analysis).toEqual({
      mode: 'training',
      status: 'not_requested',
      requestId: null,
      overDailyCap: null,
    });
  });
});

describe('explicit selection is never capped', () => {
  it('analyzes an over-cap article of an active feed when it is selected', async () => {
    const user = await createTestUser(h);
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, {
      userId: user.id,
      feedId: feed.id,
      mode: 'active',
      activatedAt: new Date(Date.now() - 30 * DAY),
    });
    const article = await createArticle(h.owner, { feedIds: [feed.id] });
    await markCapped(feed.id, article.id, 0);

    const res = await apiClient(h.server, user).post(`/subscriptions/${feed.id}/analyze`, {
      articles: [{ id: article.id, contentRevision: article.contentRevision }],
      expectedInferenceVersion: '1',
    });
    expect(res.statusCode, res.body).toBe(202);
    const requests = await h.owner.query(
      `SELECT status FROM analysis_requests WHERE user_id = $1 AND article_id = $2`,
      [user.id, article.id],
    );
    expect(requests.rows).toEqual([{ status: 'pending' }]);
  });
});

describe('D-238: a rating of a capped article consumes a slot of the feed/day allowance', () => {
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let seq = 0;
  const inputFor = (feedId: string): IngestItemInput => {
    seq += 1;
    const url = `https://news.example.test/api-cap/${Date.now()}-${seq}`;
    return {
      feedId,
      urlKey: url,
      canonicalUrl: url,
      url,
      guid: `api-cap-${seq}`,
      title: `Cap ${seq}`,
      titleNorm: `cap ${seq}`,
      author: null,
      categories: [],
      excerpt: 'Excerpt',
      excerptHtml: null,
      imageUrl: null,
      publishedAt: ago(2 * 3_600_000),
      contentHash: sha(url),
      feedBody: null,
      media: { videoEvidence: false, feedBodyImageCount: null },
      linkEnclosureType: null,
    };
  };
  const db = () => createDatabase(h.worker);
  async function ingest(feedId: string): Promise<{ id: string; revision: string }> {
    const options = {
      maxAgeDays: 14,
      linkKey: (u: string) => u,
      autoAnalysisDailyCap: CAP,
      now: apiNow(),
    } as Parameters<typeof ingestItem>[3];
    const result = await db().transaction((tx) =>
      ingestItem(tx, workerOutbox(tx), inputFor(feedId), options),
    );
    return { id: result.articleId, revision: result.revision };
  }
  const rate = (user: TestUser, id: string, revision: string) =>
    apiClient(h.server, user).post(`/articles/${id}/rating`, {
      stateVersion: '0',
      contentRevision: revision,
      rating: 1,
    });
  const requestCount = async (userId: string) =>
    (
      await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM analysis_requests WHERE user_id = $1`,
        [userId],
      )
    ).rows[0]!.n;
  const adminCount = async (feedId: string) =>
    (
      await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM feed_items WHERE feed_id = $1 AND over_cap_limit IS NULL`,
        [feedId],
      )
    ).rows[0]!.n;

  it('saves the rating and creates no analysis request when no slot is left', async () => {
    const room = Math.floor((CAP * (HOUR + 1)) / 24);
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    let last = { id: '', revision: '' };
    for (let i = 0; i < room + 1; i += 1) last = await ingest(feed);

    // The arrival that found the allowance used up is over cap.
    const shown = (await list(r, { feedId: feed })).find((i) => i.id === last.id);
    expect(shown?.analysis).toMatchObject({ status: 'not_requested', overDailyCap: CAP });

    const res = await rate(r.user, last.id, last.revision);
    expect(res.statusCode, res.body).toBe(200);
    expect(await requestCount(r.user.id)).toBe(0);
    const events = await h.owner.query(
      `SELECT 1 FROM feedback_events WHERE user_id = $1 AND article_id = $2 AND kind = 'rate'`,
      [r.user.id, last.id],
    );
    expect(events.rowCount).toBe(1);
  });

  it('asks for the analysis while a slot is left, and that rating used the slot', async () => {
    const room = Math.floor((CAP * (HOUR + 1)) / 24);
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    // An arrival the feed skipped earlier (the feed has admitted nothing yet today).
    const article = await carriedArticle(h, [feed]);
    await markCapped(feed, article, CAP);

    const res = await rate(r.user, article, '1');
    expect(res.statusCode, res.body).toBe(200);
    expect(await requestCount(r.user.id)).toBe(1);

    // The rating took one slot: the next arrivals fit `room - 1`, not `room`.
    for (let i = 0; i < room; i += 1) await ingest(feed);
    expect(await adminCount(feed)).toBe(room - 1);
  });
});
