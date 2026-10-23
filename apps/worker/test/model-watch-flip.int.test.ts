import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../src/handlers/index.js';
import { ensureFingerprintRegistered } from '../src/learn/fingerprints.js';
import { recordModelResolution } from '../src/model-resolution.js';
import { loadEffectiveValues } from '../src/runtime.js';

import { ClassifyHarness } from './support/classify.js';
import {
  V113,
  begin,
  dropRegistry,
  exactShaOf,
  learnInputs,
  modelRows,
  rankStatus,
  reasonCounts,
  registryOf,
  retag,
} from './support/jev4-world.js';
import { LearnWorld, RATED } from './support/learn-world.js';
import {
  ALIAS,
  API_KEY,
  LATER,
  NOW,
  V114,
  V2,
  WatchMailer,
  addAdmin,
  clearAdmins,
  fakeTable,
  iso,
  realProber,
  runWatch,
} from './support/model-watch-world.js';
import {
  OLD_MODEL,
  ScriptedRouter,
  baseConfig,
  expectedDedupeKey,
  handlersFor,
  pinRow,
  rebuildIntents,
  recorder,
  resetWorld,
  resolutionRow,
  setSetting,
  startRuntime,
  storeResolution,
  type ModelProbeSeam,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * JEV-3 U1 (harness brief F1, F2): the flip end to end across processes. The watch handler adopts a new release of `jev-latest` against the fake TypeSafe server;
 * workers are in-process runtimes with the production config, whose start probe seam throws if it is
 * ever called (a resolution is stored); a "restart" is a new `createWorkerRuntime` on the same
 * database (the m8b-t5 pattern). The seams are documented in support/m8b-t5-world.ts and
 * support/model-watch-world.ts.
 */

const ADMIN = 'flip-admin@example.test';

let h: ClassifyHarness;
let fake: FakeTypeSafeServer;
const runtimes: WorkerRuntimeLike[] = [];
let sharedLearnWorld: LearnWorld | undefined;

/** One learn pool per database: its fixture cards are unique. */
async function learnWorld(): Promise<LearnWorld> {
  sharedLearnWorld ??= await LearnWorld.create(h);
  return sharedLearnWorld;
}

beforeAll(async () => {
  h = await ClassifyHarness.start();
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: fakeTable(OLD_MODEL) });
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await sharedLearnWorld?.close();
  await fake?.close();
  await h?.close();
});

const flipTo = (latest: string) => fake.setOptions({ models: fakeTable(latest) });

/** A clean world on the alias: stored resolution and pin at 1.13.0, one active admin. */
async function aliasWorld(): Promise<void> {
  await resetWorld(h);
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    [
      'engine.model_watch',
      'engine.model_probe',
      'engine.model_impact',
      'house.progress',
      'engine.rating_fingerprints',
    ],
  ]);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query('DELETE FROM engine_reservations');
  await h.owner.query('DELETE FROM usage_daily');
  await setSetting(h.owner, 'engine.typesafe_model', ALIAS);
  await storeResolution(h.owner, OLD_MODEL);
  await clearAdmins(h.owner);
  await addAdmin(h.owner, ADMIN);
  fake.setOptions({
    apiKey: API_KEY,
    models: fakeTable(OLD_MODEL),
    failRate: 0,
    failStatus: undefined,
    statusOverride: undefined,
  });
  fake.requests.splice(0);
}

/** A worker process of the production config; its start probe must never be needed. */
async function boot(nodeEnv: 'test' | 'production' = 'production') {
  const rec = recorder();
  const modelProbe = vi.fn<ModelProbeSeam>(async () => {
    throw new Error('the start probe must not run: a resolution is stored');
  });
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig(nodeEnv),
    recorder: rec,
    modelProbe,
  });
  runtimes.push(runtime);
  expect(modelProbe).not.toHaveBeenCalled();
  return { runtime, rec };
}

/** One watch run at `at`: the real prober against the fake, the effective setting read from the database. */
async function watch(mailer: WatchMailer, at: Date = NOW) {
  await runWatch(h, {
    prober: realProber(h, fake, at),
    mailer,
    now: at,
    configuredModel: async () =>
      (await loadEffectiveValues(h.db, baseConfig('production'))).typesafeModel,
  });
}

async function demandedArticle(): Promise<string> {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.hold(userId, await h.card({ topicIds: ['technology'] }));
  return h.article({ feedIds: [feedId] });
}

/** An `article.enrich` job on `runtime`; the error it ended with and what it wrote. */
async function enrichOn(runtime: WorkerRuntimeLike, jobId: string) {
  const articleId = await demandedArticle();
  const router = new ScriptedRouter(h.db, runtime.processModel);
  const error = await dispatch(
    handlersFor(h, runtime, router),
    'article.enrich',
    { articleId },
    { queue: 'article.enrich', jobId },
  ).then(
    () => undefined,
    (e: unknown) => e as { name?: string; retryDelaySeconds?: number },
  );
  return { articleId, router, error, facet: await h.facetRow(articleId) };
}

