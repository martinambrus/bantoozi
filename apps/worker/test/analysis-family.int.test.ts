import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY, ago, type AskRecord } from './support/classify.js';

/**
 * JEV-4 T4: `analysis.process` accepts a request frozen under another release of the same Jev
 * family. The request answers with the worker's primary model, records that model in its result and
 * the shared caches, never reuses a cache or stage result of another model, and stays terminal
 * (`context_unavailable`) across families.
 */

const V13 = 'jev-1.13.0';
const V14 = 'jev-1.14.0';
const V2 = 'jev-2.0.0';

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

let titles = 0;

async function trainee(options: { cards?: number } = {}) {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'training');
  const cardIds: string[] = [];
  for (let i = 0; i < (options.cards ?? 1); i += 1) {
    cardIds.push(await h.heldCard(userId, { topicIds: ['technology'] }));
  }
  titles += 1;
  const articleId = await h.article({
    feedIds: [feedId],
    title: `Family story number ${titles} about wind turbines`,
    firstSeenAt: ago(3 * DAY),
  });
  return { feedId, userId, cardIds, articleId };
}

type Trainee = Awaited<ReturnType<typeof trainee>>;

const requestAsks = (requestId: string): AskRecord[] =>
  h.router.asks.filter((ask) =>
    ask.witnesses.some((w) => w.kind === 'manual' && w.analysisRequestId === requestId),
  );

/** Deliver the request's due intent through a worker whose pinned primary model is `primary`. */
const processAs = (primary: string, requestId: string): Promise<number> =>
  h.runAs(primary, 'analysis.process', (payload) => payload['analysisRequestId'] === requestId);

async function frozenModelOf(requestId: string): Promise<string> {
  const row = await h.owner.query<{ model: string }>(
    `SELECT input_snapshot -> 'model' ->> 'model' AS model FROM analysis_requests WHERE id = $1`,
    [requestId],
  );
  return row.rows[0]?.model as string;
}

interface Resulted {
  model: { engine: string; model: string };
  match: { cards: Array<{ cardId: string; p: number }> };
}

const resultOf = async (requestId: string): Promise<Resulted> =>
  (await h.analysis(requestId)).resultSnapshot as unknown as Resulted;

async function clearCaches(articleId: string): Promise<void> {
  await h.owner.query('DELETE FROM card_answers WHERE article_id = $1', [articleId]);
  await h.owner.query('DELETE FROM article_topics_l2 WHERE article_id = $1', [articleId]);
  await h.owner.query('DELETE FROM article_facets WHERE article_id = $1', [articleId]);
}

describe('same family: frozen and primary are releases of one Jev major', () => {
  it('completes under the answering model, records it in the result and fills the caches with it', async () => {
    const t = await trainee({ cards: 2 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V13);
    h.router.model = V14;
    await processAs(V14, requestId);

    expect(await h.analysis(requestId)).toMatchObject({
      status: 'complete',
      attempts: 0,
      lastErrorCode: null,
    });
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect((await resultOf(requestId)).model).toEqual({ engine: 'typesafe', model: V14 });
    expect(await frozenModelOf(requestId)).toBe(V13);

    expect(await h.facetRow(t.articleId)).toMatchObject({ engine: 'typesafe', model: V14 });
    const answers = await h.cardAnswers(t.articleId);
    expect(answers).toHaveLength(2);
    expect(answers.map((a) => [a.engine, a.model])).toEqual([
      ['typesafe', V14],
      ['typesafe', V14],
    ]);
    const l2 = await h.l2Rows(t.articleId);
    expect(l2.length).toBeGreaterThan(0);
    expect(l2.every((row) => row.engine === 'typesafe' && row.model === V14)).toBe(true);
  });

  it('never reuses a current cache row labelled with the frozen model: the router is asked and the caches end labelled with the answering model', async () => {
    const t = await trainee({ cards: 2 });
    await h.enrichDirect(t.articleId, { model: V13, state: 'extracted' });
    for (const cardId of t.cardIds)
      await h.answerCard(t.articleId, cardId, { engine: 'typesafe', model: V13, p: 0.25 });
    for (const l1 of ['science', 'technology'])
      await h.answerL2(t.articleId, l1, { engine: 'typesafe', model: V13 });
    expect((await h.facetRow(t.articleId))?.model).toBe(V13);

    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V13);
    h.router.model = V14;
    await processAs(V14, requestId);

    expect((await h.analysis(requestId)).status).toBe('complete');
    const asks = requestAsks(requestId);
    expect(asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect([...(asks[1]?.cards ?? [])].sort()).toEqual([...t.cardIds].sort());
    expect([...(asks[1]?.l2 ?? [])].sort()).toEqual(['science', 'technology']);
    const result = await resultOf(requestId);
    expect(result.model.model).toBe(V14);
    expect(result.match.cards.map((card) => card.p)).toEqual([0.8, 0.8]);

    expect(await h.facetRow(t.articleId)).toMatchObject({ model: V14 });
    expect((await h.cardAnswers(t.articleId)).map((a) => [a.model, a.p])).toEqual([
      [V14, 0.8],
      [V14, 0.8],
    ]);
    expect((await h.l2Rows(t.articleId)).map((row) => row.model)).toEqual([V14, V14]);
  });

  it('frozen equal to primary (regression): completes and labels everything with it', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V14);
    h.router.model = V14;
    await processAs(V14, requestId);

    expect((await h.analysis(requestId)).status).toBe('complete');
    expect((await resultOf(requestId)).model).toEqual({ engine: 'typesafe', model: V14 });
    expect(await frozenModelOf(requestId)).toBe(V14);
    expect(await h.facetRow(t.articleId)).toMatchObject({ model: V14 });
    expect((await h.cardAnswers(t.articleId)).map((a) => a.model)).toEqual([V14]);
  });

  it('a newer frozen model than the worker primary (same family) is accepted too', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V14);
    h.router.model = V13;
    await processAs(V13, requestId);

    expect((await h.analysis(requestId)).status).toBe('complete');
    expect((await resultOf(requestId)).model).toEqual({ engine: 'typesafe', model: V13 });
    expect(await frozenModelOf(requestId)).toBe(V14);
    expect(await h.facetRow(t.articleId)).toMatchObject({ model: V13 });
  });
});

