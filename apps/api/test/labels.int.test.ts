import { randomUUID } from 'node:crypto';

import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * M4-T5 labels (spec 08 §7, spec 05 §5.1): each endpoint maps to its label lifecycle action; a
 * semantic change or an example returns the new label id and migrates the user's `label_ids` and
 * `label_suggestions` with `array_replace`; colour changes stay in place; deletion strips the id;
 * labels never train the interest model (no `user.learn`); quotas and cross-user ids.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

let sequence = 0;
const unique = (text: string) => {
  sequence += 1;
  return `${text} ${sequence}-${randomUUID().slice(0, 6)}`;
};

async function reader() {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: unique('Parliament passes the new budget'),
  });
  const other = await createArticle(h.owner, { feedIds: [feed.id] });
  return { user, feed, article, other, api: apiClient(h.server, user) };
}

type Reader = Awaited<ReturnType<typeof reader>>;

async function createLabel(r: Reader, body: Record<string, unknown> = {}) {
  const res = await r.api.post('/labels', {
    name: unique('Politics'),
    definition: unique('Articles about domestic politics and elections'),
    ...body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().label as { id: string; name: string; color: string };
}

/** Label `articleId` (and suggest it on `suggestedId`) directly, as the article actions would. */
async function labelArticles(
  userId: string,
  labelId: string,
  articleId: string,
  suggestedId: string,
) {
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, label_ids) VALUES ($1, $2, ARRAY[$3::bigint])`,
    [userId, articleId, labelId],
  );
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, label_suggestions) VALUES ($1, $2, ARRAY[$3::bigint])`,
    [userId, suggestedId, labelId],
  );
}

async function articleLabels(userId: string) {
  const { rows } = await h.owner.query<{
    article_id: string;
    label_ids: string[];
    label_suggestions: string[];
    state_version: string;
  }>(
    `SELECT article_id::text, label_ids::text[] AS label_ids,
            label_suggestions::text[] AS label_suggestions, state_version::text
       FROM user_article WHERE user_id = $1 ORDER BY article_id`,
    [userId],
  );
  return rows;
}

async function pendingQueues(userId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ queue: string }>(
    'SELECT queue FROM job_outbox WHERE user_id = $1 AND delivered_at IS NULL ORDER BY id',
    [userId],
  );
  return rows.map((row) => row.queue);
}

async function drainOutbox(): Promise<void> {
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
}