/** Moves the resolution as the watch does, but by hand (the fixture sanity of the flow). */
async function adoptByHand(latest: string, at: Date): Promise<void> {
  await ensureFingerprintRegistered(
    h.db,
    { settingsEnv: h.settingsEnv, primaryModel: OLD_MODEL },
    at,
  );
  await recordModelResolution(h.db, { alias: ALIAS, model: latest, now: at });
}

const DRIVERS = [
  ['the watch handler', true],
  ['fixture sanity: the resolution moved by hand', false],
] as const;

describe.each(DRIVERS)(
  'F1: two worker processes follow a flip of jev-latest via %s',
  (_name, real) => {
    beforeEach(aliasWorld);

    it('drains and exits each old worker once, fences their jobs, and lets the first restarted worker alone record the pin and enqueue one rebuild', async () => {
      const mailer = new WatchMailer();
      const a1 = await boot();
      const b1 = await boot();
      for (const w of [a1, b1]) {
        expect(w.runtime.modelState).toMatchObject({
          kind: 'resolved',
          alias: ALIAS,
          model: OLD_MODEL,
          source: 'stored',
        });
      }

      // Control: nothing changed, and a watch run that finds the same release changes nothing.
      if (real) await watch(mailer);
      for (const w of [a1, b1]) {
        expect(await w.runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
        expect(w.rec.exits).toEqual([]);
      }
      expect(await rebuildIntents(h.owner)).toEqual([]);
      expect(mailer.attempts).toBe(0);

      // The release moves: the watch adopts it.
      if (real) {
        flipTo(V114);
        await watch(mailer, LATER);
      } else {
        await adoptByHand(V114, LATER);
      }
      expect(await resolutionRow(h.owner)).toMatchObject({
        model: V114,
        previous: { model: OLD_MODEL, until: iso(LATER) },
      });
      if (real) expect(mailer.sent).toHaveLength(1);

      // The watcher ticks several times: each worker drains once, then exits once.
      for (const w of [a1, b1]) {
        expect(await w.runtime.check()).toMatchObject({ pendingRestart: true, exiting: true });
        await w.runtime.check();
        await w.runtime.check();
        expect(w.rec.exits).toEqual([0]);
        expect(w.rec.drains).toBe(1);
        expect(w.rec.calls).toEqual(['drain', 'exit']);
      }
      // The old processes write no pin and enqueue no rebuild.
      expect(await pinRow(h.owner)).toMatchObject({ model: OLD_MODEL });
      expect(await rebuildIntents(h.owner)).toEqual([]);

      // Their in-flight classification jobs are fenced and write nothing.
      for (const [name, w] of [
        ['a1', a1],
        ['b1', b1],
      ] as const) {
        const job = await enrichOn(w.runtime, `flip-${name}`);
        expect(job.error).toMatchObject({ name: 'StaleWorkerError', retryDelaySeconds: 30 });
        expect(job.facet).toBeNull();
        expect((await h.articleRow(job.articleId)).state).toBe('extracted');
      }

      // The supervisor restarts the containers one after the other.
      const a2 = await boot();
      expect(a2.runtime.processModel).toBe(V114);
      expect(a2.runtime.modelState).toMatchObject({
        kind: 'resolved',
        model: V114,
        source: 'stored',
      });
      const pin = await pinRow(h.owner);
      expect(pin).toMatchObject({ model: V114, alias: ALIAS });
      expect(pin?.since).not.toBe('2026-10-01T00:00:00.000Z');
      const intents = [
        {
          queue: 'house.reenrich',
          payload: {},
          dedupeKey: expectedDedupeKey('house.reenrich', pin!.since),
        },
        {
          queue: 'house.rematch',
          payload: {},
          dedupeKey: expectedDedupeKey('house.rematch', pin!.since),
        },
      ];
      expect(await rebuildIntents(h.owner)).toEqual(intents);

      const b2 = await boot();
      expect(b2.runtime.processModel).toBe(V114);
      expect(await pinRow(h.owner)).toEqual(pin);
      expect(await rebuildIntents(h.owner)).toEqual(intents);
      for (const w of [a2, b2]) {
        expect(await w.runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
        expect(w.rec.exits).toEqual([]);
      }

      // One mail in total, and the old worker is still fenced after the pin moved.
      if (real) expect(mailer.sent).toHaveLength(1);
      const again = await enrichOn(a1.runtime, 'flip-a1-late');
      expect(again.error).toMatchObject({ name: 'StaleWorkerError' });
      expect(again.facet).toBeNull();

      // The restarted worker processes the same kind of article.
      const fresh = await enrichOn(a2.runtime, 'flip-a2');
      expect(fresh.error).toBeUndefined();
      expect(fresh.router.asksFor(fresh.articleId)).toHaveLength(1);
      expect((await h.articleRow(fresh.articleId)).state).toBe('enriched');

      // A further watch run on the same release changes nothing.
      const resolution = await resolutionRow(h.owner);
      if (real) await watch(mailer, new Date(LATER.getTime() + 3_600_000));
      if (real) expect(mailer.sent).toHaveLength(1);
      expect(await pinRow(h.owner)).toEqual(pin);
      expect(await rebuildIntents(h.owner)).toEqual(intents);
      expect(await resolutionRow(h.owner)).toMatchObject({
        model: V114,
        resolvedAt: resolution!.resolvedAt,
        previous: resolution!.previous,
      });
      for (const w of [a2, b2]) {
        expect(await w.runtime.check()).toMatchObject({ pendingRestart: false, exiting: false });
      }
    }, 120_000);
  },
);

describe('F1: delivery trouble', () => {
  beforeEach(aliasWorld);

  it('a failing mailer does not hold back the restart: the workers still follow the adopted release', async () => {
    const mailer = new WatchMailer();
    mailer.failing = true;
    const a1 = await boot();
    flipTo(V114);
    await watch(mailer);
    expect(mailer.sent).toHaveLength(0);
    expect(await a1.runtime.check()).toMatchObject({ pendingRestart: true, exiting: true });
    expect(a1.rec.exits).toEqual([0]);
    const a2 = await boot();
    expect(a2.runtime.processModel).toBe(V114);
    expect(await pinRow(h.owner)).toMatchObject({ model: V114, alias: ALIAS });
  });
});

describe.each(DRIVERS)(
  'F2: a flip keeps the personal models of the same major via %s',
  (_name, real) => {
    const adopt = async (latest: string) => {
      if (real) {
        flipTo(latest);
        await watch(new WatchMailer());
      } else {
        await adoptByHand(latest, NOW);
      }
    };

    let w: LearnWorld;

    beforeAll(async () => {
      w = await learnWorld();
    }, 240_000);

    beforeEach(async () => {
      await aliasWorld();
      await begin(h, V113);
      h.router.reset();
      await h.clearOutbox();
    });

    const learn = (userId: string) => h.dispatch('user.learn', { userId });

    /** A reader with RATED ratings of the 1.13.0 pool and a trained active model, registry dropped. */
    async function trainedReader(): Promise<{ userId: string; ratedSha: string }> {
      const userId = await w.user({ lastActiveDaysAgo: 0 });
      await w.rateRange(userId, 0, RATED);
      await learn(userId);
      const rows = await modelRows(h, userId);
      expect(rows.filter((row) => row.active)).toHaveLength(1);
      const ratedSha = await exactShaOf(h);
      await dropRegistry(h);
      return { userId, ratedSha };
    }

    it('1.13.0 to 1.14.0: the watch registers the outgoing sha, so after the restart the ratings stay eligible and the model stays active', async () => {
      const { userId, ratedSha } = await trainedReader();
      await boot('test');
      // Control: before the flip every rating is eligible with the (unregistered) current sha.
      expect((await learnInputs(h, userId)).eligible).toHaveLength(RATED);

      await adopt(V114);
      expect(Object.keys(await registryOf(h))).toEqual([ratedSha]);

      const restarted = await boot('test');
      expect(restarted.runtime.processModel).toBe(V114);
      expect(await pinRow(h.owner)).toMatchObject({ model: V114, alias: ALIAS });
      expect(await exactShaOf(h)).not.toBe(ratedSha);

      const inputs = await learnInputs(h, userId);
      expect(inputs.eligible).toHaveLength(RATED);
      expect(reasonCounts(inputs)).toEqual({ ok: RATED });
      expect(await rankStatus(h, userId)).toBe('current');

      await learn(userId);
      const rows = await modelRows(h, userId);
      expect(rows.filter((row) => row.active).length).toBeGreaterThanOrEqual(1);
      expect(rows.some((row) => row.metrics['deactivatedReason'] === 'incompatible')).toBe(false);
      const after = await learnInputs(h, userId);
      expect(after.eligible).toHaveLength(RATED);
      expect(reasonCounts(after)).not.toHaveProperty('rating_sha_mismatch');
      // The latest model was trained on all the ratings, under the new exact sha.
      expect(rows.at(-1)!.active).toBe(true);
      expect(rows.at(-1)!.metrics['ratingSha']).toBe(await exactShaOf(h));
    }, 120_000);

    it('CONTROL 1.13.0 to 2.0.0: the same flow drops the samples and deactivates the model', async () => {
      const { userId } = await trainedReader();
      await boot('test');

      await adopt(V2);
      const restarted = await boot('test');
      expect(restarted.runtime.processModel).toBe(V2);
      await retag(h, V2);

      const inputs = await learnInputs(h, userId);
      expect(inputs.eligible).toHaveLength(0);
      expect(reasonCounts(inputs)).toEqual({ rating_sha_mismatch: RATED });
      expect(await rankStatus(h, userId)).toBe('stale');

      await learn(userId);
      expect((await modelRows(h, userId)).filter((row) => row.active)).toHaveLength(0);
    }, 120_000);
  },
);
