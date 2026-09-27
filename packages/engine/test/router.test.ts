import { conservativeRequestTokens, isUuid, PLATFORM_USER_ID } from '@bantoozi/shared';
import { startFakeTypeSafe } from '@bantoozi/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultCircuit } from '../src/breaker.js';
import {
  estimateLlmCostUsd,
  estimateLlmInputTokens,
  estimateLlmOutputTokens,
} from '../src/llm-fallback-engine.js';
import { splitQuestionsForLlm } from '../src/router.js';
import { typesafeCostUsd } from '../src/typesafe-engine.js';
import type { EngineRequest } from '../src/types.js';
import {
  drive,
  failure,
  fakeCredentials,
  JEV_KEY,
  LLM_MODEL,
  OLLAMA_KEY,
  QUESTIONS,
  request,
  scriptedEngine,
  setup,
  success,
  TYPESAFE_MODEL,
  USER_ID,
} from './support/router-fixtures.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const EVAL_AUTH = { type: 'eval', runId: 'run-1' } as const;

/** The reserve of one Jev attempt of `req` (conservative §6.1 tokens at the Jev price). */
const jevEstimate = (req: EngineRequest = request()) =>
  typesafeCostUsd(conservativeRequestTokens(req.state, req.questions), 0.042);
/** The reserve of one LLM attempt: input plus the full default output cap at LLM prices. */
const llmEstimate = (req: EngineRequest = request(), maxOutput = 2048) =>
  estimateLlmCostUsd(estimateLlmInputTokens(req.state, req.questions), maxOutput, LLM_MODEL);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EngineRouter.ask: a successful logical request', () => {
  it('reserves, sends with the active credential and settles one attempt row', async () => {
    const { router, store, typesafe } = setup();
    const outcome = await router.ask(request({ userId: USER_ID }));

    expect(outcome).toMatchObject({ ok: true, engine: 'typesafe', model: TYPESAFE_MODEL });
    expect(typesafe!.calls).toHaveLength(1);
    expect(typesafe!.calls[0]!.auth).toEqual(JEV_KEY);
    expect(store.reservations).toEqual([
      expect.objectContaining({
        engine: 'typesafe',
        kind: 'enrich',
        day: '2026-09-26',
        userId: USER_ID,
        status: 'settled',
        callCap: undefined,
      }),
    ]);
    expect(store.reservations[0]!.reservedUsd).toBeCloseTo(jevEstimate(), 12);
    expect(store.calls).toHaveLength(1);
    const row = store.calls[0]!;
    expect(row).toMatchObject({
      engine: 'typesafe',
      kind: 'enrich',
      model: TYPESAFE_MODEL,
      attempts: 1,
      status: 'ok',
      billing: 'known',
      credentialVersion: '7',
      articleId: '11',
      articleRevision: '3',
      nQuestions: 3,
      userId: USER_ID,
      reservationId: store.reservations[0]!.id,
      stateSha256: 'b'.repeat(64),
    });
    expect(isUuid(row.logicalRequestId)).toBe(true);
    expect(row.createdAt.toISOString()).toBe(NOW.toISOString());
    expect([...store.usage.values()]).toEqual([
      expect.objectContaining({
        day: '2026-09-26',
        userId: USER_ID,
        engine: 'typesafe',
        kind: 'enrich',
        calls: 1,
        inputTokens: 100,
        outputTokens: 10,
      }),
    ]);
  });

  it('attributes usage without a user to the platform sentinel', async () => {
    const { router, store } = setup();
    await router.ask(request());
    expect([...store.usage.values()][0]!.userId).toBe(PLATFORM_USER_ID);
  });

  it('gives every logical request its own id', async () => {
    const { router, store } = setup();
    await router.ask(request());
    await router.ask(request());
    const [a, b] = store.calls;
    expect(a!.logicalRequestId).not.toBe(b!.logicalRequestId);
    expect(a!.attempts).toBe(1);
    expect(b!.attempts).toBe(1);
  });

  it('runs an injected engine without auth when no credential is available', async () => {
    const { router, typesafe } = setup({ credentials: fakeCredentials({}) });
    const outcome = await router.ask(request());
    expect(outcome.ok).toBe(true);
    expect(typesafe!.calls[0]!.auth).toBeUndefined();
  });
});

describe('EngineRouter.ask: request validation and demand', () => {
  it.each([
    ['no questions', { questions: {} }],
    ['a bad question key', { questions: { 'bad key': QUESTIONS.q1! } }],
    ['a bad user id', { userId: 'nope' }],
    ['a bad article id', { articleId: '0' }],
    ['a bad state hash', { stateSha256: '' }],
    ['a bad card list', { cardIds: ['1', 'x'] }],
    ['an unknown priority', { priority: 'urgent' as never }],
    ['an eval kind on a production router', { kind: 'eval' as const }],
    ['an eval authorization on a production router', { authorization: EVAL_AUTH }],
    ['a non-finite deadline', { deadlineMs: Number.NaN }],
  ])('refuses %s as invalid_request before any spend', async (_name, patch) => {
    const { router, store, typesafe } = setup();
    const outcome = await router.ask(request(patch as Partial<EngineRequest>));
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(store.reservations).toHaveLength(0);
    expect(typesafe!.calls).toHaveLength(0);
  });

  it('returns no_demand without a reservation when the authorization no longer holds', async () => {
    const { router, store, typesafe } = setup();
    store.authorize = () => false;
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'no_demand',
      detail: 'demand_lost',
    });
    expect(store.reservations).toHaveLength(0);
    expect(typesafe!.calls).toHaveLength(0);
  });

  it('returns no_demand when the demand is lost before a retry, with no fallback', async () => {
    const { router, store, typesafe, llm } = setup({
      config: { llmFallbackEnabled: true },
      typesafe: scriptedEngine('typesafe', [
        () => {
          store.authorize = () => false;
          return failure('error');
        },
      ]),
    });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: false, reason: 'no_demand' });
    expect(typesafe!.calls).toHaveLength(1);
    expect(llm!.calls).toHaveLength(0);
  });
});

