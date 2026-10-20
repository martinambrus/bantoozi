import { createDatabase } from '@bantoozi/db';
import {
  JEV_FAKE_MODEL,
  type EngineOutcome,
  type EngineRequest,
  type EngineRouter,
  type Question,
} from '@bantoozi/engine';
import type { EngineCircuit, InferenceAuthorization } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
  createSubscription,
  createUser,
  startFakeTypeSafe,
  type FakeTypeSafeServer,
} from '@bantoozi/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from '../src/engine-router.js';
import {
  ADMIN,
  AlertsWorld,
  DAY,
  HOUR,
  MINUTE,
  RecordingMailer,
  hostHealth,
  opsEvent,
} from './support/alerts-world.js';
import { ClassifyHarness } from './support/classify.js';

const API_KEY = 'outage-alerts-bootstrap-key';
const STEP_MS = 50;
const PINNED_MODEL = 'jev-1.13.0';
const FAILING_TITLE = 'Classification engine failing';
const MISMATCH_TITLE = 'Jev answered with another model';

const realSetTimeout = globalThis.setTimeout;
const realPause = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 12));

const QUESTIONS: Record<string, Question> = {
  energy: { type: 'noul', instructions: { interest: 'Solar and wind energy' } },
  topic: {
    type: 'choice',
    instructions: 'Main topic',
    criteria: { energy: 'Energy and power grids', sport: 'Sport' },
  },
};

let h: ClassifyHarness;
let w: AlertsWorld;
let fake: FakeTypeSafeServer;
let authorization: InferenceAuthorization;
let articleId: string;
let articleRevision: string;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new AlertsWorld(h);
  fake = await startFakeTypeSafe({ apiKey: API_KEY });
}, 240_000);

afterAll(async () => {
  vi.useRealTimers();
  await fake?.close();
  await h?.close();
});

afterEach(() => {
  vi.useRealTimers();
});

async function freshWorld(): Promise<void> {
  await w.baseline(NOW);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query(
    `DELETE FROM settings WHERE key IN ('engine.typesafe_model', 'engine.model_pin')`,
  );
  const feed = await createFeed(h.owner);
  const user = await createUser(h.owner);
  await createSubscription(h.owner, {
    userId: user.id,
    feedId: feed.id,
    mode: 'active',
    activatedAt: new Date(Date.now() - 3_600_000),
  });
  const article = await createArticle(h.owner, { feedIds: [feed.id] });
  articleId = article.id;
  articleRevision = article.contentRevision;
  authorization = {
    type: 'article',
    articleId,
    articleRevision,
    witnesses: [{ kind: 'automatic', userId: user.id, feedId: feed.id, inferenceVersion: '1' }],
  };
}

function routerFor(typesafeModel: string): EngineRouter {
  const db = createDatabase(h.worker);
  const noop = () => undefined;
  const logger = { info: noop, warn: noop, error: noop };
  const config: WorkerEngineConfig = {
    nodeEnv: 'test',
    typesafeBaseUrl: fake.url,
    typesafeModel,
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 8,
    dailyBudgetUsd: 100,
    ollamaBaseUrl: 'http://127.0.0.1:9',
    ollamaModelFast: 'glm-5.3-flash',
    ollamaModelStrong: 'glm-5.3',
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
  };
  return createWorkerEngineRouter({
    db,
    config,
    credentials: createWorkerCredentialResolver({
      db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { typesafe: API_KEY },
      logger,
    }),
    logger,
    random: () => 0.5,
  });
}

function call(i: number): EngineRequest {
  return {
    kind: 'enrich',
    state: {
      article: {
        title: `Grid storage outage report number ${i}`,
        excerpt: `Batteries and solar farms, synthetic item ${i}.`,
      },
    },
    questions: QUESTIONS,
    questionSetSha: 'a'.repeat(64),
    stateSha256: i.toString(16).padStart(64, '0'),
    articleId,
    articleRevision,
    priority: 'bulk',
    authorization,
  };
}

async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 20_000 && !settled; i += 1) {
    await realPause(1);
    if (!settled) await vi.advanceTimersByTimeAsync(STEP_MS);
  }
  return promise;
}

async function typesafeState(): Promise<EngineCircuit['typesafe']> {
  const { rows } = await h.owner.query<{ value: EngineCircuit }>(
    `SELECT value FROM settings WHERE key = 'engine.circuit'`,
  );
  return rows[0]?.value.typesafe ?? { state: 'closed', reopenCount: 0 };
}

