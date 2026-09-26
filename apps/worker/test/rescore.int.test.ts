import type { RouterStatus } from '@bantoozi/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RESCORE_ENRICH_PAGE } from '../src/handlers/house-rescore-degraded.js';
import { enqueueOverdueHousekeeping } from '../src/housekeeping.js';
import {
  ClassifyHarness,
  DAY,
  HOUR,
  MINUTE,
  PRIMARY_MODEL,
  ago,
  failure,
  forArticles,
} from './support/classify.js';

/**
 * M2-T9 `house.rescore-degraded` (spec 04 §5, spec 11 §6) through the real handler: it reads the
 * breaker mirror, re-enqueues eligible degraded and LLM-answered demand only, never revives off or
 * cancelled demand, and walks the window with a persisted cursor that wraps.
 */

const JOB = 'house.rescore-degraded';

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

/** Every test starts from a clean window: earlier articles are stale, no queue, no progress. */
beforeEach(async () => {
  h.router.reset();
  await h.owner.query(
    `UPDATE articles SET pipeline_state = 'stale' WHERE pipeline_state <> 'stale'`,
  );
  await h.owner.query('DELETE FROM match_queue');
  await h.deleteSetting('house.progress');
  await h.deleteSetting('engine.circuit');
  await h.clearOutbox();
});

const closed = { state: 'closed', reopenCount: 0 } as const;

/** The breaker mirror as the engine router persists it (spec 02 §2 `engine.circuit`). */
const mirror = (typesafe: Record<string, unknown>) =>
  h.setSetting('engine.circuit', { typesafe, llm: closed, resetRequested: {} });

async function rescore(): Promise<{ enrich: Array<Record<string, unknown>>; match: string[] }> {
  const since = await h.mark();
  await h.dispatch(JOB, {});
  return {
    enrich: await h.payloads('article.enrich', since),
    // Queue recovery may dispatch an article the answer page already did (duplicates coalesce in
    // the singleton job).
    match: [
      ...new Set((await h.payloads('article.match', since)).map((p) => String(p['articleId']))),
    ].sort(),
  };
}

/** A reader of a new feed in `mode` (active since 30 days). */
async function reader(mode: 'off' | 'training' | 'active' = 'active') {
  const userId = await h.user();
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, mode, ago(30 * DAY));
  return { userId, feedId };
}

describe('house.rescore-degraded availability (spec 04 §5)', () => {
  it('reads the breaker mirror, the credential and the bulk budget before recovering anything', async () => {
    const r = await reader();
    const degraded = await h.article({ feedIds: [r.feedId], state: 'degraded' });
    const expected = [{ articleId: degraded, priority: 'bulk' }];

    await mirror({
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(Date.now() + 10 * MINUTE).toISOString(),
      reopenCount: 1,
    });
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    await mirror({ state: 'open', reopenCount: 2 });
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    await mirror({ state: 'auth', reopenCount: 0 });
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    expect(await h.setting('house.progress')).toBeUndefined();

    // An open period that has passed: the next call is the half-open probe, recovery may start.
    await mirror({ state: 'open', openUntil: ago(MINUTE).toISOString(), reopenCount: 1 });
    expect(await rescore()).toEqual({ enrich: expected, match: [] });
    await h.clearOutbox();

    // The mirror is authoritative, not this process's own breaker view.
    await mirror(closed);
    const status = h.router.status.bind(h.router);
    Object.assign(h.router, {
      status: async (): Promise<RouterStatus> => ({
        ...(await status()),
        breakers: {
          typesafe: { state: 'open', reopenCount: 3 },
          llm: { state: 'open', reopenCount: 3 },
        },
      }),
    });
    try {
      expect(await rescore()).toEqual({ enrich: expected, match: [] });
    } finally {
      delete (h.router as unknown as Record<string, unknown>)['status'];
    }
    await h.clearOutbox();

    h.router.credential = { source: 'none', enabled: false };
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    h.router.credential = { source: 'db', enabled: false, activeVersion: '4' };
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    h.router.credential = { source: 'env', enabled: true };
    h.router.spendable = false;
    expect(await rescore()).toEqual({ enrich: [], match: [] });
    h.router.spendable = true;
    expect(await rescore()).toEqual({ enrich: expected, match: [] });
  });
});

