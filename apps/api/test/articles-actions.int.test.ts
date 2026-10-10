import { randomUUID } from 'node:crypto';

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
  DAY,
  HOUR,
  ago,
  carriedArticle,
  clearOutbox,
  clusterOf,
  events,
  explainJson,
  fence,
  freshFence,
  newReader,
  outbox,
  rank,
  rankRevision,
  readerState,
  restamp,
  subscribedFeed,
  type Reader,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * M4-T7 (spec 08 §5.3–5.4, spec 06 §8.2, §8.4, §10): every reader action through `req.mutate`
 * (fences, idempotent retries, exact undo), event provenance and feature snapshots, rank/learn
 * intents, example suggestions, bookmarks with retained snapshots and selected training requests.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

interface Item {
  id: string;
  stateVersion: string;
  contentRevision: string;
  readAt: string | null;
  rating: 1 | -1 | null;
  reason: string | null;
  archivedAt: string | null;
  bookmarkedAt: string | null;
  labelIds: string[];
  labelSuggestions: string[];
  bookmarkCapture: {
    status: string;
    generation: string;
    snapshotId: string | null;
  } | null;
  analysis: { mode: string; status: string; requestId: string | null };
}

async function setup(
  prefs: Record<string, unknown> = {},
  feedMode: 'active' | 'off' | 'training' = 'active',
) {
  const r = await newReader(h, prefs);
  const feed = await subscribedFeed(h, r.user.id, { mode: feedMode });
  const article = await carriedArticle(h, [feed]);
  return { r, feed, article };
}

async function ok(
  promise: ReturnType<Reader['api']['post']>,
  status = 200,
): Promise<{ item: Item; mutationId: string } & Record<string, unknown>> {
  const res = await promise;
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function errorOf(promise: ReturnType<Reader['api']['post']>, status: number) {
  const res = await promise;
  expect(res.statusCode, res.body).toBe(status);
  return res.json().error as { code: string; details?: Record<string, unknown> };
}

async function createLabel(userId: string, name = 'Politics'): Promise<string> {
  const card = await createCard(h.owner, {
    kind: 'label',
    visibility: 'private',
    ownerUserId: userId,
    title: name,
  });
  await h.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)`, [
    userId,
    card.id,
    name,
  ]);
  return card.id;
}

async function holdCard(userId: string, strength: string, title = 'EV batteries'): Promise<string> {
  const card = await createCard(h.owner, { title });
  await h.owner.query(`INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, $3)`, [
    userId,
    card.id,
    strength,
  ]);
  return card.id;
}

const QUESTION_SET_SHA = 'f'.repeat(64);

/** The model the snapshot attributes answers to: the stored pin, else the API's `TYPESAFE_MODEL`. */
async function currentModel(): Promise<string> {
  const pin = (
    await h.owner.query<{ value: { model?: string } }>(
      `SELECT value FROM settings WHERE key = 'engine.model_pin'`,
    )
  ).rows[0]?.value;
  return pin?.model ?? h.config.typesafeModel;
}

/** The match and enrich `state_sha256` the article has now (no translation exists in these tests). */
async function currentStates(articleId: string): Promise<{ state: string; enrich: string }> {
  const env = {
    dailyBudgetUsd: h.config.dailyBudgetUsd,
    languageModes: h.config.languageModes,
    signupMode: h.config.signupMode,
  };
  const setting = async (key: string): Promise<unknown> =>
    (await h.owner.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]))
      .rows[0]?.value;
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
  const languageModes = readSetting('language_modes', await setting('language_modes'), env) ?? {};
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

/** The `state_sha256` and `card_input_sha256` a current answer of the article to the card carries. */
async function currentHashes(
  articleId: string,
  cardId: string,
): Promise<{ state: string; card: string }> {
  const env = {
    dailyBudgetUsd: h.config.dailyBudgetUsd,
    languageModes: h.config.languageModes,
    signupMode: h.config.signupMode,
  };
  const setting = async (key: string): Promise<unknown> =>
    (await h.owner.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]))
      .rows[0]?.value;
  const card = (
    await h.owner.query<{ kind: 'interest' | 'label'; title: string; body: CardBody }>(
      `SELECT kind, title, body FROM interest_cards WHERE id = $1`,
      [cardId],
    )
  ).rows[0]!;
  const mode = readSetting('card_text_mode', await setting('card_text_mode'), env) ?? 'as_written';
  return {
    state: (await currentStates(articleId)).state,
    card: builtCardQuestion(card, mode).sha256,
  };
}

async function answer(articleId: string, cardId: string, p: number, revision = 1): Promise<void> {
  await h.owner.query(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('match', 'articles-test', $1, '{}') ON CONFLICT DO NOTHING`,
    [QUESTION_SET_SHA],
  );
  // The snapshot reads answers of the active match set only.
  await h.owner.query(
    `INSERT INTO settings (key, value)
     SELECT 'question_sets.active', jsonb_build_object('match', id::text) FROM question_sets WHERE sha256 = $1
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`,
    [QUESTION_SET_SHA],
  );
  const hashes = await currentHashes(articleId, cardId);
  await h.owner.query(
    `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                               state_sha256, card_input_sha256, state_variant, model)
     VALUES ($1, $2, $3, 'typesafe', $5, $4, $6, $7, 'native', $8)`,
    [
      articleId,
      cardId,
      p,
      revision,
      QUESTION_SET_SHA,
      hashes.state,
      hashes.card,
      await currentModel(),
    ],
  );
}

