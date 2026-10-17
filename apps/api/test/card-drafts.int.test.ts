import { createDatabase, isInferenceAuthorized } from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY,
  carriedArticle,
  newReader,
  outbox,
  subscribedFeed,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * Card drafts (D-240): `POST /cards/drafts` records a draft of articles the user can see with its
 * `card.draft` intent, `GET /cards/drafts/:id` reads it back (own drafts only), and a pending,
 * recent draft is the only thing that authorizes its provider call.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function setup() {
  const r = await newReader(h);
  const feed = await subscribedFeed(h, r.user.id);
  const articles = [await carriedArticle(h, [feed]), await carriedArticle(h, [feed])];
  return { r, articles };
}

describe('POST /cards/drafts', () => {
  it('records a pending draft with its intent, readable by its owner only', async () => {
    const { r, articles } = await setup();
    const res = await r.api.post('/cards/drafts', { articleIds: articles });
    expect(res.statusCode, res.body).toBe(202);
    const draft = res.json() as { id: string };
    expect(draft).toEqual({
      id: expect.any(String),
      status: 'pending',
      title: null,
      interest: null,
      source: null,
      similar: null,
    });
    expect(await outbox(h, r.user.id, 'card.draft')).toEqual([
      { queue: 'card.draft', payload: { draftId: draft.id } },
    ]);
    const stored = await h.owner.query<{ article_ids: string[]; locale: string }>(
      `SELECT article_ids::text[] AS article_ids, locale FROM card_drafts WHERE id = $1`,
      [draft.id],
    );
    expect(stored.rows[0]).toEqual({ article_ids: articles, locale: 'en' });

    expect((await r.api.get(`/cards/drafts/${draft.id}`)).json()).toMatchObject({
      status: 'pending',
    });
    await h.owner.query(
      `UPDATE card_drafts SET status = 'complete', title = 'Space', interest = 'Space news.',
                              source = 'llm', completed_at = now() WHERE id = $1`,
      [draft.id],
    );
    expect((await r.api.get(`/cards/drafts/${draft.id}`)).json()).toEqual({
      id: draft.id,
      status: 'complete',
      title: 'Space',
      interest: 'Space news.',
      source: 'llm',
      similar: null,
    });

    const other = await newReader(h);
    expect((await other.api.get(`/cards/drafts/${draft.id}`)).statusCode).toBe(404);
  });

  it('rejects articles the user cannot see, duplicates and more than five', async () => {
    const { r, articles } = await setup();
    const stranger = await newReader(h);
    const theirs = await carriedArticle(h, [await subscribedFeed(h, stranger.user.id)]);
    expect((await r.api.post('/cards/drafts', { articleIds: [theirs] })).statusCode).toBe(404);
    expect(
      (await r.api.post('/cards/drafts', { articleIds: [articles[0], articles[0]] })).statusCode,
    ).toBe(400);
    expect(
      (await r.api.post('/cards/drafts', { articleIds: ['1', '2', '3', '4', '5', '6'] }))
        .statusCode,
    ).toBe(400);
    expect((await r.api.post('/cards/drafts', { articleIds: [] })).statusCode).toBe(400);
  });

  it('removes the user’s drafts older than a day when a new one is asked for', async () => {
    const { r, articles } = await setup();
    const first = (await r.api.post('/cards/drafts', { articleIds: [articles[0]] })).json() as {
      id: string;
    };
    await h.owner.query(`UPDATE card_drafts SET created_at = $2 WHERE id = $1`, [
      first.id,
      new Date(Date.now() - 2 * DAY),
    ]);
    const second = (await r.api.post('/cards/drafts', { articleIds: [articles[1]] })).json() as {
      id: string;
    };
    const left = await h.owner.query<{ id: string }>(
      `SELECT id::text AS id FROM card_drafts WHERE user_id = $1`,
      [r.user.id],
    );
    expect(left.rows.map((row) => row.id)).toEqual([second.id]);
  });
});