describe('EngineRouter.ask: retries (spec 04 §4)', () => {
  it('retries transient failures after 500 ms × 2^(n−2) on one logical id', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('error'),
      failure('timeout'),
      failure('rate_limited'),
      'ok',
    ]);
    const { router, store } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome.ok).toBe(true);
    expect(typesafe.calls.map((c) => c.at - NOW.getTime())).toEqual([0, 500, 1500, 3500]);
    expect(store.calls.map((c) => c.attempts)).toEqual([1, 2, 3, 4]);
    expect(new Set(store.calls.map((c) => c.logicalRequestId)).size).toBe(1);
    expect(store.calls.map((c) => c.status)).toEqual(['error', 'timeout', 'rate_limited', 'ok']);
    expect(store.reservations).toHaveLength(4);
  });

  it('applies ±20 % jitter to the backoff', async () => {
    const typesafe = scriptedEngine('typesafe', [failure('error'), failure('error'), 'ok']);
    const { router } = setup({ typesafe, random: () => 0 });
    await drive(router.ask(request()), advance);
    expect(typesafe.calls.map((c) => c.at - NOW.getTime())).toEqual([0, 400, 1200]);
  });

  it('stops after four TypeSafe attempts and reports exhaustion without retryAt', async () => {
    const typesafe = scriptedEngine('typesafe', [], failure('error', { detail: 'http_503' }));
    const { router, store } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toEqual({ ok: false, reason: 'error', detail: 'typesafe:error:http_503' });
    expect(typesafe.calls).toHaveLength(4);
    expect(store.calls).toHaveLength(4);
  });

  it('never nests retries: 4 Jev attempts, then 2 LLM attempts, all under one logical id', async () => {
    const typesafe = scriptedEngine('typesafe', [], failure('error'));
    const llm = scriptedEngine('llm', [], failure('timeout'));
    const { router, store } = setup({ typesafe, llm, config: { llmFallbackEnabled: true } });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'error',
      detail: 'typesafe:error:test_error',
    });
    expect(typesafe.calls).toHaveLength(4);
    expect(llm.calls).toHaveLength(2);
    expect(store.calls.map((c) => `${c.engine}:${c.attempts}`)).toEqual([
      'typesafe:1',
      'typesafe:2',
      'typesafe:3',
      'typesafe:4',
      'llm:1',
      'llm:2',
    ]);
    expect(new Set(store.calls.map((c) => c.logicalRequestId)).size).toBe(1);
  });

  it('never retries sooner than a valid Retry-After', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('rate_limited', { retryAfterMs: 5_000 }),
      'ok',
    ]);
    const { router } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome.ok).toBe(true);
    expect(typesafe.calls.map((c) => c.at - NOW.getTime())).toEqual([0, 5_000]);
  });

  it('defers with retryAt when Retry-After ends after the job deadline', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('error', { retryAfterMs: 30_000, detail: 'http_503' }),
    ]);
    const { router } = setup({ typesafe });
    const outcome = await drive(
      router.ask(request({ deadlineMs: NOW.getTime() + 2_000 })),
      advance,
    );
    expect(outcome).toEqual({
      ok: false,
      reason: 'error',
      detail: 'deferred:retry_after',
      retryAt: new Date(NOW.getTime() + 30_000),
    });
    expect(typesafe.calls).toHaveLength(1);
  });

  it('defers a delay longer than maxRetryWaitMs even without a deadline', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('rate_limited', { retryAfterMs: 90_000 }),
    ]);
    const { router } = setup({ typesafe, config: { maxRetryWaitMs: 10_000 } });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ reason: 'error', detail: 'deferred:retry_after' });
    expect(typesafe.calls).toHaveLength(1);
  });

  it('is cancelled while waiting for a retry, without another attempt', async () => {
    const typesafe = scriptedEngine('typesafe', [failure('error')], 'ok');
    const { router } = setup({ typesafe });
    const controller = new AbortController();
    const pending = router.ask(request(), controller.signal);
    await advance(100);
    controller.abort();
    const outcome = await drive(pending, advance);
    expect(outcome).toMatchObject({ ok: false, reason: 'error', detail: 'cancelled' });
    expect(typesafe.calls).toHaveLength(1);
  });

  it('returns a cancelled outcome for an already aborted signal', async () => {
    const { router, typesafe } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await router.ask(request(), controller.signal)).toMatchObject({
      reason: 'error',
      detail: 'cancelled',
    });
    expect(typesafe!.calls).toHaveLength(0);
  });

  it('retries invalid_response at most once', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('invalid_response'),
      failure('invalid_response'),
      'ok',
    ]);
    const { router } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(typesafe.calls).toHaveLength(2);
  });

  it('does not retry a permanent error the adapter marks non-retryable', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('error', { retryable: false, detail: 'http_404' }),
    ]);
    const { router } = setup({ typesafe });
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'error',
      detail: 'typesafe:error:http_404',
    });
    expect(typesafe.calls).toHaveLength(1);
  });

  it('treats an adapter exception as an uncertain transient failure', async () => {
    const typesafe = scriptedEngine('typesafe', [
      () => {
        throw new Error('adapter bug');
      },
      'ok',
    ]);
    const { router, store } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome.ok).toBe(true);
    expect(store.calls[0]).toMatchObject({ status: 'error', billing: 'uncertain', costUsd: 0 });
    expect(store.reservations[0]!.status).toBe('uncertain');
  });
});

describe('EngineRouter.ask: non-retryable outcomes', () => {
  it('does not retry an invalid request or route it to the fallback', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('invalid_request', { retryable: false, detail: 'http_422:invalid_request' }),
    ]);
    const { router, llm } = setup({ typesafe, config: { llmFallbackEnabled: true } });
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'invalid_request',
      detail: 'typesafe:invalid_request:http_422:invalid_request',
    });
    expect(typesafe.calls).toHaveLength(1);
    expect(llm!.calls).toHaveLength(0);
  });

  it('puts the breaker into auth mode on a 401 of the active credential', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('auth_error', { retryable: false, detail: 'http_401' }),
    ]);
    const { router, circuit } = setup({ typesafe });
    circuit.setActiveCredential('typesafe', '7');
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'error',
      detail: 'typesafe:auth_error:http_401',
    });
    expect(typesafe.calls).toHaveLength(1);
    expect((await circuit.readCircuit()).typesafe.state).toBe('auth');

    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'circuit_open',
      detail: 'typesafe:auth',
    });
    expect(typesafe.calls).toHaveLength(1);
  });

  it('ignores a late 401 of a superseded credential version', async () => {
    const typesafe = scriptedEngine('typesafe', [failure('auth_error', { retryable: false })]);
    const { router, circuit } = setup({ typesafe });
    circuit.setActiveCredential('typesafe', '8');
    await router.ask(request());
    expect((await circuit.readCircuit()).typesafe.state).toBe('closed');
  });

  it('returns no_key without spend when Jev has no credential and no fallback is eligible', async () => {
    const { router, store } = setup({ typesafe: null, credentials: fakeCredentials({}) });
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'no_key',
      detail: 'typesafe:none',
    });
    expect(store.reservations).toHaveLength(0);
  });
});