describe('GET/POST /labels', () => {
  it('creates a label with the default colour and lists it with its article count', async () => {
    const r = await reader();
    expect((await r.api.get('/labels')).json()).toEqual([]);
    await drainOutbox();
    const name = unique('Budget');
    const res = await r.api.post('/labels', {
      name,
      definition: 'Government budgets, taxes and public spending',
      notFor: 'Household budgeting tips',
    });
    expect(res.statusCode).toBe(201);
    const { label, idChange } = res.json();
    expect(idChange).toBeNull();
    expect(label).toEqual({
      id: expect.any(String),
      name,
      color: '#64748b',
      definition: 'Government budgets, taxes and public spending',
      notFor: 'Household budgeting tips',
      examplesYes: [],
      examplesNo: [],
      count: 0,
    });
    const queues = await pendingQueues(r.user.id);
    expect(queues).toContain('user.rank');
    expect(queues).not.toContain('user.learn'); // labels never train the interest model
    await h.owner.query(
      'INSERT INTO user_article (user_id, article_id, label_ids) VALUES ($1, $2, ARRAY[$3::bigint])',
      [r.user.id, r.article.id, label.id],
    );
    expect((await r.api.get('/labels')).json()[0].count).toBe(1);
  });

  it('validates colour, length and unknown keys', async () => {
    const r = await reader();
    for (const body of [
      { name: 'Bad colour', definition: 'Some definition text', color: 'red' },
      { name: 'Bad colour', definition: 'Some definition text', color: '#12345' },
      { name: 'x'.repeat(61), definition: 'Some definition text' },
      { name: 'Extra', definition: 'Some definition text', strength: 'like' },
      { definition: 'Missing name' },
    ]) {
      const res = await r.api.post('/labels', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('PATCH /labels/:id', () => {
  it('changes the colour and a case-only rename in place (same id, no effects)', async () => {
    const r = await reader();
    const label = await createLabel(r, { name: 'Economy news' });
    await drainOutbox();
    const res = await r.api.patch(`/labels/${label.id}`, {
      color: '#FF0000',
      name: 'economy NEWS',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      idChange: null,
      label: { id: label.id, color: '#ff0000', name: 'economy NEWS' },
    });
    expect(await pendingQueues(r.user.id)).toEqual([]);
  });

  it('re-points a renamed label and migrates label_ids and label_suggestions', async () => {
    const r = await reader();
    const label = await createLabel(r);
    await labelArticles(r.user.id, label.id, r.article.id, r.other.id);
    const before = await articleLabels(r.user.id);
    const res = await r.api.patch(`/labels/${label.id}`, { name: unique('Elections') });
    expect(res.statusCode).toBe(200);
    const { label: next, idChange } = res.json();
    expect(next.id).not.toBe(label.id);
    expect(idChange).toEqual({ from: label.id, to: next.id });
    const after = await articleLabels(r.user.id);
    const labelled = after.find((row) => row.article_id === r.article.id)!;
    const suggested = after.find((row) => row.article_id === r.other.id)!;
    expect(labelled.label_ids).toEqual([next.id]);
    expect(suggested.label_suggestions).toEqual([next.id]);
    // Only the row whose label_ids changed advances its reader state version (D-41).
    const old = (id: string) => before.find((row) => row.article_id === id)!.state_version;
    expect(BigInt(labelled.state_version)).toBe(BigInt(old(r.article.id)) + 1n);
    expect(suggested.state_version).toBe(old(r.other.id));
    expect((await r.api.get('/labels')).json().map((l: { id: string }) => l.id)).toEqual([next.id]);
    expect((await r.api.patch(`/labels/${label.id}`, { color: '#000000' })).statusCode).toBe(404);
  });

  it('re-points a redefined label; an empty body is a validation failure', async () => {
    const r = await reader();
    const label = await createLabel(r);
    const res = await r.api.patch(`/labels/${label.id}`, {
      definition: unique('Coalition disputes in parliament'),
    });
    expect(res.json().idChange).toEqual({ from: label.id, to: res.json().label.id });
    const empty = await r.api.patch(`/labels/${res.json().label.id}`, {});
    expect(empty.statusCode).toBe(400);
  });
});

describe('label examples and delete', () => {
  it('forks on an added example, migrates ids, and returns on removal', async () => {
    const r = await reader();
    const label = await createLabel(r);
    await labelArticles(r.user.id, label.id, r.article.id, r.other.id);
    await drainOutbox();
    const added = await r.api.post(`/labels/${label.id}/examples`, {
      articleId: r.article.id,
      side: 'yes',
    });
    expect(added.statusCode).toBe(200);
    const fork = added.json();
    expect(fork.label.examplesYes).toEqual([expect.stringContaining('Parliament passes')]);
    expect(fork.idChange).toEqual({ from: label.id, to: fork.label.id });
    expect((await articleLabels(r.user.id)).flatMap((row) => row.label_ids)).toEqual([
      fork.label.id,
    ]);
    expect(await pendingQueues(r.user.id)).not.toContain('user.learn');

    const removed = await r.api.post(`/labels/${fork.label.id}/examples/remove`, {
      side: 'yes',
      text: fork.label.examplesYes[0],
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().label.id).toBe(label.id);
    expect((await articleLabels(r.user.id)).flatMap((row) => row.label_ids)).toEqual([label.id]);
  });

  it('deletes a label and strips it from label_ids and label_suggestions', async () => {
    const r = await reader();
    const label = await createLabel(r);
    await labelArticles(r.user.id, label.id, r.article.id, r.other.id);
    const res = await r.api.delete(`/labels/${label.id}`);
    expect(res.statusCode).toBe(204);
    const rows = await articleLabels(r.user.id);
    expect(rows.flatMap((row) => [...row.label_ids, ...row.label_suggestions])).toEqual([]);
    expect((await r.api.get('/labels')).json()).toEqual([]);
    expect((await r.api.delete(`/labels/${label.id}`)).statusCode).toBe(404);
  });
});

describe('cross-user label ids', () => {
  it('answers 404 for another user’s label or private label fork', async () => {
    const a = await reader();
    const b = await reader();
    const label = await createLabel(b);
    const fork = (
      await b.api.post(`/labels/${label.id}/examples`, { articleId: b.article.id, side: 'no' })
    ).json().label;
    expect((await a.api.get('/labels')).json()).toEqual([]);
    for (const id of [label.id, fork.id]) {
      expect((await a.api.patch(`/labels/${id}`, { color: '#000000' })).statusCode).toBe(404);
      expect(
        (await a.api.post(`/labels/${id}/examples`, { articleId: a.article.id, side: 'yes' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await a.api.post(`/labels/${id}/examples/remove`, { side: 'no', text: 'x' })).statusCode,
      ).toBe(404);
      expect((await a.api.delete(`/labels/${id}`)).statusCode).toBe(404);
    }
    // An interest card id is not a label.
    const card = await createCard(h.owner, { interest: unique('Not a label') });
    expect((await a.api.delete(`/labels/${card.id}`)).statusCode).toBe(404);
  });
});

describe('maxLabels (spec 08 §6)', () => {
  it('accepts the 20th label, refuses the 21st, and does not count label forks as forks', async () => {
    const r = await reader();
    for (let i = 0; i < 19; i += 1) {
      const card = await createCard(h.owner, { kind: 'label', title: unique('Filler label') });
      await h.owner.query('INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)', [
        r.user.id,
        card.id,
        unique('Filler'),
      ]);
    }
    const twentieth = await createLabel(r);
    const over = await r.api.post('/labels', {
      name: unique('One too many'),
      definition: 'Anything else at all',
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxLabels', used: 20, max: 20 },
    });
    // A label fork is bounded by maxLabels, not maxForks.
    const fork = await r.api.post(`/labels/${twentieth.id}/examples`, {
      articleId: r.article.id,
      side: 'yes',
    });
    expect(fork.statusCode).toBe(200);
    const { rows } = await h.owner.query<{ forks: number }>(
      `SELECT count(*)::int AS forks FROM user_cards uc JOIN interest_cards c ON c.id = uc.card_id
        WHERE uc.user_id = $1 AND c.visibility = 'private'`,
      [r.user.id],
    );
    expect(rows[0]!.forks).toBe(0);
  });
});
