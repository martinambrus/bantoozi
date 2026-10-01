import { randomUUID } from 'node:crypto';

import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T5 (spec 08 §7, spec 05 §5.1): the interest-card endpoints over the `bantoozi_app` role. Each
 * endpoint maps to one card lifecycle action; text and example changes return the new card id with
 * `idChange`; renames change nothing but the holder's name (no rank); quotas, the per-user card
 * write limit, idempotent replay and cross-user ids are exercised.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

interface Intent {
  queue: string;
  payload: Record<string, unknown>;
}

/**
 * Mark every pending intent delivered (as the relay would), so identical later intents are not
 * coalesced into them, and return the newest outbox id.
 */
async function outboxMark(): Promise<string> {
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
  const { rows } = await h.owner.query<{ id: string }>(
    'SELECT coalesce(max(id), 0)::text AS id FROM job_outbox',
  );
  return rows[0]!.id;
}

async function intentsSince(userId: string, mark: string): Promise<Intent[]> {
  const { rows } = await h.owner.query<Intent>(
    'SELECT queue, payload FROM job_outbox WHERE user_id = $1 AND id > $2 ORDER BY id',
    [userId, mark],
  );
  return rows;
}

async function rankRevision(userId: string): Promise<string> {
  const { rows } = await h.owner.query<{ r: string }>(
    'SELECT rank_revision::text AS r FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.r;
}

async function heldIds(userId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ id: string }>(
    'SELECT card_id::text AS id FROM user_cards WHERE user_id = $1 ORDER BY card_id',
    [userId],
  );
  return rows.map((row) => row.id);
}

let sequence = 0;
const unique = (text: string) => {
  sequence += 1;
  return `${text} (variant ${sequence} ${randomUUID().slice(0, 8)})`;
};

/** A reader subscribed (`mode`) to a new feed carrying one article. */
async function reader(mode: 'off' | 'training' | 'active' = 'active') {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: unique('Solid-state battery pilot line reaches 1,000 cycles'),
  });
  return { user, feed, article, api: apiClient(h.server, user) };
}