describe('EngineRouter.ask: spend guard (spec 04 §6)', () => {
  it('defers budget-blocked work to the next UTC day', async () => {
    const { router, store, typesafe } = setup();
    store.settings.set('engine.daily_budget_usd', 0);
    expect(await router.ask(request({ priority: 'bulk' }))).toEqual({
      ok: false,
      reason: 'budget',
      detail: 'daily_budget',
      retryAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    expect(typesafe!.calls).toHaveLength(0);
  });

  it('lets only one of two routers reserve the last budget while both are in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = async (req: EngineRequest) => {
      await gate;
      return success('typesafe', req);
    };
    // Room for exactly one attempt: the reservation, not the settled spend, holds it.
    const config = { dailyBudgetUsd: jevEstimate() };
    const a = setup({ config, typesafe: scriptedEngine('typesafe', [], held) });
    const b = setup({
      config,
      store: a.store,
      circuit: a.circuit,
      typesafe: scriptedEngine('typesafe', [], held),
    });
    const first = a.router.ask(request());
    const second = b.router.ask(request());
    expect(await Promise.race([first, second])).toMatchObject({ ok: false, reason: 'budget' });
    release();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(a.typesafe!.calls.length + b.typesafe!.calls.length).toBe(1);
  });

  it('lets interactive requests use the 10 % allowance that bulk requests may not', async () => {
    const { router, store, typesafe } = setup();
    const estimate = jevEstimate();
    store.reservations.push({
      id: 'prior',
      day: '2026-09-26',
      engine: 'typesafe',
      kind: 'match',
      userId: undefined,
      priority: 'bulk',
      reservedUsd: 1,
      callCap: undefined,
      status: 'settled',
      actualUsd: 1 - estimate / 2,
    });
    store.settings.set('engine.daily_budget_usd', 1);
    expect(await router.ask(request({ priority: 'bulk' }))).toMatchObject({ reason: 'budget' });
    expect(await router.ask(request({ priority: 'interactive' }))).toMatchObject({ ok: true });
    expect(typesafe!.calls).toHaveLength(1);
  });

  it('keeps unknown billing charged as uncertain', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('timeout', { billing: 'uncertain' }),
      'ok',
    ]);
    const { router, store } = setup({ typesafe });
    await drive(router.ask(request()), advance);
    expect(store.calls[0]).toMatchObject({ status: 'timeout', billing: 'uncertain', costUsd: 0 });
    expect(store.reservations[0]!.status).toBe('uncertain');
    const snapshot = await store.getBudgetSnapshot('2026-09-26', { excludeKinds: ['eval'] });
    expect(snapshot.uncertainUsd).toBeCloseTo(jevEstimate(), 12);
  });

  it('charges a failed attempt its reported usage', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('invalid_response', { usage: { inputTokens: 50, outputTokens: 5 } }),
      'ok',
    ]);
    const { router, store } = setup({ typesafe });
    await drive(router.ask(request()), advance);
    expect(store.calls[0]!.costUsd).toBeCloseTo(typesafeCostUsd(50, 0.042), 12);
    expect(store.calls[0]!.inputTokens).toBe(50);
  });

  it('stops retrying and alerts when an attempt cost more than its reservation', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('invalid_response', { usage: { inputTokens: 5_000_000, outputTokens: 0 } }),
      'ok',
    ]);
    const { router, logger } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(typesafe.calls).toHaveLength(1);
    expect(logger.entries.map((e) => e.msg)).toContain(
      'engine attempt cost exceeded its reservation',
    );
  });

  it('retries a failed settlement and records the attempt once', async () => {
    const { router, store } = setup();
    store.failSettlements(2);
    expect((await router.ask(request())).ok).toBe(true);
    expect(store.settleAttempts).toBe(3);
    expect(store.calls).toHaveLength(1);
    expect(store.reservations[0]!.status).toBe('settled');
  });

  it('keeps the reservation charged when settlement keeps failing, and still answers', async () => {
    const { router, store, logger } = setup();
    store.failSettlements(10);
    expect((await router.ask(request())).ok).toBe(true);
    expect(store.calls).toHaveLength(0);
    expect(store.reservations[0]!.status).toBe('reserved');
    const entry = logger.entries.find((e) => e.level === 'error');
    expect(entry?.msg).toBe('engine attempt settlement failed; its reservation stays charged');
    expect(JSON.stringify(entry?.obj)).not.toContain('connection lost');
  });
});

