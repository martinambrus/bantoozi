import { randomUUID } from 'node:crypto';

import { createDatabase, loadLearnSamples, readRatingFingerprint } from '@bantoozi/db';
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
 * JEV-4 (design visible-learning §4.2): a rating through a selected analysis request frozen under
 * another model of the SAME family as the current one still records the request's rating sha, and it
 * is the EXACT current sha. Every other pair of the manifest (match/enrich set, language mode, card
 * text mode) stays an exact comparison, and a model of another family is a mismatch.
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
    [`family-${sha.slice(0, 12)}`, sha],
  );
  return res.rows[0]!.id;
}

const currentSha = (): Promise<string> =>
  readRatingFingerprint(createDatabase(h.owner), {
    model: h.config.typesafeModel,
    languageModes: h.config.languageModes,
    cardTextMode: 'as_written',
  });

interface Outcome {
  analysisRatingSha: unknown;
  features: { ratingSha: string } | null;
  exactSha: string;
  sample: Awaited<ReturnType<typeof loadLearnSamples>>['samples'][number];
  cardId: string;
}

/**
 * Rates a live article through a request whose frozen manifest is complete (it is completed after
 * the rating, so the learning loader can derive from it), with `pin` as the stored model.
 */
async function rate(options: {
  pin: string;
  frozenModel: string | undefined;
  otherEnrich?: boolean;
  otherMatch?: boolean;
  languageMode?: string;
  cardTextMode?: string;
}): Promise<Outcome> {
  await setSetting('engine.model_pin', { model: options.pin });
  const matchA = await matchSet();
  const matchB = await matchSet();
  await setSetting('question_sets.active', { enrich: matchA, match: matchA });
  await setSetting('language_modes', { en: 'native' });

  const r = await newReader(h, {});
  const feed = await subscribedFeed(h, r.user.id, { mode: 'training' });
  const article = await carriedArticle(h, [feed]);
  await h.owner.query(`UPDATE articles SET lang = 'en' WHERE id = $1`, [article]);
  const card = await createCard(h.owner, { title: 'Family card' });
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
    [r.user.id, card.id],
  );

  const requestId = randomUUID();
  const at = new Date().toISOString();
  const manifest = {
    v: 1,
    capturedAt: at,
    article: {
      id: article,
      revision: '1',
      title: 'Frozen title',
      author: 'Frozen Author',
      categories: [],
      excerpt: null,
      bodyLead: null,
      wordCount: 321,
      lang: 'en',
      feed: { title: null, site: null },
      firstSeenAt: at,
      publishedAt: null,
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 0,
      storyClusterId: null,
      clusterSize: 1,
    },
    languageMode: options.languageMode ?? 'native',
    translation: null,
    questionSets: {
      enrich: { id: options.otherEnrich === true ? matchB : matchA },
      match: { id: options.otherMatch === true ? matchB : matchA },
    },
    cardTextMode: options.cardTextMode ?? 'as_written',
    ...(options.frozenModel === undefined
      ? {}
      : { model: { engine: 'typesafe', model: options.frozenModel } }),
    cards: [
      {
        cardId: card.id,
        kind: 'interest',
        strength: 'love',
        question: {},
        cardInputSha256: 'f'.repeat(64),
      },
    ],
  };
  const client = await h.owner.connect();
  let inputSha: string;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [r.user.id]);
    const inserted = await client.query<{ input_sha: string }>(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, $5::jsonb,
              encode(sha256(convert_to($5::jsonb::text, 'UTF8')), 'hex')
         FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
        WHERE a.id = $4
       RETURNING input_sha`,
      [requestId, r.user.id, feed, article, JSON.stringify(manifest)],
    );
    inputSha = inserted.rows[0]!.input_sha;
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

  const hex = (c: string) => c.repeat(64);
  const result = {
    v: 1,
    requestId,
    inputSha,
    processedAt: at,
    article: { id: article, revision: '1' },
    model: { engine: 'typesafe', model: options.frozenModel ?? options.pin },
    translation: null,
    enrich: {
      questionSetSha: hex('b'),
      stateSha256: hex('c'),
      stateVariant: 'native',
      answers: {},
      features: { time_sensitive: 0.9 },
    },
    match: {
      questionSetSha: hex('d'),
      stateSha256: hex('e'),
      stateVariant: 'native',
      cards: [{ cardId: card.id, cardInputSha256: hex('f'), p: 0.8, answer: {} }],
      l2: [],
    },
  };
  await h.owner.query(
    `UPDATE analysis_requests
        SET result_snapshot = $2::jsonb, result_sha = $3, status = 'complete', completed_at = now()
      WHERE id = $1`,
    [requestId, JSON.stringify(result), hex('9')],
  );

  const event = (await events(h, r.user.id, article)).find((e) => e.kind === 'rate')!;
  const { samples } = await loadLearnSamples(createDatabase(h.worker), {
    userId: r.user.id,
    now: new Date(),
  });
  expect(samples).toHaveLength(1);
  return {
    analysisRatingSha: event.value['analysisRatingSha'],
    features: event.value['features'] as { ratingSha: string } | null,
    exactSha: await currentSha(),
    sample: samples[0]!,
    cardId: card.id,
  };
}

function expectDerived(out: Outcome) {
  expect(out.analysisRatingSha).toBe(out.exactSha);
  expect(out.features?.ratingSha).toBe(out.exactSha);
  expect(out.sample.features?.ratingSha).toBe(out.exactSha);
  expect(out.sample.features?.cards.find((c) => c.id === out.cardId)?.p).toBe(0.8);
  expect(out.sample.features?.values.facets).toEqual({ time_sensitive: 0.9 });
}

function expectNotDerived(out: Outcome) {
  expect(out.analysisRatingSha).toBeNull();
  expect(out.features?.ratingSha).toBe(out.exactSha);
  expect(out.sample.features?.cards.find((c) => c.id === out.cardId)?.p).toBeNull();
  expect(out.sample.features?.values.facets).toBeNull();
}

describe('analysisRatingSha across the model pair', () => {
  it('records the exact current sha for a request frozen under another model of the same family', async () => {
    const out = await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-1.13.0' });
    expectDerived(out);
  });

  it('completes the sample from a same-family request when the current model is a pre-release', async () => {
    expectDerived(await rate({ pin: 'jev-1.14.0-rc1', frozenModel: 'jev-1.13.0' }));
  });

  it('records the exact current sha when the frozen model equals the current one', async () => {
    expectDerived(await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-1.14.0' }));
  });

  it('records the exact current sha when the manifest carries no model', async () => {
    expectDerived(await rate({ pin: 'jev-1.14.0', frozenModel: undefined }));
  });

  it('records null for a request frozen under another major version', async () => {
    expectNotDerived(await rate({ pin: 'jev-2.0.0', frozenModel: 'jev-1.13.0' }));
  });

  it('records null in the other direction across majors too', async () => {
    expectNotDerived(await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-2.0.0' }));
  });

  it('records null for a frozen model that is not a concrete Jev release', async () => {
    expectNotDerived(await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-frozen-other' }));
  });

  it('records null when the frozen model is an alias, even of the same major version', async () => {
    expectNotDerived(await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-latest' }));
    expectNotDerived(await rate({ pin: 'jev-1.14.0', frozenModel: 'jev-1' }));
  });

  it('records null when the current model is an alias', async () => {
    expectNotDerived(await rate({ pin: 'jev-latest', frozenModel: 'jev-1.13.0' }));
  });

  it('keeps an alias equal to itself', async () => {
    expectDerived(await rate({ pin: 'jev-latest', frozenModel: 'jev-latest' }));
  });
});

describe('only the model pair is relaxed', () => {
  const sameFamily = { pin: 'jev-1.14.0', frozenModel: 'jev-1.13.0' };

  it('still records null for another enrich question set', async () => {
    expectNotDerived(await rate({ ...sameFamily, otherEnrich: true }));
  });

  it('still records null for another match question set', async () => {
    expectNotDerived(await rate({ ...sameFamily, otherMatch: true }));
  });

  it('still records null for another language mode', async () => {
    expectNotDerived(await rate({ ...sameFamily, languageMode: 'translate' }));
  });

  it('still records null for another card text mode', async () => {
    expectNotDerived(await rate({ ...sameFamily, cardTextMode: 'english' }));
  });
});