describe('cross family: terminal context_unavailable before any call', () => {
  it.each([
    ['jev-1 against jev-2', V13, V2],
    ['jev-2 against jev-1', V2, V13],
    ['own-family ids', 'jev-test-1', 'jev-test-2'],
    ['an alias against a release', 'jev-latest', V14],
  ])('%s', async (_name, frozen, primary) => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, frozen);
    h.router.model = primary;
    await processAs(primary, requestId);

    expect(h.router.asks).toEqual([]);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'context_unavailable',
      resultSnapshot: null,
      resultSha: null,
      leaseToken: null,
    });
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
  });
});

describe('a third model answers', () => {
  it('is retried as model_mismatch with an attempt and publishes nothing', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V13);
    h.router.model = 'jev-1.99.0';
    await processAs(V14, requestId);

    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich']);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'model_mismatch',
      leaseToken: null,
      resultSnapshot: null,
    });
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
  });

  it('the frozen model answering a worker pinned to its successor is a mismatch as well', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, V13);
    h.router.model = V13;
    await processAs(V14, requestId);

    expect(await h.analysis(requestId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'model_mismatch',
      resultSnapshot: null,
    });
  });
});

describe('stage results carry the answering model', () => {
  /** A finished request's stages under `model`, with the shared caches cleared for the article. */
  async function donor(t: Trainee, model: string): Promise<Record<string, unknown>> {
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, model);
    h.router.model = model;
    await processAs(model, requestId);
    const done = await h.analysis(requestId);
    expect(done.status).toBe('complete');
    const stages = done.stageResults as Record<string, unknown>;
    expect(stages['enrich']).toBeDefined();
    expect(stages['cards']).toBeDefined();
    expect(stages['l2']).toBeDefined();
    await clearCaches(t.articleId);
    h.router.asks.length = 0;
    return JSON.parse(JSON.stringify(stages)) as Record<string, unknown>;
  }

  /** The donor's stages with distinguishable card answers and a saved translation stage. */
  function seeded(stages: Record<string, unknown>, tag: string | null): Record<string, unknown> {
    const cards = Object.fromEntries(
      Object.entries(stages['cards'] as Record<string, Record<string, unknown>>).map(
        ([id, entry]) => [id, { ...entry, p: 0.33, answer: { type: 'noul', p: 0.33 } }],
      ),
    );
    const { model: _stamped, ...untagged } = stages;
    return { ...untagged, cards, translation: [], ...(tag === null ? {} : { model: tag }) };
  }

  async function resume(
    t: Trainee,
    frozen: string,
    primary: string,
    stages: Record<string, unknown>,
  ): Promise<string> {
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId, frozen);
    await h.owner.query(`UPDATE analysis_requests SET stage_results = $2::jsonb WHERE id = $1`, [
      requestId,
      JSON.stringify(stages),
    ]);
    h.router.model = primary;
    await processAs(primary, requestId);
    return requestId;
  }

  it.each([
    ['an explicit tag of the old model', V13],
    ['the legacy untagged shape (frozen model)', null],
  ])(
    'drops enrich, cards and l2 saved under another model (%s) and keeps the translation',
    async (_name, tag) => {
      const t = await trainee({ cards: 2 });
      const stages = seeded(await donor(t, V13), tag);
      const requestId = await resume(t, V13, V14, stages);

      expect((await h.analysis(requestId)).status).toBe('complete');
      expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
      const result = await resultOf(requestId);
      expect(result.model.model).toBe(V14);
      expect(result.match.cards.map((card) => card.p)).toEqual([0.8, 0.8]);
      const after = (await h.analysis(requestId)).stageResults as Record<string, unknown>;
      expect(after['model']).toBe(V14);
      expect(after['translation']).toEqual([]);
      expect(after['enrich']).toBeDefined();
      expect(
        Object.values(after['cards'] as Record<string, { p: number }>).map((card) => card.p),
      ).toEqual([0.8, 0.8]);
    },
  );

  it.each([
    ['tagged with the answering model', V14],
    ['untagged under a frozen model equal to the primary', null],
  ])(
    'control: resumed with the same model (%s) keeps its stage results and asks nothing',
    async (_name, tag) => {
      const t = await trainee({ cards: 2 });
      const stages = seeded(await donor(t, V14), tag);
      const requestId = await resume(t, V14, V14, stages);

      expect((await h.analysis(requestId)).status).toBe('complete');
      expect(requestAsks(requestId)).toEqual([]);
      const result = await resultOf(requestId);
      expect(result.model.model).toBe(V14);
      expect(result.match.cards.map((card) => card.p)).toEqual([0.33, 0.33]);
    },
  );

  it('control: stages tagged with the answering model survive a frozen model of the same family', async () => {
    const t = await trainee({ cards: 2 });
    const stages = seeded(await donor(t, V14), V14);
    const requestId = await resume(t, V13, V14, stages);

    expect((await h.analysis(requestId)).status).toBe('complete');
    expect(requestAsks(requestId)).toEqual([]);
    expect((await resultOf(requestId)).match.cards.map((card) => card.p)).toEqual([0.33, 0.33]);
  });
});