describe('the card_draft spend authorization', () => {
  it('holds only for the user’s own pending, recent draft', async () => {
    const { r, articles } = await setup();
    const { id } = (await r.api.post('/cards/drafts', { articleIds: articles })).json() as {
      id: string;
    };
    const db = createDatabase(h.owner);
    const check = (userId: string, draftId: string) =>
      isInferenceAuthorized(db, { type: 'card_draft', userId, draftId });
    expect(await check(r.user.id, id)).toBe(true);
    const other = await newReader(h);
    expect(await check(other.user.id, id)).toBe(false);
    await h.owner.query(
      `UPDATE card_drafts SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [id],
    );
    expect(await check(r.user.id, id)).toBe(false);
    await h.owner.query(
      `UPDATE card_drafts SET created_at = now(), status = 'failed', error_code = 'x',
                              completed_at = now() WHERE id = $1`,
      [id],
    );
    expect(await check(r.user.id, id)).toBe(false);
  });
});

describe('POST /cards/from-article with more articles', () => {
  it('keeps every title as an example of the new card', async () => {
    const { r, articles } = await setup();
    const titles = await h.owner.query<{ title: string }>(
      `SELECT title FROM articles WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [articles],
    );
    const res = await r.api.post('/cards/from-article', {
      articleId: articles[0],
      moreArticleIds: [articles[1]],
      interest: 'New battery chemistries and how they reach production.',
      strength: 'like',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().card.examplesYes).toEqual(titles.rows.map((row) => row.title));
    const tooMany = await r.api.post('/cards/from-article', {
      articleId: articles[0],
      moreArticleIds: ['1', '2', '3', '4', '5'],
      interest: 'Anything at all, really.',
      strength: 'like',
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('D-265: reused drafts, the kind of card and held look-alikes', () => {
  const complete = (id: string, title: string, interest: string) =>
    h.owner.query(
      `UPDATE card_drafts SET status = 'complete', title = $2, interest = $3, source = 'llm',
                              completed_at = now() WHERE id = $1`,
      [id, title, interest],
    );

  it('reuses the latest complete or awaited draft of the same articles, kind and language', async () => {
    const { r, articles } = await setup();
    const first = (await r.api.post('/cards/drafts', { articleIds: articles })).json() as {
      id: string;
    };
    // Pending and awaited: the same draft, and no second provider call.
    const again = (await r.api.post('/cards/drafts', { articleIds: articles })).json() as {
      id: string;
    };
    expect(again.id).toBe(first.id);
    await complete(first.id, 'Batteries', 'New battery chemistries and how they reach production.');
    const reused = await r.api.post('/cards/drafts', { articleIds: articles });
    expect(reused.json().id).toBe(first.id);
    expect((await r.api.get(`/cards/drafts/${first.id}`)).json()).toMatchObject({
      status: 'complete',
      title: 'Batteries',
    });
    expect(await outbox(h, r.user.id, 'card.draft')).toHaveLength(1);

    // Another kind, another order of the articles, or a failed draft: a new one.
    const never = await r.api.post('/cards/drafts', { articleIds: articles, kind: 'never' });
    const reordered = await r.api.post('/cards/drafts', { articleIds: [...articles].reverse() });
    expect(new Set([first.id, never.json().id, reordered.json().id]).size).toBe(3);
    const kinds = await h.owner.query<{ kind: string }>(
      `SELECT kind FROM card_drafts WHERE id = $1`,
      [never.json().id],
    );
    expect(kinds.rows[0]?.kind).toBe('never');
    await h.owner.query(
      `UPDATE card_drafts SET status = 'failed', error_code = 'x', completed_at = now(),
                              title = NULL, interest = NULL, source = NULL
        WHERE user_id = $1`,
      [r.user.id],
    );
    const fresh = await r.api.post('/cards/drafts', { articleIds: articles });
    expect([first.id, never.json().id, reordered.json().id]).not.toContain(fresh.json().id);
  });

  it('does not reuse a pending draft nobody waits for any more', async () => {
    const { r, articles } = await setup();
    const first = (await r.api.post('/cards/drafts', { articleIds: articles })).json() as {
      id: string;
    };
    await h.owner.query(
      `UPDATE card_drafts SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [first.id],
    );
    const second = await r.api.post('/cards/drafts', { articleIds: articles });
    expect(second.json().id).not.toBe(first.id);
  });

  it('names the held card of its kind a complete draft restates', async () => {
    const { r, articles } = await setup();
    const held = await r.api.post('/cards', {
      title: 'Battery chemistry',
      interest: 'New battery chemistries and how they reach production.',
      strength: 'like',
    });
    expect(held.statusCode, held.body).toBe(201);
    const cardId = held.json().card.id as string;
    const like = (await r.api.post('/cards/drafts', { articleIds: articles })).json().id as string;
    const never = (
      await r.api.post('/cards/drafts', { articleIds: articles, kind: 'never' })
    ).json().id as string;
    for (const id of [like, never]) {
      await complete(id, 'Battery chemistries', 'New battery chemistries reaching production.');
    }
    expect((await r.api.get(`/cards/drafts/${like}`)).json().similar).toEqual({
      cardId,
      title: 'Battery chemistry',
    });
    // A Never draft is compared with Never cards only.
    expect((await r.api.get(`/cards/drafts/${never}`)).json().similar).toBeNull();
    const other = (await r.api.post('/cards/drafts', { articleIds: [articles[0]!] })).json()
      .id as string;
    await complete(other, 'Garden birds', 'Which birds visit gardens in winter and why.');
    expect((await r.api.get(`/cards/drafts/${other}`)).json().similar).toBeNull();
  });
});

describe('D-265: POST /subscriptions/:feedId/card-hint/dismiss', () => {
  it('records "Not now" per feed and kind, only for a subscribed feed', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const res = await r.api.post(`/subscriptions/${feed}/card-hint/dismiss`, { kind: 'interest' });
    expect(res.statusCode, res.body).toBe(204);
    const stored = await h.owner.query<{ interest: boolean; never: boolean }>(
      `SELECT interest_hint_dismissed_at IS NOT NULL AS interest,
              never_hint_dismissed_at IS NOT NULL AS never
         FROM user_feed_preferences WHERE user_id = $1 AND feed_id = $2`,
      [r.user.id, feed],
    );
    expect(stored.rows[0]).toEqual({ interest: true, never: false });
    expect(
      (await r.api.post(`/subscriptions/${feed}/card-hint/dismiss`, { kind: 'never' })).statusCode,
    ).toBe(204);
    const other = await newReader(h);
    expect(
      (await other.api.post(`/subscriptions/${feed}/card-hint/dismiss`, { kind: 'never' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await r.api.post(`/subscriptions/${feed}/card-hint/dismiss`, { kind: 'maybe' })).statusCode,
    ).toBe(400);
  });
});
