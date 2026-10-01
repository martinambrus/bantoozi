import { randomUUID } from 'node:crypto';

import { createCard } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY,
  HOUR,
  ago,
  carriedArticle,
  carry,
  clusterOf,
  explainJson,
  fence,
  freshFence,
  newReader,
  outbox,
  rank,
  rankRevision,
  setReader,
  subscribedFeed,
  type Reader,
} from './support/article-fixtures.js';
import { apiClient, createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * M4-T6 (spec 08 §5.1–5.2, spec 06 §6.4, §7, §10): the article list (candidate set → demand
 * projection → folding → filters → sort), signed cursors under change, counts, detail and the
 * calibration round, over the `bantoozi_app` role.
 */

let h: ApiHarness;
/** Shifts the API clock (cursor expiry); the database clock is untouched. */
let clockOffsetMs = 0;

beforeAll(async () => {
  h = await createApiHarness({ clock: { now: () => new Date(Date.now() + clockOffsetMs) } });
});

afterAll(async () => {
  await h.close();
});

interface Item {
  id: string;
  lane: string;
  pLike: number | null;
  tier: number | null;
  stateVersion: string;
  contentRevision: string;
  readAt: string | null;
  archivedAt: string | null;
  bookmarkedAt: string | null;
  firstSeenAt: string;
  topReason: Record<string, unknown> | null;
  analysis: { mode: string; status: string; requestId: string | null };
  feed: { id: string; title: string } | null;
  cluster: { id: string; size: number; otherFeeds: string[] } | null;
}

interface Page {
  items: Item[];
  nextCursor: string | null;
  asOf: string;
  datasetVersion: string;
  rankingPending: boolean;
}

async function list(r: Reader, query: Record<string, string> = {}): Promise<Page> {
  const res = await r.api.get('/articles', { query });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Page>();
}

const ids = (page: Page) => page.items.map((item) => item.id);

/** Every page of a list, following `nextCursor`. */
async function listAll(r: Reader, query: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await list(r, cursor === null ? query : { ...query, cursor });
    out.push(...ids(page));
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error('pagination did not end');
}

describe('GET /articles: lanes, statuses and tiers', () => {
  it('filters by lane, status and minTier; hidden never appears in all', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const top = await carriedArticle(h, [feed]);
    const maybe = await carriedArticle(h, [feed]);
    const low = await carriedArticle(h, [feed]);
    const fresh = await carriedArticle(h, [feed]);
    const hidden = await carriedArticle(h, [feed]);
    const readTop = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, top, { lane: 'for_you', p: 0.9, tier: 5 });
    await rank(h, r.user.id, maybe, { lane: 'maybe', p: 0.5, tier: 3 });
    await rank(h, r.user.id, low, { lane: 'everything', p: 0.2, tier: 1 });
    await rank(h, r.user.id, fresh, { lane: 'new' });
    await rank(h, r.user.id, hidden, {
      lane: 'hidden',
      p: 0.1,
      tier: 1,
      rulesFired: ['block_author'],
    });
    await rank(h, r.user.id, readTop, { lane: 'for_you', p: 0.8, tier: 4 });
    await setReader(h, r.user.id, readTop, { readAt: new Date() });

    expect(ids(await list(r))).toEqual([top]);
    expect(new Set(ids(await list(r, { status: 'all' })))).toEqual(new Set([top, readTop]));
    expect(ids(await list(r, { lane: 'maybe' }))).toEqual([maybe]);
    expect(ids(await list(r, { lane: 'maybe', minTier: '4' }))).toEqual([]);
    expect(ids(await list(r, { lane: 'everything' }))).toEqual([low]);
    expect(ids(await list(r, { lane: 'new' }))).toEqual([fresh]);
    expect(new Set(ids(await list(r, { lane: 'all' })))).toEqual(new Set([top, maybe, low, fresh]));
    expect(new Set(ids(await list(r, { lane: 'all', minTier: '4' })))).toEqual(
      new Set([top, low, fresh]),
    );
    expect(ids(await list(r, { lane: 'hidden' }))).toEqual([hidden]);

    const item = (await list(r)).items[0]!;
    expect(item).toMatchObject({ lane: 'for_you', pLike: expect.closeTo(0.9, 5), tier: 5 });
    const newItem = (await list(r, { lane: 'new' })).items[0]!;
    expect(newItem).toMatchObject({ pLike: null, tier: null, stateVersion: '0' });
  });

  it('uses prefs.defaultTier and prefs.sort as defaults', async () => {
    const r = await newReader(h, { defaultTier: 4, sort: 'date' });
    const feed = await subscribedFeed(h, r.user.id);
    const older = await carriedArticle(h, [feed], { publishedAt: ago(3 * DAY), arrival: ago(DAY) });
    const newer = await carriedArticle(h, [feed], { publishedAt: ago(DAY), arrival: ago(DAY) });
    const lowTier = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, older, { lane: 'for_you', p: 0.95, tier: 5 });
    await rank(h, r.user.id, newer, { lane: 'for_you', p: 0.7, tier: 4 });
    await rank(h, r.user.id, lowTier, { lane: 'for_you', p: 0.6, tier: 3 });
    expect(ids(await list(r))).toEqual([newer, older]);
    expect(ids(await list(r, { sort: 'score' }))).toEqual([older, newer]);
    expect(ids(await list(r, { sort: 'score', minTier: '1' }))).toEqual([older, newer, lowTier]);
  });

  it('orders Maybe by uncertainty |P − 0.5|', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const near = await carriedArticle(h, [feed]);
    const far = await carriedArticle(h, [feed]);
    const mid = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, near, { lane: 'maybe', p: 0.52, tier: 3 });
    await rank(h, r.user.id, far, { lane: 'maybe', p: 0.36, tier: 2 });
    await rank(h, r.user.id, mid, { lane: 'maybe', p: 0.6, tier: 3 });
    expect(ids(await list(r, { lane: 'maybe' }))).toEqual([near, mid, far]);
  });

  it('projects ineligible rows as neutral New (spec 06 §6.4) without inferred effects', async () => {
    const r = await newReader(h);
    const off = await subscribedFeed(h, r.user.id, { mode: 'off' });
    const article = await carriedArticle(h, [off]);
    const muted = await carriedArticle(h, [off]);
    const neverCard = await carriedArticle(h, [off]);
    await rank(h, r.user.id, article, { lane: 'for_you', p: 0.9, tier: 5 });
    await rank(h, r.user.id, muted, { lane: 'hidden', rulesFired: ['mute_keyword:crypto'] });
    await rank(h, r.user.id, neverCard, {
      lane: 'hidden',
      p: 0.1,
      tier: 1,
      rulesFired: ['never:5'],
    });
    const page = await list(r, { lane: 'new' });
    expect(new Set(ids(page))).toEqual(new Set([article, neverCard]));
    for (const item of page.items) {
      expect(item).toMatchObject({ lane: 'new', pLike: null, tier: null, topReason: null });
      expect(item.analysis).toEqual({ mode: 'off', status: 'not_requested', requestId: null });
    }
    expect(ids(await list(r, { lane: 'hidden' }))).toEqual([muted]);
    expect((await list(r, { lane: 'for_you' })).items).toEqual([]);
  });

  it('a feed view of an off feed stays neutral while the global view uses the active carrier', async () => {
    const r = await newReader(h);
    const active = await subscribedFeed(h, r.user.id);
    const off = await subscribedFeed(h, r.user.id, { mode: 'off' });
    const article = await carriedArticle(h, [active, off]);
    await rank(h, r.user.id, article, { lane: 'for_you', p: 0.9, tier: 5 });
    expect(ids(await list(r))).toEqual([article]);
    expect(ids(await list(r, { lane: 'for_you', feedId: active }))).toEqual([article]);
    const offView = await list(r, { lane: 'new', feedId: off });
    expect(offView.items.map((i) => [i.id, i.lane, i.pLike])).toEqual([[article, 'new', null]]);
  });
});