describe('EngineRouter.ask: LLM fallback (spec 04 §5 step 4)', () => {
  const noJev = () => fakeCredentials({ ollama: OLLAMA_KEY });

  it('answers with the LLM when Jev has no active credential', async () => {
    const { router, store, llm } = setup({
      typesafe: null,
      credentials: noJev(),
      config: { llmFallbackEnabled: true },
    });
    const outcome = await router.ask(request({ userId: USER_ID }));
    expect(outcome).toMatchObject({ ok: true, engine: 'llm', model: LLM_MODEL });
    expect(llm!.calls[0]!.auth).toEqual(OLLAMA_KEY);
    expect(store.reservations).toEqual([
      expect.objectContaining({ engine: 'llm', kind: 'enrich', callCap: 200, userId: USER_ID }),
    ]);
    // A separate reservation at LLM prices, including the full output cap.
    expect(store.reservations[0]!.reservedUsd).toBeCloseTo(llmEstimate(), 12);
    expect(store.calls[0]).toMatchObject({ engine: 'llm', attempts: 1, status: 'ok' });
  });

  it('is not used for bulk requests', async () => {
    const { router, llm } = setup({
      typesafe: null,
      credentials: noJev(),
      config: { llmFallbackEnabled: true },
    });
    expect(await router.ask(request({ priority: 'bulk' }))).toMatchObject({ reason: 'no_key' });
    expect(llm!.calls).toHaveLength(0);
  });

  it('is not used unless LLM_FALLBACK_ENABLED', async () => {
    const { router, llm } = setup({ typesafe: null, credentials: noJev() });
    expect(await router.ask(request())).toMatchObject({ reason: 'no_key' });
    expect(llm!.calls).toHaveLength(0);
  });

  it('is not used once the LLM daily call cap is reached', async () => {
    const { router, store, llm } = setup({
      typesafe: null,
      credentials: noJev(),
      config: { llmFallbackEnabled: true },
    });
    store.settings.set('engine.llm_daily_cap', 1);
    expect((await router.ask(request())).ok).toBe(true);
    expect(await router.ask(request())).toEqual({
      ok: false,
      reason: 'no_key',
      detail: 'typesafe:none',
    });
    expect(llm!.calls).toHaveLength(1);
  });

  it('is not used while its own breaker is open', async () => {
    const { router, circuit, llm } = setup({
      typesafe: null,
      credentials: noJev(),
      config: { llmFallbackEnabled: true },
    });
    circuit.write({
      ...defaultCircuit(),
      llm: {
        state: 'open',
        openedAt: NOW.toISOString(),
        openUntil: new Date(NOW.getTime() + 120_000).toISOString(),
        reopenCount: 0,
      },
    });
    expect(await router.ask(request())).toMatchObject({ reason: 'no_key' });
    expect(llm!.calls).toHaveLength(0);
  });

  it('is not used without an Ollama credential when the real adapter would be needed', async () => {
    const { router } = setup({
      typesafe: null,
      llm: null,
      credentials: fakeCredentials({}),
      config: { llmFallbackEnabled: true },
    });
    expect(await router.ask(request())).toMatchObject({ reason: 'no_key' });
  });

  it('takes over after Jev exhausts its retries, under the same logical id', async () => {
    const typesafe = scriptedEngine('typesafe', [], failure('error'));
    const { router, store } = setup({ typesafe, config: { llmFallbackEnabled: true } });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: true, engine: 'llm' });
    expect(store.calls.map((c) => c.engine)).toEqual([
      'typesafe',
      'typesafe',
      'typesafe',
      'typesafe',
      'llm',
    ]);
    expect(new Set(store.calls.map((c) => c.logicalRequestId)).size).toBe(1);
  });

  it('takes over while the Jev breaker is open', async () => {
    const { router, circuit, typesafe } = setup({ config: { llmFallbackEnabled: true } });
    circuit.write({
      ...defaultCircuit(),
      typesafe: {
        state: 'open',
        openedAt: NOW.toISOString(),
        openUntil: new Date(NOW.getTime() + 120_000).toISOString(),
        reopenCount: 0,
      },
    });
    expect(await router.ask(request())).toMatchObject({ ok: true, engine: 'llm' });
    expect(typesafe!.calls).toHaveLength(0);
  });

  it('never lets a cheap Jev reservation authorize the expensive LLM call', async () => {
    const typesafe = scriptedEngine('typesafe', [], failure('error'));
    const { router, store, llm } = setup({ typesafe, config: { llmFallbackEnabled: true } });
    // Room for the Jev reserve (with the interactive allowance) but not for the LLM's.
    store.settings.set('engine.daily_budget_usd', jevEstimate() * 2);
    expect(llmEstimate()).toBeGreaterThan(jevEstimate() * 2.2);
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: false, reason: 'error' });
    expect(typesafe.calls).toHaveLength(4);
    expect(llm!.calls).toHaveLength(0);
    expect(store.reservations.every((r) => r.engine === 'typesafe')).toBe(true);
  });

  it('splits a pack for the output cap and numbers attempts across subpacks', async () => {
    const cap = estimateLlmOutputTokens({ q1: QUESTIONS.q1!, q2: QUESTIONS.q2! });
    const packs = splitQuestionsForLlm(QUESTIONS, cap)!;
    expect(packs.map((p) => Object.keys(p))).toEqual([['q1', 'q2'], ['q3']]);
    const llm = scriptedEngine('llm', [failure('error'), 'ok', 'ok']);
    const { router, store } = setup({
      typesafe: null,
      llm,
      credentials: noJev(),
      config: { llmFallbackEnabled: true, ollama: { ...baseOllama(), maxOutputTokens: cap } },
    });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome).toMatchObject({ ok: true, engine: 'llm' });
    if (outcome.ok) expect(Object.keys(outcome.answers).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(llm.calls.map((c) => Object.keys(c.req.questions))).toEqual([
      ['q1', 'q2'],
      ['q1', 'q2'],
      ['q3'],
    ]);
    // The same immutable state in every subrequest.
    expect(new Set(llm.calls.map((c) => c.req.state)).size).toBe(1);
    expect(store.calls.map((c) => c.attempts)).toEqual([1, 2, 3]);
    expect(store.calls.map((c) => c.nQuestions)).toEqual([2, 2, 1]);
    expect(store.reservations[2]!.reservedUsd).toBeCloseTo(
      llmEstimate(request({ questions: { q3: QUESTIONS.q3! } }), cap),
      12,
    );
  });

  it('sends no further subpack once a successful one cost more than its reservation', async () => {
    const cap = estimateLlmOutputTokens({ q1: QUESTIONS.q1!, q2: QUESTIONS.q2! });
    const firstReserve = llmEstimate(
      request({ questions: { q1: QUESTIONS.q1!, q2: QUESTIONS.q2! } }),
      cap,
    );
    const llm = scriptedEngine('llm', [
      (req) => ({ ...success('llm', req), costUsd: firstReserve * 2 }),
    ]);
    const { router, store, logger } = setup({
      typesafe: null,
      llm,
      credentials: noJev(),
      config: { llmFallbackEnabled: true, ollama: { ...baseOllama(), maxOutputTokens: cap } },
    });
    const outcome = await drive(router.ask(request()), advance);
    // The fallback stopped, so the primary's reason stands; the overrun is still charged.
    expect(outcome).toMatchObject({ ok: false, reason: 'no_key' });
    expect(llm.calls.map((c) => Object.keys(c.req.questions))).toEqual([['q1', 'q2']]);
    expect(store.calls.map((c) => c.status)).toEqual(['ok']);
    expect(store.calls[0]!.costUsd).toBeCloseTo(firstReserve * 2, 12);
    expect(logger.entries.map((e) => e.msg)).toContain(
      'engine attempt cost exceeded its reservation',
    );
  });

  it('is ok only when every original key has an answer', async () => {
    const cap = estimateLlmOutputTokens({ q1: QUESTIONS.q1!, q2: QUESTIONS.q2! });
    const llm = scriptedEngine('llm', ['ok', failure('invalid_request', { retryable: false })]);
    const { router } = setup({
      typesafe: null,
      llm,
      credentials: noJev(),
      config: { llmFallbackEnabled: true, ollama: { ...baseOllama(), maxOutputTokens: cap } },
    });
    expect(await router.ask(request())).toMatchObject({ ok: false, reason: 'no_key' });
    expect(llm.calls).toHaveLength(2);
  });

  it('skips the fallback when a single question exceeds the output cap', async () => {
    const { router, llm, logger } = setup({
      typesafe: null,
      credentials: noJev(),
      config: { llmFallbackEnabled: true, ollama: { ...baseOllama(), maxOutputTokens: 5 } },
    });
    expect(await router.ask(request())).toMatchObject({ reason: 'no_key' });
    expect(llm!.calls).toHaveLength(0);
    expect(logger.entries.some((e) => e.msg.includes('exceeds its output cap'))).toBe(true);
  });

  it('does not rebill an LLM answer as a Jev budget refusal', async () => {
    const { router, store, llm } = setup({ config: { llmFallbackEnabled: true } });
    store.settings.set('engine.daily_budget_usd', 0);
    expect(await router.ask(request())).toMatchObject({ reason: 'budget' });
    expect(llm!.calls).toHaveLength(0);
  });
});

