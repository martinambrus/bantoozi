import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { dispatch } from '../src/handlers/index.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  handlersFor,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];
const NOW = new Date('2026-10-24T12:00:00.000Z');

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await h?.close();
});
beforeEach(async () => {
  await resetWorld(h);
  await h.owner.query("DELETE FROM settings WHERE key = 'house.progress'");
});

async function boot(model: string) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', { typesafeModel: model }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  return runtime;
}

it.each(['house.reenrich', 'house.rematch'] as const)(
  '%s survives two stale deliveries, freezes its scope, and reconcile resumes it once',
  async (queue) => {
    const old = await boot(OLD_MODEL);
    const current = await boot(NEW_MODEL);
    await h.clearOutbox();
    const payload = {
      since: '2026-10-01T00:00:00.000Z',
      cursor: { key: '2026-10-20T00:00:00.000Z', articleId: '1' },
      ...(queue === 'house.reenrich' ? { lang: 'sk' } : { cardId: '1' }),
    };
    const router = new ScriptedRouter(h.db, old.processModel);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        dispatch(handlersFor(h, old, router), queue, payload, {
          queue,
          jobId: 'stale-rebuild',
          retry: { count: attempt, limit: 1 },
        }),
      ).rejects.toMatchObject({ name: 'StaleWorkerError' });
    }
    expect(router.asks).toEqual([]);
    const progress = await h.owner.query<{ value: Record<string, unknown> }>(
      "SELECT value FROM settings WHERE key = 'house.progress'",
    );
    expect(progress.rows[0]?.value[queue]).toMatchObject({ cursor: { pending: [payload] } });

    const handlers = handlersFor(h, current, new ScriptedRouter(h.db, current.processModel));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await dispatch(
        handlers,
        'house.reconcile',
        {},
        { queue: 'house.reconcile', jobId: 'resume' },
      );
    }
    expect((await h.intents(queue, { pending: true })).map((intent) => intent.payload)).toEqual([
      payload,
    ]);
  },
);

it.each(['house.reenrich', 'house.rematch'] as const)(
  '%s also parks a restart-settings mismatch with a default frozen since',
  async (queue) => {
    const runtime = await boot(OLD_MODEL);
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    const handlers = h.handlersWith({
      now: () => NOW,
      classification: runtime.models.classification,
    });
    await expect(
      dispatch(handlers, queue, {}, { queue, jobId: 'restart-stale' }),
    ).rejects.toMatchObject({ name: 'StaleWorkerError', reason: 'restart_settings' });
    const result = await h.owner.query<{ pending: unknown }>(
      "SELECT value -> $1 -> 'cursor' -> 'pending' AS pending FROM settings WHERE key = 'house.progress'",
      [queue],
    );
    expect(result.rows[0]?.pending).toEqual([{ since: '2026-10-10T12:00:00.000Z' }]);
  },
);

it.each(['house.reenrich', 'house.rematch'] as const)(
  '%s leaves no parked run when a current worker completes the queue retry',
  async (queue) => {
    const old = await boot(OLD_MODEL);
    const current = await boot(NEW_MODEL);
    const payload = { since: '2026-10-01T00:00:00.000Z' };
    await expect(
      dispatch(handlersFor(h, old, new ScriptedRouter(h.db, old.processModel)), queue, payload, {
        queue,
        jobId: 'retried-rebuild',
        retry: { count: 0, limit: 1 },
      }),
    ).rejects.toMatchObject({ name: 'StaleWorkerError' });
    await dispatch(
      handlersFor(h, current, new ScriptedRouter(h.db, current.processModel)),
      queue,
      payload,
      {
        queue,
        jobId: 'retried-rebuild',
        retry: { count: 1, limit: 1 },
      },
    );
    const result = await h.owner.query<{ pending: unknown }>(
      "SELECT value -> $1 -> 'cursor' -> 'pending' AS pending FROM settings WHERE key = 'house.progress'",
      [queue],
    );
    expect(result.rows[0]?.pending ?? []).toEqual([]);
  },
);

it.each(['house.reenrich', 'house.rematch'] as const)(
  '%s parks a fresh trigger only on its final attempt and preserves earlier progress',
  async (queue) => {
    const old = await boot(OLD_MODEL);
    await boot(NEW_MODEL);
    const completedAt = '2026-10-20T00:00:00.000Z';
    const pending = { since: '2026-10-01T00:00:00.000Z' };
    await setSetting(h.owner, 'house.progress', {
      [queue]: { cursor: { pending: [pending] }, completedAt, updatedAt: completedAt, version: 1 },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handlers = h.handlersWith({
        now: () => new Date(NOW.getTime() + attempt * 30_000),
        classification: old.models.classification,
      });
      await expect(
        dispatch(
          handlers,
          queue,
          {},
          {
            queue,
            jobId: 'fresh-rebuild',
            retry: { count: attempt, limit: 1 },
          },
        ),
      ).rejects.toMatchObject({ name: 'StaleWorkerError' });
    }
    const result = await h.owner.query<{ value: Record<string, unknown> }>(
      "SELECT value FROM settings WHERE key = 'house.progress'",
    );
    expect(result.rows[0]?.value[queue]).toEqual({
      cursor: { pending: [pending, { since: '2026-10-10T12:00:30.000Z' }] },
      completedAt,
      updatedAt: '2026-10-24T12:00:30.000Z',
      version: 1,
    });
  },
);