describe('GET /articles: analysis status per view', () => {
  it("never shows another feed's analysis request on a direct off-feed view", async () => {
    const r = await newReader(h);
    const off = await subscribedFeed(h, r.user.id, { mode: 'off' });
    const training = await subscribedFeed(h, r.user.id, { mode: 'training' });
    const article = await carriedArticle(h, [off, training]);
    const requestId = randomUUID();
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [r.user.id]);
      await client.query(
        `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                        inference_version, input_snapshot, input_sha)
         SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, '{}'::jsonb,
                encode(sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'hex')
           FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
          WHERE a.id = $4`,
        [requestId, r.user.id, training, article],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const offView = await list(r, { lane: 'new', feedId: off });
    expect(offView.items.map((i) => i.analysis)).toEqual([
      { mode: 'off', status: 'not_requested', requestId: null },
    ]);
    const trainingView = await list(r, { lane: 'new', feedId: training });
    expect(trainingView.items.map((i) => i.analysis)).toEqual([
      { mode: 'training', status: 'pending', requestId },
    ]);
  });
});

describe('GET /articles: folding', () => {
  it('folds before the lane filter, with mixed allow_duplicates carriers', async () => {
    const r = await newReader(h);
    const strict = await subscribedFeed(h, r.user.id, { title: 'Strict feed' });
    const loose = await subscribedFeed(h, r.user.id, {
      allowDuplicates: true,
      title: 'Loose feed',
    });
    const a1 = await carriedArticle(h, [strict]);
    const a2 = await carriedArticle(h, [loose]);
    const a3 = await carriedArticle(h, [loose]);
    await carry(h, strict, a3);
    await clusterOf(h, [a1, a2, a3]);
    // a1 and a3 have a strict carrier (foldable); a2 only a loose one (its own row).
    await rank(h, r.user.id, a1, { lane: 'maybe', p: 0.55, tier: 3 });
    await rank(h, r.user.id, a2, { lane: 'everything', p: 0.3, tier: 1 });
    await rank(h, r.user.id, a3, { lane: 'for_you', p: 0.8, tier: 4 });

    const all = await list(r, { lane: 'all' });
    expect(new Set(ids(all))).toEqual(new Set([a3, a2]));
    const folded = all.items.find((i) => i.id === a3)!;
    expect(folded.cluster).toMatchObject({ size: 2 });
    expect(all.items.find((i) => i.id === a2)!.cluster).toBeNull();
    // The representative is chosen before the lane filter: Maybe shows no folded member.
    expect(ids(await list(r, { lane: 'maybe' }))).toEqual([]);
    expect(ids(await list(r, { lane: 'for_you' }))).toEqual([a3]);
  });

  it('lists an unread story through its best unread member; filter mark-read marks it', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const best = await carriedArticle(h, [feed]);
    const second = await carriedArticle(h, [feed]);
    const third = await carriedArticle(h, [feed]);
    await clusterOf(h, [best, second, third]);
    await rank(h, r.user.id, best, { lane: 'for_you', p: 0.95, tier: 5 });
    await rank(h, r.user.id, second, { lane: 'for_you', p: 0.8, tier: 4 });
    await rank(h, r.user.id, third, { lane: 'everything', p: 0.3, tier: 1 });
    await setReader(h, r.user.id, best, { readAt: new Date() });

    const page = await list(r, { lane: 'all' });
    expect(ids(page)).toEqual([second]);
    expect(page.items[0]!.cluster).toMatchObject({ size: 3 });
    expect(ids(await list(r, { lane: 'all', status: 'all' }))).toEqual([best]);

    const res = await r.api.post('/articles/mark-read', {
      filter: { lane: 'all', olderThan: page.asOf },
      datasetVersion: page.datasetVersion,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ count: 1 });
    const read = await h.owner.query<{ article_id: string }>(
      `SELECT article_id::text FROM user_article WHERE user_id = $1 AND read_at IS NOT NULL ORDER BY article_id`,
      [r.user.id],
    );
    expect(read.rows.map((row) => row.article_id).sort()).toEqual([best, second].sort());
    // The third member now represents the story.
    expect(ids(await list(r, { lane: 'all' }))).toEqual([third]);
  });

  it("counts only members accessible in the view, never other users' feeds", async () => {
    const r = await newReader(h);
    const other = await newReader(h);
    const mine = await subscribedFeed(h, r.user.id, { title: 'My feed' });
    const theirs = await subscribedFeed(h, other.user.id, { title: 'Their private feed' });
    const a1 = await carriedArticle(h, [mine]);
    const a2 = await carriedArticle(h, [theirs]);
    await clusterOf(h, [a1, a2]);
    await rank(h, r.user.id, a1, { lane: 'for_you', p: 0.9, tier: 5 });
    const page = await list(r);
    expect(page.items[0]!.cluster).toEqual({ id: expect.any(String), size: 1, otherFeeds: [] });
    const detail = await r.api.get(`/articles/${a1}`);
    expect(detail.json().clusterMembers.map((m: { id: string }) => m.id)).toEqual([]);
    expect(detail.body).not.toContain('Their private feed');
  });
});

