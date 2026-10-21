import { FEATURE_SPEC_V1_SHA } from '@bantoozi/ranker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { currentContextSha } from '../src/learn/inputs.js';
import { ClassifyHarness } from './support/classify.js';
import {
  V113,
  V114,
  V2,
  begin,
  dropRegistry,
  effectiveSettingsOf,
  ensureRegistered,
  exactShaOf,
  familyShaOracle,
  flip,
  learnInputs,
  modelRows,
  oldInputSha,
  ownIdsOf,
  rankStatus,
  reasonCounts,
  registryOf,
  registryStamp,
  retag,
  settingsRows,
  simulatePreDeploy,
} from './support/jev4-world.js';
import { LearnWorld, RATED } from './support/learn-world.js';
import { rank } from './support/rank-model-world.js';

/**
 * JEV-4 T2 (contract: fingerprint families): a model upgrade inside one Jev major keeps the ratings
 * and the model; another major, or an unregistered sha, does not. Real ratings through the API
 * functions (their snapshots carry the real exact sha), the registered `user.learn`, `user.rank`
 * and `house.nightly-learn` handlers, effects read from the database and the outbox.
 */

let h: ClassifyHarness;
let w: LearnWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = await LearnWorld.create(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

const learn = (userId: string) => h.dispatch('user.learn', { userId });
const nightly = () => h.dispatch('house.nightly-learn', {});

/** A reader with RATED explicit ratings (24 likes, 24 dislikes) of the current pin's answers. */
async function rated(): Promise<string> {
  const userId = await w.user({ lastActiveDaysAgo: 0 });
  await w.rateRange(userId, 0, RATED);
  return userId;
}

async function trained(): Promise<string> {
  const userId = await rated();
  await learn(userId);
  return userId;
}

const T0 = new Date('2026-10-20T10:00:00.000Z');
const T1 = new Date('2026-10-21T10:00:00.000Z');

describe('ensureFingerprintRegistered', () => {
  it('registers the current sha once with its family sha and settings, never rewrites it, and registers a different pin as a distinct entry', async () => {
    await begin(h, V113);
    const exact = await exactShaOf(h);
    const family = await familyShaOracle(h);
    expect(family).not.toBe(exact);
    expect(await registryOf(h)).toEqual({});

    expect(await ensureRegistered(h, T0)).toEqual({ registered: true, evicted: 0 });
    const registry = await registryOf(h);
    expect(Object.keys(registry)).toEqual([exact]);
    expect(registry[exact]).toEqual({
      family,
      settings: JSON.parse(JSON.stringify(await effectiveSettingsOf(h))),
      firstSeenAt: T0.toISOString(),
    });

    const stamp = await registryStamp(h);
    expect(await ensureRegistered(h, T1)).toEqual({ registered: false, evicted: 0 });
    expect(await registryStamp(h)).toBe(stamp);
    expect((await registryOf(h))[exact]!.firstSeenAt).toBe(T0.toISOString());

    await flip(h, V114);
    const exact114 = await exactShaOf(h);
    expect(exact114).not.toBe(exact);
    expect(await ensureRegistered(h, T1)).toEqual({ registered: true, evicted: 0 });
    const both = await registryOf(h);
    expect(Object.keys(both).sort()).toEqual([exact, exact114].sort());
    expect(both[exact114]!.family).toBe(family);
    expect(both[exact114]!.firstSeenAt).toBe(T1.toISOString());
    expect(both[exact]).toEqual(registry[exact]);

    await flip(h, V2);
    const exact2 = await exactShaOf(h);
    expect(await ensureRegistered(h, T1)).toEqual({ registered: true, evicted: 0 });
    const three = await registryOf(h);
    expect(Object.keys(three)).toHaveLength(3);
    expect(three[exact2]!.family).toBe(await familyShaOracle(h));
    expect(three[exact2]!.family).not.toBe(family);
  });
});

describe('reads never write the registry', () => {
  it('loadLearnInputs, loadRankModelState and user.rank leave every settings row untouched, with the registry missing and with the current sha unregistered', async () => {
    await begin(h, V113);
    const userId = await trained();
    const exact = await exactShaOf(h);
    await dropRegistry(h);
    await rank(h, userId);

    const missing = await settingsRows(h);
    const before = await learnInputs(h, userId);
    expect(before.registered).toBe(false);
    expect(before.familySha).toBe(await familyShaOracle(h));
    expect(before.ratingSha).toBe(exact);
    await rankStatus(h, userId);
    await rank(h, userId);
    expect(await settingsRows(h)).toEqual(missing);
    expect(await registryOf(h)).toEqual({});

    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.rating_fingerprints', $1::jsonb)`,
      [
        JSON.stringify({
          ['c'.repeat(64)]: { family: 'd'.repeat(64), settings: {}, firstSeenAt: T0.toISOString() },
        }),
      ],
    );
    const unregistered = await settingsRows(h);
    const other = await learnInputs(h, userId);
    expect(other.registered).toBe(false);
    await rankStatus(h, userId);
    await rank(h, userId);
    await rank(h, userId, { full: true });
    expect(await settingsRows(h)).toEqual(unregistered);

    expect(await ensureRegistered(h, T0)).toMatchObject({ registered: true });
    expect((await learnInputs(h, userId)).registered).toBe(true);
    expect(Object.keys(await registryOf(h))).toContain(exact);
  });
});