describe('house.rescore-degraded recovery (spec 04 §5, spec 05 §5.5 step 7)', () => {
  it('re-enqueues eligible degraded and LLM-enriched articles and requeues current LLM answers', async () => {
    const r = await reader();
    const card = await h.heldCard(r.userId);
    const unheld = await h.card();

    const degraded = await h.article({ feedIds: [r.feedId], state: 'degraded' });
    const llmEnriched = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(llmEnriched, { engine: 'llm', model: 'glm-5.3-flash' });
    const llmMatched = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(llmMatched, { engine: 'llm', model: 'glm-5.3', state: 'matched' });
    const llmCards = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(llmCards);
    await h.answerCard(llmCards, card, { engine: 'llm' });
    await h.answerCard(llmCards, unheld, { engine: 'llm' });
    const llmBranch = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(llmBranch);
    await h.answerL2(llmBranch, 'technology', { engine: 'llm' });
    const primary = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(primary, { state: 'matched' });
    await h.answerCard(primary, card, { engine: 'typesafe' });
    // Retained exhausted work: a service failure that gave up seven hours ago and a permanent
    // invalid request; a service failure exhausted an hour ago waits for its six-hour cooldown.
    const exhausted = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(exhausted);
    const other = await h.heldCard(r.userId);
    await h.queue(exhausted, [card], {
      attempts: 5,
      lastError: 'error',
      nextAttemptAt: ago(7 * HOUR),
    });
    await h.queue(exhausted, [other], { attempts: 5, lastError: 'invalid_request' });
    const recent = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(recent);
    await h.queue(recent, [card], { attempts: 5, lastError: 'error', nextAttemptAt: ago(HOUR) });
    // Never revived: failed, stale and out-of-window articles.
    await h.article({ feedIds: [r.feedId], state: 'failed' });
    await h.article({ feedIds: [r.feedId], state: 'stale' });
    await h.article({ feedIds: [r.feedId], state: 'degraded', firstSeenAt: ago(15 * DAY) });

    const result = await rescore();
    expect(result.enrich.sort((a, b) => Number(a['articleId']) - Number(b['articleId']))).toEqual(
      [degraded, llmEnriched, llmMatched].map((articleId) => ({ articleId, priority: 'bulk' })),
    );
    expect(result.match).toEqual([llmCards, llmBranch, exhausted].sort());
    // Only the still-demanded pair of the LLM answers is requeued.
    expect((await h.queueRows(llmCards)).map((row) => [row.cardId, row.priority, row.due])).toEqual(
      [[card, 5, true]],
    );
    expect(await h.queueRows(primary)).toEqual([]);
    expect(await h.queueRows(exhausted)).toMatchObject([
      { cardId: card, attempts: 0, lastError: null, due: true },
      { cardId: other, attempts: 5, lastError: 'invalid_request' },
    ]);
    expect(await h.queueRows(recent)).toMatchObject([
      { cardId: card, attempts: 5, lastError: 'error' },
    ]);

    // Delivered, the recovery asks the primary engine in bulk and replaces the provisional work.
    await h.run('article.enrich', forArticles(degraded));
    expect(h.router.asksFor(degraded, 'enrich').map((ask) => ask.priority)).toEqual(['bulk']);
    await h.run('article.match', forArticles(llmCards, llmBranch));
    expect((await h.cardAnswers(llmCards)).find((a) => a.cardId === card)?.engine).toBe('typesafe');
    expect((await h.l2Rows(llmBranch)).map((row) => [row.l1, row.engine])).toEqual([
      ['science', 'typesafe'],
      ['technology', 'typesafe'],
    ]);
  });

  it('never revives off, pre-activation, unselected or cancelled demand', async () => {
    const off = await reader('off');
    const offDegraded = await h.article({ feedIds: [off.feedId], state: 'degraded' });
    const offLlm = await h.article({ feedIds: [off.feedId] });
    await h.enrichDirect(offLlm, { engine: 'llm', model: 'glm-5.3-flash' });

    // Active only since now: an earlier arrival stays a hidden backlog.
    const late = { userId: await h.user(), feedId: await h.feed() };
    await h.subscribe(late.userId, late.feedId, 'active', new Date());
    const backlog = await h.article({ feedIds: [late.feedId], state: 'degraded' });

    const trainee = await reader('training');
    const unselected = await h.article({ feedIds: [trainee.feedId], state: 'degraded' });
    const selected = await h.article({ feedIds: [trainee.feedId], state: 'degraded' });
    const cancelled = await h.article({ feedIds: [trainee.feedId], state: 'degraded' });
    await h.select(trainee.userId, trainee.feedId, selected);
    const dropped = await h.select(trainee.userId, trainee.feedId, cancelled);
    await h.owner.query(
      `UPDATE analysis_requests SET status = 'cancelled', completed_at = now() WHERE id = $1`,
      [dropped.requestId],
    );

    // A reader switched off after the pair was exhausted.
    const switched = await reader();
    const card = await h.heldCard(switched.userId);
    const wasActive = await h.article({ feedIds: [switched.feedId] });
    await h.enrichDirect(wasActive);
    await h.queue(wasActive, [card], {
      attempts: 5,
      lastError: 'circuit_open',
      nextAttemptAt: ago(7 * HOUR),
    });
    await h.setMode(switched.userId, switched.feedId, 'off');

    const result = await rescore();
    // Only the current selection is recovered.
    expect(result.enrich).toEqual([{ articleId: selected, priority: 'bulk' }]);
    for (const id of [offDegraded, offLlm, backlog, unselected, cancelled]) {
      expect(result.enrich.some((p) => p['articleId'] === id)).toBe(false);
    }

    // Queue recovery resets the retained row, but matching recomputes demand and asks nothing.
    expect(result.match).toEqual([wasActive]);
    await h.run('article.match', forArticles(wasActive));
    expect(h.router.asksFor(wasActive)).toEqual([]);
    expect(await h.queueRows(wasActive)).toEqual([]);

    // Delivering the enrich intent of the off article (a stale intent) spends nothing either.
    await h.dispatch('article.enrich', { articleId: offDegraded, priority: 'bulk' });
    expect(h.router.asksFor(offDegraded)).toEqual([]);
    expect(await h.articleRow(offDegraded)).toMatchObject({ state: 'degraded' });
  });

  it('does not loop on an LLM-enriched article whose revision Jev rejected as invalid', async () => {
    const r = await reader();
    const rejected = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(rejected, { engine: 'llm', model: 'glm-5.3-flash' });
    expect((await rescore()).enrich).toEqual([{ articleId: rejected, priority: 'bulk' }]);

    // The bulk retry reaches Jev, which rejects the request: the article keeps its fallback
    // answers, and the router's ledger records the rejection (inserted here: the scripted router
    // keeps no ledger).
    h.router.respond = () => failure('invalid_request');
    await h.dispatch('article.enrich', { articleId: rejected, priority: 'bulk' });
    await h.owner.query(
      `INSERT INTO engine_calls (engine, kind, model, article_id, question_set_id,
                                 logical_request_id, article_revision, status, error)
       SELECT 'typesafe', 'enrich', $1, a.id, $3, gen_random_uuid(), a.content_revision,
              'invalid_request', 'http_400'
         FROM articles a WHERE a.id = $2`,
      [PRIMARY_MODEL, rejected, h.sets.enrich],
    );
    expect(await h.articleRow(rejected)).toMatchObject({ state: 'enriched', enrichEngine: 'llm' });
    await h.clearOutbox();
    expect((await rescore()).enrich).toEqual([]);
  });
});