describe('GET /articles: windows and bookmarks', () => {
  it('uses the subscribed carrier arrival, not the global first sighting', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const elsewhere = await subscribedFeed(h, (await newReader(h)).user.id);
    const old = await carriedArticle(h, [elsewhere], { arrival: ago(40 * DAY) });
    await carry(h, feed, old, ago(HOUR));
    const stale = await carriedArticle(h, [feed], { arrival: ago(20 * DAY) });
    const page = await list(r, { lane: 'all' });
    expect(ids(page)).toContain(old);
    expect(ids(page)).not.toContain(stale);
    const item = page.items.find((i) => i.id === old)!;
    expect(Date.parse(item.firstSeenAt)).toBeGreaterThan(Date.now() - 2 * HOUR);
  });

  it('bookmarks default to status=all and ignore the window and hiding', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const old = await carriedArticle(h, [feed], { arrival: ago(40 * DAY) });
    const fresh = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, fresh, { lane: 'hidden', rulesFired: ['block_feed'] });
    for (const id of [old, fresh]) {
      const res = await r.api.post(`/articles/${id}/bookmark`, freshFence);
      expect(res.statusCode, res.body).toBe(200);
    }
    await setReader(h, r.user.id, old, { readAt: new Date() });
    expect(new Set(ids(await list(r, { lane: 'bookmarks' })))).toEqual(new Set([old, fresh]));
    expect(ids(await list(r, { lane: 'bookmarks', status: 'unread' }))).toEqual([fresh]);
    const counts = (await r.api.get('/articles/counts')).json();
    expect(counts.bookmarks).toBe(2);
  });
});

