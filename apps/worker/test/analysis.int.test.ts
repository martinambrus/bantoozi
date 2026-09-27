import { resetArticleAnswers, retryTransaction, workerOutbox } from '@bantoozi/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ClassificationDeps } from '../src/handlers/deps.js';
import {
  ClassifyHarness,
  DAY,
  HOUR,
  MINUTE,
  PRIMARY_MODEL,
  ago,
  failure,
  forArticles,
  waitFor,
  witnessesOf,
  type AskRecord,
  type SettingWrite,
} from './support/classify.js';

/**
 * M2-T9 `analysis.process {analysisRequestId}` (spec 03 §2.2, spec 05 §1.1) through the real handler:
 * frozen input and result snapshots, request leases with resumable stages, cache reconciliation,
 * deferral and failure accounting, completion fences, and readers with different modes sharing a
 * feed.
 */

let h: ClassifyHarness;

const byId = (a: string, b: string): number => Number(a) - Number(b);
const sorted = (ids: readonly string[]): string[] => [...ids].sort(byId);

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

/** A training reader of a new feed holding `cards` shared cards, and an unprocessed article. */
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
    title: `Selected story number ${titles} about solar panels`,
    firstSeenAt: ago(3 * DAY),
  });
  return { feedId, userId, cardIds, articleId };
}

/** The router calls made under this request's manual witness. */
const requestAsks = (requestId: string): AskRecord[] =>
  h.router.asks.filter((ask) =>
    ask.witnesses.some((w) => w.kind === 'manual' && w.analysisRequestId === requestId),
  );

/** Deliver the request's due pending intents through the real handler (as the relay would). */
const processRequest = (requestId: string): Promise<number> =>
  h.run('analysis.process', (payload) => payload['analysisRequestId'] === requestId);

const pendingIntents = async (requestId: string) =>
  (await h.intents('analysis.process', { pending: true })).filter(
    (intent) => intent.payload['analysisRequestId'] === requestId,
  );

/** Make a deferred request and its delayed intent due now. */
async function makeDue(requestId: string): Promise<void> {
  await h.owner.query('UPDATE analysis_requests SET next_attempt_at = now() WHERE id = $1', [
    requestId,
  ]);
  await h.owner.query(
    `UPDATE job_outbox SET available_at = now()
      WHERE queue = 'analysis.process' AND delivered_at IS NULL
        AND payload ->> 'analysisRequestId' = $1`,
    [requestId],
  );
}

