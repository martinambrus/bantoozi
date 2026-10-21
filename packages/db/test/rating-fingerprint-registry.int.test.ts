import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RATING_FINGERPRINTS_MAX } from '@bantoozi/shared';

import {
  ratingFingerprintOf,
  readRatingFingerprint,
  readRatingFingerprintState,
  registerRatingFingerprint,
  type RatingDefaults,
  type RatingFingerprint,
} from '../src/index.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * JEV-4 T1 ruler: the worker-written registry `engine.rating_fingerprints` (register once, cap 64 with
 * the eviction order of the contract, self-heal) and its reader through the API role.
 */

let ctx: DbTestContext;
beforeAll(async () => {
  ctx = await setupDbTest();
});
afterAll(async () => {
  await ctx.close();
});

const KEY = 'engine.rating_fingerprints';
const defaults: RatingDefaults = {
  model: 'jev-1.13.0',
  languageModes: { sk: 'translate' },
  cardTextMode: 'as_written',
};
const FAM_A = 'a'.repeat(64);
const FAM_B = 'b'.repeat(64);
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const shaOf = (i: number): string => i.toString(16).padStart(64, '0');
const synth = (i: number, family: string): RatingFingerprint => ({
  sha: shaOf(i),
  familySha: family,
  settings: { n: i, language_modes: { sk: 'native' } },
});

interface Stored {
  [sha: string]: { family: string; settings: Record<string, unknown>; firstSeenAt: string };
}
async function stored(): Promise<Stored> {
  const r = await ctx.owner.query<{ value: Stored }>('SELECT value FROM settings WHERE key = $1', [
    KEY,
  ]);
  return r.rows[0]?.value ?? {};
}
async function updatedAt(): Promise<string | undefined> {
  const r = await ctx.owner.query<{ t: string }>(
    'SELECT updated_at::text AS t FROM settings WHERE key = $1',
    [KEY],
  );
  return r.rows[0]?.t;
}
async function putRaw(value: unknown): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [KEY, JSON.stringify(value)],
  );
}

beforeEach(async () => {
  await ctx.owner.query('DELETE FROM settings WHERE key = $1', [KEY]);
});