describe('GET /articles: cursors', () => {
  async function sameScoreReader(n: number) {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const arrival = ago(HOUR);
    const articles: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = await carriedArticle(h, [feed], { arrival });
      await rank(h, r.user.id, id, { lane: 'for_you', p: 0.8, tier: 4 });
      articles.push(id);
    }
    return { r, feed, articles };
  }

  it('pages through equal sort keys by id without repeats or skips', async () => {
    const { r, articles } = await sameScoreReader(5);
    for (const sort of ['score', 'date']) {
      const all = await listAll(r, { limit: '2', sort });
      expect(all).toEqual([...articles].sort((a, b) => Number(b) - Number(a)));
    }
  });

  it('keeps microsecond arrivals exact in the keyset (no repeats across pages)', async () => {
    const { r, articles } = await sameScoreReader(6);
    await h.owner.query(
      `UPDATE feed_items fi
          SET first_seen_at = date_trunc('second', now()) - interval '1 hour'
                              + make_interval(secs => x.ord * 0.000001)
         FROM unnest($1::bigint[]) WITH ORDINALITY AS x(id, ord)
        WHERE fi.article_id = x.id`,
      [articles],
    );
    for (const sort of ['score', 'date']) {
      const all = await listAll(r, { limit: '2', sort });
      expect(all).toEqual([...articles].reverse());
    }
  });

  it('keeps asOf: a new arrival does not shift the pages', async () => {
    const { r, feed, articles } = await sameScoreReader(3);
    const first = await list(r, { limit: '2' });
    const late = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, late, { lane: 'for_you', p: 0.99, tier: 5 });
    const second = await list(r, { limit: '2', cursor: first.nextCursor! });
    expect(second.asOf).toBe(first.asOf);
    expect([...ids(first), ...ids(second)].sort()).toEqual([...articles].sort());
    expect(ids(await list(r))).toContain(late);
  });

  it('a requested rerank (rank_revision bump) between pages is STALE_CURSOR before any row moves', async () => {
    const { r } = await sameScoreReader(3);
    const first = await list(r, { limit: '2' });
    await h.owner.query('UPDATE users SET rank_revision = rank_revision + 1 WHERE id = $1', [
      r.user.id,
    ]);
    const res = await r.api.get('/articles', { query: { limit: '2', cursor: first.nextCursor! } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STALE_CURSOR');
  });

  it('a rerank between pages is STALE_CURSOR', async () => {
    const { r, articles } = await sameScoreReader(3);
    const first = await list(r, { limit: '2' });
    await rank(h, r.user.id, articles[0]!, { lane: 'for_you', p: 0.81, tier: 4 });
    const res = await r.api.get('/articles', { query: { limit: '2', cursor: first.nextCursor! } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STALE_CURSOR');
  });

  it('rejects an expired, foreign or other-query cursor', async () => {
    const { r } = await sameScoreReader(3);
    const first = await list(r, { limit: '2' });
    const cursor = first.nextCursor!;
    const other = await newReader(h);
    const foreign = await other.api.get('/articles', { query: { limit: '2', cursor } });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('VALIDATION_FAILED');
    const mismatch = await r.api.get('/articles', { query: { lane: 'maybe', cursor } });
    expect(mismatch.statusCode).toBe(400);
    const tampered = await r.api.get('/articles', { query: { cursor: `${cursor}x` } });
    expect(tampered.statusCode).toBe(400);
    clockOffsetMs = 16 * 60 * 1000;
    try {
      const expired = await r.api.get('/articles', { query: { limit: '2', cursor } });
      expect(expired.statusCode).toBe(400);
    } finally {
      clockOffsetMs = 0;
    }
  });
});

describe('GET /articles/counts', () => {
  it('agrees with the list totals and reports scored/total', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id, { folder: 'News' });
    const loose = await subscribedFeed(h, r.user.id, { allowDuplicates: true });
    const lanes = ['for_you', 'for_you', 'maybe', 'everything', 'new', 'new'] as const;
    const made: string[] = [];
    for (const [i, lane] of lanes.entries()) {
      const id = await carriedArticle(h, [i % 2 === 0 ? feed : loose]);
      made.push(id);
      await rank(h, r.user.id, id, {
        lane,
        p: lane === 'new' ? null : 0.9 - i * 0.1,
        tier: lane === 'new' ? null : 5 - i,
      });
    }
    await clusterOf(h, [made[0]!, made[2]!]);
    const counts = (await r.api.get('/articles/counts')).json();
    const asOf = counts.asOf as string;
    const sizes: Record<string, number> = {};
    for (const lane of ['for_you', 'maybe', 'everything', 'new', 'all']) {
      const page = await list(r, { lane, limit: '100' });
      sizes[lane] = page.items.length;
    }
    expect(counts).toMatchObject({
      forYou: sizes['for_you'],
      maybe: sizes['maybe'],
      everything: sizes['everything'],
      new: sizes['new'],
      scored: sizes['for_you']! + sizes['maybe']! + sizes['everything']!,
      total: sizes['all'],
      hidden: 0,
      bookmarks: 0,
    });
    expect(counts.total).toBe(5);
    const allPage = await list(r, { lane: 'all' });
    const again = (await r.api.get('/articles/counts', { query: { asOf: allPage.asOf } })).json();
    expect(again.datasetVersion).toBe(allPage.datasetVersion);
    expect(asOf).toEqual(expect.any(String));
    const folder = (await r.api.get('/articles/counts', { query: { folder: 'News' } })).json();
    expect(folder.total).toBe((await list(r, { lane: 'all', folder: 'News' })).items.length);
  });

  it('an outdated score_version enqueues a full rank without a revision bump', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const article = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, article, { lane: 'for_you', p: 0.9, tier: 5 });
    expect((await list(r)).rankingPending).toBe(false);
    expect(await outbox(h, r.user.id, 'user.rank')).toEqual([]);

    await rank(h, r.user.id, article, { lane: 'for_you', p: 0.9, tier: 5, scoreVersion: '1:7' });
    const before = await rankRevision(h, r.user.id);
    const page = await list(r);
    expect(page.rankingPending).toBe(true);
    expect(ids(page)).toEqual([article]);
    expect((await outbox(h, r.user.id, 'user.rank')).map((j) => j.payload)).toEqual([
      { userId: r.user.id, reason: 'list', full: true },
    ]);
    expect(await rankRevision(h, r.user.id)).toBe(before);
    expect((await r.api.get('/articles/counts')).json().rankingPending).toBe(true);
    // Read, so the default unread counts are empty: the outdated projection is still pending.
    await h.owner.query(`UPDATE user_article SET read_at = now() WHERE user_id = $1`, [r.user.id]);
    const unread = (await r.api.get('/articles/counts')).json();
    expect(unread).toMatchObject({ total: 0, rankingPending: true });

    // A plain untrained article of an off feed is not pending.
    const quiet = await newReader(h);
    const off = await subscribedFeed(h, quiet.user.id, { mode: 'off' });
    await carriedArticle(h, [off]);
    expect((await list(quiet, { lane: 'new' })).rankingPending).toBe(false);
    expect(await outbox(h, quiet.user.id, 'user.rank')).toEqual([]);
  });
});