async function rate(userId: string, articleId: string, requestId: string | null): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, 1, now())
     ON CONFLICT (user_id, article_id) DO UPDATE SET rating = 1, rated_at = now()`,
    [userId, articleId],
  );
  await h.owner.query(
    `INSERT INTO feedback_events (user_id, article_id, kind, value)
     VALUES ($1, $2, 'rate', $3::jsonb)`,
    [
      userId,
      articleId,
      JSON.stringify(
        requestId === null ? { rating: 1 } : { rating: 1, analysisRequestId: requestId },
      ),
    ],
  );
}

interface ResultShape {
  requestId: string;
  inputSha: string;
  article: { id: string; revision: string };
  model: { engine: string; model: string };
  translation: unknown;
  enrich: { stateSha256: string; stateVariant: string; answers: Record<string, unknown> };
  match: {
    stateSha256: string;
    cards: Array<{ cardId: string; cardInputSha256: string; p: number }>;
    l2: Array<{ l1Id: string }>;
  };
}

describe('analysis.process results (spec 03 §2.2, spec 05 §1.1)', () => {
  it('answers from the frozen snapshot, stores result_snapshot and result_sha, fills the caches and ranks', async () => {
    const t = await trainee({ cards: 2 });
    const { requestId, snapshot } = await h.select(t.userId, t.feedId, t.articleId);
    const since = await h.mark();
    expect(await processRequest(requestId)).toBe(1);

    const asks = requestAsks(requestId);
    expect(asks.map((ask) => [ask.kind, ask.priority, ask.userId, ask.articleRevision])).toEqual([
      ['enrich', 'bulk', t.userId, '1'],
      ['match', 'bulk', t.userId, '1'],
    ]);
    expect(witnessesOf(asks)).toEqual({ users: [], requests: [requestId] });
    const [enrichAsk, matchAsk] = asks as [AskRecord, AskRecord];
    expect(sorted(matchAsk.cards)).toEqual(sorted(t.cardIds));
    expect([...matchAsk.l2].sort()).toEqual(['science', 'technology']);
    // The frozen card questions are sent exactly as captured.
    for (const card of snapshot.cards) {
      expect(matchAsk.request.questions[`c${card.cardId}`]).toEqual(card.question);
    }

    const row = await h.analysis(requestId);
    expect(row).toMatchObject({
      status: 'complete',
      attempts: 0,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: null,
    });
    expect(row.completedAt).not.toBeNull();
    expect(row.resultSha).toMatch(/^[0-9a-f]{64}$/);
    expect(row.resultSha).toBe(row.computedSha);
    const inputSha = await h.owner.query<{ input_sha: string }>(
      'SELECT input_sha FROM analysis_requests WHERE id = $1',
      [requestId],
    );
    const result = row.resultSnapshot as unknown as ResultShape;
    expect(result).toMatchObject({
      requestId,
      inputSha: inputSha.rows[0]?.input_sha,
      article: { id: t.articleId, revision: '1' },
      model: { engine: 'typesafe', model: PRIMARY_MODEL },
      translation: null,
      enrich: { stateSha256: enrichAsk.request.stateSha256, stateVariant: 'native' },
      match: { stateSha256: matchAsk.request.stateSha256 },
    });
    expect(
      result.match.cards
        .map((card) => [card.cardId, card.p])
        .sort((a, b) => byId(String(a[0]), String(b[0]))),
    ).toEqual(sorted(t.cardIds).map((id) => [id, 0.8]));
    expect(result.match.l2.map((row) => row.l1Id)).toEqual(['science', 'technology']);

    // The live revision and every manifest still match: the shared caches are filled.
    expect(await h.facetRow(t.articleId)).toMatchObject({
      revision: '1',
      engine: 'typesafe',
      model: PRIMARY_MODEL,
      stateSha256: enrichAsk.request.stateSha256,
    });
    expect((await h.cardAnswers(t.articleId)).map((a) => [a.cardId, a.engine, a.p])).toEqual(
      sorted(t.cardIds).map((id) => [id, 'typesafe', 0.8]),
    );
    expect((await h.l2Rows(t.articleId)).map((l2) => [l2.l1, l2.engine])).toEqual([
      ['science', 'typesafe'],
      ['technology', 'typesafe'],
    ]);
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: t.userId, reason: 'analysis' },
    ]);
    expect(await h.payloads('user.learn', since)).toEqual([]);

    // A duplicate after completion is a no-op.
    const again = await h.mark();
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(requestAsks(requestId)).toHaveLength(2);
    expect(await h.analysis(requestId)).toEqual(row);
    expect(await h.intents('user.rank', { since: again })).toEqual([]);
    expect(await h.intents('analysis.process', { since: again })).toEqual([]);
  });

  it('never switches to live inputs: a moved revision completes from the frozen snapshot and leaves the caches alone', async () => {
    const t = await trainee({ cards: 1 });
    const frozenTitle = (
      await h.owner.query<{ title: string }>('SELECT title FROM articles WHERE id = $1', [
        t.articleId,
      ])
    ).rows[0]?.title as string;
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    // After the selection: a publisher rewrite (revision 2) and a newly held card.
    const rewritten = 'Tariff dispute escalates between neighbouring countries';
    await h.owner.query('UPDATE articles SET title = $2, title_norm = lower($2) WHERE id = $1', [
      t.articleId,
      rewritten,
    ]);
    await retryTransaction(h.db, (tx) =>
      resetArticleAnswers(tx, workerOutbox(tx), t.articleId, {
        reason: 'source_changed',
        nextState: 'extracted',
        keepBody: true,
      }),
    );
    const added = await h.heldCard(t.userId);
    const since = await h.mark();
    await processRequest(requestId);

    const asks = requestAsks(requestId);
    expect(asks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    for (const ask of asks) {
      expect(ask.articleRevision).toBe('1');
      const state = JSON.stringify(ask.request.state);
      expect(state).toContain(frozenTitle);
      expect(state).not.toContain('Tariff');
    }
    expect(asks[1]?.cards).toEqual(t.cardIds);
    expect(asks[1]?.cards).not.toContain(added);
    const row = await h.analysis(requestId);
    expect(row.status).toBe('complete');
    expect((row.resultSnapshot as unknown as ResultShape).article.revision).toBe('1');
    // Historical answers never reach the caches of revision 2, and nothing current is re-ranked.
    expect(await h.articleRow(t.articleId)).toMatchObject({ revision: '2' });
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
    expect(await h.l2Rows(t.articleId)).toEqual([]);
    expect(await h.payloads('user.rank', since)).toEqual([]);
  });

  it('keeps the result request-only when a live manifest changed (card text mode), still ranking current content', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId, snapshot } = await h.select(t.userId, t.feedId, t.articleId);
    await h.setSetting('card_text_mode', 'english');
    try {
      const since = await h.mark();
      await processRequest(requestId);
      const match = requestAsks(requestId).find((ask) => ask.kind === 'match');
      expect(match?.request.questions[`c${t.cardIds[0]}`]).toEqual(snapshot.cards[0]?.question);
      expect((await h.analysis(requestId)).status).toBe('complete');
      expect(await h.facetRow(t.articleId)).toBeNull();
      expect(await h.cardAnswers(t.articleId)).toEqual([]);
      expect(await h.l2Rows(t.articleId)).toEqual([]);
      expect(await h.payloads('user.rank', since)).toEqual([
        { userId: t.userId, reason: 'analysis' },
      ]);
    } finally {
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('keeps the result request-only when a manifest switch commits while it is published', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    let write: Promise<SettingWrite> | undefined;
    h.router.respond = async (ask) => {
      if (ask.kind === 'match') {
        write ??= h.openSettingWrite('card_text_mode', 'english');
        await write;
      }
      return undefined;
    };
    try {
      const run = processRequest(requestId);
      expect(await waitFor(() => write !== undefined, 10_000)).toBe(true);
      await (await write!).commit();
      await run;
      expect((await h.analysis(requestId)).status).toBe('complete');
      expect(await h.facetRow(t.articleId)).toBeNull();
      expect(await h.cardAnswers(t.articleId)).toEqual([]);
      expect(await h.l2Rows(t.articleId)).toEqual([]);
    } finally {
      h.router.respond = undefined;
      (await write)?.close();
      await h.setSetting('card_text_mode', 'as_written');
    }
  });

  it('never overwrites a newer compatible shared answer; missing and lower-precedence entries are filled', async () => {
    const t = await trainee({ cards: 2 });
    const [k1, k2] = sorted(t.cardIds) as [string, string];
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    const newer = { science: 0.85, technology: 0.1 };
    h.router.respond = async (ask) => {
      if (ask.kind !== 'match') return undefined;
      // Meanwhile the shared worker answered the same live input: Call A and k1 with the primary
      // engine, k2 and one branch with the LLM fallback.
      await h.enrichDirect(t.articleId, { topics: newer, state: 'extracted' });
      await h.answerCard(t.articleId, k1, { engine: 'typesafe', p: 0.25 });
      await h.answerCard(t.articleId, k2, { engine: 'llm', p: 0.5 });
      await h.answerL2(t.articleId, 'technology', { engine: 'llm' });
      return undefined;
    };
    await processRequest(requestId);

    const row = await h.analysis(requestId);
    expect(row.status).toBe('complete');
    const result = row.resultSnapshot as unknown as ResultShape;
    expect(result.enrich.answers['topic_l1']).toMatchObject({ choice: 'technology' });
    // The newer primary Call A and card answer survive; the fallback answers are replaced.
    const facets = await h.facetRow(t.articleId);
    expect(facets).toMatchObject({ engine: 'typesafe', model: PRIMARY_MODEL });
    expect(facets?.answers['topic_l1']).toMatchObject({ choice: 'science' });
    const answers = await h.cardAnswers(t.articleId);
    expect(answers.find((a) => a.cardId === k1)).toMatchObject({ engine: 'typesafe', p: 0.25 });
    expect(answers.find((a) => a.cardId === k2)).toMatchObject({ engine: 'typesafe', p: 0.8 });
    expect((await h.l2Rows(t.articleId)).map((l2) => [l2.l1, l2.engine])).toEqual([
      ['science', 'typesafe'],
      ['technology', 'typesafe'],
    ]);
  });

  it('rebuilds the features of a facet row it keeps from the level-2 answers it fills', async () => {
    const t = await trainee({ cards: 1 });
    // A current primary Call A of the same input, stored before any level-2 branch was asked.
    await h.enrichDirect(t.articleId, { state: 'extracted' });
    const kept = await h.facetRow(t.articleId);
    expect(kept?.features).toMatchObject({ 't2_asked.technology': 0, 't2_asked.science': 0 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    await processRequest(requestId);

    expect((await h.analysis(requestId)).status).toBe('complete');
    // Call A came from that row; the match asked both of its branches.
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['match']);
    expect((await h.l2Rows(t.articleId)).map((l2) => l2.l1)).toEqual(['science', 'technology']);
    const facets = await h.facetRow(t.articleId);
    expect(facets?.answers).toEqual(kept?.answers);
    expect(facets?.features).toMatchObject({ 't2_asked.technology': 1, 't2_asked.science': 1 });
  });
});

describe('analysis.process fences (spec 03 §2.2, spec 05 §1.1)', () => {
  it('a switch to off mid-request stops at the next admission without publishing', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    h.router.respond = async (ask) => {
      if (ask.kind === 'enrich') await h.setMode(t.userId, t.feedId, 'off');
      return undefined;
    };
    const since = await h.mark();
    await processRequest(requestId);

    // The match pack was refused admission: it never reached the provider.
    expect(requestAsks(requestId).map((ask) => [ask.kind, ask.authorized])).toEqual([
      ['enrich', true],
      ['match', false],
    ]);
    const row = await h.analysis(requestId);
    expect(row).toMatchObject({
      status: 'cancelled',
      lastErrorCode: 'revoked',
      resultSnapshot: null,
      resultSha: null,
      leaseToken: null,
    });
    expect(row.completedAt).not.toBeNull();
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.payloads('user.rank', since)).toEqual([]);
    expect(await pendingIntents(requestId)).toEqual([]);

    // A redelivered job, and switching the feed back to training, do not revive the request.
    h.router.respond = undefined;
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    await h.setMode(t.userId, t.feedId, 'training');
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(requestAsks(requestId)).toHaveLength(2);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'cancelled',
      resultSnapshot: null,
    });
    expect(await h.facetRow(t.articleId)).toBeNull();
  });

  it('a mode version change during the last call fences completion: cancelled, nothing published', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    h.router.respond = async (ask) => {
      // training → active increments the inference version the request was made under.
      if (ask.kind === 'match') await h.setMode(t.userId, t.feedId, 'active');
      return undefined;
    };
    const since = await h.mark();
    await processRequest(requestId);

    expect(requestAsks(requestId).map((ask) => [ask.kind, ask.authorized])).toEqual([
      ['enrich', true],
      ['match', true],
    ]);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'cancelled',
      lastErrorCode: 'revoked',
      resultSnapshot: null,
    });
    expect(await h.facetRow(t.articleId)).toBeNull();
    expect(await h.cardAnswers(t.articleId)).toEqual([]);
    expect(await h.l2Rows(t.articleId)).toEqual([]);
    expect(await h.payloads('user.rank', since)).toEqual([]);
    expect(await h.payloads('user.learn', since)).toEqual([]);
  });
});

describe('analysis.process leases and retries (spec 03 §2.2)', () => {
  it('reclaims an expired lease and resumes from the stored stage results without re-asking a finished stage', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    h.router.respond = (ask) => {
      if (ask.kind === 'match') throw new Error('worker crashed');
      return undefined;
    };
    await expect(processRequest(requestId)).rejects.toThrow('worker crashed');
    const enrichSha = requestAsks(requestId)[0]?.request.stateSha256;
    const crashed = await h.analysis(requestId);
    expect(crashed).toMatchObject({ status: 'running', attempts: 0 });
    expect(crashed.leaseToken).not.toBeNull();
    expect(crashed.stageResults).toMatchObject({ v: 1, enrich: { stateSha256: enrichSha } });
    expect(crashed.stageResults?.['cards']).toBeUndefined();

    // A duplicate delivery meets the live lease and schedules itself for the lease expiry.
    h.router.respond = undefined;
    const since = await h.mark();
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(requestAsks(requestId)).toHaveLength(2);
    const delayed = await h.intents('analysis.process', { since, pending: true });
    expect(delayed.map((intent) => intent.payload)).toEqual([{ analysisRequestId: requestId }]);
    expect(delayed[0]?.availableAt.getTime()).toBe(crashed.leaseUntil?.getTime());

    // Once the lease has expired another worker reclaims the request and asks the match only.
    await h.owner.query(
      `UPDATE analysis_requests SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [requestId],
    );
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match', 'match']);
    const done = await h.analysis(requestId);
    expect(done.status).toBe('complete');
    expect(done.leaseToken).not.toBe(crashed.leaseToken);
    const result = done.resultSnapshot as unknown as ResultShape;
    expect(result.enrich.answers).toEqual(
      (crashed.stageResults as { enrich: { answers: unknown } }).enrich.answers,
    );
    expect(result.match.cards.map((card) => card.cardId)).toEqual(t.cardIds);
  });

  it('ends a run at the job budget after one call; the next job resumes from the saved stages', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    const classification = h.deps.classification as ClassificationDeps;
    classification.jobBudgetMs = 0;
    try {
      await h.dispatch('analysis.process', { analysisRequestId: requestId });
      expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich']);
      // Deferred to now without a failure attempt; the stored Call A is not asked again.
      const continued = await h.analysis(requestId);
      expect(continued).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastErrorCode: 'continued',
        leaseToken: null,
      });
      expect(continued.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await pendingIntents(requestId)).toHaveLength(1);
      await processRequest(requestId);
    } finally {
      classification.jobBudgetMs = 600_000;
    }
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(await h.analysis(requestId)).toMatchObject({ status: 'complete', attempts: 0 });
  });

  it('defers on budget, an open breaker or a known retry time: pending with a due time and a delayed intent', async () => {
    const cases = [
      { reason: 'budget', retryAt: new Date(Date.now() + 2 * HOUR) },
      { reason: 'circuit_open', retryAt: undefined },
      { reason: 'error', retryAt: new Date(Date.now() + 30 * MINUTE) },
    ] as const;
    let last = '';
    for (const c of cases) {
      const t = await trainee({ cards: 1 });
      const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
      last = requestId;
      h.router.respond = () => failure(c.reason, c.retryAt);
      const before = Date.now();
      await processRequest(requestId);
      const row = await h.analysis(requestId);
      expect(row).toMatchObject({
        status: 'pending',
        attempts: 0,
        lastErrorCode: c.reason,
        leaseToken: null,
        resultSnapshot: null,
      });
      if (c.retryAt === undefined) {
        // The 10-minute recovery interval.
        const delay = row.nextAttemptAt.getTime() - before;
        expect(delay).toBeGreaterThanOrEqual(10 * MINUTE - 1_000);
        expect(delay).toBeLessThanOrEqual(10 * MINUTE + 5_000);
      } else {
        expect(row.nextAttemptAt.getTime()).toBe(c.retryAt.getTime());
      }
      const pending = await pendingIntents(requestId);
      expect(pending.map((intent) => intent.availableAt.getTime())).toEqual([
        row.nextAttemptAt.getTime(),
      ]);
      // An early duplicate delivery is not due: nothing is asked and no second intent appears.
      const asked = requestAsks(requestId).length;
      await h.dispatch('analysis.process', { analysisRequestId: requestId });
      expect(requestAsks(requestId)).toHaveLength(asked);
      expect(await pendingIntents(requestId)).toHaveLength(1);
      expect((await h.analysis(requestId)).status).toBe('pending');
    }

    // Due again with the engine back, the deferred request completes.
    h.router.respond = undefined;
    await makeDue(last);
    await processRequest(last);
    expect(await h.analysis(last)).toMatchObject({ status: 'complete', attempts: 0 });
  });

  it('counts a failure attempt with backoff per failed run and fails at five; an invalid request fails at once', async () => {
    const t = await trainee({ cards: 1 });
    const { requestId } = await h.select(t.userId, t.feedId, t.articleId);
    h.router.respond = () => failure('error');
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const before = Date.now();
      expect(await processRequest(requestId)).toBe(1);
      const row = await h.analysis(requestId);
      if (attempt < 5) {
        expect(row).toMatchObject({
          status: 'pending',
          attempts: attempt,
          lastErrorCode: 'error',
          leaseToken: null,
        });
        delays.push(Math.round((row.nextAttemptAt.getTime() - before) / MINUTE));
        expect((await pendingIntents(requestId)).map((i) => i.availableAt.getTime())).toEqual([
          row.nextAttemptAt.getTime(),
        ]);
        await makeDue(requestId);
      } else {
        expect(row).toMatchObject({ status: 'failed', attempts: 5, lastErrorCode: 'error' });
        expect(row.completedAt).not.toBeNull();
        expect(await pendingIntents(requestId)).toEqual([]);
      }
    }
    expect(delays).toEqual([1, 2, 4, 8]);
    expect(requestAsks(requestId).map((ask) => ask.kind)).toEqual(Array(5).fill('enrich'));
    // A failed request is final.
    await h.dispatch('analysis.process', { analysisRequestId: requestId });
    expect(requestAsks(requestId)).toHaveLength(5);

    const u = await trainee({ cards: 1 });
    const invalid = await h.select(u.userId, u.feedId, u.articleId);
    h.router.respond = () => failure('invalid_request');
    await processRequest(invalid.requestId);
    expect(await h.analysis(invalid.requestId)).toMatchObject({
      status: 'failed',
      attempts: 0,
      lastErrorCode: 'invalid_request',
      resultSnapshot: null,
    });
    expect(await pendingIntents(invalid.requestId)).toEqual([]);
  });
});

