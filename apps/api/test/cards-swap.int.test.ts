import { randomUUID } from 'node:crypto';

import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  BETA_LIMITS,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * Swapping a card at the card limit (`replaceCardId` on POST /cards and /cards/from-article) and
 * GET /cards/usage (liked matches per held card in the last 90 days).
 */

let h: ApiHarness;
let questionSetSha: string;

beforeAll(async () => {
  h = await createApiHarness();
  const version = `swap-${randomUUID()}`;
  const { rows } = await h.owner.query<{ sha: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', $1, encode(sha256(convert_to($1, 'UTF8')), 'hex'), '{}'::jsonb)
     RETURNING sha256 AS sha`,
    [version],
  );
  questionSetSha = rows[0]!.sha;
});

afterAll(async () => {
  await h.close();
});

let sequence = 0;
const unique = (text: string) => {
  sequence += 1;
  return `${text} (variant ${sequence} ${randomUUID().slice(0, 8)})`;
};

async function heldIds(userId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ id: string }>(
    'SELECT card_id::text AS id FROM user_cards WHERE user_id = $1 ORDER BY card_id',
    [userId],
  );
  return rows.map((row) => row.id);
}

async function reader() {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: unique('Solid-state battery pilot line reaches 1,000 cycles'),
  });
  return { user, feed, article, api: apiClient(h.server, user) };
}

async function hold(userId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const card = await createCard(h.owner, { interest: unique('Filler interest') });
    await h.owner.query(
      "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
      [userId, card.id],
    );
    ids.push(card.id);
  }
  return ids;
}

describe('replaceCardId (swap at the card limit)', () => {
  it('POST /cards at the limit with a held replaceCardId swaps the holding', async () => {
    const { user, api } = await reader();
    const held = await hold(user.id, BETA_LIMITS.maxCards);
    const res = await api.post('/cards', {
      interest: unique('Swapped-in interest'),
      strength: 'like',
      replaceCardId: held[0],
    });
    expect(res.statusCode).toBe(201);
    const { card } = res.json();
    const after = await heldIds(user.id);
    expect(after).toHaveLength(BETA_LIMITS.maxCards);
    expect(after).not.toContain(held[0]);
    expect(after).toContain(card.id);
  });

  it('POST /cards/from-article at the limit with a held replaceCardId swaps the holding', async () => {
    const { user, article, api } = await reader();
    const held = await hold(user.id, BETA_LIMITS.maxCards);
    const res = await api.post('/cards/from-article', {
      articleId: article.id,
      interest: unique('Swapped-in from article'),
      strength: 'like',
      replaceCardId: held[0],
    });
    expect(res.statusCode).toBe(201);
    const { card } = res.json();
    const after = await heldIds(user.id);
    expect(after).toHaveLength(BETA_LIMITS.maxCards);
    expect(after).not.toContain(held[0]);
    expect(after).toContain(card.id);
  });

  it('POST /cards with an unknown replaceCardId is 404 and creates nothing', async () => {
    const { user, api } = await reader();
    const held = await hold(user.id, 2);
    const res = await api.post('/cards', {
      interest: unique('Never created'),
      strength: 'like',
      replaceCardId: '999999999999',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await heldIds(user.id)).toEqual(held);
  });

  it('a replaceCardId held only by another user is 404 on both endpoints, holdings unchanged', async () => {
    const a = await reader();
    const b = await reader();
    const mine = await hold(a.user.id, 2);
    const [theirs] = await hold(b.user.id, 1);
    const create = await a.api.post('/cards', {
      interest: unique('Never created'),
      strength: 'like',
      replaceCardId: theirs,
    });
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe('NOT_FOUND');
    const fromArticle = await a.api.post('/cards/from-article', {
      articleId: a.article.id,
      interest: unique('Never created from article'),
      strength: 'like',
      replaceCardId: theirs,
    });
    expect(fromArticle.statusCode).toBe(404);
    expect(fromArticle.json().error.code).toBe('NOT_FOUND');
    expect(await heldIds(a.user.id)).toEqual(mine);
    expect(await heldIds(b.user.id)).toEqual([theirs]);
  });

  it('keeps the replaced card when the create fails (already_held rollback)', async () => {
    const { user, api } = await reader();
    const [replaced] = await hold(user.id, 1);
    const interest = unique('Already held interest');
    const first = await api.post('/cards', { interest, strength: 'like' });
    expect(first.statusCode).toBe(201);
    const before = await heldIds(user.id);
    const res = await api.post('/cards', { interest, strength: 'love', replaceCardId: replaced });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already_held' },
    });
    expect(await heldIds(user.id)).toEqual(before);
    expect(await heldIds(user.id)).toContain(replaced);
  });

  it('without replaceCardId at the limit it is still QUOTA_EXCEEDED', async () => {
    const { user, api } = await reader();
    const held = await hold(user.id, BETA_LIMITS.maxCards);
    const res = await api.post('/cards', { interest: unique('One too many'), strength: 'like' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxCards', used: BETA_LIMITS.maxCards, max: BETA_LIMITS.maxCards },
    });
    expect(await heldIds(user.id)).toEqual(held.slice().sort((x, y) => Number(x) - Number(y)));
  });
});

describe('GET /cards/usage', () => {
  async function rate(
    userId: string,
    articleId: string,
    rating: 1 | -1,
    ratedAt = new Date(),
  ): Promise<void> {
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, article_id) DO UPDATE SET rating = EXCLUDED.rating, rated_at = EXCLUDED.rated_at`,
      [userId, articleId, rating, ratedAt],
    );
  }

  async function answer(
    articleId: string,
    cardId: string,
    p: number,
    opts: { engine?: string; revision?: string } = {},
  ): Promise<void> {
    const revision =
      opts.revision ??
      (
        await h.owner.query<{ r: string }>(
          'SELECT content_revision::text AS r FROM articles WHERE id = $1',
          [articleId],
        )
      ).rows[0]!.r;
    await h.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, $3, $4, $5, $6, 'state', 'input', 'native')
       ON CONFLICT (article_id, card_id) DO UPDATE SET p = EXCLUDED.p, engine = EXCLUDED.engine,
         article_revision = EXCLUDED.article_revision`,
      [articleId, cardId, p, opts.engine ?? 'typesafe', questionSetSha, revision],
    );
  }

  async function article(feedId: string) {
    return createArticle(h.owner, { feedIds: [feedId], title: unique('Usage article') });
  }

  const days = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('counts liked, recent, current-revision, non-prefilter matches at or above lanes.maybe', async () => {
    const { user, feed, api } = await reader();
    const [counted, other, empty] = await hold(user.id, 3);
    const stranger = await createTestUser(h);

    // Counted: two distinct liked articles for `counted`.
    const a1 = await article(feed.id);
    const a2 = await article(feed.id);
    for (const a of [a1, a2]) {
      await rate(user.id, a.id, 1, days(5));
      await answer(a.id, counted!, 0.9);
    }
    // Same article also matches `other` once.
    await answer(a1.id, other!, 0.9);
    // Below lanes.maybe: not counted.
    const low = await article(feed.id);
    await rate(user.id, low.id, 1, days(1));
    await answer(low.id, counted!, 0.1);
    // Older than 90 days: not counted.
    const old = await article(feed.id);
    await rate(user.id, old.id, 1, days(120));
    await answer(old.id, counted!, 0.9);
    // Disliked: not counted.
    const disliked = await article(feed.id);
    await rate(user.id, disliked.id, -1, days(1));
    await answer(disliked.id, counted!, 0.9);
    // Prefilter engine: not counted.
    const pre = await article(feed.id);
    await rate(user.id, pre.id, 1, days(1));
    await answer(pre.id, counted!, 0.9, { engine: 'prefilter' });
    // Stale revision: not counted.
    const stale = await article(feed.id);
    await rate(user.id, stale.id, 1, days(1));
    await answer(stale.id, counted!, 0.9, { revision: '7' });
    // Another user's like: not counted.
    const foreign = await article(feed.id);
    await rate(stranger.id, foreign.id, 1, days(1));
    await answer(foreign.id, counted!, 0.9);

    const res = await api.get('/cards/usage');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cardId: string; likedMatches: number }[];
    expect(body).toHaveLength(3);
    const byCard = new Map(body.map((row) => [row.cardId, row.likedMatches]));
    expect(byCard.get(counted!)).toBe(2);
    expect(byCard.get(other!)).toBe(1);
    expect(byCard.get(empty!)).toBe(0);
  });

  it('returns an empty list for a user holding no cards', async () => {
    const { api } = await reader();
    const res = await api.get('/cards/usage');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