describe('GET /articles/:id', () => {
  it('applies the 404 rule', async () => {
    const r = await newReader(h);
    const other = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const theirFeed = await subscribedFeed(h, other.user.id);
    const mine = await carriedArticle(h, [feed]);
    const theirs = await carriedArticle(h, [theirFeed]);
    expect((await r.api.get(`/articles/${mine}`)).statusCode).toBe(200);
    expect((await r.api.get(`/articles/${theirs}`)).statusCode).toBe(404);
    expect((await r.api.get('/articles/999999999')).statusCode).toBe(404);
    expect(
      (await r.api.get(`/articles/${mine}`, { query: { sourceFeedId: theirFeed } })).statusCode,
    ).toBe(404);
    expect((await r.api.get(`/articles/${mine}`, { query: { view: 'saved' } })).statusCode).toBe(
      404,
    );
    // Another user's bookmark grants nothing.
    await other.api.post(`/articles/${theirs}/bookmark`, {
      stateVersion: '0',
      contentRevision: '1',
    });
    expect((await r.api.get(`/articles/${theirs}`)).statusCode).toBe(404);
    expect((await r.api.get(`/articles/${theirs}`, { query: { view: 'saved' } })).statusCode).toBe(
      404,
    );
  });

  it('returns the detail with topReason titles of held cards and the projected explanation', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const card = await createCard(h.owner, { title: 'Battery chemistry' });
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
      [r.user.id, card.id],
    );
    const article = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, article, {
      lane: 'for_you',
      p: 0.9,
      tier: 5,
      explain: explainJson({
        p: 0.9,
        lane: 'for_you',
        tier: 5,
        decidingCardId: card.id,
        cards: [{ id: card.id, title: 'Old title', strength: 'love', p: 0.9, engine: 'typesafe' }],
      }),
    });
    const res = await r.api.get(`/articles/${article}`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json();
    expect(detail.topReason).toEqual({
      kind: 'card',
      cardId: card.id,
      title: 'Battery chemistry',
      p: 0.9,
    });
    expect(detail.explain).toMatchObject({ source: 'cards', decidingCardId: card.id });
    expect(detail.feed).toMatchObject({ id: feed });
    expect(detail).toHaveProperty('bookmarkSnapshot', null);
  });
});

