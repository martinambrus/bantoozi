import { randomUUID } from 'node:crypto';

import { createCard } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  carriedArticle,
  events,
  freshFence,
  newReader,
  subscribedFeed,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * F3: a manifest field the request froze must not be treated as agreeing when the current value is
 * unknown (no active enrich/match set, no article language).
 */

let h: ApiHarness;
let previous: Map<string, unknown>;
const KEYS = ['engine.model_pin', 'question_sets.active', 'language_modes'];

beforeAll(async () => {
  h = await createApiHarness();
  const rows = await h.owner.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [KEYS],
  );
  previous = new Map(rows.rows.map((row) => [row.key, row.value]));
});

afterAll(async () => {
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) await h.owner.query(`DELETE FROM settings WHERE key = $1`, [key]);
    else await setSetting(key, value);
  }
  await h.close();
});

async function setSetting(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function matchSet(): Promise<string> {
  const sha = randomUUID().replaceAll('-', '').repeat(2);
  const res = await h.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', $1, $2, '{}') RETURNING id::text AS id`,
    [`null-current-${sha.slice(0, 12)}`, sha],
  );
  return res.rows[0]!.id;
}

async function rateLive(options: {
  active: (set: string) => Record<string, unknown>;
  lang: string | null;
  manifest: (set: string) => Record<string, unknown>;
}): Promise<{ analysisRatingSha: unknown; features: { ratingSha: string } | null }> {
  const set = await matchSet();
  await setSetting('question_sets.active', options.active(set));
  await setSetting('language_modes', { en: 'native' });
  const r = await newReader(h, {});
  const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
  const article = await carriedArticle(h, [feed]);
  await h.owner.query(`UPDATE articles SET lang = $2 WHERE id = $1`, [article, options.lang]);
  const card = await createCard(h.owner, { title: 'Null current' });
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
    [r.user.id, card.id],
  );
  const requestId = randomUUID();
  const manifest = JSON.stringify(options.manifest(set));
  const client = await h.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [r.user.id]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, $5::jsonb,
              encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex')
         FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
        WHERE a.id = $4`,
      [requestId, r.user.id, feed, article, manifest],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const res = await r.api.post(`/articles/${article}/rating`, {
    ...freshFence,
    rating: 1,
    analysisRequestId: requestId,
  });
  expect(res.statusCode, res.body).toBe(200);
  const event = (await events(h, r.user.id, article)).find((e) => e.kind === 'rate')!;
  return {
    analysisRatingSha: event.value['analysisRatingSha'],
    features: event.value['features'] as { ratingSha: string } | null,
  };
}

const full = (set: string, patch: Record<string, unknown> = {}) => ({
  questionSets: { enrich: { id: set }, match: { id: set } },
  article: { lang: 'en' },
  languageMode: 'native',
  cardTextMode: 'as_written',
  ...patch,
});

describe('requestRatingSha with an unknown current value', () => {
  it('records the sha when every field agrees', async () => {
    const out = await rateLive({
      active: (s) => ({ enrich: s, match: s }),
      lang: 'en',
      manifest: (s) => full(s),
    });
    expect(out.analysisRatingSha).toBe(out.features?.ratingSha);
    expect(out.analysisRatingSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is null when the active sets have no enrich entry but the request froze one', async () => {
    const out = await rateLive({
      active: (s) => ({ match: s }),
      lang: 'en',
      manifest: (s) => full(s),
    });
    expect(out.analysisRatingSha).toBeNull();
  });

  it('is null when the active sets have no match entry but the request froze one', async () => {
    const out = await rateLive({
      active: (s) => ({ enrich: s }),
      lang: 'en',
      manifest: (s) => full(s),
    });
    expect(out.analysisRatingSha).toBeNull();
  });

  it('is null when the request froze no article language and a translate mode', async () => {
    const out = await rateLive({
      active: (s) => ({ enrich: s, match: s }),
      lang: null,
      manifest: (s) => full(s, { article: {}, languageMode: 'translate' }),
    });
    expect(out.analysisRatingSha).toBeNull();
  });

  it('records the sha when the request froze no article language and the native mode', async () => {
    const out = await rateLive({
      active: (s) => ({ enrich: s, match: s }),
      lang: null,
      manifest: (s) => full(s, { article: {}, languageMode: 'native' }),
    });
    expect(out.analysisRatingSha).toBe(out.features?.ratingSha);
  });

  it('records the sha when the manifest lacks the set fields', async () => {
    const out = await rateLive({
      active: (s) => ({ match: s }),
      lang: 'en',
      manifest: () => ({
        article: { lang: 'en' },
        languageMode: 'native',
        cardTextMode: 'as_written',
      }),
    });
    expect(out.analysisRatingSha).toBe(out.features?.ratingSha);
  });
});