describe('EngineRouter: circuit breaker integration (spec 04 §5)', () => {
  /** 15 successes, then failures: the 20th logical request (5 failures, 25 %) opens it. */
  async function tripJev(setupResult: ReturnType<typeof setup>) {
    const { router, typesafe } = setupResult;
    typesafe!.script.push(
      ...Array.from({ length: 15 }, () => 'ok' as const),
      ...Array.from({ length: 5 }, () => failure('error', { retryable: false })),
    );
    for (let i = 0; i < 20; i += 1) await router.ask(request());
  }

  it('opens after 20 logical requests with more than 20 % failures', async () => {
    const env = setup();
    await tripJev(env);
    const circuit = await env.circuit.readCircuit();
    expect(circuit.typesafe).toMatchObject({
      state: 'open',
      openUntil: new Date(NOW.getTime() + 120_000).toISOString(),
    });
    expect(await env.router.ask(request())).toEqual({
      ok: false,
      reason: 'circuit_open',
      detail: 'typesafe:open',
      retryAt: new Date(NOW.getTime() + 120_000),
    });
    expect(env.typesafe!.calls).toHaveLength(20);
  });

  it('probes after the open duration and closes on success', async () => {
    const env = setup();
    await tripJev(env);
    await advance(120_000);
    expect(await env.router.ask(request())).toMatchObject({ ok: true });
    expect((await env.circuit.readCircuit()).typesafe).toEqual({
      state: 'closed',
      reopenCount: 0,
    });
  });

  it('re-opens for twice as long after a failed probe', async () => {
    const env = setup();
    await tripJev(env);
    await advance(120_000);
    env.typesafe!.script.push(failure('error', { retryable: false }));
    await env.router.ask(request());
    expect((await env.circuit.readCircuit()).typesafe).toMatchObject({
      state: 'open',
      reopenCount: 1,
      openUntil: new Date(Date.now() + 240_000).toISOString(),
    });
  });

  it('keeps its half-open probe lease through retries that outlast one lease', async () => {
    const a = setup();
    await tripJev(a);
    await advance(120_000);
    const b = setup({ circuit: a.circuit });
    // Three slow 503s with a 60 s Retry-After, then an answer: about 4.5 minutes in all.
    const slow = () => async () => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return failure('error', { retryAfterMs: 60_000 });
    };
    a.typesafe!.script.push(slow(), slow(), slow(), 'ok');
    const probe = a.router.ask(request());
    // Past the first lease (150 s): the holder renewed it before each attempt.
    await advance(200_000);
    expect(await b.router.ask(request())).toMatchObject({ ok: false, reason: 'circuit_open' });
    expect(b.typesafe!.calls).toHaveLength(0);
    await advance(100_000);
    expect(await probe).toMatchObject({ ok: true });
    expect(a.typesafe!.calls).toHaveLength(24);
    expect((await a.circuit.readCircuit()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
  });

  it('sends nothing more once another router reclaimed its expired probe lease', async () => {
    const a = setup();
    await tripJev(a);
    await advance(120_000);
    const b = setup({ circuit: a.circuit });
    // A 100 s attempt and a 60 s Retry-After: the next renewal comes after the 150 s lease.
    a.typesafe!.script.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100_000));
      return failure('error', { retryAfterMs: 60_000 });
    });
    b.typesafe!.script.push(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return success('typesafe', req);
    });
    const stale = a.router.ask(request());
    await advance(155_000);
    const reclaimed = b.router.ask(request());
    await advance(31_000);
    expect(await stale).toMatchObject({
      ok: false,
      reason: 'circuit_open',
      detail: 'typesafe:open',
    });
    expect(a.typesafe!.calls).toHaveLength(21);
    expect(await reclaimed).toMatchObject({ ok: true });
    expect((await a.circuit.readCircuit()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
  });

  it('shares the state between two routers within one poll interval', async () => {
    const a = setup();
    const b = setup({ circuit: a.circuit });
    expect((await b.router.ask(request())).ok).toBe(true);
    await tripJev(a);
    // b's cached state is at most one poll (10 s) old.
    expect((await b.router.ask(request())).ok).toBe(true);
    await advance(10_000);
    expect(await b.router.ask(request())).toMatchObject({ reason: 'circuit_open' });
    expect(b.typesafe!.calls).toHaveLength(2);
  });

  it('closes an auth-mode breaker within one poll of a reset request', async () => {
    const typesafe = scriptedEngine('typesafe', [failure('auth_error', { retryable: false })]);
    const a = setup({ typesafe });
    a.circuit.setActiveCredential('typesafe', '7');
    await a.router.ask(request());
    const b = setup({ circuit: a.circuit });
    expect(await b.router.ask(request())).toMatchObject({ reason: 'circuit_open' });
    await advance(1_000);
    a.circuit.write({
      ...(await a.circuit.readCircuit()),
      resetRequested: { typesafe: new Date().toISOString() },
    });
    await advance(10_000);
    expect(await b.router.ask(request())).toMatchObject({ ok: true });
    expect((await a.circuit.readCircuit()).typesafe.state).toBe('closed');
  });

  it('does not count budget refusals, cancellations or invalid requests as failures', async () => {
    const env = setup();
    env.typesafe!.script.push(
      ...Array.from({ length: 30 }, () => failure('invalid_request', { retryable: false })),
    );
    for (let i = 0; i < 30; i += 1) await env.router.ask(request());
    expect((await env.circuit.readCircuit()).typesafe.state).toBe('closed');
  });
});