describe('lane=hidden and unhide', () => {
  it('recovers an explicitly hidden item and explains rule hiding', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const archived = await carriedArticle(h, [feed]);
    const ruled = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, archived, { lane: 'for_you', p: 0.9, tier: 5 });
    await rank(h, r.user.id, ruled, {
      lane: 'hidden',
      p: 0.9,
      tier: 5,
      rulesFired: ['mute_story'],
      explain: explainJson({
        p: 0.9,
        lane: 'hidden',
        tier: 5,
        rules: [{ code: 'mute_story', ruleId: '77' }],
      }),
    });
    const rated = await r.api.post(`/articles/${archived}/rating`, {
      ...fence({ stateVersion: '0', contentRevision: '1' }),
      rating: -1,
      reason: 'seen',
      hide: true,
    });
    expect(rated.statusCode, rated.body).toBe(200);
    expect(ids(await list(r, { lane: 'all', status: 'all' }))).not.toContain(archived);
    const hidden = await list(r, { lane: 'hidden' });
    expect(new Set(ids(hidden))).toEqual(new Set([archived, ruled]));
    expect(hidden.items.find((i) => i.id === ruled)!.topReason).toEqual({
      kind: 'rule',
      code: 'mute_story',
      ruleId: '77',
    });
    const item = hidden.items.find((i) => i.id === archived)!;
    const unhide = await r.api.post(`/articles/${archived}/unhide`, fence(item));
    expect(unhide.statusCode, unhide.body).toBe(200);
    expect(unhide.json().item).toMatchObject({ archivedAt: null, rating: -1, reason: 'seen' });
    expect(ids(await list(r, { lane: 'hidden' }))).toEqual([ruled]);
    expect(ids(await list(r, { lane: 'for_you', status: 'all' }))).toContain(archived);
    const counts = (await r.api.get('/articles/counts', { query: { status: 'all' } })).json();
    expect(counts.hidden).toBe(1);
  });
});

