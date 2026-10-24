import { retryTransaction, workerOutbox } from '@bantoozi/db';
import { QUEUES, buildJobIntent, parseJobPayload, type QueueName } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createBoss, registerHandlers } from '../src/boss.js';
import { relayOnce, type JobBroker } from '../src/outbox-relay.js';

import { dispatch, type QueueHandler } from '../src/handlers/index.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  ScriptedRouter,
  baseConfig,
  handlersFor,
  recorder,
  resetWorld,
  startRuntime,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await h?.close();
});
beforeEach(async () => {
  await resetWorld(h);
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

async function revisionOf(id: string): Promise<string> {
  const result = await h.owner.query<{ revision: string }>(
    "SELECT dedupe_key::jsonb ->> 'revision' AS revision FROM job_outbox WHERE id = $1",
    [id],
  );
  return result.rows[0]!.revision;
}

const cases: Array<[QueueName, Record<string, unknown>]> = [
  ['article.enrich', { articleId: '1', priority: 'interactive' }],
  ['article.translate', { articleId: '1', modeChange: true, forceTier2: true, retried: true }],
  ['article.cluster', { articleId: '1' }],
  ['article.match', { articleId: '1', l2Attempts: 2 }],
  [
    'card.backfill',
    {
      userId: '00000000-0000-4000-8000-000000000001',
      cardIds: ['1'],
      feedIds: ['1'],
      snapshotAt: '2026-10-20T00:00:00.000Z',
      cursor: { firstSeenAt: '2026-10-19T00:00:00.000Z', articleId: '1' },
      processedCount: 500,
    },
  ],
  ['house.translate-cards', { userId: '00000000-0000-4000-8000-000000000001' }],
];

it.each(cases)(
  '%s keeps a delayed intent after its last retry and repeated stale consumption',
  async (queue, input) => {
    const old = await boot(OLD_MODEL);
    await boot(NEW_MODEL);
    await h.clearOutbox();
    const router = new ScriptedRouter(h.db, old.processModel);
    const logs = recorder();
    const handlers = h.handlersWith({
      logger: logs.logger,
      classification: { ...old.models.classification, router },
    });
    const payload = parseJobPayload(queue, input);
    let staleRecoveryRevision: string | undefined;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const limit = QUEUES[queue].options.retryLimit ?? 0;
      for (let attempt = 0; attempt <= limit; attempt += 1) {
        await expect(
          dispatch(handlers, queue, payload, {
            queue,
            jobId: `stale-${cycle}`,
            ...(staleRecoveryRevision === undefined ? {} : { staleRecoveryRevision }),
            retry: { count: attempt, limit },
          }),
        ).rejects.toMatchObject({ name: 'StaleWorkerError' });
        if (attempt < limit) expect(await h.intents(queue, { pending: true })).toHaveLength(0);
      }
      // A repeated final delivery is idempotent even before the relay sends the replacement.
      await expect(
        dispatch(handlers, queue, payload, {
          queue,
          jobId: `stale-${cycle}`,
          ...(staleRecoveryRevision === undefined ? {} : { staleRecoveryRevision }),
          retry: { count: limit, limit },
        }),
      ).rejects.toMatchObject({ name: 'StaleWorkerError' });
      const intents = await h.intents(queue, { pending: true });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.payload).toEqual(payload);
      const delay = (intents[0]?.availableAt.getTime() ?? 0) - Date.now();
      expect(delay).toBeGreaterThan(30_000 * 2 ** cycle - 10_000);
      expect(delay).toBeLessThanOrEqual(30_000 * 2 ** cycle + 1_000);
      staleRecoveryRevision = await revisionOf(intents[0]!.id);
      // Simulate delivery of the replacement; its next stale consumption must leave another.
      await h.clearOutbox();
    }
    expect(router.asks).toEqual([]);
    expect(
      logs.logs
        .filter((entry) => entry.msg === 'stale worker: delayed intent left for a current worker')
        .map((entry) => entry.obj.hop),
    ).toEqual([0, 1, 2]);
  },
);