describe('EngineRouter: concurrency and rate limits (spec 04 §3, §4)', () => {
  it('holds no semaphore slot during backoff', async () => {
    const slow = () =>
      new Promise<ReturnType<typeof failure>>((resolve) =>
        setTimeout(() => resolve(failure('error')), 100),
      );
    const typesafe = scriptedEngine('typesafe', [slow, 'ok', 'ok']);
    const { router } = setup({ typesafe, config: { concurrency: 1 } });
    const a = router.ask(request());
    const b = router.ask(request());
    await drive(Promise.all([a, b]), advance, 10);
    // a's first attempt (0–100 ms) holds the only slot; b runs at 100 ms while a backs off.
    expect(typesafe.calls.map((c) => c.at - NOW.getTime())).toEqual([0, 100, 600]);
  });

  it('cancels a request waiting for a slot', async () => {
    const hold = () =>
      new Promise<ReturnType<typeof failure>>((resolve) =>
        setTimeout(() => resolve(failure('error', { retryable: false })), 1_000),
      );
    const typesafe = scriptedEngine('typesafe', [hold]);
    const { router } = setup({ typesafe, config: { concurrency: 1 } });
    const first = router.ask(request());
    const controller = new AbortController();
    const second = router.ask(request(), controller.signal);
    await advance(10);
    controller.abort();
    expect(await drive(second, advance)).toMatchObject({ detail: 'cancelled' });
    await drive(first, advance);
    expect(typesafe.calls).toHaveLength(1);
  });

  it('waits for rate-limiter capacity, or defers past the deadline', async () => {
    const { router, typesafe } = setup({
      config: {
        typesafe: {
          baseUrl: 'http://127.0.0.1:9',
          model: TYPESAFE_MODEL,
          pricePerMTokUsd: 0.042,
          requestsPerMinute: 2,
        },
      },
    });
    await router.ask(request());
    await router.ask(request());
    const deferred = await drive(
      router.ask(request({ deadlineMs: NOW.getTime() + 1_000 })),
      advance,
    );
    expect(deferred).toMatchObject({ reason: 'error', detail: 'deferred:rate_limit' });
    if (!deferred.ok) expect(deferred.retryAt!.getTime()).toBeGreaterThan(NOW.getTime() + 1_000);
    const waited = await drive(router.ask(request()), advance, 1_000);
    expect(waited.ok).toBe(true);
    expect(typesafe!.calls.at(-1)!.at - NOW.getTime()).toBeGreaterThanOrEqual(29_000);
  });

  it('lowers the rate after a 429', async () => {
    const typesafe = scriptedEngine('typesafe', [
      failure('rate_limited', { retryAfterMs: 2_000 }),
      'ok',
    ]);
    const { router } = setup({ typesafe });
    const outcome = await drive(router.ask(request()), advance);
    expect(outcome.ok).toBe(true);
    expect(typesafe.calls[1]!.at - NOW.getTime()).toBe(2_000);
  });
});