/** A pending selected request, inserted as its tenant (the insert trigger checks it). */
async function selectArticle(userId: string, feedId: string, articleId: string): Promise<string> {
  const id = randomUUID();
  const client = await h.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       SELECT $1, $2, $3, a.id, a.content_revision, s.inference_version, '{"article":"frozen"}',
              encode(sha256(convert_to('{"article":"frozen"}'::jsonb::text, 'UTF8')), 'hex')
         FROM articles a JOIN subscriptions s ON s.user_id = $2 AND s.feed_id = $3
        WHERE a.id = $4`,
      [id, userId, feedId, articleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

const queues = async (userId: string) => (await outbox(h, userId)).map((job) => job.queue);

describe('single-article state actions', () => {
  it('read and unread record events; a clustered story requests a full rank', async () => {
    const { r, feed, article } = await setup();
    const loose = await carriedArticle(h, [feed]);
    const before = await rankRevision(h, r.user.id);
    // An unclustered read changes no ranking input.
    await ok(r.api.post(`/articles/${loose}/read`, freshFence));
    expect(await rankRevision(h, r.user.id)).toBe(before);
    await clusterOf(h, [article]);
    await clearOutbox(h, r.user.id);
    const read = await ok(r.api.post(`/articles/${article}/read`, freshFence));
    expect(read.item).toMatchObject({ stateVersion: '1', readAt: expect.any(String) });
    expect(read.mutationId).toEqual(expect.any(String));
    expect(BigInt(await rankRevision(h, r.user.id))).toBe(BigInt(before) + 1n);
    expect(await queues(r.user.id)).toContain('user.rank');

    const unread = await ok(r.api.post(`/articles/${article}/unread`, fence(read.item)));
    expect(unread.item).toMatchObject({ stateVersion: '2', readAt: null });
    const evs = await events(h, r.user.id, article);
    expect(evs.map((e) => e.kind)).toEqual(['read', 'unread']);
    expect(evs[0]!.value).toMatchObject({
      signalOrigin: 'explicit',
      learningConsent: { implicitFeedback: false, implicitNegative: false },
    });
    expect(evs[0]!.value['features'] ?? null).toBeNull();
    // A no-op read of an already read article appends nothing.
    const again = await ok(r.api.post(`/articles/${article}/read`, fence(unread.item)));
    await ok(r.api.post(`/articles/${article}/read`, fence(again.item)));
    expect((await events(h, r.user.id, article)).length).toBe(3);
  });

  it('expand-triggered reads are recorded as such and never carry features', async () => {
    const { r, article } = await setup({ implicitFeedback: true, implicitNegative: true });
    await ok(r.api.post(`/articles/${article}/read`, { ...freshFence, trigger: 'expand' }));
    const [event] = await events(h, r.user.id, article);
    expect(event!.value).toMatchObject({ signalOrigin: 'expand' });
    expect(event!.value['features'] ?? null).toBeNull();
  });

  it('open requires a safe URL and sets opened_at and read_at', async () => {
    const { r, feed, article } = await setup();
    const opened = await ok(r.api.post(`/articles/${article}/open`, freshFence));
    expect(opened.item.readAt).not.toBeNull();
    const state = await readerState(h, r.user.id, article);
    expect(state!.opened_at).not.toBeNull();
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual(['open']);

    const unsafe = await carriedArticle(h, [feed], { url: 'javascript:alert(1)' });
    const error = await errorOf(r.api.post(`/articles/${unsafe}/open`, freshFence), 400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('a stale fence or content revision is STALE_STATE with the current item', async () => {
    const { r, article } = await setup();
    await ok(r.api.post(`/articles/${article}/read`, freshFence));
    const stale = await errorOf(r.api.post(`/articles/${article}/unread`, freshFence), 409);
    expect(stale.code).toBe('STALE_STATE');
    expect(stale.details).toMatchObject({ item: { id: article, stateVersion: '1' } });
    const revision = await errorOf(
      r.api.post(`/articles/${article}/unread`, { stateVersion: '1', contentRevision: '2' }),
      409,
    );
    expect(revision.code).toBe('STALE_STATE');
  });

  it('actions on inaccessible articles are 404', async () => {
    const { r } = await setup();
    const other = await setup();
    await errorOf(r.api.post(`/articles/${other.article}/read`, freshFence), 404);
    await errorOf(r.api.post('/articles/999999999/rating', { ...freshFence, rating: 1 }), 404);
    expect(await readerState(h, r.user.id, other.article)).toBeUndefined();
  });
});

describe('/dwell', () => {
  it('stores nothing without the implicit-feedback opt-in', async () => {
    const { r, article } = await setup();
    const opened = await ok(r.api.post(`/articles/${article}/open`, freshFence));
    const dwell = await ok(
      r.api.post(`/articles/${article}/dwell`, { ...fence(opened.item), ms: 9000 }),
    );
    expect(dwell).toMatchObject({
      prompt: false,
      item: { stateVersion: opened.item.stateVersion },
    });
    expect((await readerState(h, r.user.id, article))!.dwell_ms).toBeNull();
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual(['open']);
  });

  it('validates the duration, needs an open, clamps and prompts at most once', async () => {
    const { r, feed, article } = await setup({ implicitFeedback: true });
    await rank(h, r.user.id, article, { lane: 'maybe', p: 0.5, tier: 3 });
    for (const ms of [-1, 1_800_001, 1.5]) {
      await errorOf(r.api.post(`/articles/${article}/dwell`, { ...freshFence, ms }), 400);
    }
    const notOpened = await errorOf(
      r.api.post(`/articles/${article}/dwell`, { ...freshFence, ms: 1000 }),
      409,
    );
    expect(notOpened).toMatchObject({ code: 'CONFLICT', details: { reason: 'not_opened' } });

    const opened = await ok(r.api.post(`/articles/${article}/open`, freshFence));
    // Clamped to the time since the open: a just-opened article cannot claim 20 minutes.
    const quick = await ok(
      r.api.post(`/articles/${article}/dwell`, { ...fence(opened.item), ms: 1_200_000 }),
    );
    expect(quick.prompt).toBe(false);
    expect((await readerState(h, r.user.id, article))!.dwell_ms).toBeLessThan(60_000);

    await h.owner.query(
      `UPDATE user_article SET opened_at = now() - interval '5 minutes' WHERE user_id = $1 AND article_id = $2`,
      [r.user.id, article],
    );
    const long = await ok(
      r.api.post(`/articles/${article}/dwell`, { ...fence(quick.item), ms: 9000 }),
    );
    expect(long.prompt).toBe(true);
    const state = await readerState(h, r.user.id, article);
    expect(state).toMatchObject({ dwell_ms: 9000, feedback_prompted_at: expect.any(Date) });
    const twice = await ok(
      r.api.post(`/articles/${article}/dwell`, { ...fence(long.item), ms: 8000 }),
    );
    expect(twice.prompt).toBe(false);
    expect((await readerState(h, r.user.id, article))!.dwell_ms).toBe(9000);
    const kinds = (await events(h, r.user.id, article)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'dwell').length).toBe(3);

    // A rated article is never prompted.
    const rated = await carriedArticle(h, [feed]);
    await rank(h, r.user.id, rated, { lane: 'maybe', p: 0.5, tier: 3 });
    const rate = await ok(r.api.post(`/articles/${rated}/rating`, { ...freshFence, rating: 1 }));
    const open2 = await ok(r.api.post(`/articles/${rated}/open`, fence(rate.item)));
    await h.owner.query(
      `UPDATE user_article SET opened_at = now() - interval '5 minutes' WHERE user_id = $1 AND article_id = $2`,
      [r.user.id, rated],
    );
    const noPrompt = await ok(
      r.api.post(`/articles/${rated}/dwell`, { ...fence(open2.item), ms: 9000 }),
    );
    expect(noPrompt.prompt).toBe(false);
  });
});

describe('/rating and /prompt-answer', () => {
  it('rates, un-rates and hides with the documented read/archive effects', async () => {
    const { r, article } = await setup();
    const liked = await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    expect(liked.item).toMatchObject({ rating: 1, reason: null, readAt: expect.any(String) });
    expect(liked.exampleSuggestion).toBeNull();
    const unrated = await ok(
      r.api.post(`/articles/${article}/rating`, { ...fence(liked.item), rating: null }),
    );
    expect(unrated.item).toMatchObject({ rating: null, readAt: liked.item.readAt });
    const hidden = await ok(
      r.api.post(`/articles/${article}/rating`, {
        ...fence(unrated.item),
        rating: -1,
        reason: 'clickbait',
        hide: true,
      }),
    );
    expect(hidden.item).toMatchObject({
      rating: -1,
      reason: 'clickbait',
      archivedAt: expect.any(String),
    });
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual([
      'rate',
      'unrate',
      'rate',
    ]);
    // Un-rating forces learning.
    expect(await queues(r.user.id)).toContain('user.learn');

    await errorOf(
      r.api.post(`/articles/${article}/rating`, {
        ...fence(hidden.item),
        rating: 1,
        reason: 'seen',
      }),
      400,
    );
  });

  it('honours markReadOnRate=false', async () => {
    const { r, article } = await setup({ markReadOnRate: false });
    const liked = await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    expect(liked.item.readAt).toBeNull();
  });

  it('records the calibration selection with its source lane', async () => {
    const { r, article } = await setup();
    await rank(h, r.user.id, article, { lane: 'maybe', p: 0.5, tier: 3 });
    const round = (await r.api.get('/articles/calibration')).json();
    expect(round.items.map((i: Item) => i.id)).toEqual([article]);
    await ok(
      r.api.post(`/articles/${article}/rating`, {
        ...freshFence,
        rating: -1,
        selection: 'calibration',
      }),
    );
    const [event] = await events(h, r.user.id, article);
    expect(event!.value['selection']).toEqual({ method: 'calibration', sourceLane: 'maybe' });
    expect((await r.api.get('/articles/calibration')).json().items).toEqual([]);
  });

  it('stores a prompt answer as a rating', async () => {
    const { r, article } = await setup();
    const res = await ok(
      r.api.post(`/articles/${article}/prompt-answer`, { ...freshFence, liked: false }),
    );
    expect(res.item).toMatchObject({ rating: -1, reason: null });
    const [event] = await events(h, r.user.id, article);
    expect(event).toMatchObject({
      kind: 'prompt_answer',
      value: { rating: -1, signalOrigin: 'explicit' },
    });
  });

  it('freezes the feature snapshot with every applicable card and its snapshot-time strength', async () => {
    const { r, feed, article } = await setup();
    const love = await holdCard(r.user.id, 'love', 'Batteries');
    const never = await holdCard(r.user.id, 'never', 'Crypto');
    const unanswered = await holdCard(r.user.id, 'like', 'Rail');
    const otherFeed = await subscribedFeed(h, r.user.id);
    const scoped = await holdCard(r.user.id, 'must', 'Scoped elsewhere');
    await h.owner.query(
      `UPDATE user_cards SET scope_feed_id = $3 WHERE user_id = $1 AND card_id = $2`,
      [r.user.id, scoped, otherFeed],
    );
    await answer(article, love, 0.8);
    await answer(article, never, 0.2);
    await rank(h, r.user.id, article, { lane: 'for_you', p: 0.8, tier: 4 });

    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    // A later strength change does not rewrite the frozen snapshot.
    await h.owner.query(
      `UPDATE user_cards SET strength = 'like' WHERE user_id = $1 AND card_id = $2`,
      [r.user.id, love],
    );
    const [event] = await events(h, r.user.id, article);
    const features = event!.value['features'] as Record<string, unknown>;
    expect(features).toMatchObject({
      specSha: expect.stringMatching(/^[0-9a-f]{64}$/),
      ratingSha: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceManifest: { contentRevision: '1', inferenceFeedIds: [feed] },
    });
    const cards = (features['cards'] as { id: string; strength: string; p: number | null }[]).map(
      (c) => [c.id, c.strength, c.p === null ? null : Math.round(c.p * 100) / 100],
    );
    expect(cards).toEqual(
      [
        [love, 'love', 0.8],
        [never, 'never', 0.2],
        [unanswered, 'like', null],
      ].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
    expect(event!.value['before']).toMatchObject({ lane: 'for_you', tier: 4 });

    // An ineligible (off-feed) article keeps the rating but has no features.
    const offFeed = await subscribedFeed(h, r.user.id, { mode: 'off' });
    const neutral = await carriedArticle(h, [offFeed]);
    const res = await ok(r.api.post(`/articles/${neutral}/rating`, { ...freshFence, rating: -1 }));
    expect(res.item.rating).toBe(-1);
    expect((await events(h, r.user.id, neutral))[0]!.value).toMatchObject({ features: null });
  });

  it('keeps the first rating of an unanalyzed article', async () => {
    const { r, article } = await setup();
    await holdCard(r.user.id, 'love');
    const res = await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    expect(res.item.rating).toBe(1);
    const [event] = await events(h, r.user.id, article);
    const cards = (event!.value['features'] as { cards: { p: number | null }[] }).cards;
    expect(cards.map((c) => c.p)).toEqual([null]);
  });

  it('records user.learn once retrainEvery articles changed, never for labels', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const articles: string[] = [];
    for (let i = 0; i < 11; i += 1) articles.push(await carriedArticle(h, [feed]));
    const label = await createLabel(r.user.id);
    const bulk = await r.api.post('/articles/rate-bulk', {
      targets: articles.slice(0, 9).map((id) => ({ id, ...freshFence })),
      rating: 1,
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(await queues(r.user.id)).not.toContain('user.learn');
    await ok(r.api.post(`/articles/${articles[9]!}/labels`, { ...freshFence, labelId: label }));
    expect(await queues(r.user.id)).not.toContain('user.learn');
    await ok(r.api.post(`/articles/${articles[10]!}/rating`, { ...freshFence, rating: -1 }));
    expect((await outbox(h, r.user.id, 'user.learn')).map((j) => j.payload)).toEqual([
      { userId: r.user.id },
    ]);
  });
});

describe('example suggestions (spec 06 §10)', () => {
  async function suggestible(r: Reader, feed: string, cardId: string, title: string) {
    const article = await carriedArticle(h, [feed], { title });
    await rank(h, r.user.id, article, {
      lane: 'maybe',
      p: 0.5,
      tier: 3,
      explain: explainJson({
        p: 0.5,
        lane: 'maybe',
        tier: 3,
        decidingCardId: cardId,
        cards: [{ id: cardId, title: 'C', strength: 'love', p: 0.5, engine: 'typesafe' }],
      }),
    });
    return article;
  }

  it('returns and stores the suggestion and respects the 7-day and 24-hour limits', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const card = await holdCard(r.user.id, 'love');
    const first = await suggestible(r, feed, card, 'Solid-state pilot line hits 1,000 cycles');
    const res = await ok(r.api.post(`/articles/${first}/rating`, { ...freshFence, rating: 1 }));
    expect(res.exampleSuggestion).toEqual({ cardId: card, side: 'yes' });
    const [event] = await events(h, r.user.id, first);
    expect(event!.value['exampleSuggestion']).toEqual({ cardId: card, side: 'yes' });

    // Same card within 7 days: no suggestion.
    const second = await suggestible(r, feed, card, 'Sodium-ion cells reach the grid');
    const again = await ok(r.api.post(`/articles/${second}/rating`, { ...freshFence, rating: 1 }));
    expect(again.exampleSuggestion).toBeNull();

    // Three suggestions in the last 24 hours block a fourth card.
    const others = [await holdCard(r.user.id, 'like'), await holdCard(r.user.id, 'like')];
    for (const other of others) {
      await h.owner.query(
        `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
         VALUES ($1, $2, 'rate', $3::jsonb, now() - interval '1 hour')`,
        [r.user.id, first, JSON.stringify({ exampleSuggestion: { cardId: other, side: 'yes' } })],
      );
    }
    const fresh = await holdCard(r.user.id, 'love');
    const third = await suggestible(r, feed, fresh, 'Lithium recycling plant opens');
    const blocked = await ok(r.api.post(`/articles/${third}/rating`, { ...freshFence, rating: 1 }));
    expect(blocked.exampleSuggestion).toBeNull();
    await h.owner.query(
      `UPDATE feedback_events SET created_at = now() - interval '2 days'
        WHERE user_id = $1 AND value -> 'exampleSuggestion' ->> 'cardId' = ANY($2::text[])`,
      [r.user.id, others],
    );
    const fourth = await suggestible(r, feed, fresh, 'Battery passport rules agreed');
    const allowed = await ok(
      r.api.post(`/articles/${fourth}/rating`, { ...freshFence, rating: 1 }),
    );
    expect(allowed.exampleSuggestion).toEqual({ cardId: fresh, side: 'yes' });
  });

  it('never suggests for bulk ratings or when the preference is off', async () => {
    const r = await newReader(h, { exampleSuggestions: false });
    const feed = await subscribedFeed(h, r.user.id);
    const card = await holdCard(r.user.id, 'love');
    const article = await suggestible(r, feed, card, 'Grid batteries double');
    const res = await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    expect(res.exampleSuggestion).toBeNull();
  });
});

describe('labels', () => {
  it('assigns and removes a held label without touching cards or learning', async () => {
    const { r, article } = await setup();
    const card = await holdCard(r.user.id, 'love');
    const label = await createLabel(r.user.id);
    const cardsBefore = await h.owner.query(
      `SELECT c.id, c.body, c.text_hash, uc.strength FROM interest_cards c
         LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = $1
        WHERE c.id = ANY($2::bigint[]) ORDER BY c.id`,
      [r.user.id, [card, label]],
    );
    await h.owner.query(
      `UPDATE user_article SET label_suggestions = ARRAY[$3::bigint] WHERE user_id = $1 AND article_id = $2`,
      [r.user.id, article, label],
    );
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, label_suggestions) VALUES ($1, $2, ARRAY[$3::bigint])
       ON CONFLICT DO NOTHING`,
      [r.user.id, article, label],
    );
    await clearOutbox(h, r.user.id);
    const added = await ok(
      r.api.post(`/articles/${article}/labels`, { ...freshFence, labelId: label }),
    );
    expect(added.item).toMatchObject({ labelIds: [label], labelSuggestions: [] });
    const removed = await ok(
      r.api.delete(`/articles/${article}/labels/${label}`, { query: fence(added.item) }),
    );
    expect(removed.item.labelIds).toEqual([]);
    expect(
      (await events(h, r.user.id, article)).map((e) => [e.kind, e.value['features'] ?? null]),
    ).toEqual([
      ['label', null],
      ['unlabel', null],
    ]);
    const cardsAfter = await h.owner.query(
      `SELECT c.id, c.body, c.text_hash, uc.strength FROM interest_cards c
         LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = $1
        WHERE c.id = ANY($2::bigint[]) ORDER BY c.id`,
      [r.user.id, [card, label]],
    );
    expect(cardsAfter.rows).toEqual(cardsBefore.rows);
    expect(await queues(r.user.id)).toEqual([]);

    const foreign = await createLabel((await newReader(h)).user.id, 'Not mine');
    await errorOf(
      r.api.post(`/articles/${article}/labels`, { ...fence(removed.item), labelId: foreign }),
      404,
    );
  });
});