describe('analysis.process training feedback (spec 05 §1.1)', () => {
  it('records user.learn only when a surviving rating references the request; a replay adds nothing', async () => {
    // Rated with the request referenced: the inaugural rating becomes learnable.
    const a = await trainee();
    const ra = await h.select(a.userId, a.feedId, a.articleId);
    await rate(a.userId, a.articleId, ra.requestId);
    const since = await h.mark();
    await processRequest(ra.requestId);
    expect(await h.payloads('user.learn', since)).toEqual([{ userId: a.userId }]);
    await h.clearOutbox();
    const replay = await h.mark();
    await h.dispatch('analysis.process', { analysisRequestId: ra.requestId });
    await h.dispatch('analysis.process', { analysisRequestId: ra.requestId });
    expect(await h.payloads('user.learn', replay)).toEqual([]);
    const events = await h.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM feedback_events WHERE user_id = $1',
      [a.userId],
    );
    expect(events.rows[0]?.n).toBe(1);

    // The rating was removed before completion: nothing to learn.
    const b = await trainee();
    const rb = await h.select(b.userId, b.feedId, b.articleId);
    await rate(b.userId, b.articleId, rb.requestId);
    await h.owner.query(
      'UPDATE user_article SET rating = NULL, rated_at = NULL WHERE user_id = $1 AND article_id = $2',
      [b.userId, b.articleId],
    );
    const sinceB = await h.mark();
    await processRequest(rb.requestId);
    expect((await h.analysis(rb.requestId)).status).toBe('complete');
    expect(await h.payloads('user.learn', sinceB)).toEqual([]);

    // A rating that references no request (or another one) is not this request's feedback.
    const c = await trainee();
    const rc = await h.select(c.userId, c.feedId, c.articleId);
    await rate(c.userId, c.articleId, null);
    await rate(c.userId, c.articleId, ra.requestId);
    const sinceC = await h.mark();
    await processRequest(rc.requestId);
    expect((await h.analysis(rc.requestId)).status).toBe('complete');
    expect(await h.payloads('user.learn', sinceC)).toEqual([]);
  });
});

