import { createCard } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY,
  ago,
  carriedArticle,
  clearOutbox,
  freshFence,
  newReader,
  outbox,
  rank,
  subscribedFeed,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * DPF-2 (black box): a dislike, undo or un-rate of an article marks the ranked rows of its card
 * family due (`next_rank_at <= now`) and enqueues a `user.rank` job.
 */

let h: ApiHarness;
const SHA = 'dpf2-marks-question-set-sha';

beforeAll(async () => {
  h = await createApiHarness();
  await h.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', 'dpf2-marks', $1, '{}') ON CONFLICT DO NOTHING`,
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

async function world() {
  const r = await newReader(h);
  const feed = await subscribedFeed(h, r.user.id);
  const card = (await createCard(h.owner, { interest: `used Skoda parts and cars ${r.user.id}` }))
    .id;
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
    [r.user.id, card],
  );
  const titles = ['Škoda 105 L zadné svetlo: 60', 'Škoda 105 L blatník predný: 80'];
  for (const [i, title] of titles.entries()) {
    const id = await carriedArticle(h, [feed], { title });
    await answer(id, card, 0.9);
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, -1, $3)`,
      [r.user.id, id, ago((i + 1) * DAY)],
    );
  }
  const target = await carriedArticle(h, [feed], { title: 'Škoda 105 L kapota: 90' });
  await answer(target, card, 0.9);
  await rank(h, r.user.id, target, { lane: 'for_you', p: 0.7, tier: 3 });
  const third = await carriedArticle(h, [feed], { title: 'Škoda 105 L sedadlá: 120' });
  await answer(third, card, 0.9);
  await clearOutbox(h, r.user.id);
  return { ...r, feed, card, target, third };
}

async function nextRankAt(userId: string, articleId: string): Promise<Date | null> {
  const res = await h.owner.query<{ next_rank_at: Date | null }>(
    `SELECT next_rank_at FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  return res.rows[0]?.next_rank_at ?? null;
}

describe('similar-dislike marks (DPF-2)', () => {
  it('A1 a dislike marks the card family window rows due and enqueues user.rank', async () => {
    const w = await world();
    expect(await nextRankAt(w.user.id, w.target)).toBeNull();
    const res = await w.api.post(`/articles/${w.third}/rating`, { ...freshFence, rating: -1 });
    expect(res.statusCode, res.body).toBe(200);
    const due = await nextRankAt(w.user.id, w.target);
    expect(due).not.toBeNull();
    expect((due as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await outbox(h, w.user.id, 'user.rank')).length).toBeGreaterThan(0);
  });

  it('A2 undoing that dislike marks the row again', async () => {
    const w = await world();
    const res = await w.api.post(`/articles/${w.third}/rating`, { ...freshFence, rating: -1 });
    expect(res.statusCode, res.body).toBe(200);
    await h.owner.query(
      `UPDATE user_article SET next_rank_at = NULL WHERE user_id = $1 AND article_id = $2`,
      [w.user.id, w.target],
    );
    await clearOutbox(h, w.user.id);
    const undo = await w.api.post('/articles/undo', { mutationId: res.json().mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    const due = await nextRankAt(w.user.id, w.target);
    expect(due).not.toBeNull();
    expect((due as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await outbox(h, w.user.id, 'user.rank')).length).toBeGreaterThan(0);
  });
});