async function createInterest(user: TestUser, body: Record<string, unknown> = {}) {
  const res = await apiClient(h.server, user).post('/cards', {
    interest: unique('New battery chemistry for electric vehicles'),
    strength: 'like',
    ...body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    card: Record<string, unknown> & { id: string };
    idChange: unknown;
    translation: unknown;
  };
}

describe('GET/POST /cards', () => {
  it('creates a card, lists it and records refresh/backfill/rank/learn intents', async () => {
    const { user, feed, api } = await reader('active');
    expect((await api.get('/cards')).json()).toEqual([]);
    const mark = await outboxMark();
    const before = await rankRevision(user.id);
    const interest = unique('New battery chemistry for electric vehicles');
    const res = await api.post('/cards', {
      title: 'EV batteries',
      interest,
      notFor: 'Stock-price moves',
      strength: 'love',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      idChange: null,
      translation: null,
      card: {
        kind: 'interest',
        title: 'EV batteries',
        interest,
        notFor: 'Stock-price moves',
        strength: 'love',
        scopeFeedId: null,
        origin: 'user',
        isPrivateFork: false,
        examplesYes: [],
        examplesNo: [],
      },
    });
    const list = (await api.get('/cards')).json();
    expect(list).toEqual([body.card]);
    const queues = (await intentsSince(user.id, mark)).map((i) => i.queue);
    expect(queues).toEqual(expect.arrayContaining(['card.backfill', 'user.rank', 'user.learn']));
    const backfill = (await intentsSince(user.id, mark)).find((i) => i.queue === 'card.backfill');
    expect(backfill?.payload).toMatchObject({ cardIds: [body.card.id], feedIds: [feed.id] });
    expect(BigInt(await rankRevision(user.id))).toBeGreaterThan(BigInt(before));
  });

  it('rejects invalid bodies with 400 VALIDATION_FAILED', async () => {
    const { api } = await reader();
    for (const body of [
      { interest: 'Valid interest text', strength: 'adore' },
      { interest: 'Valid interest text', strength: 'like', extra: true },
      { strength: 'like' },
      { interest: 'x'.repeat(301), strength: 'like' },
      { interest: 'Valid interest text', strength: 'like', scopeFeedId: 'feed-1' },
      { interest: '  ', strength: 'like' },
    ]) {
      const res = await api.post('/cards', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('answers a replayed Idempotency-Key from its receipt without a second holding', async () => {
    const { user, api } = await reader();
    const key = randomUUID();
    const body = { interest: unique('Rust programming language releases'), strength: 'like' };
    const first = await api.post('/cards', body, { idempotencyKey: key });
    const second = await api.post('/cards', body, { idempotencyKey: key });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(await heldIds(user.id)).toEqual([first.json().card.id]);
    const conflict = await api.post(
      '/cards',
      { ...body, strength: 'love' },
      { idempotencyKey: key },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('reuses the shared card of the same text for a second user without revealing the first', async () => {
    const a = await reader();
    const b = await reader();
    const interest = unique('Hiking routes in the High Tatras');
    const ca = (await a.api.post('/cards', { interest, strength: 'like' })).json();
    const cb = (
      await b.api.post('/cards', { interest: interest.toUpperCase(), strength: 'must' })
    ).json();
    expect(cb.card.id).toBe(ca.card.id);
    expect(cb.card.strength).toBe('must');
    expect((await a.api.get('/cards')).json()[0].strength).toBe('like');
  });
});

describe('PATCH /cards/:id', () => {
  it('renames in place without effects: no rank, no learn, same id', async () => {
    const { user, api } = await reader();
    const { card } = await createInterest(user);
    const mark = await outboxMark();
    const before = await rankRevision(user.id);
    const res = await api.patch(`/cards/${card.id}`, { title: 'My own name' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      idChange: null,
      card: { id: card.id, title: 'My own name', titleOverride: 'My own name' },
    });
    expect(await intentsSince(user.id, mark)).toEqual([]);
    expect(await rankRevision(user.id)).toBe(before);
    // The title is read by card id: the list shows the new name for the same id.
    expect((await api.get('/cards')).json()[0]).toMatchObject({
      id: card.id,
      title: 'My own name',
    });
    const cleared = await api.patch(`/cards/${card.id}`, { title: null });
    expect(cleared.json().card.titleOverride).toBeNull();
  });

  it('re-points an edited text to another card id and returns idChange', async () => {
    const { user, api } = await reader();
    const { card } = await createInterest(user);
    const interest = unique('Sodium-ion battery research');
    const res = await api.patch(`/cards/${card.id}`, { interest });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.card.id).not.toBe(card.id);
    expect(body.idChange).toEqual({ from: card.id, to: body.card.id });
    expect(body.card.interest).toBe(interest);
    expect(await heldIds(user.id)).toEqual([body.card.id]);
    // The stale id is no longer held: 404, and no implicit holding is created.
    const stale = await api.patch(`/cards/${card.id}`, { strength: 'love' });
    expect(stale.statusCode).toBe(404);
    expect(await heldIds(user.id)).toEqual([body.card.id]);
  });

  it('changes strength and scope with rank and learn intents', async () => {
    const { user, feed, api } = await reader('active');
    const { card } = await createInterest(user);
    const mark = await outboxMark();
    const res = await api.patch(`/cards/${card.id}`, { strength: 'never', scopeFeedId: feed.id });
    expect(res.json()).toMatchObject({
      idChange: null,
      card: { id: card.id, strength: 'never', scopeFeedId: feed.id },
    });
    const queues = (await intentsSince(user.id, mark)).map((i) => i.queue);
    expect(queues).toEqual(expect.arrayContaining(['user.rank', 'user.learn']));
    const back = await api.patch(`/cards/${card.id}`, { scopeFeedId: null });
    expect(back.json().card.scopeFeedId).toBeNull();
  });

  it('rejects an empty body, an unknown key and an unsubscribed scope', async () => {
    const { user, api } = await reader();
    const { card } = await createInterest(user);
    const other = await createFeed(h.owner);
    for (const body of [{}, { color: '#000000' }, { scopeFeedId: other.id }]) {
      const res = await api.patch(`/cards/${card.id}`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('examples, from-article and delete', () => {
  it('adds and removes an article example through private forks', async () => {
    const { user, article, api } = await reader();
    const { card } = await createInterest(user);
    const added = await api.post(`/cards/${card.id}/examples`, {
      articleId: article.id,
      side: 'yes',
    });
    expect(added.statusCode).toBe(200);
    const fork = added.json();
    expect(fork.card).toMatchObject({ isPrivateFork: true, origin: 'fork' });
    expect(fork.card.examplesYes).toHaveLength(1);
    expect(fork.idChange).toEqual({ from: card.id, to: fork.card.id });

    const removed = await api.post(`/cards/${fork.card.id}/examples/remove`, {
      side: 'yes',
      text: fork.card.examplesYes[0],
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().card).toMatchObject({ id: card.id, isPrivateFork: false });
    expect(removed.json().idChange).toEqual({ from: fork.card.id, to: card.id });

    const missing = await api.post(`/cards/${card.id}/examples/remove`, {
      side: 'no',
      text: 'never added',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('needs an article the user can see: other feeds are 404, untitled ones 400', async () => {
    const { user, feed, api } = await reader();
    const { card } = await createInterest(user);
    const foreignFeed = await createFeed(h.owner);
    const foreign = await createArticle(h.owner, { feedIds: [foreignFeed.id] });
    const res = await api.post(`/cards/${card.id}/examples`, {
      articleId: foreign.id,
      side: 'yes',
    });
    expect(res.statusCode).toBe(404);
    const untitled = await createArticle(h.owner, { feedIds: [feed.id], title: '   ' });
    const blank = await api.post(`/cards/${card.id}/examples`, {
      articleId: untitled.id,
      side: 'yes',
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error.details).toMatchObject({ reason: 'no_title' });
    const invalid = await api.post(`/cards/${card.id}/examples`, {
      articleId: foreign.id,
      side: 'maybe',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('creates a card from an article as a private fork with the title as example', async () => {
    const { user, article, api } = await reader();
    const res = await api.post('/cards/from-article', {
      articleId: article.id,
      interest: unique('Battery manufacturing scale-up'),
      strength: 'like',
    });
    expect(res.statusCode).toBe(201);
    const { card } = res.json();
    expect(card).toMatchObject({ isPrivateFork: true, origin: 'fork', examplesNo: [] });
    expect(card.examplesYes).toEqual([
      expect.stringContaining('Solid-state battery pilot line reaches 1,000 cycles'),
    ]);
    expect(await heldIds(user.id)).toEqual([card.id]);
  });

  it('deletes a holding with 204, then answers 404', async () => {
    const { user, api } = await reader();
    const { card } = await createInterest(user);
    const mark = await outboxMark();
    const res = await api.delete(`/cards/${card.id}`);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await heldIds(user.id)).toEqual([]);
    expect((await intentsSince(user.id, mark)).map((i) => i.queue)).toEqual(
      expect.arrayContaining(['user.rank', 'user.learn']),
    );
    expect((await api.delete(`/cards/${card.id}`)).statusCode).toBe(404);
  });
});

describe('cross-user ids (spec 08 §1 "Authorization")', () => {
  it('never lists, edits, forks or deletes another user’s card or private fork', async () => {
    const a = await reader();
    const b = await reader();
    const { card: shared } = await createInterest(b.user);
    const fork = (
      await b.api.post(`/cards/${shared.id}/examples`, { articleId: b.article.id, side: 'yes' })
    ).json().card;
    expect((await a.api.get('/cards')).json()).toEqual([]);
    for (const id of [shared.id, fork.id]) {
      expect((await a.api.patch(`/cards/${id}`, { title: 'x' })).statusCode).toBe(404);
      expect((await a.api.patch(`/cards/${id}`, { interest: unique('Taken') })).statusCode).toBe(
        404,
      );
      expect(
        (await a.api.post(`/cards/${id}/examples`, { articleId: a.article.id, side: 'no' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await a.api.post(`/cards/${id}/examples/remove`, { side: 'yes', text: 'x' })).statusCode,
      ).toBe(404);
      expect((await a.api.delete(`/cards/${id}`)).statusCode).toBe(404);
    }
    // B's article (B's feed only) is not A's to use as an example.
    const own = await createInterest(a.user);
    expect(
      (await a.api.post(`/cards/${own.card.id}/examples`, { articleId: b.article.id, side: 'yes' }))
        .statusCode,
    ).toBe(404);
    expect(await heldIds(b.user.id)).toEqual([fork.id]);
  });
});

describe('quotas (spec 08 §6)', () => {
  async function holdShared(userId: string, count: number): Promise<string[]> {
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

  it('maxCards: the 50th card is accepted, the 51st is QUOTA_EXCEEDED', async () => {
    const { user, api } = await reader();
    await holdShared(user.id, 49);
    const ok = await api.post('/cards', { interest: unique('Fiftieth card'), strength: 'like' });
    expect(ok.statusCode).toBe(201);
    const over = await api.post('/cards', { interest: unique('One too many'), strength: 'like' });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxCards', used: 50, max: 50 },
    });
    // An idempotent re-create of a held card uses no quota.
    const replay = await api.post('/cards', {
      interest: ok.json().card.interest,
      strength: 'like',
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().card.id).toBe(ok.json().card.id);
  });

  it('maxForks: the 20th private fork is accepted, the 21st is QUOTA_EXCEEDED', async () => {
    const { user, article, api } = await reader();
    for (let i = 0; i < 19; i += 1) {
      const fork = await createCard(h.owner, {
        visibility: 'private',
        ownerUserId: user.id,
        interest: unique('Private fork filler'),
      });
      await h.owner.query(
        "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
        [user.id, fork.id],
      );
    }
    const [first, second] = await holdShared(user.id, 2);
    const ok = await api.post(`/cards/${first}/examples`, { articleId: article.id, side: 'yes' });
    expect(ok.statusCode).toBe(200);
    const over = await api.post(`/cards/${second}/examples`, {
      articleId: article.id,
      side: 'yes',
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxForks', used: 20, max: 20 },
    });
  });
});

describe('card write rate limit (spec 08 §11)', () => {
  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await h.buildAnother({ env: { RATE_LIMITS_ENABLED: 'true' } });
  });

  it('allows 60 card writes per user and hour, then answers 429', async () => {
    const user = await createTestUser(h);
    const api = apiClient(limited, user);
    const created = await api.post('/cards', {
      interest: unique('Rate-limited interest'),
      strength: 'like',
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-ratelimit-limit']).toBe('60');
    const id = created.json().card.id as string;
    for (let i = 1; i < 60; i += 1) {
      const res = await api.patch(`/cards/${id}`, { title: `Name ${i}` });
      expect(res.statusCode).toBe(200);
    }
    const over = await api.patch(`/cards/${id}`, { title: 'One more' });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    expect(over.headers['retry-after']).toBeDefined();
    // Reads are not card writes.
    expect((await api.get('/cards')).statusCode).toBe(200);
  });

  it('answers retries of a committed write from the receipt without charging the limit', async () => {
    const user = await createTestUser(h);
    const api = apiClient(limited, user);
    const key = randomUUID();
    const body = { interest: unique('Replayed interest'), strength: 'like' };
    const first = await api.post('/cards', body, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    for (let i = 0; i < 65; i += 1) {
      const retry = await api.post('/cards', body, { idempotencyKey: key });
      expect(retry.statusCode, retry.body).toBe(201);
      expect(retry.json()).toEqual(first.json());
    }
    // Only the first write was charged.
    const next = await api.post('/cards', { interest: unique('Another'), strength: 'like' });
    expect(next.statusCode).toBe(201);
  });

  it('charges label edits to the same card-write bucket', async () => {
    const user = await createTestUser(h);
    const api = apiClient(limited, user);
    const label = await api.patch('/labels/1', { color: '#123456' });
    expect(label.headers['x-ratelimit-limit']).toBe('60');
  });
});
