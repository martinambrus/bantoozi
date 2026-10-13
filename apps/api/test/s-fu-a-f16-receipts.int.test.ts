import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  carriedArticle,
  freshFence,
  newReader,
  subscribedFeed,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * M8-F16 (PLAN §14.1): new undo receipts (`api_mutations.undo`) no longer carry `effects.rankFull`
 * (dead data: an undo recomputes its own effects, S22); `effects.learn` stays. A receipt written
 * before the change, with `rankFull`, still parses and undoes.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h.close();
});

async function receipt(mutationId: string): Promise<{ effects: Record<string, unknown> }> {
  const row = (
    await h.owner.query<{ undo: { effects: Record<string, unknown> } }>(
      'SELECT undo FROM api_mutations WHERE id = $1',
      [mutationId],
    )
  ).rows[0];
  if (row?.undo == null) throw new Error(`no undo receipt for ${mutationId}`);
  return row.undo;
}

async function setup() {
  const r = await newReader(h);
  const feed = await subscribedFeed(h, r.user.id, { mode: 'active' });
  const article = await carriedArticle(h, [feed]);
  return { r, article };
}

describe('M8-F16 undo receipts', () => {
  it('a new rating receipt carries no effects.rankFull but keeps effects.learn', async () => {
    const { r, article } = await setup();
    const res = await r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const effects = (await receipt(res.json().mutationId)).effects;
    expect(effects).not.toHaveProperty('rankFull');
    expect(effects).toMatchObject({ learn: true });
  });

  it('a new read receipt carries no effects.rankFull', async () => {
    const { r, article } = await setup();
    const res = await r.api.post(`/articles/${article}/read`, { ...freshFence });
    expect(res.statusCode, res.body).toBe(200);
    const effects = (await receipt(res.json().mutationId)).effects;
    expect(effects).not.toHaveProperty('rankFull');
  });

  it('an old receipt with effects.rankFull still undoes', async () => {
    const { r, article } = await setup();
    const res = await r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 });
    expect(res.statusCode, res.body).toBe(200);
    const mutationId = res.json().mutationId as string;
    await h.owner.query(
      `UPDATE api_mutations
          SET undo = jsonb_set(undo, '{effects}', '{"rankFull": true, "learn": true}'::jsonb)
        WHERE id = $1`,
      [mutationId],
    );
    const undo = await r.api.post('/articles/undo', { mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json().items[0].rating).toBeNull();
  });
});
