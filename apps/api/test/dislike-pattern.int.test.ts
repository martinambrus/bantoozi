import { createCard } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY,
  ago,
  carriedArticle,
  freshFence,
  newReader,
  outbox,
  rank,
  subscribedFeed,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/** DPF-3 (black box): rating `pattern` and `POST /cards/:id/examples/batch`. */

let h: ApiHarness;
const SHA = 'dpf3-pattern-question-set-sha';

const D1 = 'Škoda 105 L zadné svetlo: 60';
const D2 = 'Škoda 105 L blatník predný: 80';
const D3 = 'Škoda 105 L sedadlá: 120';
const TARGET = 'Škoda 105 L kapota: 90';
const LIKES = [
  'Škoda Octavia III 2.0 TDI 110kw: 12 900',
  'Škoda Superb 2 2.0TDI: 9 990',
  'Škoda Kodiaq 4x4 DSG: 24 500',
  'Škoda Fabia III 1.0 TSI: 8 400',
  'Škoda Kamiq 1.5 TSI Style: 19 900',
];
const MODERN = 'Škoda Enyaq iV 80 Sportline: 31 000';

beforeAll(async () => {
  h = await createApiHarness();
  await h.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', 'dpf3-pattern', $1, '{}') ON CONFLICT DO NOTHING`,
    [SHA],
  );
});

afterAll(async () => {
  await h.close();
});

async function answer(articleId: string, cardId: string, p: number): Promise<void> {
  await h.owner.query(
    `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                               state_sha256, card_input_sha256, state_variant, model)
     VALUES ($1, $2, $3, 'typesafe', $4, 1, 'x', 'x', 'native', 'm')`,
    [articleId, cardId, p, SHA],
  );
}