describe('EngineRouter: eval routers (spec 04 §1)', () => {
  const evalRequest = (patch: Partial<EngineRequest> = {}) =>
    request({ kind: 'enrich', authorization: EVAL_AUTH, ...patch });

  it('records every call as kind eval and ignores the production budget', async () => {
    const { router, store } = setup({ budgetOverrideUsd: 1 });
    store.settings.set('engine.daily_budget_usd', 0);
    expect((await router.ask(evalRequest())).ok).toBe(true);
    expect(store.reservations[0]).toMatchObject({ kind: 'eval' });
    expect(store.calls[0]).toMatchObject({ kind: 'eval' });
  });

  it('enforces its own per-invocation cap across concurrent attempts', async () => {
    const estimate = jevEstimate(evalRequest());
    const actual = typesafeCostUsd(100, 0.042);
    expect(estimate).toBeGreaterThan(actual);
    // Below two reserves (so two in-flight attempts never fit), at least one settled + one reserve.
    const { router, typesafe } = setup({ budgetOverrideUsd: (actual + 3 * estimate) / 2 });
    const [a, b] = await Promise.all([router.ask(evalRequest()), router.ask(evalRequest())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((o) => !o.ok)).toMatchObject({ reason: 'budget', detail: 'eval_budget' });
    expect(typesafe!.calls).toHaveLength(1);
    // The settled attempt freed its unused reserve: another attempt fits.
    expect((await router.ask(evalRequest())).ok).toBe(true);
  });

  it('keeps an uncertain attempt charged against the invocation cap', async () => {
    const estimate = jevEstimate(evalRequest());
    const typesafe = scriptedEngine('typesafe', [
      failure('timeout', { billing: 'uncertain', retryable: false }),
    ]);
    const { router } = setup({ typesafe, budgetOverrideUsd: estimate * 1.5 });
    await router.ask(evalRequest());
    expect(await router.ask(evalRequest())).toMatchObject({ reason: 'budget' });
    expect(await router.canSpend(estimate, 'interactive')).toBe(false);
  });

  it('refuses a production authorization', async () => {
    const { router } = setup({ budgetOverrideUsd: 1 });
    expect(await router.ask(request())).toMatchObject({ reason: 'invalid_request' });
  });

  it('pins the required engine without falling back', async () => {
    const typesafe = scriptedEngine('typesafe', [], failure('error', { retryable: false }));
    const { router, llm } = setup({
      typesafe,
      budgetOverrideUsd: 1,
      requiredEngine: 'typesafe',
      config: { llmFallbackEnabled: true },
    });
    expect(await router.ask(evalRequest())).toMatchObject({ ok: false, reason: 'error' });
    expect(llm!.calls).toHaveLength(0);
  });

  it('runs a pinned LLM for bulk work and can ignore the daily caps', async () => {
    const { router, store, typesafe } = setup({
      budgetOverrideUsd: 1,
      requiredEngine: 'llm',
      ignoreDailyCaps: true,
    });
    expect(await router.ask(evalRequest({ priority: 'bulk' }))).toMatchObject({
      ok: true,
      engine: 'llm',
    });
    expect(typesafe!.calls).toHaveLength(0);
    expect(store.reservations[0]).toMatchObject({
      engine: 'llm',
      kind: 'eval',
      callCap: undefined,
    });
  });

  it('runs a pinned local Laya engine as a zero-cost call', async () => {
    const laya = scriptedEngine('laya');
    const { router, store } = setup({ laya, budgetOverrideUsd: 1, requiredEngine: 'laya' });
    expect(await router.ask(evalRequest())).toMatchObject({ ok: true, engine: 'laya', costUsd: 0 });
    expect(store.reservations).toHaveLength(0);
    expect(store.calls[0]).toMatchObject({ engine: 'laya', kind: 'eval', costUsd: 0, attempts: 1 });
  });

  it('reports a pinned Laya that is not configured', async () => {
    const { router } = setup({ budgetOverrideUsd: 1, requiredEngine: 'laya' });
    expect(await router.ask(evalRequest())).toMatchObject({
      reason: 'error',
      detail: 'laya:not_configured',
    });
  });
});

describe('EngineRouter: status and advisory checks', () => {
  it('reports credentials, breakers, spend and LLM calls', async () => {
    const { router } = setup({
      typesafe: null,
      credentials: fakeCredentials({ ollama: OLLAMA_KEY }),
      config: { llmFallbackEnabled: true },
    });
    await router.ask(request());
    const status = await router.status();
    expect(status.credentials).toEqual({
      typesafe: { source: 'none', enabled: false },
      ollama: { source: 'env', enabled: true },
    });
    expect(status.breakers.typesafe.state).toBe('closed');
    expect(status.budgetUsd).toBe(2);
    expect(status.llmCallsToday).toBe(1);
    expect(status.spendTodayUsd).toBeGreaterThan(0);
  });

  it('answers canSpend from the day snapshot (advisory only)', async () => {
    const { router, store } = setup();
    expect(await router.canSpend(1, 'bulk')).toBe(true);
    expect(await router.canSpend(2.1, 'bulk')).toBe(false);
    expect(await router.canSpend(2.1, 'interactive')).toBe(true);
    expect(await router.canSpend(-1, 'bulk')).toBe(false);
    store.settings.set('engine.daily_budget_usd', 0);
    expect(await router.canSpend(0.01, 'interactive')).toBe(false);
  });
});

describe('EngineRouter: external calls (spec 07 §2)', () => {
  const auth = request().authorization;

  it('reserves a tier-2 translation with its daily cap and settles it with attribution', async () => {
    const { router, store } = setup();
    const id = await router.reserveExternalCall({
      engine: 'llm',
      kind: 'translate',
      estimateUsd: 0.001,
      priority: 'bulk',
      userId: USER_ID,
      authorization: auth,
    });
    expect(id).not.toBeNull();
    expect(store.reservations[0]).toMatchObject({ engine: 'llm', kind: 'translate', callCap: 300 });
    await router.recordExternalCall(
      {
        engine: 'llm',
        kind: 'translate',
        model: LLM_MODEL,
        articleId: '11',
        inputTokens: 120,
        outputTokens: 80,
        costUsd: 0.0002,
        latencyMs: 1_500,
        status: 'ok',
        billing: 'known',
        logicalRequestId: '0199a000-0000-7000-8000-00000000abcd',
        attempt: 1,
      },
      id!,
    );
    expect(store.calls[0]).toMatchObject({
      engine: 'llm',
      kind: 'translate',
      userId: USER_ID,
      attempts: 1,
      nQuestions: 0,
      reservationId: id,
    });
    expect(store.calls[0]!.createdAt.getTime()).toBe(NOW.getTime() - 1_500);
    expect(store.reservations[0]).toMatchObject({ status: 'settled', actualUsd: 0.0002 });
    expect([...store.usage.values()][0]).toMatchObject({ userId: USER_ID, calls: 1 });
  });

  it('reports and alerts a known cost above the reserve, so the caller stops (spec 04 §6)', async () => {
    const { router, store, logger } = setup();
    const reserve = () =>
      router.reserveExternalCall({
        engine: 'llm',
        kind: 'translate',
        estimateUsd: 0.001,
        priority: 'bulk',
        authorization: auth,
      });
    const call = (costUsd: number, billing: 'known' | 'uncertain', attempt: number) => ({
      engine: 'llm' as const,
      kind: 'translate' as const,
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd,
      latencyMs: 10,
      status: 'invalid_response' as const,
      billing,
      logicalRequestId: '0199a000-0000-7000-8000-00000000abd1',
      attempt,
    });
    expect(await router.recordExternalCall(call(0.001, 'known', 1), (await reserve())!)).toEqual({
      overrun: false,
    });
    // Uncertain usage is never fabricated into an overrun.
    expect(await router.recordExternalCall(call(0.5, 'uncertain', 2), (await reserve())!)).toEqual({
      overrun: false,
    });
    expect(logger.entries.map((e) => e.msg)).not.toContain(
      'engine attempt cost exceeded its reservation',
    );
    const id = (await reserve())!;
    expect(await router.recordExternalCall(call(0.002, 'known', 3), id)).toEqual({ overrun: true });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'engine attempt cost exceeded its reservation',
      }),
    );
    // The overrun is still charged in full.
    expect(store.reservations.find((r) => r.id === id)).toMatchObject({
      status: 'settled',
      actualUsd: 0.002,
    });
  });

  it('retries the settlement of an external call and never discards its result', async () => {
    const { router, store, logger } = setup();
    const reserve = () =>
      router.reserveExternalCall({
        engine: 'llm',
        kind: 'translate',
        estimateUsd: 0.001,
        priority: 'bulk',
        authorization: auth,
      });
    const call = (costUsd: number, attempt: number) => ({
      engine: 'llm' as const,
      kind: 'translate' as const,
      inputTokens: 1_000,
      outputTokens: 100,
      costUsd,
      latencyMs: 10,
      status: 'ok' as const,
      billing: 'known' as const,
      logicalRequestId: '0199a000-0000-7000-8000-00000000abd2',
      attempt,
    });
    const first = (await reserve())!;
    store.failSettlements(2);
    expect(await router.recordExternalCall(call(0.0005, 1), first)).toEqual({ overrun: false });
    expect(store.settleAttempts).toBe(3);
    expect(store.calls).toHaveLength(1);
    expect(store.reservations.find((r) => r.id === first)).toMatchObject({ status: 'settled' });

    // A settlement that keeps failing leaves the reservation charged; the overrun still stops.
    const second = (await reserve())!;
    store.failSettlements(3);
    expect(await router.recordExternalCall(call(0.002, 2), second)).toEqual({ overrun: true });
    expect(store.settleAttempts).toBe(6);
    expect(store.calls).toHaveLength(1);
    expect(store.reservations.find((r) => r.id === second)).toMatchObject({ status: 'reserved' });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'engine attempt settlement failed; its reservation stays charged',
      }),
    );
  });

  it('refuses a tier-2 reservation once the cap is reached', async () => {
    const { router, store } = setup();
    store.settings.set('translate.tier2_daily_cap', 0);
    expect(
      await router.reserveExternalCall({
        engine: 'llm',
        kind: 'translate',
        estimateUsd: 0.001,
        priority: 'bulk',
        authorization: auth,
      }),
    ).toBeNull();
  });

  it('records a free LibreTranslate call without a reservation', async () => {
    const { router, store } = setup();
    await router.recordExternalCall({
      engine: 'libretranslate',
      kind: 'translate',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 300,
      status: 'ok',
      billing: 'known',
      logicalRequestId: '0199a000-0000-7000-8000-00000000abce',
      attempt: 1,
    });
    expect(store.calls[0]).toMatchObject({ engine: 'libretranslate', costUsd: 0 });
    expect(store.reservations).toHaveLength(0);
  });

  it('refuses to record a paid call without its reservation', async () => {
    const { router } = setup();
    await expect(
      router.recordExternalCall({
        engine: 'llm',
        kind: 'translate',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
        latencyMs: 1,
        status: 'ok',
        billing: 'known',
        logicalRequestId: '0199a000-0000-7000-8000-00000000abcf',
        attempt: 1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('never admits eval spend on a production router', async () => {
    const { router } = setup();
    expect(
      await router.reserveExternalCall({
        engine: 'llm',
        kind: 'eval',
        estimateUsd: 0.001,
        priority: 'bulk',
        authorization: EVAL_AUTH,
      }),
    ).toBeNull();
  });

  it('charges external calls of an eval router to its invocation cap as kind eval', async () => {
    const { router, store } = setup({ budgetOverrideUsd: 0.0015, ignoreDailyCaps: true });
    const input = {
      engine: 'llm',
      kind: 'translate',
      estimateUsd: 0.001,
      priority: 'bulk',
      authorization: EVAL_AUTH,
    } as const;
    const first = await router.reserveExternalCall(input);
    expect(store.reservations[0]).toMatchObject({ kind: 'eval', callCap: undefined });
    expect(await router.reserveExternalCall(input)).toBeNull();
    await router.recordExternalCall(
      {
        engine: 'llm',
        kind: 'translate',
        inputTokens: 10,
        outputTokens: 10,
        costUsd: 0.0001,
        latencyMs: 10,
        status: 'ok',
        billing: 'known',
        logicalRequestId: '0199a000-0000-7000-8000-00000000abd0',
        attempt: 1,
      },
      first!,
    );
    expect(store.calls[0]).toMatchObject({ kind: 'eval' });
    expect(await router.reserveExternalCall(input)).not.toBeNull();
  });

  it('rejects a negative estimate', async () => {
    const { router } = setup();
    await expect(
      router.reserveExternalCall({
        engine: 'llm',
        kind: 'translate',
        estimateUsd: -1,
        priority: 'bulk',
        authorization: auth,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('EngineRouter: the real TypeSafe adapter configuration (spec 04 §2, §3)', () => {
  beforeEach(() => {
    // Real HTTP to the loopback fake server: real timers for this block.
    vi.useRealTimers();
  });

  const fakeConfig = (fakeUrl: string, patch: Record<string, unknown> = {}) => ({
    typesafe: {
      baseUrl: fakeUrl,
      model: 'jev-fake',
      pricePerMTokUsd: 0.042,
      allowFakeModel: true,
      ...patch,
    },
  });

  it('talks to the fake TypeSafe server when allowFakeModel is configured', async () => {
    const fake = await startFakeTypeSafe({ apiKey: JEV_KEY.apiKey });
    try {
      const { router, store } = setup({ typesafe: null, config: fakeConfig(fake.url) });
      const outcome = await router.ask(request());
      expect(outcome).toMatchObject({ ok: true, engine: 'typesafe', model: 'jev-fake' });
      expect(Object.keys(outcome.ok ? outcome.answers : {}).sort()).toEqual(['q1', 'q2', 'q3']);
      expect(fake.requestCount()).toBe(1);
      expect(store.calls).toMatchObject([{ status: 'ok', model: 'jev-fake', attempts: 1 }]);
      // Without the flag the adapter refuses the fake model, so the engine is unavailable.
      const refused = setup({
        typesafe: null,
        config: fakeConfig(fake.url, { allowFakeModel: false }),
      });
      expect(await refused.router.ask(request())).toMatchObject({
        ok: false,
        reason: 'no_key',
        detail: 'typesafe:not_configured',
      });
      expect(fake.requestCount()).toBe(1);
      expect(refused.logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'engine adapter is not configured; the engine is unavailable',
        }),
      );
    } finally {
      await fake.close();
    }
  });

  it('reads the credential again before refusing Jev on cached metadata without a key', async () => {
    const fake = await startFakeTypeSafe({ apiKey: JEV_KEY.apiKey });
    try {
      const credentials = fakeCredentials({ typesafe: JEV_KEY });
      // Activated a moment ago: the metadata cache still shows no key (spec 04 §1.2 step 5).
      credentials.cached.typesafe = { source: 'none', enabled: false };
      const { router } = setup({ typesafe: null, credentials, config: fakeConfig(fake.url) });
      expect(await router.ask(request())).toMatchObject({ ok: true, engine: 'typesafe' });
      expect(fake.requestCount()).toBe(1);
      // Still without a key at the fresh read: refused as before, without a request.
      delete credentials.keys.typesafe;
      expect(await router.ask(request())).toEqual({
        ok: false,
        reason: 'no_key',
        detail: 'typesafe:none',
      });
      expect(fake.requestCount()).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it('refuses to start with allowFakeModel in production', () => {
    expect(() =>
      setup({
        typesafe: null,
        config: { ...fakeConfig('https://api.typesafe.example'), production: true },
      }),
    ).toThrow(TypeError);
  });

  it('checks the configured request limits before any spend', async () => {
    const { router, store, typesafe } = setup({
      config: {
        typesafe: {
          baseUrl: 'http://127.0.0.1:9',
          model: TYPESAFE_MODEL,
          pricePerMTokUsd: 0.042,
          limits: { maxRequestBytes: 64 },
        },
      },
    });
    const outcome = await router.ask(request());
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(typesafe!.calls).toHaveLength(0);
    expect(store.reservations).toHaveLength(0);
    // The adapter gets the same limits: a real adapter refuses before its wire attempt.
    const fake = await startFakeTypeSafe({ apiKey: JEV_KEY.apiKey });
    try {
      const real = setup({
        typesafe: null,
        config: fakeConfig(fake.url, { limits: { maxQuestions: 2 } }),
      });
      expect(await real.router.ask(request())).toMatchObject({
        ok: false,
        reason: 'invalid_request',
      });
      expect(fake.requestCount()).toBe(0);
    } finally {
      await fake.close();
    }
  });
});

function baseOllama() {
  return {
    baseUrl: 'http://127.0.0.1:9',
    modelFast: LLM_MODEL,
    modelStrong: 'glm-5.3',
    maxConcurrency: 1,
  };
}
