import { claimSuggestLease, releaseSuggestLease } from '@bantoozi/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { dispatch } from '../src/handlers/index.js';
import { ProcessLeases } from '../src/process-leases.js';
import { ClassifyHarness } from './support/classify.js';

let h: ClassifyHarness;
beforeAll(async () => {
  h = await ClassifyHarness.start();
});
afterAll(async () => {
  await h?.close();
});

it('drain releases owned match, selected-analysis and suggest leases, preserves other owners and fences late answers', async () => {
  const leases = new ProcessLeases();
  h.deps.leases = leases;
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const cardId = await h.heldCard(userId);
  const matchId = await h.article({ feedIds: [feedId] });
  await h.enrichDirect(matchId);
  await h.queue(matchId, [cardId]);
  const selectedId = await h.article({ feedIds: [feedId] });
  const { requestId } = await h.select(userId, feedId, selectedId);
  const suggest = await leases.acquire(
    () => claimSuggestLease(h.db, userId, { leaseMs: 600_000 }),
    (claim) =>
      claim.status !== 'claimed'
        ? undefined
        : () => releaseSuggestLease(h.db, userId, claim.leaseToken, { resetDailyGate: true }),
  );
  expect(suggest.status).toBe('claimed');
  const otherUser = await h.user();
  const other = await claimSuggestLease(h.db, otherUser, { leaseMs: 600_000 });
  expect(other.status).toBe('claimed');
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let calls = 0;
  h.router.respond = async () => {
    calls += 1;
    await blocked;
    return undefined;
  };
  const jobs = [
    dispatch(
      h.handlers,
      'article.match',
      { articleId: matchId },
      { queue: 'article.match', jobId: 'match' },
    ),
    dispatch(
      h.handlers,
      'analysis.process',
      { analysisRequestId: requestId },
      { queue: 'analysis.process', jobId: 'analysis' },
    ),
  ];
  try {
    await vi.waitFor(() => expect(calls).toBe(2));
    await leases.drain();
    expect(
      (
        await h.owner.query('SELECT lease_token, attempts FROM match_queue WHERE article_id=$1', [
          matchId,
        ])
      ).rows,
    ).toEqual([{ lease_token: null, attempts: 0 }]);
    expect(await h.analysis(requestId)).toMatchObject({
      status: 'pending',
      leaseToken: null,
      attempts: 0,
      lastErrorCode: 'worker_drain',
    });
    expect(
      (await h.owner.query('SELECT suggest_lease_token FROM users WHERE id=$1', [userId])).rows[0]
        ?.suggest_lease_token,
    ).toBeNull();
    expect(
      (await h.owner.query('SELECT suggest_lease_token FROM users WHERE id=$1', [otherUser]))
        .rows[0]?.suggest_lease_token,
    ).toBe(other.status === 'claimed' ? other.leaseToken : undefined);
    expect(
      (await h.intents('analysis.process', { pending: true })).some(
        (intent) => intent.payload['analysisRequestId'] === requestId,
      ),
    ).toBe(true);
    expect(
      (await h.intents('article.match', { pending: true })).some(
        (intent) => intent.payload['articleId'] === matchId,
      ),
    ).toBe(true);
  } finally {
    resume();
    await Promise.allSettled(jobs);
  }
  expect(
    (
      await h.owner.query('SELECT count(*)::int AS n FROM card_answers WHERE article_id=$1', [
        matchId,
      ])
    ).rows[0]?.n,
  ).toBe(0);
  expect(await h.analysis(requestId)).toMatchObject({
    status: 'pending',
    leaseToken: null,
    resultSnapshot: null,
    resultSha: null,
    stageResults: null,
    completedAt: null,
  });
  expect(await h.facetRow(selectedId)).toBeNull();
});

it('drain cannot release match or analysis leases reclaimed by another process', async () => {
  h.router.reset();
  const leases = new ProcessLeases();
  h.deps.leases = leases;
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const cardId = await h.heldCard(userId);
  const matchId = await h.article({ feedIds: [feedId] });
  await h.enrichDirect(matchId);
  await h.queue(matchId, [cardId]);
  const selectedId = await h.article({ feedIds: [feedId] });
  const { requestId } = await h.select(userId, feedId, selectedId);
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let calls = 0;
  h.router.respond = async () => {
    calls += 1;
    await blocked;
    return undefined;
  };
  const jobs = [
    h.dispatch('article.match', { articleId: matchId }),
    h.dispatch('analysis.process', { analysisRequestId: requestId }),
  ];
  try {
    await vi.waitFor(() => expect(calls).toBe(2));
    await h.owner.query(
      'UPDATE match_queue SET lease_token=gen_random_uuid() WHERE article_id=$1',
      [matchId],
    );
    await h.owner.query('UPDATE analysis_requests SET lease_token=gen_random_uuid() WHERE id=$1', [
      requestId,
    ]);
    const match = await h.queueRows(matchId);
    const analysis = await h.analysis(requestId);
    const mark = await h.mark();
    await leases.drain();
    expect(await h.queueRows(matchId)).toEqual(match);
    expect(await h.analysis(requestId)).toEqual(analysis);
    expect(await h.intents('article.match', { since: mark })).toEqual([]);
    expect(await h.intents('analysis.process', { since: mark })).toEqual([]);
  } finally {
    resume();
    await Promise.allSettled(jobs);
  }
  expect(await h.cardAnswers(matchId)).toEqual([]);
  expect((await h.analysis(requestId)).resultSnapshot).toBeNull();
});