describe('/mute-story', () => {
  it('creates a cluster when missing and a mute_story rule; enqueues a full rank', async () => {
    const { r, article } = await setup();
    await clearOutbox(h, r.user.id);
    const res = await r.api.post(`/articles/${article}/mute-story`, { days: 7 });
    expect(res.statusCode, res.body).toBe(201);
    const { rule } = res.json();
    const cluster = await h.owner.query<{ id: string }>(
      `SELECT story_cluster_id::text AS id FROM articles WHERE id = $1`,
      [article],
    );
    expect(cluster.rows[0]!.id).not.toBeNull();
    expect(rule).toMatchObject({
      kind: 'mute_story',
      value: cluster.rows[0]!.id,
      expiresAt: expect.any(String),
    });
    expect(Date.parse(rule.expiresAt) - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect((await outbox(h, r.user.id, 'user.rank')).map((j) => j.payload['full'])).toEqual([true]);
    const repeat = await r.api.post(`/articles/${article}/mute-story`, { days: 1 });
    expect(repeat.json().rule.id).toBe(rule.id);
    expect((await r.api.post(`/articles/${article}/mute-story`, { days: 2 })).statusCode).toBe(400);
  });
});

describe('bulk actions', () => {
  it('mark-read by targets is all-or-nothing and never touches foreign articles', async () => {
    const { r, feed, article } = await setup();
    const second = await carriedArticle(h, [feed]);
    const other = await setup();
    const mixed = await errorOf(
      r.api.post('/articles/mark-read', {
        targets: [
          { id: article, ...freshFence },
          { id: other.article, ...freshFence },
        ],
      }),
      404,
    );
    expect(mixed.code).toBe('NOT_FOUND');
    expect(await readerState(h, r.user.id, article)).toBeUndefined();
    expect(await readerState(h, other.r.user.id, other.article)).toBeUndefined();
    expect(await readerState(h, r.user.id, other.article)).toBeUndefined();

    const res = await r.api.post('/articles/mark-read', {
      targets: [
        { id: article, ...freshFence },
        { id: second, ...freshFence },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ count: 2, mutationId: expect.any(String) });
    const [event] = await events(h, r.user.id, article);
    expect(event).toMatchObject({ kind: 'mark_read', value: { signalOrigin: 'bulk_mark_read' } });
    const stale = await errorOf(
      r.api.post('/articles/mark-read', { targets: [{ id: article, ...freshFence }] }),
      409,
    );
    expect(stale.code).toBe('STALE_STATE');
  });

  it('mark-read by filter checks the dataset version and the 5,000 cap', async () => {
    const { r, feed } = await setup();
    const listed = (await r.api.get('/articles', { query: { lane: 'all' } })).json();
    await carriedArticle(h, [feed], { arrival: ago(HOUR) });
    const stale = await errorOf(
      r.api.post('/articles/mark-read', {
        filter: { lane: 'all', olderThan: listed.asOf },
        datasetVersion: listed.datasetVersion,
      }),
      409,
    );
    expect(stale.code).toBe('STALE_STATE');

    await h.owner.query(
      `WITH a AS (
         INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash, first_seen_at)
         SELECT 'https://bulk.example.test/' || g, 'https://bulk.example.test/' || g,
                'bulk.example.test/' || g || '-' || $2, 'Bulk ' || g, 'bulk ' || g, md5(g::text || $2),
                now() - interval '2 hours'
           FROM generate_series(1, 5001) g RETURNING id)
       INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       SELECT $1, a.id, 'bulk-' || a.id, now() - interval '2 hours' FROM a`,
      [feed, randomUUID()],
    );
    const big = (await r.api.get('/articles', { query: { lane: 'all', limit: '1' } })).json();
    const tooMany = await errorOf(
      r.api.post('/articles/mark-read', {
        filter: { lane: 'all', olderThan: big.asOf },
        datasetVersion: big.datasetVersion,
      }),
      400,
    );
    expect(tooMany).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'too_many_targets' },
    });
    const unread = await h.owner.query(
      `SELECT count(*)::int AS n FROM user_article WHERE user_id = $1 AND read_at IS NOT NULL`,
      [r.user.id],
    );
    expect(unread.rows[0]).toEqual({ n: 0 });
  });

  it('rejects an article listed twice in rate-bulk and mark-read targets', async () => {
    const { r, article } = await setup();
    const twice = [
      { id: article, ...freshFence },
      { id: article, ...freshFence },
    ];
    const rated = await r.api.post('/articles/rate-bulk', { targets: twice, rating: 1 });
    expect(rated.statusCode, rated.body).toBe(400);
    const read = await r.api.post('/articles/mark-read', { targets: twice });
    expect(read.statusCode, read.body).toBe(400);
    expect(await events(h, r.user.id, article)).toEqual([]);
  });

  it('rate-bulk applies single-rating semantics; null un-rates; undo restores', async () => {
    const { r, feed, article } = await setup();
    const second = await carriedArticle(h, [feed]);
    const liked = await r.api.post('/articles/rate-bulk', {
      targets: [
        { id: article, ...freshFence },
        { id: second, ...freshFence },
      ],
      rating: 1,
    });
    expect(liked.statusCode, liked.body).toBe(200);
    const body = liked.json();
    expect(body.count).toBe(2);
    expect(body.items.map((i: Item) => i.rating)).toEqual([1, 1]);
    const cleared = await r.api.post('/articles/rate-bulk', {
      targets: body.items.map((i: Item) => ({ id: i.id, ...fence(i) })),
      rating: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().items.map((i: Item) => i.rating)).toEqual([null, null]);
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual(['rate', 'unrate']);
    const undo = await r.api.post('/articles/undo', { mutationId: cleared.json().mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json()).toMatchObject({ count: 2 });
    expect(undo.json().items.map((i: Item) => i.rating)).toEqual([1, 1]);
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual([
      'rate',
      'unrate',
      'undo',
    ]);
  });

  it('rate-bulk with a foreign target mutates nothing', async () => {
    const { r, article } = await setup();
    const other = await setup();
    await errorOf(
      r.api.post('/articles/rate-bulk', {
        targets: [
          { id: article, ...freshFence },
          { id: other.article, ...freshFence },
        ],
        rating: -1,
      }),
      404,
    );
    expect(await events(h, r.user.id)).toEqual([]);
    expect(await events(h, other.r.user.id)).toEqual([]);
  });
});

describe('idempotency and undo', () => {
  it('a retry with the same key replays without a second effect', async () => {
    const { r, article } = await setup();
    const key = randomUUID();
    const first = await r.api.post(
      `/articles/${article}/rating`,
      { ...freshFence, rating: 1 },
      { idempotencyKey: key },
    );
    const replay = await r.api.post(
      `/articles/${article}/rating`,
      { ...freshFence, rating: 1 },
      { idempotencyKey: key },
    );
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.json().mutationId).toBe(key);
    expect((await events(h, r.user.id, article)).length).toBe(1);
    const conflict = await errorOf(
      r.api.post(
        `/articles/${article}/rating`,
        { ...freshFence, rating: -1 },
        { idempotencyKey: key },
      ),
      409,
    );
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('undo restores exactly the prior fields and rejects later edits', async () => {
    const { r, article } = await setup();
    const liked = await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const disliked = await ok(
      r.api.post(`/articles/${article}/rating`, {
        ...fence(liked.item),
        rating: -1,
        reason: 'promo',
        hide: true,
      }),
    );
    await clearOutbox(h, r.user.id);
    const undo = await r.api.post('/articles/undo', { mutationId: disliked.mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    const restored = undo.json().items[0] as Item;
    expect(restored).toMatchObject({
      rating: 1,
      reason: null,
      archivedAt: null,
      readAt: liked.item.readAt,
    });
    expect(BigInt(restored.stateVersion)).toBe(BigInt(disliked.item.stateVersion) + 1n);
    expect(await queues(r.user.id)).toEqual(expect.arrayContaining(['user.rank', 'user.learn']));
    const undoEvent = (await events(h, r.user.id, article)).at(-1)!;
    expect(undoEvent).toMatchObject({ kind: 'undo', value: { mutationId: disliked.mutationId } });

    const twice = await errorOf(
      r.api.post('/articles/undo', { mutationId: disliked.mutationId }),
      409,
    );
    expect(twice).toMatchObject({ code: 'CONFLICT' });
    const later = await errorOf(
      r.api.post('/articles/undo', { mutationId: liked.mutationId }),
      409,
    );
    expect(later.code).toBe('STALE_STATE');
    const other = await newReader(h);
    await errorOf(other.api.post('/articles/undo', { mutationId: liked.mutationId }), 404);
    await errorOf(r.api.post('/articles/undo', { mutationId: randomUUID() }), 404);
  });

  it('a non-undoable action (open) cannot be undone', async () => {
    const { r, article } = await setup();
    const opened = await ok(r.api.post(`/articles/${article}/open`, freshFence));
    const error = await errorOf(
      r.api.post('/articles/undo', { mutationId: opened.mutationId }),
      409,
    );
    expect(error).toMatchObject({ code: 'CONFLICT', details: { reason: 'not_undoable' } });
  });

  it('undo of a filter mark-read restores unread state', async () => {
    const { r, feed, article } = await setup();
    const listed = (await r.api.get('/articles', { query: { lane: 'all', feedId: feed } })).json();
    const res = await r.api.post(`/subscriptions/${feed}/mark-read`, {
      olderThan: listed.asOf,
      datasetVersion: listed.datasetVersion,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().count).toBe(1);
    expect((await readerState(h, r.user.id, article))!.read_at).not.toBeNull();
    const undo = await r.api.post('/articles/undo', { mutationId: res.json().mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await readerState(h, r.user.id, article))!.read_at).toBeNull();

    const other = await newReader(h);
    const theirs = await subscribedFeed(h, other.user.id);
    await errorOf(
      r.api.post(`/subscriptions/${theirs}/mark-read`, {
        olderThan: listed.asOf,
        datasetVersion: listed.datasetVersion,
      }),
      404,
    );
  });
});

describe('bookmarks and saved snapshots', () => {
  it('captures, unbookmarks with a pinned snapshot and undoes exactly', async () => {
    const { r, article } = await setup();
    const saved = await ok(r.api.post(`/articles/${article}/bookmark`, freshFence));
    expect(saved.item.bookmarkedAt).not.toBeNull();
    expect(saved.item.bookmarkCapture).toMatchObject({
      status: 'pending',
      snapshotId: expect.any(String),
    });
    expect(await queues(r.user.id)).toContain('article.capture-bookmark');
    expect((await events(h, r.user.id, article)).map((e) => e.kind)).toEqual(['bookmark']);
    // Re-bookmarking is a no-op.
    const again = await ok(r.api.post(`/articles/${article}/bookmark`, fence(saved.item)));
    expect(again.item.stateVersion).toBe(saved.item.stateVersion);

    const snapshotId = saved.item.bookmarkCapture!.snapshotId!;
    const removed = await r.api.delete(`/articles/${article}/bookmark`, {
      query: fence(saved.item),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().item).toMatchObject({ bookmarkedAt: null, bookmarkCapture: null });
    const pins = await h.owner.query(
      `SELECT snapshot_id::text FROM bookmark_snapshot_pins WHERE user_id = $1 AND mutation_id = $2`,
      [r.user.id, removed.json().mutationId],
    );
    expect(pins.rows).toEqual([{ snapshot_id: snapshotId }]);
    expect(await queues(r.user.id)).toContain('user.learn');

    const undo = await r.api.post('/articles/undo', { mutationId: removed.json().mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    const state = await readerState(h, r.user.id, article);
    expect(state).toMatchObject({
      bookmark_snapshot_id: snapshotId,
      bookmarked_at: expect.any(Date),
    });
    expect(BigInt(state!.bookmark_capture_generation)).toBeGreaterThan(
      BigInt(saved.item.bookmarkCapture!.generation),
    );
  });

  it('retry-capture needs a partial/failed capture at the displayed generation', async () => {
    const { r, article } = await setup();
    const saved = await ok(r.api.post(`/articles/${article}/bookmark`, freshFence));
    const generation = saved.item.bookmarkCapture!.generation;
    const notRetryable = await errorOf(
      r.api.post(`/articles/${article}/bookmark/retry-capture`, {
        ...fence(saved.item),
        captureGeneration: generation,
      }),
      409,
    );
    expect(notRetryable.code).toBe('CONFLICT');
    await h.owner.query(
      `UPDATE user_article SET bookmark_capture_status = 'failed' WHERE user_id = $1 AND article_id = $2`,
      [r.user.id, article],
    );
    const wrong = await errorOf(
      r.api.post(`/articles/${article}/bookmark/retry-capture`, {
        ...fence(saved.item),
        captureGeneration: String(BigInt(generation) + 5n),
      }),
      409,
    );
    expect(wrong.code).toBe('STALE_STATE');
    const retried = await ok(
      r.api.post(`/articles/${article}/bookmark/retry-capture`, {
        ...fence(saved.item),
        captureGeneration: generation,
      }),
      202,
    );
    expect(BigInt(retried.item.bookmarkCapture!.generation)).toBeGreaterThan(BigInt(generation));
  });

  it('saved snapshots survive unsubscribing and stay private; snapshot fences accept older revisions', async () => {
    const { r, feed, article } = await setup();
    const saved = await ok(r.api.post(`/articles/${article}/bookmark`, freshFence));
    const snapshotId = saved.item.bookmarkCapture!.snapshotId!;
    // A newer live revision and a lost source URL (publisher change/404) leave the save intact.
    await h.owner.query(`UPDATE articles SET content_revision = 2, url = NULL WHERE id = $1`, [
      article,
    ]);
    await h.owner.query(`DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2`, [
      r.user.id,
      feed,
    ]);
    const view = await r.api.get(`/articles/${article}`, { query: { view: 'saved' } });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().bookmarkSnapshot).toMatchObject({
      id: snapshotId,
      contentRevision: '1',
      completeness: 'partial',
    });
    const other = await newReader(h);
    expect(
      (await other.api.get(`/articles/${article}`, { query: { view: 'saved' } })).statusCode,
    ).toBe(404);

    const snapshotFence = {
      stateVersion: saved.item.stateVersion,
      contentRevision: '1',
      snapshotId,
    };
    const rated = await ok(
      r.api.post(`/articles/${article}/rating`, { ...snapshotFence, rating: 1 }),
    );
    expect(rated.item.rating).toBe(1);
    const [, rate] = await events(h, r.user.id, article);
    expect(rate!.value).toMatchObject({ snapshotId, contentRevision: '1', features: null });

    const label = await createLabel(r.user.id);
    await ok(
      r.api.post(`/articles/${article}/labels`, {
        stateVersion: rated.item.stateVersion,
        contentRevision: '1',
        snapshotId,
        labelId: label,
      }),
    );
    const mismatched = await errorOf(
      r.api.post(`/articles/${article}/rating`, {
        stateVersion: String(BigInt(rated.item.stateVersion) + 1n),
        contentRevision: '2',
        snapshotId,
        rating: -1,
      }),
      409,
    );
    expect(mismatched.code).toBe('STALE_STATE');
    const live = await errorOf(
      r.api.post(`/articles/${article}/rating`, {
        stateVersion: String(BigInt(rated.item.stateVersion) + 1n),
        contentRevision: '1',
        rating: -1,
      }),
      409,
    );
    expect(live.code).toBe('STALE_STATE');
  });
});

describe('selected training requests', () => {
  it('validates analysisRequestId and records it in the event', async () => {
    const { r, feed, article } = await setup({}, 'training');
    const requestId = await selectArticle(r.user.id, feed, article);
    const inputSha = (
      await h.owner.query<{ input_sha: string }>(
        `SELECT input_sha FROM analysis_requests WHERE id = $1`,
        [requestId],
      )
    ).rows[0]!.input_sha;
    const item = (await r.api.get(`/articles/${article}`)).json();
    expect(item.analysis).toEqual({ mode: 'training', status: 'pending', requestId });

    await errorOf(
      r.api.post(`/articles/${article}/rating`, {
        ...freshFence,
        rating: 1,
        analysisRequestId: randomUUID(),
      }),
      404,
    );
    const rated = await ok(
      r.api.post(`/articles/${article}/rating`, {
        ...freshFence,
        rating: 1,
        analysisRequestId: requestId,
      }),
    );
    const [event] = await events(h, r.user.id, article);
    expect(event!.value).toMatchObject({ analysisRequestId: requestId, inputSha });
    // The pre-feedback inputs are frozen in the request; the event has the eligible snapshot too.
    expect(event!.value['features']).toMatchObject({
      sourceManifest: { inferenceFeedIds: [feed] },
    });

    await h.owner.query(
      `UPDATE analysis_requests SET status = 'cancelled', completed_at = now() WHERE id = $1`,
      [requestId],
    );
    const obsolete = await errorOf(
      r.api.post(`/articles/${article}/prompt-answer`, {
        ...fence(rated.item),
        liked: true,
        analysisRequestId: requestId,
      }),
      409,
    );
    expect(obsolete).toMatchObject({ code: 'CONFLICT', details: { reason: 'obsolete_request' } });
    await restamp(h, r.user.id);
  });

  it('a rating of an older saved revision with a request stores the rating fingerprint and no features', async () => {
    const { r, feed, article } = await setup({}, 'training');
    const requestId = await selectArticle(r.user.id, feed, article);
    const saved = await ok(r.api.post(`/articles/${article}/bookmark`, freshFence));
    const snapshotId = saved.item.bookmarkCapture!.snapshotId!;
    await h.owner.query(`UPDATE articles SET content_revision = 2 WHERE id = $1`, [article]);
    await ok(
      r.api.post(`/articles/${article}/rating`, {
        stateVersion: saved.item.stateVersion,
        contentRevision: '1',
        snapshotId,
        rating: 1,
        analysisRequestId: requestId,
      }),
    );
    const rate = (await events(h, r.user.id, article)).find((e) => e.kind === 'rate')!;
    expect(rate.value).toMatchObject({
      analysisRequestId: requestId,
      features: null,
      ratingSha: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe('feature snapshot reads the current sets (spec 06 §8.2)', () => {
  async function setSetting(key: string, value: unknown) {
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async function questionSet(kind: 'enrich' | 'match', sha: string): Promise<string> {
    const res = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ($1, $2, $3, '{}') RETURNING id::text AS id`,
      [kind, `snapshot-${sha.slice(0, 12)}`, sha],
    );
    return res.rows[0]!.id;
  }

  async function facets(articleId: string, setId: string, features: Record<string, number>) {
    await h.owner.query(
      `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256,
                                   engine, model, state_variant, answers, features)
       VALUES ($1, $2, 1, $4, 'typesafe', $5, 'native', '{}', $3::jsonb)`,
      [
        articleId,
        setId,
        JSON.stringify(features),
        (await currentStates(articleId)).enrich,
        await currentModel(),
      ],
    );
  }

  async function answerWith(
    articleId: string,
    cardId: string,
    p: number,
    sha: string,
    variant: 'native' | 'translated',
  ) {
    const hashes = await currentHashes(articleId, cardId);
    await h.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant, model)
       VALUES ($1, $2, $3, 'typesafe', $4, 1, $6, $7, $5, $8)`,
      [articleId, cardId, p, sha, variant, hashes.state, hashes.card, await currentModel()],
    );
  }

  async function frozen(r: Reader, article: string) {
    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const [event] = await events(h, r.user.id, article);
    return event!.value['features'] as {
      cards: { id: string; p: number | null }[];
      values: { facets: Record<string, number> | null };
    };
  }

  let previous: { active: unknown; modes: unknown };

  beforeAll(async () => {
    const rows = await h.owner.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key IN ('question_sets.active', 'language_modes')`,
    );
    const byKey = new Map(rows.rows.map((row) => [row.key, row.value]));
    previous = { active: byKey.get('question_sets.active'), modes: byKey.get('language_modes') };
  });

  afterAll(async () => {
    for (const [key, value] of [
      ['question_sets.active', previous.active],
      ['language_modes', previous.modes],
    ] as const) {
      if (value === undefined) await h.owner.query(`DELETE FROM settings WHERE key = $1`, [key]);
      else await setSetting(key, value);
    }
  });

  it('captures the active enrich set facets only', async () => {
    const enrichActive = await questionSet('enrich', 'a1'.repeat(32));
    const enrichOld = await questionSet('enrich', 'a2'.repeat(32));
    await setSetting('question_sets.active', { enrich: enrichActive });
    const { r, article } = await setup();
    await facets(article, enrichOld, { time_sensitive: 0.1 });
    expect((await frozen(r, article)).values.facets).toBeNull();

    const second = await setup();
    await facets(second.article, enrichOld, { time_sensitive: 0.1 });
    await facets(second.article, enrichActive, { time_sensitive: 0.9 });
    expect((await frozen(second.r, second.article)).values.facets).toEqual({ time_sensitive: 0.9 });
  });

  it('lists a card answer of a non-active match set with p null', async () => {
    const activeSha = 'b1'.repeat(32);
    const oldSha = 'b2'.repeat(32);
    const active = await questionSet('match', activeSha);
    await questionSet('match', oldSha);
    await setSetting('question_sets.active', { match: active });
    await setSetting('language_modes', { de: 'native' });
    const { r, article } = await setup();
    await h.owner.query(`UPDATE articles SET lang = 'de' WHERE id = $1`, [article]);
    const current = await holdCard(r.user.id, 'love', 'Current set');
    const stale = await holdCard(r.user.id, 'love', 'Old set');
    await answerWith(article, current, 0.7, activeSha, 'native');
    await answerWith(article, stale, 0.6, oldSha, 'native');
    const cards = new Map((await frozen(r, article)).cards.map((c) => [c.id, c.p]));
    expect(cards.get(stale)).toBeNull();
    expect(cards.get(current)).toBeCloseTo(0.7, 5);
  });

  it('decides currency by the state hash, not the variant label of the language mode', async () => {
    const sha = 'c1'.repeat(32);
    const match = await questionSet('match', sha);
    await setSetting('question_sets.active', { match });
    await setSetting('language_modes', { de: 'translate' });
    const { r, article } = await setup();
    await h.owner.query(`UPDATE articles SET lang = 'de' WHERE id = $1`, [article]);
    const native = await holdCard(r.user.id, 'love', 'Native answer');
    const translated = await holdCard(r.user.id, 'love', 'Translated answer');
    await answerWith(article, native, 0.7, sha, 'native');
    await answerWith(article, translated, 0.6, sha, 'translated');
    const cards = new Map((await frozen(r, article)).cards.map((c) => [c.id, c.p]));
    // No translation exists, so the current match state is the native one and both rows carry it.
    expect(cards.get(native)).toBeCloseTo(0.7, 5);
    expect(cards.get(translated)).toBeCloseTo(0.6, 5);
  });
  it('stamps the rating fingerprint from the settings its selection used', async () => {
    const shaOld = 'd1'.repeat(32);
    const shaNew = 'd2'.repeat(32);
    const matchOld = await questionSet('match', shaOld);
    const matchNew = await questionSet('match', shaNew);
    await setSetting('question_sets.active', { match: matchOld });
    await setSetting('language_modes', { de: 'native' });
    const reader = await newReader(h);
    const feed = await subscribedFeed(h, reader.user.id, { mode: 'active' });
    const card = await holdCard(reader.user.id, 'love', 'Switching set');
    const other = await holdCard(reader.user.id, 'love', 'Other set');
    const rated = async (article: string) => {
      await h.owner.query(`UPDATE articles SET lang = 'de' WHERE id = $1`, [article]);
      await answerWith(article, card, 0.7, shaOld, 'native');
      await answerWith(article, other, 0.2, shaNew, 'native');
    };
    const first = await carriedArticle(h, [feed]);
    await rated(first);
    await ok(reader.api.post(`/articles/${first}/rating`, { ...freshFence, rating: 1 }));
    const baseline = (await events(h, reader.user.id, first))[0]!.value['features'] as {
      ratingSha: string;
    };

    const second = await carriedArticle(h, [feed]);
    await rated(second);
    const blocker = await h.owner.connect();
    let writer: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE card_answers IN ACCESS EXCLUSIVE MODE');
      const request = reader.api.post(`/articles/${second}/rating`, { ...freshFence, rating: 1 });
      for (let i = 0; i < 200; i += 1) {
        const waiting = await h.owner.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%card_answers%'
              AND pid <> pg_backend_pid() AND pid <> $1`,
          [(await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid],
        );
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      writer = setSetting('question_sets.active', { match: matchNew });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await blocker.query('COMMIT');
      await ok(request);
    } finally {
      blocker.release();
    }
    await writer;
    const features = (await events(h, reader.user.id, second))[0]!.value['features'] as {
      ratingSha: string;
      cards: { id: string; p: number | null }[];
    };
    expect(features.ratingSha).toBe(baseline.ratingSha);
    expect(features.cards.find((c) => c.id === card)?.p).toBeCloseTo(0.7, 5);
  });
});

describe('revoking an explicit implicit-negative read', () => {
  const consents = { implicitFeedback: true, implicitNegative: true };

  it('unread of an explicit consented read records user.learn', async () => {
    const { r, article } = await setup(consents);
    const read = await ok(r.api.post(`/articles/${article}/read`, freshFence));
    expect(await queues(r.user.id)).not.toContain('user.learn');
    await ok(r.api.post(`/articles/${article}/unread`, fence(read.item)));
    expect(await queues(r.user.id)).toContain('user.learn');
  });

  it('undoing an explicit consented read records user.learn', async () => {
    const { r, article } = await setup(consents);
    const read = await ok(r.api.post(`/articles/${article}/read`, freshFence));
    expect(await queues(r.user.id)).not.toContain('user.learn');
    const undo = await r.api.post('/articles/undo', { mutationId: read.mutationId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await queues(r.user.id)).toContain('user.learn');
  });
});

describe('card answers in the feature snapshot must match the current hashes', () => {
  async function insertAnswer(
    article: string,
    card: string,
    override: { state?: string; card?: string; model?: string },
  ) {
    await h.owner.query(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', 'articles-test', $1, '{}') ON CONFLICT DO NOTHING`,
      [QUESTION_SET_SHA],
    );
    await h.owner.query(
      `INSERT INTO settings (key, value)
       SELECT 'question_sets.active', jsonb_build_object('match', id::text) FROM question_sets WHERE sha256 = $1
       ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`,
      [QUESTION_SET_SHA],
    );
    const hashes = await currentHashes(article, card);
    await h.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant, model)
       VALUES ($1, $2, 0.7, 'typesafe', $3, 1, $4, $5, 'native', $6)`,
      [
        article,
        card,
        QUESTION_SET_SHA,
        override.state ?? hashes.state,
        override.card ?? hashes.card,
        override.model ?? (await currentModel()),
      ],
    );
  }

  async function captured(override: { state?: string; card?: string; model?: string }) {
    const { r, article } = await setup();
    const card = await holdCard(r.user.id, 'love', 'Hash check');
    await insertAnswer(article, card, override);
    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const [event] = await events(h, r.user.id, article);
    const features = event!.value['features'] as {
      cards: { id: string; p: number | null; engine: string | null }[];
    };
    return features.cards.find((c) => c.id === card)!;
  }

  it('drops an answer whose state hash is obsolete', async () => {
    expect(await captured({ state: 'obsolete-state' })).toMatchObject({ p: null, engine: null });
  });

  it('drops an answer whose card input hash is obsolete', async () => {
    expect(await captured({ card: 'obsolete-card' })).toMatchObject({ p: null, engine: null });
  });

  it('keeps an answer whose hashes are current', async () => {
    const card = await captured({});
    expect(card.p).toBeCloseTo(0.7, 5);
    expect(card.engine).toBe('typesafe');
  });
});

describe('snapshot capture after a translation fallback and frozen request provenance', () => {
  async function setSetting(key: string, value: unknown) {
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async function matchSet(sha: string): Promise<string> {
    const res = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', $1, $2, '{}') RETURNING id::text AS id`,
      [`fallback-${sha.slice(0, 12)}`, sha],
    );
    return res.rows[0]!.id;
  }

  let previous: { active: unknown; modes: unknown };

  beforeAll(async () => {
    const rows = await h.owner.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key IN ('question_sets.active', 'language_modes')`,
    );
    const byKey = new Map(rows.rows.map((row) => [row.key, row.value]));
    previous = { active: byKey.get('question_sets.active'), modes: byKey.get('language_modes') };
  });

  afterAll(async () => {
    for (const [key, value] of [
      ['question_sets.active', previous.active],
      ['language_modes', previous.modes],
    ] as const) {
      if (value === undefined) await h.owner.query(`DELETE FROM settings WHERE key = $1`, [key]);
      else await setSetting(key, value);
    }
  });

  it('keeps a current native answer in a translate-mode language with no usable translation', async () => {
    const sha = 'e1'.repeat(32);
    const match = await matchSet(sha);
    await setSetting('question_sets.active', { match });
    await setSetting('language_modes', { de: 'translate' });
    const { r, article } = await setup();
    await h.owner.query(`UPDATE articles SET lang = 'de' WHERE id = $1`, [article]);
    const card = await holdCard(r.user.id, 'love', 'Fallback native');
    const hashes = await currentHashes(article, card);
    await h.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant, model)
       VALUES ($1, $2, 0.7, 'typesafe', $3, 1, $4, $5, 'native', $6)`,
      [article, card, sha, hashes.state, hashes.card, await currentModel()],
    );
    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const [event] = await events(h, r.user.id, article);
    const features = event!.value['features'] as { cards: { id: string; p: number | null }[] };
    expect(features.cards.find((c) => c.id === card)?.p).toBeCloseTo(0.7, 5);
  });

  it('records no ratingSha for a request frozen under another match set', async () => {
    const matchA = await matchSet('e2'.repeat(32));
    const matchB = await matchSet('e3'.repeat(32));
    await setSetting('question_sets.active', { match: matchA });
    const manifest = (match: string) =>
      JSON.stringify({
        questionSets: { enrich: { id: matchA }, match: { id: match } },
        languageMode: 'native',
        cardTextMode: 'as_written',
      });
    const rateOlder = async (frozenMatch: string) => {
      const { r, feed, article } = await setup({}, 'training');
      const requestId = randomUUID();
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
          [requestId, r.user.id, feed, article, manifest(frozenMatch)],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const saved = await ok(r.api.post(`/articles/${article}/bookmark`, freshFence));
      const snapshotId = saved.item.bookmarkCapture!.snapshotId!;
      await h.owner.query(`UPDATE articles SET content_revision = 2 WHERE id = $1`, [article]);
      await ok(
        r.api.post(`/articles/${article}/rating`, {
          stateVersion: saved.item.stateVersion,
          contentRevision: '1',
          snapshotId,
          rating: 1,
          analysisRequestId: requestId,
        }),
      );
      return (await events(h, r.user.id, article)).find((e) => e.kind === 'rate')!;
    };
    expect((await rateOlder(matchA)).value['ratingSha']).toMatch(/^[0-9a-f]{64}$/);
    const switched = await rateOlder(matchB);
    expect(switched.value['ratingSha']).toBeUndefined();
    expect(switched.value['features']).toBeNull();
  });
});

describe('snapshot provenance: facets, answer model and the effective fingerprint', () => {
  async function setSetting(key: string, value: unknown) {
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  let previous: unknown;

  beforeAll(async () => {
    previous = (
      await h.owner.query<{ value: unknown }>(
        `SELECT value FROM settings WHERE key = 'question_sets.active'`,
      )
    ).rows[0]?.value;
  });

  afterAll(async () => {
    if (previous === undefined)
      await h.owner.query(`DELETE FROM settings WHERE key = 'question_sets.active'`);
    else await setSetting('question_sets.active', previous);
  });

  async function enrichFacets(override: { state?: string; model?: string | null }) {
    const sha = 'f1'.repeat(32);
    const set = (
      await h.owner.query<{ id: string }>(
        `INSERT INTO question_sets (kind, version, sha256, definition)
         VALUES ('enrich', 'provenance', $1, '{}')
         ON CONFLICT (sha256) DO UPDATE SET version = EXCLUDED.version RETURNING id::text AS id`,
        [sha],
      )
    ).rows[0]!.id;
    await setSetting('question_sets.active', { enrich: set });
    const { r, article } = await setup();
    await h.owner.query(
      `INSERT INTO article_facets (article_id, question_set_id, article_revision, state_sha256,
                                   engine, model, state_variant, answers, features)
       VALUES ($1, $2, 1, $3, 'typesafe', $4, 'native', '{}', '{"time_sensitive": 0.9}')`,
      [
        article,
        set,
        override.state ?? (await currentStates(article)).enrich,
        override.model === undefined ? await currentModel() : override.model,
      ],
    );
    // A card with a current answer, so the fingerprint is consulted for the facets only by design.
    const card = await holdCard(r.user.id, 'love', 'Provenance');
    await answer(article, card, 0.7);
    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const [event] = await events(h, r.user.id, article);
    return event!.value['features'] as {
      ratingSha: string;
      cards: { id: string; p: number | null }[];
      values: { facets: Record<string, number> | null };
    };
  }

  it('drops facets whose enrich state hash is obsolete', async () => {
    expect((await enrichFacets({ state: 'obsolete-enrich' })).values.facets).toBeNull();
  });

  it('drops facets written by another model', async () => {
    expect((await enrichFacets({ model: 'jev-other' })).values.facets).toBeNull();
    expect((await enrichFacets({ model: null })).values.facets).toBeNull();
  });

  it('keeps facets of the current enrich state and model', async () => {
    expect((await enrichFacets({})).values.facets).toEqual({ time_sensitive: 0.9 });
  });

  it('drops an answer written by another model and keeps the current one', async () => {
    const { r, article } = await setup();
    const own = await holdCard(r.user.id, 'love', 'Own model');
    const other = await holdCard(r.user.id, 'love', 'Other model');
    await answer(article, own, 0.7);
    await answer(article, other, 0.6);
    await h.owner.query(`UPDATE card_answers SET model = 'jev-other' WHERE card_id = $1`, [other]);
    await ok(r.api.post(`/articles/${article}/rating`, { ...freshFence, rating: 1 }));
    const [event] = await events(h, r.user.id, article);
    const cards = new Map(
      (event!.value['features'] as { cards: { id: string; p: number | null }[] }).cards.map((c) => [
        c.id,
        c.p,
      ]),
    );
    expect(cards.get(other)).toBeNull();
    expect(cards.get(own)).toBeCloseTo(0.7, 5);
  });

  it('stamps the fingerprint the worker computes for the same settings and environment', async () => {
    const features = await enrichFacets({});
    const defaults = {
      model: h.config.typesafeModel,
      languageModes: h.config.languageModes,
      cardTextMode: 'as_written' as const,
    };
    expect(features.ratingSha).toBe(await readRatingFingerprint(createDatabase(h.owner), defaults));
    expect(features.ratingSha).not.toBe(
      await readRatingFingerprint(createDatabase(h.owner), { ...defaults, model: 'jev-other' }),
    );
  });
});
