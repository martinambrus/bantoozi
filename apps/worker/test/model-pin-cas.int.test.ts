import { retryTransaction, type Transaction } from '@bantoozi/db';
import type { ClassificationDeps } from '../src/handlers/deps.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordModelPin } from '../src/model-pin.js';
import { lockRestartCurrent } from '../src/stale-worker.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  baseConfig,
  pinRow,
  rebuildIntents,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  type ModelProbeResultLike,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * Item 4 of FNF[jev-flip-safety]: `recordModelPin` is a compare-and-set against the worker's own
 * view. A process that read its settings long ago (the start probe may take 30 s) must neither move
 * the pin back after a newer worker pinned nor enqueue a second rebuild.
 */
const ALIAS = 'jev-latest';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const T1 = new Date('2026-10-20T11:00:00.000Z');
const WARN =
  "this worker's settings are out of date: the model pin is left to the restarted worker";

let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h);
});

const probeAnswer = (model: string): ModelProbeResultLike => ({
  requested: ALIAS,
  answered: model,
  ok: true,
  at: T0.toISOString(),
});

describe('C1: recordModelPin with isCurrent', () => {
  it('skips when the process view is out of date: no write, no intent', async () => {
    await h.owner.query(
      `UPDATE settings SET value = jsonb_set(value, '{model}', $1::jsonb) WHERE key = 'engine.model_pin'`,
      [JSON.stringify(NEW_MODEL)],
    );
    const before = await h.owner.query(
      `SELECT value::text AS v, updated_at FROM settings WHERE key = 'engine.model_pin'`,
    );
    const result = await recordModelPin(h.db, { model: OLD_MODEL }, T1, {
      isCurrent: async () => false,
    });
    expect(result).toEqual({ changed: false, skipped: true });
    const after = await h.owner.query(
      `SELECT value::text AS v, updated_at FROM settings WHERE key = 'engine.model_pin'`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(await rebuildIntents(h.owner)).toEqual([]);
  });

  it('moves the pin and enqueues one pair when isCurrent says yes', async () => {
    const result = await recordModelPin(h.db, { model: NEW_MODEL }, T1, {
      isCurrent: async () => true,
    });
    expect(result).toEqual({ changed: true });
    expect(await pinRow(h.owner)).toMatchObject({ model: NEW_MODEL, since: T1.toISOString() });
    const intents = await rebuildIntents(h.owner);
    expect(intents.map((i) => i.queue)).toEqual(['house.reenrich', 'house.rematch']);
  });
});

describe('C2/C3: the runtime race', () => {
  it('a worker whose start probe outlived a settings change leaves the pin to the restarted worker', async () => {
    await setSetting(h.owner, 'engine.typesafe_model', ALIAS);
    let release!: (r: ModelProbeResultLike) => void;
    let entered!: () => void;
    const inProbe = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<ModelProbeResultLike>((resolve) => (release = resolve));
    const recA = recorder();
    const starting = startRuntime({
      db: h.db,
      config: baseConfig('test'),
      recorder: recA,
      now: () => T0,
      modelProbe: async () => {
        entered();
        return gate;
      },
    });
    await inProbe;
    await setSetting(h.owner, 'engine.typesafe_model', NEW_MODEL);
    const recB = recorder();
    const b = await startRuntime({
      db: h.db,
      config: baseConfig('test'),
      recorder: recB,
      now: () => T1,
    });
    runtimes.push(b);
    const pinned = await pinRow(h.owner);
    expect(pinned).toMatchObject({ model: NEW_MODEL });
    expect(pinned).not.toHaveProperty('alias');
    expect(await rebuildIntents(h.owner)).toHaveLength(2);

    release(probeAnswer(OLD_MODEL));
    const a = await starting;
    runtimes.push(a);
    expect(await pinRow(h.owner)).toEqual(pinned);
    expect(await rebuildIntents(h.owner)).toHaveLength(2);
    expect(recA.logs.some((l) => l.level === 'warn' && l.msg === WARN)).toBe(true);
    expect(await a.check()).toMatchObject({ pendingRestart: true });
  });

  it('control: with nothing changed meanwhile the worker pins as before', async () => {
    await setSetting(h.owner, 'engine.typesafe_model', ALIAS);
    const rec = recorder();
    const a = await startRuntime({
      db: h.db,
      config: baseConfig('test'),
      recorder: rec,
      now: () => T0,
      modelProbe: async () => probeAnswer(NEW_MODEL),
    });
    runtimes.push(a);
    expect(await pinRow(h.owner)).toMatchObject({ model: NEW_MODEL, alias: ALIAS });
    expect(await rebuildIntents(h.owner)).toHaveLength(2);
    expect(rec.logs.some((l) => l.msg === WARN)).toBe(false);
  });
});

describe('C4: lockRestartCurrent lock discipline', () => {
  it('blocks a restart-key writer, not the resolution or the pin row', async () => {
    await setSetting(h.owner, 'engine.model_resolution', { alias: ALIAS, model: OLD_MODEL });
    await setSetting(h.owner, 'engine.typesafe_model', OLD_MODEL);
    const classification = {
      currentness: {
        fingerprint: 'f',
        pin: { model: OLD_MODEL },
        restartFingerprint: async () => 'f',
      },
    } as unknown as Pick<ClassificationDeps, 'currentness'>;
    let locked!: () => void;
    let finish!: () => void;
    const lockedP = new Promise<void>((resolve) => (locked = resolve));
    const done = new Promise<void>((resolve) => (finish = resolve));
    const holder = retryTransaction(h.db, async (tx: Transaction) => {
      expect(await lockRestartCurrent(tx, classification)).toBe(true);
      locked();
      await done;
    });
    await lockedP;
    const probe = async (key: string): Promise<'ok' | 'blocked'> => {
      const client = await h.owner.connect();
      try {
        await client.query(`SET lock_timeout = '300ms'`);
        await client.query(`UPDATE settings SET updated_at = now() WHERE key = $1`, [key]);
        return 'ok';
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return 'blocked';
        throw error;
      } finally {
        client.release();
      }
    };
    expect(await probe('engine.model_resolution')).toBe('ok');
    expect(await probe('engine.model_pin')).toBe('ok');
    expect(await probe('engine.typesafe_model')).toBe('blocked');
    finish();
    await holder;
    expect(await probe('engine.typesafe_model')).toBe('ok');
  });
});