describe('JEV-4 registerRatingFingerprint', () => {
  it('RG1 adds {family, settings, firstSeenAt: now} for a new sha', async () => {
    const fp = synth(1, FAM_A);
    await expect(registerRatingFingerprint(ctx.worker, fp, at(0))).resolves.toEqual({
      registered: true,
      evicted: 0,
    });
    expect(await stored()).toEqual({
      [fp.sha]: { family: FAM_A, settings: fp.settings, firstSeenAt: at(0).toISOString() },
    });
  });

  it('RG2 registering the same sha again does nothing: registered false, row untouched', async () => {
    const fp = synth(1, FAM_A);
    await registerRatingFingerprint(ctx.worker, fp, at(0));
    const before = await updatedAt();
    const snapshot = await stored();
    await expect(registerRatingFingerprint(ctx.worker, fp, at(5))).resolves.toEqual({
      registered: false,
      evicted: 0,
    });
    expect(await updatedAt()).toBe(before);
    expect(await stored()).toEqual(snapshot);
    expect(snapshot[fp.sha]?.firstSeenAt).toBe(at(0).toISOString());
  });

  it('RG3 a real fingerprint round-trips through the registry', async () => {
    const fp = ratingFingerprintOf(
      new Map([['engine.model_pin', { model: 'jev-1.14.0', since: '2026-10-21T00:00:00.000Z' }]]),
      defaults,
    );
    await registerRatingFingerprint(ctx.worker, fp, at(0));
    expect((await stored())[fp.sha]).toEqual({
      family: fp.familySha,
      settings: fp.settings,
      firstSeenAt: at(0).toISOString(),
    });
  });

  it('RG4 40 concurrent registrations of distinct shas all land, without error', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        registerRatingFingerprint(ctx.worker, synth(i + 1, FAM_A), at(i)),
      ),
    );
    expect(results.every((r) => r.registered)).toBe(true);
    expect(Object.keys(await stored())).toHaveLength(40);
  });

  it('RG5 concurrent registrations of one sha register it once', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        registerRatingFingerprint(ctx.worker, synth(7, FAM_A), at(0)),
      ),
    );
    expect(results.filter((r) => r.registered)).toHaveLength(1);
    expect(Object.keys(await stored())).toEqual([shaOf(7)]);
  });

  it('RG6 the cap: after 70 mixed-family registrations exactly 64 remain and the order of eviction holds', async () => {
    const model = new Map<string, { family: string; firstSeenAt: number }>();
    let evictedTotal = 0;
    for (let i = 1; i <= 70; i += 1) {
      const family = i % 3 === 0 ? FAM_A : FAM_B;
      const fp = synth(i, family);
      model.set(fp.sha, { family, firstSeenAt: at(i).getTime() });
      let expectedEvicted = 0;
      while (model.size > RATING_FINGERPRINTS_MAX) {
        const victims = [...model.entries()].filter(([sha]) => sha !== fp.sha);
        const other = victims.filter(([, e]) => e.family !== family);
        const pool = other.length > 0 ? other : victims;
        pool.sort(([sa, a], [sb, b]) => a.firstSeenAt - b.firstSeenAt || (sa < sb ? -1 : 1));
        const victim = pool[0];
        if (victim === undefined) throw new Error('no victim');
        model.delete(victim[0]);
        expectedEvicted += 1;
      }
      const r = await registerRatingFingerprint(ctx.worker, fp, at(i));
      expect(r).toEqual({ registered: true, evicted: expectedEvicted });
      evictedTotal += r.evicted;
    }
    const now = await stored();
    expect(Object.keys(now)).toHaveLength(RATING_FINGERPRINTS_MAX);
    expect(evictedTotal).toBe(6);
    expect(Object.keys(now).sort()).toEqual([...model.keys()].sort());
    expect(now[shaOf(69)]).toBeDefined();
  });

  it('RG7 the sha being registered is kept even when it is the oldest, other families go first (oldest first)', async () => {
    for (let i = 1; i <= RATING_FINGERPRINTS_MAX; i += 1) {
      await registerRatingFingerprint(ctx.worker, synth(i, FAM_B), at(100 + i));
    }
    const current = synth(900, FAM_A);
    await expect(registerRatingFingerprint(ctx.worker, current, at(0))).resolves.toEqual({
      registered: true,
      evicted: 1,
    });
    const now = await stored();
    expect(Object.keys(now)).toHaveLength(RATING_FINGERPRINTS_MAX);
    expect(now[current.sha]).toBeDefined();
    expect(now[shaOf(1)]).toBeUndefined();
    expect(now[shaOf(2)]).toBeDefined();
  });

  it('RG8 with only same-family entries the oldest same-family one goes, never the sha being registered', async () => {
    for (let i = 1; i <= RATING_FINGERPRINTS_MAX; i += 1) {
      await registerRatingFingerprint(ctx.worker, synth(i, FAM_A), at(100 + i));
    }
    const current = synth(900, FAM_A);
    await expect(registerRatingFingerprint(ctx.worker, current, at(0))).resolves.toEqual({
      registered: true,
      evicted: 1,
    });
    const now = await stored();
    expect(Object.keys(now)).toHaveLength(RATING_FINGERPRINTS_MAX);
    expect(now[current.sha]).toBeDefined();
    expect(now[shaOf(1)]).toBeUndefined();
    expect(now[shaOf(2)]).toBeDefined();
  });

  it('RG9 ties in firstSeenAt are evicted in sha order', async () => {
    for (let i = 1; i <= RATING_FINGERPRINTS_MAX; i += 1) {
      await registerRatingFingerprint(ctx.worker, synth(i, FAM_B), at(50));
    }
    await registerRatingFingerprint(ctx.worker, synth(900, FAM_A), at(60));
    const now = await stored();
    expect(now[shaOf(1)]).toBeUndefined();
    expect(now[shaOf(2)]).toBeDefined();
  });

  it('RG10 an invalid entry is dropped by the next registration', async () => {
    await putRaw({
      [shaOf(5)]: { family: 'nope', settings: {}, firstSeenAt: at(0).toISOString() },
      [shaOf(6)]: { family: FAM_A, settings: {}, firstSeenAt: at(0).toISOString(), extra: 1 },
      [shaOf(7)]: { family: FAM_A, settings: { k: 1 }, firstSeenAt: at(0).toISOString() },
    });
    const fp = synth(8, FAM_A);
    await expect(registerRatingFingerprint(ctx.worker, fp, at(1))).resolves.toMatchObject({
      registered: true,
    });
    expect(Object.keys(await stored()).sort()).toEqual([shaOf(7), shaOf(8)]);
  });

  it.each([
    ['a string', 'junk'],
    ['an array', [1, 2]],
    ['null', null],
    ['a number', 3],
  ])('RG11 a stored value that is %s is replaced by the next registration', async (_n, raw) => {
    await putRaw(raw);
    const fp = synth(1, FAM_A);
    await expect(registerRatingFingerprint(ctx.worker, fp, at(0))).resolves.toMatchObject({
      registered: true,
    });
    expect(Object.keys(await stored())).toEqual([fp.sha]);
  });
});

describe('JEV-4 readRatingFingerprintState', () => {
  it('RS1 the API role sees the registered entries and the current sha', async () => {
    const before = await readRatingFingerprintState(ctx.app, defaults);
    expect(before.registered).toBe(false);
    expect(before.families).toEqual({ [before.sha]: before.familySha });
    await registerRatingFingerprint(ctx.worker, synth(1, FAM_B), at(0));
    await registerRatingFingerprint(
      ctx.worker,
      { sha: before.sha, familySha: before.familySha, settings: before.settings },
      at(1),
    );
    const after = await readRatingFingerprintState(ctx.app, defaults);
    expect(after.registered).toBe(true);
    expect(after.sha).toBe(before.sha);
    expect(after.families).toEqual({ [shaOf(1)]: FAM_B, [before.sha]: before.familySha });
  });

  it('RS2 negative control: an unregistered sha is absent from families', async () => {
    await registerRatingFingerprint(ctx.worker, synth(1, FAM_B), at(0));
    const state = await readRatingFingerprintState(ctx.app, defaults);
    expect(state.families[shaOf(2)]).toBeUndefined();
    expect(Object.hasOwn(state.families, shaOf(2))).toBe(false);
    expect(state.registered).toBe(false);
  });

  it('RS3 readRatingFingerprint still returns the exact sha string, unaffected by the registry', async () => {
    const exact = await readRatingFingerprint(ctx.app, defaults);
    expect(exact).toMatch(/^[0-9a-f]{64}$/);
    await registerRatingFingerprint(ctx.worker, synth(1, FAM_B), at(0));
    expect(await readRatingFingerprint(ctx.app, defaults)).toBe(exact);
    expect((await readRatingFingerprintState(ctx.app, defaults)).sha).toBe(exact);
  });
});