async function evaluate(mailer: RecordingMailer): Promise<Date> {
  const now = new Date();
  await w.liveness(now);
  await w.events([
    opsEvent('backup_ok', new Date(now.getTime() - HOUR)),
    hostHealth(new Date(now.getTime() - MINUTE)),
  ]);
  await w.run(now, { mailer });
  return now;
}

async function activeKeys(): Promise<string[]> {
  return Object.entries(await w.state())
    .filter(([, entry]) => entry.active)
    .map(([key]) => key)
    .sort();
}

const mailsTitled = (mailer: RecordingMailer, title: string, recovered: boolean) =>
  mailer.sent.filter(
    (message) =>
      message.subject.includes('RECOVERED') === recovered && message.text.includes(title),
  );

const fakeNow = () => new Date(Date.now());

describe('2026-10-17 outage on the fake TypeSafe server (alerts)', () => {
  it('alerts once on the mismatch, once on the long failing streak, and recovers once each', async () => {
    await freshWorld();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
    const T0 = fakeNow();
    const mailer = new RecordingMailer();
    let router = routerFor(PINNED_MODEL);

    for (let i = 0; i < 24; i += 1) {
      const outcome: EngineOutcome = await drive(router.ask(call(i)));
      expect(outcome.ok).toBe(false);
    }
    const tripped = await typesafeState();
    expect(tripped.state).toBe('open');
    expect.soft(tripped.failingSince, 'failingSince of the first trip').toBe(tripped.openedAt);
    const firstOpenedAt = tripped.openedAt!;
    const { rows: mismatchRows } = await h.owner.query<{ model: string; error: string }>(
      `SELECT DISTINCT model, error FROM engine_calls
        WHERE engine = 'typesafe' AND status = 'invalid_response'`,
    );
    expect(mismatchRows).toEqual([
      { model: PINNED_MODEL, error: `model_mismatch:${JEV_FAKE_MODEL}` },
    ]);

    await vi.advanceTimersByTimeAsync(MINUTE);
    await evaluate(mailer);
    expect(mailer.to(ADMIN)).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain(MISMATCH_TITLE);
    expect(mailer.sent[0]!.text).toContain(PINNED_MODEL);
    expect(mailer.sent[0]!.text).toContain(JEV_FAKE_MODEL);
    expect(await activeKeys()).toEqual(['engine.model_mismatch']);

    let nextEval = T0.getTime() + 5 * MINUTE;
    const advanceTo = async (at: number) => {
      if (at > Date.now()) await vi.advanceTimersByTimeAsync(at - Date.now());
    };
    const mismatchInWindow = async (now: Date): Promise<boolean> => {
      const { rows } = await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM engine_calls
          WHERE engine = 'typesafe' AND status = 'invalid_response'
            AND error LIKE 'model_mismatch:%' AND created_at > $1 AND created_at <= $2`,
        [new Date(now.getTime() - 45 * MINUTE), now],
      );
      return rows[0]!.n > 0;
    };

    let probes = 0;
    let fixed = false;
    let breakerFired = false;
    let mismatchActive = true;
    let mismatchAlerts = 1;
    let mismatchRecoveries = 0;
    let cleanEvaluations = 0;
    for (let iteration = 0; iteration < 600 && cleanEvaluations < 3; iteration += 1) {
      const state = await typesafeState();
      const probeAt =
        state.state === 'closed' ? Number.POSITIVE_INFINITY : Date.parse(state.openUntil!);
      if (probeAt <= nextEval) {
        await advanceTo(probeAt);
        const outcome = await drive(router.ask(call(1000 + probes)));
        probes += 1;
        const after = await typesafeState();
        if (!fixed) {
          expect(outcome.ok).toBe(false);
          expect(after.state).toBe('open');
          expect(Date.parse(after.openedAt!)).toBeGreaterThan(Date.parse(state.openedAt!));
          expect.soft(after.failingSince, 'failingSince after a failed probe').toBe(firstOpenedAt);
        } else {
          expect(outcome).toMatchObject({ ok: true, engine: 'typesafe' });
          expect(after).toStrictEqual({ state: 'closed', reopenCount: 0 });
        }
        continue;
      }
      await advanceTo(nextEval);
      nextEval += 5 * MINUTE;
      const sentBefore = mailer.sent.length;
      const now = await evaluate(mailer);
      const current = await typesafeState();

      const windowHasRow = await mismatchInWindow(now);
      if (windowHasRow && !mismatchActive) mismatchAlerts += 1;
      if (!windowHasRow && mismatchActive) mismatchRecoveries += 1;
      mismatchActive = windowHasRow;
      const streakAge = now.getTime() - Date.parse(firstOpenedAt);
      const breakerShouldFire = current.state !== 'closed' && streakAge > 30 * MINUTE;
      const expectedKeys = [
        ...(breakerShouldFire ? ['engine.breaker'] : []),
        ...(windowHasRow ? ['engine.model_mismatch'] : []),
      ];
      const at = `${(now.getTime() - T0.getTime()) / MINUTE} min after start`;
      expect(await activeKeys(), `active incidents ${at}`).toEqual(expectedKeys);
      expect(mailsTitled(mailer, MISMATCH_TITLE, false), `mismatch alerts ${at}`).toHaveLength(
        mismatchAlerts,
      );
      expect(mailsTitled(mailer, MISMATCH_TITLE, true), `mismatch recoveries ${at}`).toHaveLength(
        mismatchRecoveries,
      );

      if (!fixed) {
        if (!breakerShouldFire) {
          expect(mailsTitled(mailer, FAILING_TITLE, false), `no failing mail ${at}`).toHaveLength(
            0,
          );
          continue;
        }
        expect(breakerFired, 'the failing alert is sent once').toBe(false);
        breakerFired = true;
        expect(mailer.sent.length - sentBefore, 'one digest at the first firing evaluation').toBe(
          1,
        );
        const failing = mailer.sent.at(-1)!;
        expect(failing.text).toContain(FAILING_TITLE);
        expect(failing.text).toContain(`model_mismatch:${JEV_FAKE_MODEL}`);
        expect(failing.text).toContain(PINNED_MODEL);
        expect(now.getTime() - Date.parse(current.openedAt!)).toBeLessThan(30 * MINUTE);
        expect(probes).toBeGreaterThanOrEqual(4);
        router = routerFor(JEV_FAKE_MODEL);
        fixed = true;
        continue;
      }
      expect(mailsTitled(mailer, FAILING_TITLE, false)).toHaveLength(1);
      expect(mailsTitled(mailer, FAILING_TITLE, true), `breaker recoveries ${at}`).toHaveLength(
        current.state === 'closed' ? 1 : 0,
      );
      if (current.state === 'closed' && !windowHasRow) cleanEvaluations += 1;
    }
    expect(breakerFired, 'the failing streak alert fired').toBe(true);
    expect(mismatchAlerts, 'one mismatch alert: the incident does not flap between probes').toBe(1);
    expect(cleanEvaluations, 'three quiet evaluations after the recovery').toBe(3);
    expect(await activeKeys()).toEqual([]);
    expect(mailsTitled(mailer, FAILING_TITLE, false)).toHaveLength(1);
    expect(mailsTitled(mailer, FAILING_TITLE, true)).toHaveLength(1);
    expect(mailsTitled(mailer, MISMATCH_TITLE, true)).toHaveLength(mismatchAlerts);
  }, 600_000);

  it('NEG: a router on the answered model sends no mail and opens no incident in an hour of traffic', async () => {
    await freshWorld();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
    const T0 = fakeNow();
    const mailer = new RecordingMailer();
    const router = routerFor(JEV_FAKE_MODEL);

    for (let i = 0; i < 24; i += 1) {
      const outcome = await drive(router.ask(call(i)));
      expect(outcome).toMatchObject({ ok: true, engine: 'typesafe' });
    }
    let nextEval = T0.getTime() + 5 * MINUTE;
    for (let minute = 1; minute <= 60; minute += 1) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      if (minute % 3 === 0) {
        const outcome = await drive(router.ask(call(100 + minute)));
        expect(outcome).toMatchObject({ ok: true });
      }
      while (Date.now() >= nextEval) {
        nextEval += 5 * MINUTE;
        await evaluate(mailer);
        expect(mailer.sent).toHaveLength(0);
        expect(await activeKeys()).toEqual([]);
      }
    }
    expect(mailer.sent).toHaveLength(0);
    expect((await typesafeState()).state).toBe('closed');
  }, 600_000);
});