async function rate(
  userId: string,
  articleId: string,
  rating: number,
  daysAgo: number,
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)`,
    [userId, articleId, rating, ago(daysAgo * DAY)],
  );
}

async function world(
  preferences: Record<string, unknown> = {},
  mode: 'active' | 'training' = 'active',
) {
  const r = await newReader(h, preferences);
  const feed = await subscribedFeed(h, r.user.id, { mode });
  const card = (await createCard(h.owner, { interest: `used Skoda parts and cars ${r.user.id}` }))
    .id;
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
    [r.user.id, card],
  );
  for (const [i, title] of LIKES.entries()) {
    const id = await carriedArticle(h, [feed], { title });
    await answer(id, card, 0.9);
    await rate(r.user.id, id, 1, i + 1);
  }
  for (const [i, title] of [D1, D2].entries()) {
    const id = await carriedArticle(h, [feed], { title });
    await answer(id, card, 0.9);
    await rate(r.user.id, id, -1, i + 1);
  }
  return { ...r, feed, card };
}

async function candidate(w: Awaited<ReturnType<typeof world>>, title: string): Promise<string> {
  const id = await carriedArticle(h, [w.feed], { title });
  await answer(id, w.card, 0.9);
  await rank(h, w.user.id, id, { lane: 'for_you', p: 0.7, tier: 3 });
  return id;
}

interface PatternBody {
  pattern?: {
    kind: 'card' | 'feed';
    cardId: string;
    feedId: string;
    lowered: boolean;
    offer: string[] | null;
    offerId: string | null;
  } | null;
  exampleSuggestion?: unknown;
}

async function dislike(
  w: Awaited<ReturnType<typeof world>>,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<PatternBody> {
  const res = await w.api.post(`/articles/${id}/rating`, { ...freshFence, rating: -1, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as PatternBody;
}

describe('rating pattern (DPF-3)', () => {
  it('P1 two prior similar dislikes lower the card and offer three examples', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const body = await dislike(w, target);
    expect(body.pattern).toBeTruthy();
    expect(body.pattern!.cardId).toBe(w.card);
    expect(body.pattern!.lowered).toBe(true);
    const ids = await h.owner.query<{ id: string }>(
      `SELECT id FROM articles WHERE title = ANY($1)`,
      [[TARGET, D1, D2]],
    );
    expect(body.pattern!.offer).not.toBeNull();
    expect(body.pattern!.offer!.length).toBe(3);
    expect(body.pattern!.offer).toContain(target);
    expect(ids.rows.length).toBeGreaterThanOrEqual(3);
    for (const id of body.pattern!.offer!) expect(ids.rows.map((x) => x.id)).toContain(id);
    expect(body.exampleSuggestion).toBeNull();
  });

  it('P2 a modern title is not lowered', async () => {
    const w = await world();
    const target = await candidate(w, MODERN);
    const body = await dislike(w, target);
    expect(body.pattern).toBeTruthy();
    expect(body.pattern!.lowered).toBe(false);
    expect(body.pattern!.offer).toBeNull();
  });

  it('P3 a further similar dislike within 14 days is lowered without an offer', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const first = await dislike(w, target);
    expect(first.pattern?.offer).not.toBeNull();
    await w.api.post(`/articles/${target}/pattern-offer`, {
      offerId: first.pattern?.offerId,
      event: 'seen',
    });
    const third = await candidate(w, D3);
    const body = await dislike(w, third);
    expect(body.pattern).toBeTruthy();
    expect(body.pattern!.lowered).toBe(true);
    expect(body.pattern!.offer).toBeNull();
  });

  it('DPF-6 unseen offers do not consume the cooldown', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const first = await dislike(w, target);
    expect(first.pattern?.offerId).toEqual(expect.any(String));
    const next = await dislike(w, await candidate(w, D3));
    expect(next.pattern?.offer).toHaveLength(3);
    expect(next.pattern?.offerId).not.toBe(first.pattern?.offerId);
  });

  it('DPF-6 only seen offers block their scope, with idempotent tenant-scoped events', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const first = await dislike(w, target);
    const offerId = first.pattern?.offerId;
    expect(offerId).toEqual(expect.any(String));
    const stranger = await newReader(h);
    expect(
      (await stranger.api.post(`/articles/${target}/pattern-offer`, { offerId, event: 'seen' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await w.api.post(`/articles/${await candidate(w, D3)}/pattern-offer`, {
          offerId,
          event: 'seen',
        })
      ).statusCode,
    ).toBe(404);
    for (let i = 0; i < 2; i++) {
      expect(
        (await w.api.post(`/articles/${target}/pattern-offer`, { offerId, event: 'seen' }))
          .statusCode,
      ).toBe(204);
    }
    expect((await dislike(w, await candidate(w, D3))).pattern?.offer).toBeNull();
    const other = await world();
    expect((await dislike(other, await candidate(other, TARGET))).pattern?.offer).toHaveLength(3);
    await h.owner.query(
      `UPDATE dislike_pattern_offers SET seen_at = now() - interval '15 days' WHERE id = $1`,
      [offerId],
    );
    expect((await dislike(w, await candidate(w, TARGET))).pattern?.offer).toHaveLength(3);
  });

  it('DPF-6 impressions and first answer remain unchanged on repeated events', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const offerId = (await dislike(w, target)).pattern?.offerId;
    const event = (value: string) =>
      w.api.post(`/articles/${target}/pattern-offer`, { offerId, event: value });
    expect((await event('seen')).statusCode).toBe(204);
    const before = await h.owner.query('SELECT seen_at FROM dislike_pattern_offers WHERE id = $1', [
      offerId,
    ]);
    for (const value of ['seen', 'accepted', 'accepted', 'dismissed'])
      expect((await event(value)).statusCode).toBe(204);
    const after = await h.owner.query(
      'SELECT seen_at, answer, answered_at FROM dislike_pattern_offers WHERE id = $1',
      [offerId],
    );
    expect(after.rows[0].seen_at).toEqual(before.rows[0].seen_at);
    expect(after.rows[0].answer).toBe('accepted');
    expect(after.rows[0].answered_at).toBeTruthy();
  });

  it('P4 a clickbait reason has no pattern', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const res = await w.api.post(`/articles/${target}/rating`, {
      ...freshFence,
      rating: -1,
      reason: 'clickbait',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty('pattern', null);
  });

  it('P5 a like has no pattern', async () => {
    const w = await world();
    const target = await candidate(w, TARGET);
    const res = await w.api.post(`/articles/${target}/rating`, { ...freshFence, rating: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty('pattern', null);
  });

  it('P6 exampleSuggestions off still reports lowered but offers nothing', async () => {
    const w = await world({ exampleSuggestions: false });
    const target = await candidate(w, TARGET);
    const body = await dislike(w, target);
    expect(body.pattern).toBeTruthy();
    expect(body.pattern!.lowered).toBe(true);
    expect(body.pattern!.offer).toBeNull();
  });
});

describe('POST /cards/:id/examples/batch (DPF-3)', () => {
  async function batchWorld() {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const card = (await createCard(h.owner, { interest: `used cars ${r.user.id}` })).id;
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [r.user.id, card],
    );
    const titles = [D1, D2, D3];
    const ids: string[] = [];
    for (const title of titles) ids.push(await carriedArticle(h, [feed], { title }));
    return { ...r, feed, card, titles, ids };
  }

  async function holding(userId: string): Promise<string[]> {
    const res = await h.owner.query<{ card_id: string }>(
      `SELECT card_id FROM user_cards WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((x) => x.card_id);
  }

  it('B1 adds three titles in one fork with one backfill intent', async () => {
    const w = await batchWorld();
    const res = await w.api.post(`/cards/${w.card}/examples/batch`, {
      articleIds: w.ids,
      side: 'no',
    });
    expect(res.statusCode, res.body).toBe(200);
    const held = await holding(w.user.id);
    expect(held).toHaveLength(1);
    const newId = held[0]!;
    expect(newId).not.toBe(w.card);
    const row = await h.owner.query<{ visibility: string; no: string[] }>(
      `SELECT visibility, body->'examples_no' AS no FROM interest_cards WHERE id = $1`,
      [newId],
    );
    expect(row.rows[0]!.visibility).toBe('private');
    for (const t of w.titles) expect(row.rows[0]!.no).toContain(t);
    const intents = (await outbox(h, w.user.id, 'card.backfill')).filter((o) =>
      (o.payload['cardIds'] as string[] | undefined)?.includes(newId),
    );
    expect(intents).toHaveLength(1);
  });

  it('B2 an unknown id is skipped and the rest apply', async () => {
    const w = await batchWorld();
    const res = await w.api.post(`/cards/${w.card}/examples/batch`, {
      articleIds: [w.ids[0]!, '999999999999999', w.ids[1]!],
      side: 'no',
    });
    expect(res.statusCode, res.body).toBe(200);
    const newId = (await holding(w.user.id))[0]!;
    const row = await h.owner.query<{ no: string[] }>(
      `SELECT body->'examples_no' AS no FROM interest_cards WHERE id = $1`,
      [newId],
    );
    expect(row.rows[0]!.no).toContain(D1);
    expect(row.rows[0]!.no).toContain(D2);
  });

  it('B3 four ids or none are rejected', async () => {
    const w = await batchWorld();
    const extra = await carriedArticle(h, [w.feed], { title: TARGET });
    const four = await w.api.post(`/cards/${w.card}/examples/batch`, {
      articleIds: [...w.ids, extra],
      side: 'no',
    });
    expect(four.statusCode, four.body).toBe(400);
    const none = await w.api.post(`/cards/${w.card}/examples/batch`, {
      articleIds: [],
      side: 'no',
    });
    expect(none.statusCode, none.body).toBe(400);
  });
});