describe('house.rescore-degraded progress (spec 11 §6)', () => {
  it('advances the persisted cursor page by page and wraps after the oldest page', async () => {
    const r = await reader();
    const count = RESCORE_ENRICH_PAGE + 50;
    const inserted = await h.owner.query<{ id: string; first_seen_at: Date }>(
      `WITH a AS (
         INSERT INTO articles (url, canonical_url, url_key, title, title_norm, first_seen_at,
                               content_hash, pipeline_state, lang)
         SELECT 'https://rescore.example.test/' || g, 'https://rescore.example.test/' || g,
                'rescore.example.test/' || g, 'Degraded ' || g, 'degraded ' || g,
                now() - make_interval(mins => g), md5('rescore' || g), 'degraded', 'en'
           FROM generate_series(1, $2::int) AS g
         RETURNING id, first_seen_at)
       INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       SELECT $1, id, 'rescore-' || id, first_seen_at FROM a
       RETURNING article_id::text AS id, first_seen_at`,
      [r.feedId, count],
    );
    const newestFirst = inserted.rows
      .sort((x, y) => y.first_seen_at.getTime() - x.first_seen_at.getTime())
      .map((row) => row.id);
    // The outbox writes a transaction's intents in key order, not page order: compare the sets.
    const ids = (payloads: ReadonlyArray<Record<string, unknown>>) =>
      payloads.map((p) => String(p['articleId'])).sort((x, y) => Number(x) - Number(y));
    const numeric = (list: readonly string[]) => [...list].sort((x, y) => Number(x) - Number(y));
    const progress = async () =>
      ((await h.setting('house.progress')) as Record<string, Record<string, unknown>>)[JOB];

    const first = await rescore();
    expect(ids(first.enrich)).toEqual(numeric(newestFirst.slice(0, RESCORE_ENRICH_PAGE)));
    const afterFirst = await progress();
    expect(afterFirst).toMatchObject({
      version: 1,
      cursor: { enrich: { articleId: newestFirst[RESCORE_ENRICH_PAGE - 1] } },
    });
    expect(afterFirst?.['completedAt']).toBeUndefined();

    await h.clearOutbox();
    const second = await rescore();
    expect(ids(second.enrich)).toEqual(numeric(newestFirst.slice(RESCORE_ENRICH_PAGE)));
    const afterSecond = await progress();
    expect(afterSecond?.['cursor']).toEqual({});
    expect(afterSecond?.['completedAt']).toEqual(expect.any(String));

    // The next pass starts again from the newest page (new arrivals never starve older work).
    await h.clearOutbox();
    const third = await rescore();
    expect(ids(third.enrich)).toEqual(numeric(newestFirst.slice(0, RESCORE_ENRICH_PAGE)));
    expect((await progress())?.['completedAt']).toBe(afterSecond?.['completedAt']);
  });

  it('enqueues an overdue run once at worker startup (spec 11 §6)', async () => {
    const since = await h.mark();
    // Never run yet: overdue for a worker that consumes the queue, never for one that does not.
    expect(
      await enqueueOverdueHousekeeping(h.db, ['article.match'], h.settingsEnv, new Date()),
    ).toEqual([]);
    expect(await enqueueOverdueHousekeeping(h.db, [JOB], h.settingsEnv, new Date())).toEqual([JOB]);
    expect(await h.payloads(JOB, since)).toEqual([{}]);

    // After a run it is overdue again only one period (10 minutes) later.
    await h.dispatch(JOB, {});
    const at = (minutes: number) => new Date(Date.now() + minutes * MINUTE);
    expect(await enqueueOverdueHousekeeping(h.db, [JOB], h.settingsEnv, at(9))).toEqual([]);
    expect(await enqueueOverdueHousekeeping(h.db, [JOB], h.settingsEnv, at(11))).toEqual([JOB]);
  });

  it('restarts a pass from a malformed cursor instead of failing', async () => {
    const r = await reader();
    const degraded = await h.article({
      feedIds: [r.feedId],
      state: 'degraded',
      firstSeenAt: ago(2 * HOUR),
    });
    await h.setSetting('house.progress', {
      [JOB]: { cursor: { enrich: { key: 42 } }, updatedAt: new Date().toISOString(), version: 1 },
    });
    expect((await rescore()).enrich).toEqual([{ articleId: degraded, priority: 'bulk' }]);
  });
});
