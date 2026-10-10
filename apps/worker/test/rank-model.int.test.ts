import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, HOUR, ago } from './support/classify.js';
import {
  SIMPLE_MODEL,
  installModel,
  matched,
  rank,
  rankRow,
  reader,
  sigmoid,
  simpleP,
} from './support/rank-model-world.js';

/**
 * M7-T5a (PLAN §13 M7-T5, spec 06 §2 step 4a, §6.2, §7, §8.1): model scoring through the real
 * `user.rank` handler. The active model is a hand-written logistic one stored in the `user_models`
 * layout of `user.learn`, with the context the trainer would store, so every expected P is known:
 * P = sigmoid(-2 + 4 * best.like) for the simple model (0.9 -> 0.832, the cards path would give
 * 0.72). One `it` per PLAN bullet; effects are read from `user_article` and the outbox.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

/** A reader with an active simple model (the context matches). */
async function modelReader() {
  const r = await reader(h);
  const model = await installModel(h, r.userId, SIMPLE_MODEL);
  return { ...r, ...model };
}

/** The `user.learn` payloads recorded after `since`. */
const learnIntents = (since: string) => h.payloads('user.learn', since);

describe('model scoring in user.rank (spec 06 §2 step 4a, §6.2, §8.1)', () => {
  it('scores an eligible item with the compatible active model and explains it (scoreSource model, Explain.model)', async () => {
    const r = await reader(h);
    const model = await installModel(h, r.userId, {
      features: [`card.${r.cardId}`, `known.card.${r.cardId}`, 'best.like'],
      weights: [3, 0.5, 1],
      intercept: -3,
      ownCards: [r.cardId],
    });
    // A display-only rename is outside the model context; the label shows the current title.
    await h.owner.query(`UPDATE interest_cards SET title = $2 WHERE id = $1`, [
      r.cardId,
      'Renamed harbor card',
    ]);
    const a = await matched(h, r.feedId, r.cardId, 0.9);

    await rank(h, r.userId);
    const row = await rankRow(h, r.userId, a);
    expect(row.source).toBe('model');
    expect(row.p).toBeCloseTo(sigmoid(-3 + 2.7 + 0.5 + 0.9), 4);
    expect(row.explain?.source).toBe('model');
    expect(row.explain?.decidingCardId).toBeUndefined();
    const top = row.explain?.model?.top ?? [];
    expect(row.explain?.model?.version).toBe(model.version);
    expect(top).toHaveLength(3);
    expect(top.map((entry) => entry.feature)).toEqual([
      `card.${r.cardId}`,
      'best.like',
      `known.card.${r.cardId}`,
    ]);
    expect(top[0]).toMatchObject({ label: 'Renamed harbor card' });
    expect(top[0]?.contribution).toBeCloseTo(2.7, 4);
    for (const entry of top) expect(entry.label.length).toBeGreaterThan(0);
    const magnitudes = top.map((entry) => Math.abs(entry.contribution));
    expect(magnitudes).toEqual([...magnitudes].sort((p, q) => q - p));
  });

  it('applies no quality demotion on the model path', async () => {
    const { userId, feedId, cardId } = await modelReader();
    await h.owner.query(
      `UPDATE users SET preferences = coalesce(preferences, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [userId, JSON.stringify({ demote: { clickbait: 'on' } })],
    );
    const baity = await matched(h, feedId, cardId, 0.9);
    const plain = await matched(h, feedId, cardId, 0.9);
    const setClickbait = (articleId: string, value: number) =>
      h.owner.query(
        `UPDATE article_facets SET features = features || $2::jsonb WHERE article_id = $1`,
        [articleId, JSON.stringify({ clickbait: value })],
      );
    await setClickbait(baity, 0.95);
    await setClickbait(plain, 0.1);

    await rank(h, userId);
    const a = await rankRow(h, userId, baity);
    const b = await rankRow(h, userId, plain);
    expect(a.source).toBe('model');
    expect(a.rules).not.toContain('demote:clickbait');
    expect(a.p).toBeCloseTo(simpleP(0.9), 4);
    expect(a.p).toBeCloseTo(b.p ?? -1, 6);

    // Control: the same item on the cards path is demoted (the fixture does trigger the flag).
    await h.owner.query(`UPDATE user_models SET active = false WHERE user_id = $1`, [userId]);
    await rank(h, userId, { full: true });
    const cards = await rankRow(h, userId, baity);
    expect(cards.source).toBe('cards');
    expect(cards.rules).toContain('demote:clickbait');
  });

  it('never-card hides, must floors and hide rules still apply on the model path', async () => {
    // never-card hide
    {
      const { userId, feedId, cardId } = await modelReader();
      const never = await h.card({ interest: 'celebrity gossip and royal scandals' });
      await h.hold(userId, never, { strength: 'never' });
      const hidden = await matched(h, feedId, cardId, 0.9);
      await h.answerCard(hidden, never, { engine: 'typesafe', p: 0.9 });
      const control = await matched(h, feedId, cardId, 0.9);
      await h.answerCard(control, never, { engine: 'typesafe', p: 0.1 });
      await rank(h, userId);
      const a = await rankRow(h, userId, hidden);
      expect(a.lane).toBe('hidden');
      expect(a.rules).toContain(`never:${never}`);
      const c = await rankRow(h, userId, control);
      expect(c).toMatchObject({ source: 'model', lane: 'for_you' });
    }
    // must floor over a low model P
    {
      const { userId, feedId, cardId } = await modelReader();
      const must = await h.card({ interest: 'port labour law and regulation' });
      await h.hold(userId, must, { strength: 'must' });
      const floored = await matched(h, feedId, cardId, 0.1);
      await h.answerCard(floored, must, { engine: 'typesafe', p: 0.6 });
      const control = await matched(h, feedId, cardId, 0.1);
      await h.answerCard(control, must, { engine: 'typesafe', p: 0.1 });
      await rank(h, userId);
      const a = await rankRow(h, userId, floored);
      expect(a).toMatchObject({ source: 'model', lane: 'for_you' });
      expect(a.rules).toContain(`must:${must}`);
      expect(a.p).toBeGreaterThanOrEqual(0.65 - 1e-6);
      const c = await rankRow(h, userId, control);
      expect(c).toMatchObject({ source: 'model', lane: 'everything' });
      expect(c.p).toBeCloseTo(simpleP(0.1), 4);
    }
    // hide rule
    {
      const { userId, feedId, cardId } = await modelReader();
      const muted = await matched(h, feedId, cardId, 0.9, { title: 'Harbor strike update' });
      const control = await matched(h, feedId, cardId, 0.9, { title: 'Port opens new quay' });
      await h.owner.query(
        `INSERT INTO user_rules (user_id, kind, value) VALUES ($1, 'mute_keyword', 'harbor strike')`,
        [userId],
      );
      await rank(h, userId);
      const a = await rankRow(h, userId, muted);
      expect(a.lane).toBe('hidden');
      expect(a.rules).toEqual(['mute_keyword:harbor strike']);
      expect((await rankRow(h, userId, control)).source).toBe('model');
    }
  });

  it('falls back from the model for each exclusion of spec 06 §2 step 4a', async () => {
    const { userId, feedId, cardId } = await modelReader();
    const control = await matched(h, feedId, cardId, 0.9);

    const degradedCards = await h.article({ feedIds: [feedId], state: 'degraded' });
    await h.enrichDirect(degradedCards, { state: 'degraded' });
    await h.answerCard(degradedCards, cardId, { engine: 'typesafe', p: 0.9 });

    const failedCards = await h.article({ feedIds: [feedId], state: 'failed' });
    await h.enrichDirect(failedCards, { state: 'failed' });
    await h.answerCard(failedCards, cardId, { engine: 'typesafe', p: 0.9 });

    const degradedBm25 = await h.article({
      feedIds: [feedId],
      state: 'degraded',
      title: 'Ocean shipping logistics harbor expands',
      excerpt: 'Ocean shipping and harbor logistics grow.',
    });

    const noFacets = await h.article({ feedIds: [feedId] });

    const noFacetsAnswered = await h.article({ feedIds: [feedId] });
    await h.answerCard(noFacetsAnswered, cardId, { engine: 'typesafe', p: 0.9 });

    const llmFacets = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(llmFacets, { engine: 'llm', state: 'matched' });
    await h.answerCard(llmFacets, cardId, { engine: 'typesafe', p: 0.9 });

    const layaFacets = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(layaFacets, { engine: 'laya', model: null, state: 'matched' });
    await h.answerCard(layaFacets, cardId, { engine: 'typesafe', p: 0.9 });

    const llmAnswer = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(llmAnswer, { state: 'matched' });
    await h.answerCard(llmAnswer, cardId, { engine: 'llm', p: 0.9 });

    const layaAnswer = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(layaAnswer, { state: 'matched' });
    await h.answerCard(layaAnswer, cardId, { engine: 'laya', p: 0.9 });

    await rank(h, userId);
    const expected: Array<[string, string, string]> = [
      ['control', control, 'model'],
      ['degraded pipeline with answers', degradedCards, 'cards'],
      ['failed pipeline with answers', failedCards, 'cards'],
      ['degraded pipeline, no answers (BM25)', degradedBm25, 'degraded'],
      ['no facets, no answers', noFacets, 'none'],
      ['no facets, answered', noFacetsAnswered, 'cards'],
      ['facets from llm', llmFacets, 'cards'],
      ['facets from laya, Jev answers', layaFacets, 'cards'],
      ['llm card answer', llmAnswer, 'cards'],
      ['laya card answer', layaAnswer, 'cards'],
    ];
    const actual: Array<[string, string]> = [];
    for (const [name, articleId] of expected) {
      actual.push([name, (await rankRow(h, userId, articleId)).source]);
    }
    expect(actual).toEqual(expected.map(([name, , source]) => [name, source]));
    expect((await rankRow(h, userId, noFacets)).lane).toBe('new');
  });

  it("a label card's llm answer does not exclude the item", async () => {
    const { userId, feedId, cardId } = await modelReader();
    const label = await h.heldLabel(userId);
    const a = await matched(h, feedId, cardId, 0.9);
    await h.answerCard(a, label, { engine: 'llm', p: 0.9 });
    await rank(h, userId);
    const row = await rankRow(h, userId, a);
    expect(row.source).toBe('model');
    expect(row.p).toBeCloseTo(simpleP(0.9), 4);
  });

  it('a context mismatch stops model scoring and records a user.learn intent', async () => {
    // A strength weight changed in ranker.thresholds.
    {
      const { userId, feedId, cardId } = await modelReader();
      const a = await matched(h, feedId, cardId, 0.9);
      await rank(h, userId);
      expect((await rankRow(h, userId, a)).source).toBe('model');
      const since = await h.mark();
      await h.setSetting('ranker.thresholds', { strengthWeights: { like: 0.7 } });
      try {
        await rank(h, userId);
        expect((await rankRow(h, userId, a)).source).toBe('cards');
        expect(await learnIntents(since)).toContainEqual({ userId });
      } finally {
        await h.deleteSetting('ranker.thresholds');
      }
    }
    // An own-input card's strength changed.
    {
      const r = await reader(h);
      await installModel(h, r.userId, {
        features: [`card.${r.cardId}`, `known.card.${r.cardId}`, 'best.like'],
        weights: [3, 0.5, 1],
        intercept: -3,
        ownCards: [r.cardId],
      });
      const a = await matched(h, r.feedId, r.cardId, 0.9);
      await rank(h, r.userId);
      expect((await rankRow(h, r.userId, a)).source).toBe('model');
      const since = await h.mark();
      await h.owner.query(
        `UPDATE user_cards SET strength = 'love' WHERE user_id = $1 AND card_id = $2`,
        [r.userId, r.cardId],
      );
      await rank(h, r.userId, { full: true });
      expect((await rankRow(h, r.userId, a)).source).toBe('cards');
      expect(await learnIntents(since)).toContainEqual({ userId: r.userId });
    }
    // A stored context that is simply not the current one.
    {
      const r = await reader(h);
      await installModel(h, r.userId, { ...SIMPLE_MODEL, contextSha: 'f'.repeat(64) });
      const a = await matched(h, r.feedId, r.cardId, 0.9);
      const since = await h.mark();
      await rank(h, r.userId);
      expect((await rankRow(h, r.userId, a)).source).toBe('cards');
      expect(await learnIntents(since)).toContainEqual({ userId: r.userId });
    }
  });

  it('a new card that is not an own input keeps the context: items still use the model', async () => {
    const { userId, feedId, cardId } = await modelReader();
    const a = await matched(h, feedId, cardId, 0.9);
    await rank(h, userId);
    expect((await rankRow(h, userId, a)).source).toBe('model');

    const since = await h.mark();
    const added = await h.heldCard(userId, { interest: 'container terminal automation' });
    await h.answerCard(a, added, { engine: 'typesafe', p: 0.4 });
    await rank(h, userId, { full: true });
    const row = await rankRow(h, userId, a);
    expect(row.source).toBe('model');
    expect(row.p).toBeCloseTo(simpleP(0.9), 4);
    expect(await learnIntents(since)).toEqual([]);
  });

  it('the run context hash changes when a model activates, so the window re-ranks', async () => {
    const r = await reader(h);
    // A new-lane item (no facets, no answers) keeps the same result either way: only the hash moves.
    const quiet = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(HOUR) });
    await rank(h, r.userId);
    const before = (await rankRow(h, r.userId, quiet)).explain?.inputs.contextSha;
    expect(typeof before).toBe('string');
    expect(await rank(h, r.userId)).toMatchObject({ written: 0 });

    await installModel(h, r.userId, SIMPLE_MODEL);
    const run = await rank(h, r.userId);
    expect(run.written).toBeGreaterThanOrEqual(1);
    const after = (await rankRow(h, r.userId, quiet)).explain?.inputs.contextSha;
    expect(typeof after).toBe('string');
    expect(after).not.toBe(before);
  });

  it('without an active model nothing changes: the cards path and no user.learn intent', async () => {
    const r = await reader(h);
    // An inactive stored model (even one that is not current) is not a model.
    await installModel(h, r.userId, { ...SIMPLE_MODEL, active: false, contextSha: 'e'.repeat(64) });
    const a = await matched(h, r.feedId, r.cardId, 0.9);
    const since = await h.mark();
    await rank(h, r.userId);
    const row = await rankRow(h, r.userId, a);
    expect(row.source).toBe('cards');
    expect(row.explain?.model).toBeUndefined();
    expect(row.p).toBeCloseTo(0.72, 4);
    expect(row.explain?.decidingCardId).toBe(r.cardId);
    expect(await learnIntents(since)).toEqual([]);

    const bare = await reader(h);
    const b = await matched(h, bare.feedId, bare.cardId, 0.9);
    const sinceBare = await h.mark();
    await rank(h, bare.userId);
    expect((await rankRow(h, bare.userId, b)).source).toBe('cards');
    expect(await learnIntents(sinceBare)).toEqual([]);
  });
});
