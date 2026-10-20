import { LearningStatusSchema } from '@bantoozi/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

let h: ApiHarness;

const KEYS = ['engine.circuit', 'engine.model_pin', 'house.progress'] as const;
const OK = { state: 'ok', since: null, reason: null };

beforeAll(async () => {
  h = await createApiHarness();
});

afterEach(async () => {
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [[...KEYS]]);
});

afterAll(async () => {
  await h.close();
});

async function setSetting(key: (typeof KEYS)[number], value: unknown) {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;
const DAY = 86_400_000;

async function setCircuit(
  typesafe: Record<string, unknown>,
  llm: Record<string, unknown> = { state: 'closed', reopenCount: 0 },
) {
  await setSetting('engine.circuit', { typesafe, llm, resetRequested: {} });
}

async function setPin(since: string) {
  await setSetting('engine.model_pin', { model: 'jev-1.14.0', since });
}

type Progress = { updatedAt: string; completedAt?: string };
async function setProgress(jobs: Record<string, Progress>) {
  await setSetting(
    'house.progress',
    Object.fromEntries(Object.entries(jobs).map(([job, p]) => [job, { version: 1, ...p }])),
  );
}

async function raw(): Promise<Record<string, unknown>> {
  const user = await createTestUser(h);
  const res = await apiClient(h.server, user).get('/me/learning');
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Record<string, unknown>;
}

async function classification() {
  const body = await raw();
  return LearningStatusSchema.parse(body).classification;
}

describe('GET /me/learning classification', () => {
  it('is ok with no since and no reason, and present in the raw body, when no settings exist', async () => {
    const body = await raw();
    expect(body).toHaveProperty('classification');
    expect(body.classification).toEqual(OK);
    expect(await classification()).toEqual(OK);
  });

  describe('engine unavailable', () => {
    const failingSince = () => iso(Date.now() - 3 * DAY);
    const openedAt = () => iso(Date.now() - 2 * MINUTE);

    it('is paused since failingSince when the breaker is open', async () => {
      const since = failingSince();
      await setCircuit({
        state: 'open',
        reopenCount: 4,
        openedAt: openedAt(),
        openUntil: iso(Date.now() + 5 * MINUTE),
        failingSince: since,
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since,
        reason: 'engine_unavailable',
      });
    });

    it('is paused since failingSince when the breaker is half open', async () => {
      const since = failingSince();
      await setCircuit({
        state: 'half_open',
        reopenCount: 4,
        openedAt: openedAt(),
        failingSince: since,
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since,
        reason: 'engine_unavailable',
      });
    });

    it('is paused since failingSince in auth mode', async () => {
      const since = failingSince();
      await setCircuit({
        state: 'auth',
        reopenCount: 0,
        openedAt: openedAt(),
        failingSince: since,
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since,
        reason: 'engine_unavailable',
      });
    });

    it('is paused since openedAt in auth mode without failingSince', async () => {
      const opened = openedAt();
      await setCircuit({ state: 'auth', reopenCount: 0, openedAt: opened });
      expect(await classification()).toEqual({
        state: 'paused',
        since: opened,
        reason: 'engine_unavailable',
      });
    });

    it('is paused since openedAt for a legacy open state without failingSince', async () => {
      const opened = openedAt();
      await setCircuit({
        state: 'open',
        reopenCount: 1,
        openedAt: opened,
        openUntil: iso(Date.now() + 5 * MINUTE),
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since: opened,
        reason: 'engine_unavailable',
      });
    });

    it('is paused with since null when an open breaker has neither failingSince nor openedAt', async () => {
      await setCircuit({ state: 'open', reopenCount: 0 });
      expect(await classification()).toEqual({
        state: 'paused',
        since: null,
        reason: 'engine_unavailable',
      });
    });

    it('stays ok when the typesafe breaker is closed and the llm breaker is open', async () => {
      await setCircuit(
        { state: 'closed', reopenCount: 0 },
        { state: 'open', reopenCount: 2, openedAt: openedAt(), failingSince: failingSince() },
      );
      expect(await classification()).toEqual(OK);
    });

    it('stays ok when both breakers are closed', async () => {
      await setCircuit({ state: 'closed', reopenCount: 0 });
      expect(await classification()).toEqual(OK);
    });
  });

  describe('model upgrade', () => {
    const P = () => Date.now() - 2 * 3_600_000;

    it('is paused since the pin when house.reenrich runs and has not completed', async () => {
      const p = P();
      await setPin(iso(p));
      await setProgress({ 'house.reenrich': { updatedAt: iso(p + MINUTE) } });
      expect(await classification()).toEqual({
        state: 'paused',
        since: iso(p),
        reason: 'model_upgrade',
      });
    });

    it('is paused when a pass runs after an older completion', async () => {
      const p = P();
      await setPin(iso(p));
      await setProgress({
        'house.reenrich': { updatedAt: iso(p + MINUTE), completedAt: iso(p - DAY) },
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since: iso(p),
        reason: 'model_upgrade',
      });
    });

    it('is paused when only house.rematch runs while house.reenrich completed', async () => {
      const p = P();
      await setPin(iso(p));
      await setProgress({
        'house.reenrich': { updatedAt: iso(p + MINUTE), completedAt: iso(p + 2 * MINUTE) },
        'house.rematch': { updatedAt: iso(p + 3 * MINUTE) },
      });
      expect(await classification()).toEqual({
        state: 'paused',
        since: iso(p),
        reason: 'model_upgrade',
      });
    });

    it('stays ok when every job updated since the pin has also completed since the pin', async () => {
      const p = P();
      await setPin(iso(p));
      await setProgress({
        'house.reenrich': { updatedAt: iso(p + MINUTE), completedAt: iso(p + 2 * MINUTE) },
        'house.rematch': { updatedAt: iso(p + 3 * MINUTE), completedAt: iso(p + 3 * MINUTE) },
      });
      expect(await classification()).toEqual(OK);
    });

    it('stays ok when every job was last updated before the pin', async () => {
      const p = P();
      await setPin(iso(p));
      await setProgress({
        'house.reenrich': { updatedAt: iso(p - MINUTE) },
        'house.rematch': { updatedAt: iso(p - DAY), completedAt: iso(p - 2 * DAY) },
      });
      expect(await classification()).toEqual(OK);
    });

    it('stays ok when there are no progress entries', async () => {
      await setPin(iso(P()));
      await setProgress({});
      expect(await classification()).toEqual(OK);
    });

    it('stays ok when there is no pin although a job is running', async () => {
      await setProgress({ 'house.reenrich': { updatedAt: iso(Date.now() - MINUTE) } });
      expect(await classification()).toEqual(OK);
    });
  });

  it('reports engine_unavailable when the breaker is open and a rebuild is running', async () => {
    const p = Date.now() - 2 * 3_600_000;
    const failingSince = iso(Date.now() - DAY);
    await setCircuit({
      state: 'open',
      reopenCount: 2,
      openedAt: iso(Date.now() - MINUTE),
      failingSince,
    });
    await setPin(iso(p));
    await setProgress({ 'house.reenrich': { updatedAt: iso(p + MINUTE) } });
    expect(await classification()).toEqual({
      state: 'paused',
      since: failingSince,
      reason: 'engine_unavailable',
    });
  });

  it('gives two different users the same status and no keys beyond the schema', async () => {
    const since = iso(Date.now() - DAY);
    await setCircuit({
      state: 'open',
      reopenCount: 1,
      openedAt: iso(Date.now() - MINUTE),
      failingSince: since,
    });
    const first = await raw();
    const second = await raw();
    expect(first.classification).toEqual({
      state: 'paused',
      since,
      reason: 'engine_unavailable',
    });
    expect(second.classification).toEqual(first.classification);
    expect(Object.keys(first.classification as object).sort()).toEqual([
      'reason',
      'since',
      'state',
    ]);
    expect(Object.keys(first).sort()).toEqual(['classification', 'feeds', 'model']);
  });
});