describe('deploy simulation (a model stored with the exact-sha context)', () => {
  it('retrains once into the same model with the family context, deactivates the old row without a reason, and settles', async () => {
    await begin(h, V113);
    const userId = await trained();
    const [v1] = await modelRows(h, userId);
    expect(v1!.active).toBe(true);
    expect(Object.keys(await registryOf(h))).toEqual([await exactShaOf(h)]);

    await simulatePreDeploy(h, userId);
    expect(await rankStatus(h, userId)).toBe('stale');

    await learn(userId);
    const rows = await modelRows(h, userId);
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    const [old, next] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(old.active).toBe(false);
    expect(old.metrics).not.toHaveProperty('deactivatedReason');
    expect(next.active).toBe(true);
    expect(next.weights).toEqual(v1!.weights);
    expect(next.intercept).toBe(v1!.intercept);
    expect(next.scaler).toEqual(v1!.scaler);
    expect(next.calibration).toEqual(v1!.calibration);

    const inputs = await learnInputs(h, userId);
    expect(next.metrics['contextSha']).toBe(
      currentContextSha(inputs, FEATURE_SPEC_V1_SHA, ownIdsOf(next)),
    );
    expect(next.metrics['familySha']).toBe(inputs.familySha);
    expect(next.metrics['familySha']).toBe(await familyShaOracle(h));
    expect(next.metrics['ratingSha']).toBe(await exactShaOf(h));
    expect(await rankStatus(h, userId)).toBe('current');

    await learn(userId);
    await learn(userId);
    expect((await modelRows(h, userId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it('why inputSha carries the family sha: a stale context under an unchanged inputSha deactivates the model as incompatible and stores no row', async () => {
    await begin(h, V113);
    const userId = await trained();
    const { oldContext } = await simulatePreDeploy(h, userId, { keepInputSha: true });
    const inputs = await learnInputs(h, userId);
    const [v1] = await modelRows(h, userId);
    expect(oldContext).not.toBe(currentContextSha(inputs, FEATURE_SPEC_V1_SHA, ownIdsOf(v1!)));

    await learn(userId);
    const rows = await modelRows(h, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.metrics['deactivatedReason']).toBe('incompatible');
    await learn(userId);
    expect(await modelRows(h, userId)).toHaveLength(1);
  });

  it('the input hash of unchanged data differs from the one the code before the family sha computed', async () => {
    await begin(h, V113);
    const userId = await trained();
    const inputs = await learnInputs(h, userId);
    expect(inputs.eligible).toHaveLength(RATED);
    expect(inputs.inputSha).not.toBe(oldInputSha(inputs));
  });
});

describe('the invariant between inputSha and the context', () => {
  it('a pin change inside a major changes inputSha but not the context; another major changes both', async () => {
    await begin(h, V113);
    await ensureRegistered(h);
    const userId = await rated();
    const own = [w.cardM];
    const ctx = (i: Awaited<ReturnType<typeof learnInputs>>) =>
      currentContextSha(i, FEATURE_SPEC_V1_SHA, own);

    const a = await learnInputs(h, userId);
    expect(a.ratingSha).toBe(await exactShaOf(h));
    expect(a.familySha).toBe(await familyShaOracle(h));

    await flip(h, V114);
    await ensureRegistered(h);
    const b = await learnInputs(h, userId);
    expect(b.ratingSha).toBe(await exactShaOf(h));
    expect(b.ratingSha).not.toBe(a.ratingSha);
    expect(b.familySha).toBe(a.familySha);
    expect(ctx(b)).toBe(ctx(a));
    expect(b.inputSha).not.toBe(a.inputSha);

    await flip(h, V2);
    await ensureRegistered(h);
    const c = await learnInputs(h, userId);
    expect(c.ratingSha).toBe(await exactShaOf(h));
    expect(c.familySha).not.toBe(a.familySha);
    expect(c.familySha).toBe(await familyShaOracle(h));
    expect(ctx(c)).not.toBe(ctx(a));
    expect(c.inputSha).not.toBe(a.inputSha);
    expect(c.inputSha).not.toBe(b.inputSha);
  });
});

describe('a within-family flip 1.13.0 to 1.14.0', () => {
  it('keeps the ratings eligible and the model active, retrains once, then settles', async () => {
    await begin(h, V113);
    await ensureRegistered(h);
    const userId = await trained();
    const [v1] = await modelRows(h, userId);
    expect(v1!.active).toBe(true);

    await flip(h, V114);
    await ensureRegistered(h);
    const inputs = await learnInputs(h, userId);
    expect(inputs.eligible).toHaveLength(RATED);
    expect(reasonCounts(inputs)).toEqual({ ok: RATED });
    expect(inputs.samples.every((s) => s.features?.ratingSha !== inputs.ratingSha)).toBe(true);
    expect((await modelRows(h, userId)).filter((row) => row.active).map((r) => r.version)).toEqual([
      1,
    ]);
    expect(await rankStatus(h, userId)).toBe('current');

    await learn(userId);
    const rows = await modelRows(h, userId);
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows.filter((row) => row.active).map((row) => row.version)).toEqual([2]);
    expect(rows[1]!.metrics['ratingSha']).toBe(await exactShaOf(h));
    expect(rows[1]!.metrics['familySha']).toBe(v1!.metrics['familySha']);
    expect(rows[1]!.metrics['contextSha']).toBe(v1!.metrics['contextSha']);
    expect(await rankStatus(h, userId)).toBe('current');

    await learn(userId);
    expect((await modelRows(h, userId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it('CONTROL: with the old sha not registered every rating is a rating_sha_mismatch', async () => {
    await begin(h, V113);
    const userId = await rated();
    await flip(h, V114);
    await ensureRegistered(h);
    const inputs = await learnInputs(h, userId);
    expect(inputs.eligible).toHaveLength(0);
    expect(reasonCounts(inputs)).toEqual({ rating_sha_mismatch: RATED });
  });
});

describe('across families 1.13.0 to 2.0.0', () => {
  it('makes every rating ineligible, retires the model, and only ratings given under 2.0.0 count', async () => {
    await begin(h, V113);
    await ensureRegistered(h);
    const userId = await trained();
    expect((await modelRows(h, userId))[0]!.active).toBe(true);

    await flip(h, V2, { answers: true });
    await ensureRegistered(h);
    const inputs = await learnInputs(h, userId);
    expect(inputs.eligible).toHaveLength(0);
    expect(reasonCounts(inputs)).toEqual({ rating_sha_mismatch: RATED });
    expect(await rankStatus(h, userId)).toBe('stale');

    await learn(userId);
    expect((await modelRows(h, userId)).filter((row) => row.active)).toHaveLength(0);

    const exact2 = await exactShaOf(h);
    await w.rateRange(userId, RATED, RATED + 12);
    const after = await learnInputs(h, userId);
    expect(after.eligible).toHaveLength(12);
    expect(after.eligible.every((s) => s.features?.ratingSha === exact2)).toBe(true);
    expect(reasonCounts(after)).toEqual({ ok: 12, rating_sha_mismatch: RATED });
  });
});

describe('the current sha needs no registry entry', () => {
  it('ratings stamped with the current exact sha are eligible with an empty registry', async () => {
    await begin(h, V113);
    const userId = await rated();
    const inputs = await learnInputs(h, userId);
    expect(inputs.registered).toBe(false);
    expect(inputs.eligible).toHaveLength(RATED);
    expect(reasonCounts(inputs)).toEqual({ ok: RATED });
    expect(await registryOf(h)).toEqual({});
  });
});

describe('house.nightly-learn', () => {
  it('registers a missing current sha once: the second run writes nothing', async () => {
    await begin(h, V113);
    const userId = await trained();
    await dropRegistry(h);
    await nightly();
    const exact = await exactShaOf(h);
    expect(Object.keys(await registryOf(h))).toEqual([exact]);
    expect((await registryOf(h))[exact]!.family).toBe(await familyShaOracle(h));
    const stamp = await registryStamp(h);
    const rows = await settingsRows(h);
    await nightly();
    expect(await registryStamp(h)).toBe(stamp);
    expect(
      (await settingsRows(h)).filter(
        (row) => (row as { key: string }).key === 'engine.rating_fingerprints',
      ),
    ).toEqual(rows.filter((row) => (row as { key: string }).key === 'engine.rating_fingerprints'));
    expect(userId).toBeTruthy();
  });

  it('enqueues user.learn after a within-family flip for the user whose inputs changed, not for one trained since', async () => {
    await begin(h, V113);
    await ensureRegistered(h);
    const flipped = await trained();
    await flip(h, V114, { answers: true });
    await ensureRegistered(h);
    const settled = await trained();
    await h.clearOutbox();
    const mark = await h.mark();

    await nightly();

    expect(await w.userIntents('user.learn', flipped, mark)).not.toHaveLength(0);
    expect(await w.userIntents('user.learn', settled, mark)).toHaveLength(0);
  });
});

describe('user.rank with a deploy-simulated stale model', () => {
  it('enqueues one user.learn and, once the retrain has run, none', async () => {
    await begin(h, V113);
    const userId = await trained();
    await simulatePreDeploy(h, userId);
    await h.clearOutbox();

    const first = await h.mark();
    await rank(h, userId);
    expect(await w.userIntents('user.learn', userId, first)).toHaveLength(1);

    await learn(userId);
    expect((await modelRows(h, userId)).filter((row) => row.active).map((r) => r.version)).toEqual([
      2,
    ]);
    const second = await h.mark();
    await rank(h, userId);
    await rank(h, userId, { full: true });
    expect(await w.userIntents('user.learn', userId, second)).toHaveLength(0);
  });
});

describe('answers retagged', () => {
  it('moves the pool to the pin model (fixture self-check)', async () => {
    await begin(h, V113);
    await retag(h, V113);
    const models = await h.owner.query<{ model: string }>(
      `SELECT DISTINCT model FROM card_answers WHERE engine = 'typesafe'`,
    );
    expect(models.rows.map((row) => row.model)).toEqual([V113]);
  });
});