it('an in-flight stale enrichment is discarded, then a current worker completes its replacement once', async () => {
  const old = await boot(OLD_MODEL);
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.heldCard(userId, { topicIds: ['technology'] });
  const articleId = await h.article({ feedIds: [feedId] });
  const router = new ScriptedRouter(h.db, old.processModel);
  let current: WorkerRuntimeLike | undefined;
  router.respond = async () => {
    current = await boot(NEW_MODEL);
    return undefined;
  };
  await h.clearOutbox();
  await expect(
    dispatch(
      handlersFor(h, old, router),
      'article.enrich',
      { articleId },
      {
        queue: 'article.enrich',
        jobId: 'in-flight',
        retry: { count: 1, limit: 1 },
      },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  expect(await h.facetRow(articleId)).toBeNull();
  const intents = await h.intents('article.enrich', { pending: true });
  expect(intents).toHaveLength(1);
  expect(current).toBeDefined();
  const next = current as WorkerRuntimeLike;
  const nextRouter = new ScriptedRouter(h.db, next.processModel);
  const handlers = handlersFor(h, next, nextRouter);
  const payload = parseJobPayload('article.enrich', intents[0]?.payload);
  await h.clearOutbox();
  for (let delivery = 0; delivery < 2; delivery += 1) {
    await dispatch(handlers, 'article.enrich', payload, {
      queue: 'article.enrich',
      jobId: 'replacement',
    });
  }
  expect(await h.facetRow(articleId)).toMatchObject({ model: NEW_MODEL });
  expect(nextRouter.asksFor(articleId, 'enrich')).toHaveLength(1);
});

it('does not coalesce the replacement into the original intent while its relay acknowledgement is pending', async () => {
  const old = await boot(OLD_MODEL);
  await boot(NEW_MODEL);
  await h.clearOutbox();
  const payload = { articleId: '1' };
  await retryTransaction(h.db, (tx) =>
    workerOutbox(tx).enqueue(buildJobIntent('article.enrich', payload)),
  );
  const [original] = await h.intents('article.enrich', { pending: true });
  await expect(
    dispatch(
      handlersFor(h, old, new ScriptedRouter(h.db, old.processModel)),
      'article.enrich',
      payload,
      {
        queue: 'article.enrich',
        jobId: 'already-sent',
        retry: { count: 1, limit: 1 },
      },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [original?.id]);
  expect(await h.intents('article.enrich', { pending: true })).toHaveLength(1);
});

it('carries three growing stale hops through the relay and broker, then a current worker ends the chain', async () => {
  const old = await boot(OLD_MODEL);
  const current = await boot(NEW_MODEL);
  const logs = recorder();
  const now = new Date();
  const makeHandlers = (runtime: WorkerRuntimeLike) =>
    h.handlersWith({
      now: () => now,
      logger: logs.logger,
      classification: {
        ...runtime.models.classification,
        router: new ScriptedRouter(h.db, runtime.processModel),
      },
    });
  let active = makeHandlers(old);
  const handlers = {
    ...active,
    'article.enrich': {
      status: 'implemented' as const,
      handle: async (...args: Parameters<QueueHandler<'article.enrich'>>) => {
        await dispatch(active, 'article.enrich', ...args);
      },
    },
  };
  const boss = createBoss(h.testDb.urls.worker);
  boss.on('error', () => {});
  await boss.start();
  const broker: JobBroker = {
    send: (queue, data, singletonKey) =>
      boss.send(queue, data, {
        retryLimit: 0,
        ...(singletonKey === undefined ? {} : { singletonKey }),
      }),
    sendDebounced: async () => {
      throw new Error('unexpected debounce');
    },
  };
  try {
    await registerHandlers(boss, handlers, ['article.enrich'], logs.logger);
    await h.clearOutbox();
    const originalJobId = await boss.send('article.enrich', { articleId: '1' }, { retryLimit: 0 });
    for (let hop = 0; hop < 3; hop += 1) {
      await expect
        .poll(async () => (await h.intents('article.enrich', { pending: true })).length, {
          timeout: 10_000,
        })
        .toBe(1);
      const [intent] = await h.intents('article.enrich', { pending: true });
      expect(intent!.availableAt.getTime() - now.getTime()).toBe(30_000 * 2 ** hop);
      expect(await revisionOf(intent!.id)).toBe(`stale:${originalJobId}:${hop}`);
      if (hop === 2) active = makeHandlers(current);
      await h.owner.query('UPDATE job_outbox SET available_at = now() WHERE id = $1', [intent!.id]);
      expect(await relayOnce(h.db, broker, { handlers })).toMatchObject({ delivered: 1 });
    }
    await expect
      .poll(
        async () => {
          const result = await h.owner.query<{ state: string }>(
            "SELECT state::text AS state FROM pgboss.job WHERE name = 'article.enrich' ORDER BY created_on DESC LIMIT 1",
          );
          return result.rows[0]?.state;
        },
        { timeout: 10_000 },
      )
      .toBe('completed');
    expect(await h.intents('article.enrich', { pending: true })).toEqual([]);
    expect(
      logs.logs
        .filter((entry) => entry.msg === 'stale worker: delayed intent left for a current worker')
        .map((entry) => entry.obj.hop),
    ).toEqual([0, 1, 2]);
  } finally {
    await boss.stop({ graceful: false, wait: true, timeout: 5_000 });
  }
});

it.each([5, 20])('caps stale replacement hop %s at fifteen minutes', async (hop) => {
  const old = await boot(OLD_MODEL);
  await boot(NEW_MODEL);
  const now = new Date();
  const handlers = h.handlersWith({ now: () => now, classification: old.models.classification });
  await h.clearOutbox();
  await expect(
    dispatch(
      handlers,
      'article.enrich',
      { articleId: '1' },
      {
        queue: 'article.enrich',
        jobId: 'capped',
        staleRecoveryRevision: `stale:original:${hop - 1}`,
      },
    ),
  ).rejects.toMatchObject({ name: 'StaleWorkerError' });
  const [intent] = await h.intents('article.enrich', { pending: true });
  expect(intent!.availableAt.getTime() - now.getTime()).toBe(15 * 60_000);
  expect(await revisionOf(intent!.id)).toBe(`stale:original:${hop}`);
});
