import { createDatabase, readRatingFingerprint } from '@bantoozi/db';
import { registrableDomain } from '@bantoozi/feeds';
import {
  builtCardQuestion,
  enrichStateSha256,
  matchStateSha256,
  type CardBody,
} from '@bantoozi/questions';
import { readSetting } from '@bantoozi/shared';
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
 * A rating captured while a rebuild is still running reads the answers of another release of the
 * pinned Jev major as current (spec 06 §8.2), and stamps the exact current fingerprint.
 */

let h: ApiHarness;
let previous: Map<string, unknown>;
const KEYS = ['engine.model_pin', 'question_sets.active'];
const MATCH_SHA = 'e7'.repeat(32);
const ENRICH_SHA = 'e8'.repeat(32);
const V113 = 'jev-1.13.0';
const V114 = 'jev-1.14.0';

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

async function pinTo(model: string) {
  await setSetting('engine.model_pin', { model, since: new Date().toISOString() });
}

const env = () => ({
  dailyBudgetUsd: h.config.dailyBudgetUsd,
  languageModes: h.config.languageModes,
  signupMode: h.config.signupMode,
});

const storedSetting = async (key: string): Promise<unknown> =>
  (await h.owner.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]))
    .rows[0]?.value;

async function currentStates(articleId: string): Promise<{ state: string; enrich: string }> {
  const article = (
    await h.owner.query<{
      title: string;
      author: string | null;
      categories: string[];
      excerpt: string | null;
      lang: string | null;
      word_count: number | null;
      body_lead: string | null;
      feed_title: string | null;
      feed_site_url: string | null;
      feed_url: string | null;
    }>(
      `SELECT a.title, a.author, a.categories, a.excerpt, a.lang, a.word_count, b.body_lead,
              f.title AS feed_title, f.site_url AS feed_site_url, f.url AS feed_url
         FROM articles a
         LEFT JOIN article_bodies b ON b.article_id = a.id AND b.article_revision = a.content_revision
         LEFT JOIN LATERAL (SELECT fi.feed_id FROM feed_items fi WHERE fi.article_id = a.id
                             ORDER BY fi.first_seen_at, fi.feed_id LIMIT 1) cf ON true
         LEFT JOIN feeds f ON f.id = cf.feed_id
        WHERE a.id = $1`,
      [articleId],
    )
  ).rows[0]!;
  const languageModes =
    readSetting('language_modes', await storedSetting('language_modes'), env()) ?? {};
  const base = {
    title: article.title,
    author: article.author,
    categories: article.categories,
    excerpt: article.excerpt,
    bodyLead: article.body_lead,
    wordCount: article.word_count,
    lang: article.lang,
    feed: {
      title: article.feed_title,
      site:
        article.feed_url === null && article.feed_site_url === null
          ? null
          : (registrableDomain(article.feed_site_url) ?? registrableDomain(article.feed_url)),
    },
  };
  return {
    state: matchStateSha256(base, languageModes, null),
    enrich: enrichStateSha256(base, languageModes, null),
  };
}

async function cardInputSha(cardId: string): Promise<string> {
  const card = (
    await h.owner.query<{ kind: 'interest' | 'label'; title: string; body: CardBody }>(
      `SELECT kind, title, body FROM interest_cards WHERE id = $1`,
      [cardId],
    )
  ).rows[0]!;
  const mode =
    readSetting('card_text_mode', await storedSetting('card_text_mode'), env()) ?? 'as_written';
  return builtCardQuestion(card, mode).sha256;
}

interface Stored {
  facetsModel?: string | null;
  facetsState?: string;
  cardModel?: string | null;
  cardState?: string;
}

interface Snapshot {
  ratingSha: string;
  cards: { id: string; p: number | null; engine: string | null }[];
  values: { facets: Record<string, number> | null; facetsEngine: string | null };
}