describe('readers with different modes on one feed (spec 05 §1.1)', () => {
  it('only active arrivals and the trainee’s selection reach the provider; an off switch fences the trainee’s request', async () => {
    const feedId = await h.feed();
    const [a, b, c] = [await h.user(), await h.user(), await h.user()];
    await h.subscribe(a, feedId, 'active', ago(2 * DAY));
    await h.subscribe(b, feedId, 'off');
    await h.subscribe(c, feedId, 'training');
    const cardA = await h.heldCard(a);
    const cardB = await h.heldCard(b);
    const cardC = await h.card({ visibility: 'private', ownerUserId: c });
    await h.hold(c, cardC);
    // `fresh` arrived after A's activation; `old` and `other` before it (A's hidden backlog).
    const fresh = await h.article({
      feedIds: [feedId],
      title: 'Harbour cranes arrive in port',
      firstSeenAt: ago(HOUR),
    });
    const old = await h.article({
      feedIds: [feedId],
      title: 'Museum reopens its east wing',
      firstSeenAt: ago(3 * DAY),
    });
    const other = await h.article({
      feedIds: [feedId],
      title: 'Night trains return next spring',
      firstSeenAt: ago(4 * DAY),
    });

    // The automatic pipeline, and C's explicit selection of the old article.
    for (const articleId of [fresh, old, other]) await h.dispatch('article.enrich', { articleId });
    await h.run('article.match', forArticles(fresh, old, other));
    const selected = await h.select(c, feedId, old);
    await processRequest(selected.requestId);

    expect(h.router.asks.every((ask) => ask.authorized)).toBe(true);
    const freshAsks = h.router.asksFor(fresh);
    expect(freshAsks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(witnessesOf(freshAsks)).toEqual({ users: [a], requests: [] });
    expect(freshAsks.flatMap((ask) => ask.cards)).toEqual([cardA]);
    const oldAsks = h.router.asksFor(old);
    expect(oldAsks.map((ask) => ask.kind)).toEqual(['enrich', 'match']);
    expect(witnessesOf(oldAsks)).toEqual({ users: [], requests: [selected.requestId] });
    expect(oldAsks.flatMap((ask) => ask.cards)).toEqual([cardC]);
    expect(oldAsks.every((ask) => ask.userId === c)).toBe(true);
    expect(h.router.asksFor(other)).toEqual([]);
    // The off reader's interests never leave the database.
    expect(h.router.asks.some((ask) => ask.cards.includes(cardB))).toBe(false);
    expect(h.router.asks.some((ask) => witnessesOf([ask]).users.includes(b))).toBe(false);
    expect((await h.analysis(selected.requestId)).status).toBe('complete');

    // C switches the feed off while a second selection is in flight: its completion is fenced.
    const second = await h.select(c, feedId, other);
    h.router.respond = async (ask) => {
      if (ask.kind === 'match' && witnessesOf([ask]).requests.includes(second.requestId)) {
        await h.setMode(c, feedId, 'off');
      }
      return undefined;
    };
    const since = await h.mark();
    await processRequest(second.requestId);
    expect(await h.analysis(second.requestId)).toMatchObject({
      status: 'cancelled',
      lastErrorCode: 'revoked',
      resultSnapshot: null,
    });
    expect(await h.facetRow(other)).toBeNull();
    expect(await h.cardAnswers(other)).toEqual([]);
    expect(await h.payloads('user.rank', since)).toEqual([]);
    // A's shared work and C's completed training result stand.
    expect((await h.cardAnswers(fresh)).map((x) => [x.cardId, x.engine])).toEqual([
      [cardA, 'typesafe'],
    ]);
    expect(await h.articleRow(fresh)).toMatchObject({ state: 'matched' });
    expect((await h.analysis(selected.requestId)).status).toBe('complete');
  });
});