describe('GET /articles/calibration', () => {
  it('returns unrated eligible items, most uncertain Maybe first, at most 3 per feed', async () => {
    const r = await newReader(h);
    const a = await subscribedFeed(h, r.user.id);
    const b = await subscribedFeed(h, r.user.id);
    const off = await subscribedFeed(h, r.user.id, { mode: 'off' });
    const made: Record<string, string> = {};
    const specs: [string, string, 'maybe' | 'everything' | 'for_you', number][] = [
      ['m1', a, 'maybe', 0.5],
      ['m2', a, 'maybe', 0.55],
      ['m3', a, 'maybe', 0.6],
      ['m4', a, 'maybe', 0.62],
      ['e1', b, 'everything', 0.3],
      ['e2', b, 'everything', 0.1],
      ['f1', b, 'for_you', 0.9],
    ];
    for (const [key, feed, lane, p] of specs) {
      made[key] = await carriedArticle(h, [feed]);
      await rank(h, r.user.id, made[key]!, { lane, p, tier: 3 });
    }
    const offArticle = await carriedArticle(h, [off]);
    await rank(h, r.user.id, offArticle, { lane: 'maybe', p: 0.5, tier: 3 });
    const old = await carriedArticle(h, [b], { arrival: ago(8 * DAY) });
    await rank(h, r.user.id, old, { lane: 'maybe', p: 0.5, tier: 3 });

    const res = await r.api.get('/articles/calibration');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((i: Item) => i.id)).toEqual([
      made['m1'],
      made['m2'],
      made['m3'],
      made['e1'],
      made['e2'],
    ]);
  });
});

describe('subscriptions and scope', () => {
  it('a feed view includes a hidden subscription; the global view does not', async () => {
    const r = await newReader(h);
    const hiddenFeed = await subscribedFeed(h, r.user.id, { hidden: true });
    const article = await carriedArticle(h, [hiddenFeed]);
    expect(ids(await list(r, { lane: 'all' }))).toEqual([]);
    expect(ids(await list(r, { lane: 'all', feedId: hiddenFeed }))).toEqual([article]);
  });

  it('requires a session', async () => {
    expect((await apiClient(h.server).get('/articles')).statusCode).toBe(401);
  });
});