/** Rates a fresh Active-feed article under `pin` whose stored facets and card answer carry `stored`. */
async function captured(pin: string, stored: Stored): Promise<Snapshot> {
  await pinTo(pin);
  const [matchSet, enrichSet] = await Promise.all(
    (
      [
        ['match', MATCH_SHA],
        ['enrich', ENRICH_SHA],
      ] as const
    ).map(
      async ([kind, sha]) =>
        (
          await h.owner.query<{ id: string }>(
            `INSERT INTO question_sets (kind, version, sha256, definition)
             VALUES ($1, 'answer-family-' || $1, $2, '{}')
             ON CONFLICT (sha256) DO UPDATE SET version = EXCLUDED.version RETURNING id::text AS id`,
            [kind, sha],
          )
        ).rows[0]!.id,
    ),
  );
  await setSetting('question_sets.active', { match: matchSet, enrich: enrichSet });
  const r = await newReader(h, {});
  const feed = await subscribedFeed(h, r.user.id, { mode: 'active' });
  const article = await carriedArticle(h, [feed]);
  const card = await createCard(h.owner, { title: 'Family answers' });
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
    [r.user.id, card.id],
  );
  const states = await currentStates(article);
  if (stored.facetsModel !== undefined) {
    await h.owner.query(
      `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256,
                                   engine, model, state_variant, answers, features)
       VALUES ($1, $2, 1, $3, 'typesafe', $4, 'native', '{}', '{"time_sensitive": 0.9}')`,
      [article, enrichSet, stored.facetsState ?? states.enrich, stored.facetsModel],
    );
  }
  if (stored.cardModel !== undefined) {
    await h.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant, model)
       VALUES ($1, $2, 0.7, 'typesafe', $3, 1, $4, $5, 'native', $6)`,
      [
        article,
        card.id,
        MATCH_SHA,
        stored.cardState ?? states.state,
        await cardInputSha(card.id),
        stored.cardModel,
      ],
    );
  }
  const res = await r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 });
  expect(res.statusCode, res.body).toBe(200);
  const [event] = await events(h, r.user.id, article);
  return event!.value['features'] as Snapshot;
}

const exactSha = (model: string): Promise<string> =>
  readRatingFingerprint(createDatabase(h.owner), {
    model,
    languageModes: h.config.languageModes,
    cardTextMode: 'as_written',
  });

describe('an answer of another release of the pinned Jev major counts as current', () => {
  it('C1-a keeps the facets of the older release', async () => {
    const features = await captured(V114, { facetsModel: V113 });
    expect(features.values.facets).toEqual({ time_sensitive: 0.9 });
    expect(features.values.facetsEngine).toBe('typesafe');
  });

  it('C1-b keeps a card answer of the older release', async () => {
    const features = await captured(V114, { cardModel: V113 });
    expect(features.cards).toHaveLength(1);
    expect(features.cards[0]!.p).toBeCloseTo(0.7, 5);
    expect(features.cards[0]!.engine).toBe('typesafe');
  });

  it('C1-c keeps both and stamps the exact fingerprint of the current pin', async () => {
    await pinTo(V113);
    const olderSha = await exactSha(V113);
    const features = await captured(V114, { facetsModel: V113, cardModel: V113 });
    expect(features.values.facets).toEqual({ time_sensitive: 0.9 });
    expect(features.cards[0]!.p).toBeCloseTo(0.7, 5);
    expect(features.ratingSha).toBe(await exactSha(V114));
    expect(features.ratingSha).not.toBe(olderSha);
  });

  it('keeps a newer release under an older pin after a rollback', async () => {
    const features = await captured(V113, { facetsModel: V114, cardModel: V114 });
    expect(features.values.facets).toEqual({ time_sensitive: 0.9 });
    expect(features.cards[0]!.p).toBeCloseTo(0.7, 5);
  });
});

describe('answers of any other model still drop from the snapshot', () => {
  it.each(['jev-2.0.0', 'jev-latest', 'jev-1', 'jev-other', null])(
    'drops facets and card answers tagged %s under a Jev pin',
    async (model) => {
      const features = await captured(V114, { facetsModel: model, cardModel: model });
      expect(features.values.facets).toBeNull();
      expect(features.values.facetsEngine).toBeNull();
      expect(features.cards[0]).toMatchObject({ p: null, engine: null });
    },
  );

  it('drops a Jev answer under a non-Jev pin', async () => {
    const features = await captured('jev-test-1', { facetsModel: V113, cardModel: V113 });
    expect(features.values.facets).toBeNull();
    expect(features.cards[0]).toMatchObject({ p: null, engine: null });
  });

  it('keeps an answer of the non-Jev pin itself', async () => {
    const features = await captured('jev-test-1', {
      facetsModel: 'jev-test-1',
      cardModel: 'jev-test-1',
    });
    expect(features.values.facets).toEqual({ time_sensitive: 0.9 });
    expect(features.cards[0]!.p).toBeCloseTo(0.7, 5);
  });

  it('drops family answers whose state hash is obsolete', async () => {
    const features = await captured(V114, {
      facetsModel: V113,
      facetsState: 'obsolete-enrich',
      cardModel: V113,
      cardState: 'obsolete-state',
    });
    expect(features.values.facets).toBeNull();
    expect(features.cards[0]).toMatchObject({ p: null, engine: null });
  });
});
