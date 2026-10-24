import { randomUUID } from 'node:crypto';

import { createDatabase, readSettingRows } from '@bantoozi/db';
import { AdminEngineModelSchema } from '@bantoozi/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { seedModelState, type ProbeSeed } from './support/model-state.js';

/**
 * JEV-5 (visible-learning §4.1): the admin model gate and the model routes.
 *
 * - `PATCH /admin/settings` refuses a change of the EFFECTIVE `engine.typesafe_model` unless
 *   `settings['engine.model_probe']` holds a fresh probe of the NEW value that confirms it (409
 *   `model_probe_required` / `model_probe_failed`), and asks for `acknowledge: true` only when the
 *   change restarts personal models (another Jev family); same-major releases and the alias
 *   answering one are kept.
 * - `GET /admin/engine/model`, `POST /admin/engine/model-probe`, `POST /admin/engine/model-check`.
 *
 * Harness defaults: env `TYPESAFE_MODEL=jev-1.13.0`, system clock, rate limits off.
 */

const MIN = 60_000;
const SINCE = '2026-10-01T00:00:00.000Z';

let h: ApiHarness;
let admin: TestUser;
let admin2: TestUser;
let reader: TestUser;
let prod: FastifyInstance;

interface OutboxRow {
  queue: string;
  payload: Record<string, unknown>;
  user_id: string | null;
}

async function outbox(): Promise<OutboxRow[]> {
  const result = await h.owner.query<OutboxRow>(
    'SELECT queue, payload, user_id FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
  );
  return result.rows;
}

async function stored(key: string): Promise<unknown> {
  const result = await h.owner.query<{ value: unknown }>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value;
}

async function setRow(key: string, value: unknown): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function clearModelSetting(): Promise<void> {
  await h.owner.query("DELETE FROM settings WHERE key = 'engine.typesafe_model'");
}

const ok = (id: string, extra: Partial<ProbeSeed> = {}): ProbeSeed => ({
  requested: id,
  answered: id,
  ...extra,
});

const patch = (
  body: unknown,
  options: { server?: FastifyInstance; key?: string } = {},
): ReturnType<ReturnType<typeof apiClient>['patch']> =>
  apiClient(options.server ?? h.server, admin).patch(
    '/admin/settings',
    body,
    options.key === undefined ? {} : { idempotencyKey: options.key },
  );
const setModel = (model: string | null, extra: Record<string, unknown> = {}) =>
  patch({ 'engine.typesafe_model': model, ...extra });
const status = (server: FastifyInstance = h.server, user: TestUser | null = admin) =>
  apiClient(server, user).get('/admin/engine/model');

/** The acknowledgement is not the gate: with the probe gone, `acknowledge: true` is still refused. */
async function expectProbeStillRequired(model: string): Promise<void> {
  await h.owner.query("DELETE FROM settings WHERE key = 'engine.model_probe'");
  const res = await setModel(model, { acknowledge: true });
  expect(res.statusCode, res.body).toBe(409);
  expect(details(res)).toEqual({ reason: 'model_probe_required', model });
}

function details(res: { json: () => { error: { details: unknown } } }): unknown {
  return res.json().error.details;
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  admin2 = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
  prod = await h.buildAnother({
    env: {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://bantoozi.test',
      MAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://127.0.0.1:1',
      RATE_LIMITS_ENABLED: 'true',
      PROVIDER_HOST_ALLOWLIST: 'api.typesafe.ai,ollama.com',
    },
  });
}, 120_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query('DELETE FROM job_outbox');
  await h.owner.query('DELETE FROM rate_limit_buckets');
  await h.owner.query(
    `DELETE FROM settings WHERE key LIKE 'engine.%' AND key NOT LIKE 'engine.circuit%'`,
  );
  await seedModelState(h, { reset: true });
});

describe('P1-P3: the probe gate', () => {
  it('P1 no probe: 409 model_probe_required and nothing is written', async () => {
    const res = await setModel('jev-1.14.0');
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(details(res)).toEqual({ reason: 'model_probe_required', model: 'jev-1.14.0' });
    expect(await stored('engine.typesafe_model')).toBeUndefined();
    expect(await outbox()).toEqual([]);
  });

  it.each([
    ['9m59s old', -(10 * MIN - 1000), 200],
    ['11 minutes old', -11 * MIN, 409],
    ['30 s in the future (clock skew)', 30_000, 200],
    ['120 s in the future', 120_000, 409],
  ])('P2 freshness: a probe %s', async (_name, offsetMs, statusCode) => {
    await seedModelState(h, { probes: [ok('jev-1.14.0', { offsetMs })] });
    const res = await setModel('jev-1.14.0');
    expect(res.statusCode, res.body).toBe(statusCode);
    if (statusCode === 409) {
      expect(details(res)).toEqual({ reason: 'model_probe_required', model: 'jev-1.14.0' });
      expect(await stored('engine.typesafe_model')).toBeUndefined();
    } else {
      expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
    }
  });

  const AT = new Date(Date.now() - 2 * MIN).toISOString();
  it.each<[string, string, ProbeSeed, Record<string, unknown>]>([
    [
      'ok:false, Jev answered another id',
      'jev-1.14.0',
      { requested: 'jev-1.14.0', answered: 'jev-1.15.0', ok: false, error: 'model_mismatch' },
      { answered: 'jev-1.15.0', error: 'model_mismatch' },
    ],
    [
      'ok:true but Jev answered another id (error synthesized)',
      'jev-1.14.0',
      { requested: 'jev-1.14.0', answered: 'jev-1.15.0' },
      { answered: 'jev-1.15.0', error: 'model_mismatch' },
    ],
    [
      'ok:true without an answer (error synthesized)',
      'jev-1.14.0',
      { requested: 'jev-1.14.0' },
      { error: 'model_mismatch' },
    ],
    [
      'no answer at all (model_unavailable)',
      'jev-1.14.0',
      { requested: 'jev-1.14.0', ok: false, error: 'model_unavailable' },
      { error: 'model_unavailable' },
    ],
    [
      'the alias answered itself',
      'jev-latest',
      { requested: 'jev-latest', answered: 'jev-latest' },
      { answered: 'jev-latest', error: 'alias_unresolved' },
    ],
    [
      'the alias answered jev-fake',
      'jev-latest',
      { requested: 'jev-latest', answered: 'jev-fake' },
      { answered: 'jev-fake', error: 'alias_unresolved' },
    ],
  ])('P3 not confirming (%s): 409 model_probe_failed', async (_name, model, seed, expected) => {
    await seedModelState(h, { probes: [{ ...seed, at: AT }] });
    const res = await setModel(model, { acknowledge: true });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(details(res)).toEqual({ reason: 'model_probe_failed', model, at: AT, ...expected });
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });
});

describe('P4-P9: the impact of a confirmed change', () => {
  it('P4 env 1.13.0 -> 1.14.0 with a fresh ok probe: 200, no acknowledge, nothing queued', async () => {
    await seedModelState(h, { probes: [ok('jev-1.14.0')] });
    const res = await setModel('jev-1.14.0');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual(['engine.typesafe_model']);
    expect(res.json().queued).toEqual([]);
    expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
  });

  it('P5 another family needs the acknowledgement', async () => {
    await seedModelState(h, { probes: [ok('jev-2.0.0')] });
    const refused = await setModel('jev-2.0.0');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(details(refused)).toEqual({
      reason: 'confirmation_required',
      effects: ['reenrich', 'rematch'],
    });
    expect(await stored('engine.typesafe_model')).toBeUndefined();
    await expectProbeStillRequired('jev-2.0.0');
    await seedModelState(h, { probes: [ok('jev-2.0.0')] });
    const accepted = await setModel('jev-2.0.0', { acknowledge: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await stored('engine.typesafe_model')).toBe('jev-2.0.0');
  });

  it.each<[string, number, string | null]>([
    ['jev-1.14.0', 200, null],
    ['jev-1.13.0', 200, null],
    ['jev-2.0.0', 409, 'confirmation_required'],
  ])('P6 stored 1.14.0 -> jev-latest answering %s: %i', async (answered, code, reason) => {
    await setRow('engine.typesafe_model', 'jev-1.14.0');
    await seedModelState(h, {
      pin: { model: 'jev-1.14.0' },
      probes: [{ requested: 'jev-latest', answered }],
    });
    const res = await setModel('jev-latest');
    expect(res.statusCode, res.body).toBe(code);
    if (reason !== null) {
      expect((details(res) as { reason: string }).reason).toBe(reason);
      expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
      await expectProbeStillRequired('jev-latest');
    } else {
      expect(await stored('engine.typesafe_model')).toBe('jev-latest');
    }
  });

  it('P7 a stale resolution is not a step of the path: the alias answering the current model changes nothing', async () => {
    await setRow('engine.typesafe_model', 'jev-2.0.0');
    await seedModelState(h, {
      pin: { model: 'jev-2.0.0' },
      resolution: { model: 'jev-1.13.0' },
      probes: [{ requested: 'jev-latest', answered: 'jev-2.0.0' }],
    });
    const res = await setModel('jev-latest');
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored('engine.typesafe_model')).toBe('jev-latest');
    // Control: without the resolution the same change is the same.
    await setRow('engine.typesafe_model', 'jev-2.0.0');
    await h.owner.query("DELETE FROM settings WHERE key = 'engine.model_resolution'");
    const control = await setModel('jev-latest');
    expect(control.statusCode, control.body).toBe(200);
    expect(await stored('engine.typesafe_model')).toBe('jev-latest');
  });

  it.each<[string, number]>([
    ['jev-1.13.0', 200],
    ['jev-1.14.0', 200],
    ['jev-2.0.0', 409],
  ])('P8 stored jev-latest resolved to 1.13.0 -> %s: %i', async (target, code) => {
    await setRow('engine.typesafe_model', 'jev-latest');
    await seedModelState(h, { resolution: { model: 'jev-1.13.0' }, probes: [ok(target)] });
    const res = await setModel(target);
    expect(res.statusCode, res.body).toBe(code);
    if (code === 200) {
      expect(res.json().changed).toEqual(['engine.typesafe_model']);
      expect(await stored('engine.typesafe_model')).toBe(target);
    } else {
      expect((details(res) as { reason: string }).reason).toBe('confirmation_required');
      expect(await stored('engine.typesafe_model')).toBe('jev-latest');
      await expectProbeStillRequired(target);
    }
  });

  it('P9 reset targets the env default: it needs its probe, and the acknowledgement from another family', async () => {
    await setRow('engine.typesafe_model', 'jev-2.0.0');
    const unprobed = await setModel(null, { acknowledge: true });
    expect(unprobed.statusCode, unprobed.body).toBe(409);
    expect(details(unprobed)).toEqual({ reason: 'model_probe_required', model: 'jev-1.13.0' });

    await seedModelState(h, { probes: [ok('jev-1.13.0')] });
    const unacknowledged = await setModel(null);
    expect(unacknowledged.statusCode, unacknowledged.body).toBe(409);
    expect((details(unacknowledged) as { reason: string }).reason).toBe('confirmation_required');
    expect(await stored('engine.typesafe_model')).toBe('jev-2.0.0');

    const acknowledged = await setModel(null, { acknowledge: true });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    const settings = await apiClient(h.server, admin).get('/admin/settings');
    expect(settings.json().sources['engine.typesafe_model']).toBe('env');
    expect(settings.json().values['engine.typesafe_model']).toBe('jev-1.13.0');
  });

  it('P9 a reset whose effective value stays equal needs no probe', async () => {
    await setRow('engine.typesafe_model', 'jev-1.13.0'); // equals the env default
    const res = await setModel(null);
    expect(res.statusCode, res.body).toBe(200);
    const settings = await apiClient(h.server, admin).get('/admin/settings');
    expect(settings.json().sources['engine.typesafe_model']).toBe('env');
  });
});

describe('P10-P13: scope of the gate, replays, garbage rows', () => {
  it('P10 a no-op PATCH is not gated', async () => {
    const same = await setModel('jev-1.13.0');
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().changed).toEqual([]);
    const reset = await setModel(null);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().changed).toEqual([]);
    await setRow('engine.typesafe_model', 'jev-1.14.0');
    const again = await setModel('jev-1.14.0');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().changed).toEqual([]);
  });

  it('P11 the whole patch is refused: a sibling key is not written', async () => {
    const res = await patch({ 'engine.typesafe_model': 'jev-1.14.0', 'engine.concurrency': 3 });
    expect(res.statusCode, res.body).toBe(409);
    expect((details(res) as { reason: string }).reason).toBe('model_probe_required');
    expect(await stored('engine.concurrency')).toBeUndefined();
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });

  it('P12 a committed PATCH replays although its probe is gone; a new key is gated again', async () => {
    await seedModelState(h, { probes: [ok('jev-1.14.0')] });
    const key = randomUUID();
    const committed = await patch({ 'engine.typesafe_model': 'jev-1.14.0' }, { key });
    expect(committed.statusCode, committed.body).toBe(200);
    await h.owner.query("DELETE FROM settings WHERE key = 'engine.model_probe'");
    const replay = await patch({ 'engine.typesafe_model': 'jev-1.14.0' }, { key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().changed).toEqual(['engine.typesafe_model']);

    await clearModelSetting(); // the same body would be a no-op otherwise
    const fresh = await patch({ 'engine.typesafe_model': 'jev-1.14.0' });
    expect(fresh.statusCode, fresh.body).toBe(409);
    expect((details(fresh) as { reason: string }).reason).toBe('model_probe_required');
    const replayAgain = await patch({ 'engine.typesafe_model': 'jev-1.14.0' }, { key });
    expect(replayAgain.statusCode, replayAgain.body).toBe(200);
  });

  const now = () => new Date().toISOString();
  const entry = (requested: string, answered = requested, at = now()) => ({
    requested,
    answered,
    ok: true,
    at,
  });
  const eleven = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => {
      const id = `jev-3.${i}.0`;
      return [id, entry(id)];
    }).concat([
      [
        'jev-1.14.0',
        entry('jev-1.14.0', 'jev-1.14.0', new Date(Date.now() - 5 * MIN).toISOString()),
      ],
    ]),
  );
  it.each<[string, Record<string, unknown>]>([
    ['a probe row that is not an object', { 'engine.model_probe': 'garbage' }],
    ['a probe row that is a number', { 'engine.model_probe': 42 }],
    [
      'an entry whose requested differs from its key',
      { 'engine.model_probe': { 'jev-1.14.0': entry('jev-1.15.0', 'jev-1.14.0') } },
    ],
    ['an entry that is not an object', { 'engine.model_probe': { 'jev-1.14.0': 'x' } }],
    ['eleven entries (the target is the oldest)', { 'engine.model_probe': eleven }],
    [
      'a pin with llm:null and a setting that follows the alias',
      {
        'engine.model_pin': { model: 'jev-1.13.0', llm: null, since: SINCE },
        'engine.typesafe_model': 'jev-latest',
      },
    ],
    [
      'a malformed resolution',
      {
        'engine.model_resolution': { alias: 'jev-latest', model: 'nonsense' },
        'engine.typesafe_model': 'jev-latest',
      },
    ],
  ])('P13 garbage rows (%s): 409 required on PATCH, 200 on GET, never 500', async (_name, raw) => {
    for (const [key, value] of Object.entries(raw)) await setRow(key, value);
    const res = await setModel('jev-1.14.0');
    expect(res.statusCode, res.body).toBe(409);
    expect(details(res)).toEqual({ reason: 'model_probe_required', model: 'jev-1.14.0' });
    const get = await status(await h.buildAnother());
    expect(get.statusCode, get.body).toBe(200);
    AdminEngineModelSchema.parse(get.json());
  });

  it('P13 control: a malformed resolution reads as absent, the pin decides', async () => {
    await setRow('engine.typesafe_model', 'jev-latest');
    await setRow('engine.model_resolution', { alias: 'jev-latest', model: 'nonsense' });
    await seedModelState(h, { pin: { model: 'jev-1.13.0' }, probes: [ok('jev-1.14.0')] });
    const res = await setModel('jev-1.14.0');
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('P14-P18: validation order, recheck, acknowledgements', () => {
  it('P14 production: unpinned ids are 400 before the gate', async () => {
    for (const model of ['jev-beta', 'Jev-Latest']) {
      const res = await patch(
        { 'engine.typesafe_model': model, acknowledge: true },
        { server: prod },
      );
      expect(res.statusCode, `${model} ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      expect(res.json().error.details.key).toBe('engine.typesafe_model');
    }
    // Control: a pinned id without a probe passes the schema rules and meets the gate.
    const gated = await patch({ 'engine.typesafe_model': 'jev-1.14.0' }, { server: prod });
    expect(gated.statusCode, gated.body).toBe(409);
    expect((details(gated) as { reason: string }).reason).toBe('model_probe_required');
  });

  it('P15 outside production an id that cannot be probed is 400, not a 409 loop', async () => {
    const res = await setModel('vendor/model-1', { acknowledge: true });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.details.key).toBe('engine.typesafe_model');
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });

  /** Holds the settings lock of the model key, fires the PATCH, lets `flip` change rows, releases. */
  async function patchBlockedOnLock(flip: () => Promise<void>) {
    const holder = await h.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('settings:engine.typesafe_model'))",
      );
      const pending = setModel('jev-1.14.0', { acknowledge: true });
      await vi.waitFor(
        async () => {
          const { rows } = await h.owner.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          expect(rows[0]?.n).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 },
      );
      await flip();
      await holder.query('COMMIT');
      return await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  it('P16 the gate is checked again under the lock: a probe deleted after the first check', async () => {
    await seedModelState(h, { probes: [ok('jev-1.14.0')] });
    const res = await patchBlockedOnLock(async () => {
      await h.owner.query("DELETE FROM settings WHERE key = 'engine.model_probe'");
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(details(res)).toEqual({ reason: 'model_probe_required', model: 'jev-1.14.0' });
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });

  it('P16 the gate is checked again under the lock: a probe flipped to a failure', async () => {
    await seedModelState(h, { probes: [ok('jev-1.14.0')] });
    const res = await patchBlockedOnLock(async () => {
      await seedModelState(h, {
        probes: [{ requested: 'jev-1.14.0', ok: false, error: 'model_unavailable' }],
      });
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((details(res) as { reason: string }).reason).toBe('model_probe_failed');
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });

  it('P17 the llm_fallback and ollama_models acknowledgements are unchanged (no probe involved)', async () => {
    const refused = await patch({ 'engine.llm_fallback_enabled': true });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(details(refused)).toEqual({
      reason: 'confirmation_required',
      effects: ['reenrich', 'rematch'],
    });
    const accepted = await patch({ 'engine.llm_fallback_enabled': true, acknowledge: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const models = { fast: 'glm-5.3-flash', strong: 'glm-5.3' };
    const ollama = await patch({ 'engine.ollama_models': models });
    expect(ollama.statusCode, ollama.body).toBe(409);
    expect((details(ollama) as { reason: string }).reason).toBe('confirmation_required');
    const ollamaAck = await patch({ 'engine.ollama_models': models, acknowledge: true });
    expect(ollamaAck.statusCode, ollamaAck.body).toBe(200);
    expect(await outbox()).toEqual([]);
  });

  it('P18 acknowledge:true never bypasses the probe', async () => {
    const res = await setModel('jev-2.0.0', { acknowledge: true });
    expect(res.statusCode, res.body).toBe(409);
    expect(details(res)).toEqual({ reason: 'model_probe_required', model: 'jev-2.0.0' });
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });
});

describe('R1, R6: GET /admin/engine/model', () => {
  it('R1/R6 default: no rows at all is a 200 with the env setting and empty state', async () => {
    const res = await status(await h.buildAnother());
    expect(res.statusCode, res.body).toBe(200);
    const body = AdminEngineModelSchema.parse(res.json());
    expect(body).toMatchObject({
      setting: { value: 'jev-1.13.0', source: 'env' },
      resolution: null,
      pin: null,
      watch: { lastCheck: null },
      probes: {},
      impact: null,
    });
    expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(60_000);
  });

  it('R1 after a PATCH the setting is stored', async () => {
    const server = await h.buildAnother();
    await seedModelState(h, { probes: [ok('jev-1.14.0')] });
    const saved = await patch({ 'engine.typesafe_model': 'jev-1.14.0' }, { server });
    expect(saved.statusCode, saved.body).toBe(200);
    const res = await status(server);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().setting).toEqual({ value: 'jev-1.14.0', source: 'stored' });
    expect(res.json().probes['jev-1.14.0'].answered).toBe('jev-1.14.0');
  });

  it('R1 a pin that carries llm and laya is mapped to model, alias and since', async () => {
    await seedModelState(h, {
      pin: {
        model: 'jev-1.13.0',
        alias: 'jev-latest',
        llm: { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
        laya: { checkpointSha: 'a'.repeat(64), calibrationVersion: 'v1' },
      },
      resolution: { model: 'jev-1.13.0' },
    });
    const res = await status(await h.buildAnother());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pin).toEqual({ model: 'jev-1.13.0', alias: 'jev-latest', since: SINCE });
    expect(res.json().resolution.model).toBe('jev-1.13.0');
  });

  it('R1 twelve probes are capped to the newest ten; garbage entries are ignored', async () => {
    const at = (i: number) => new Date(Date.now() - (20 - i) * 1000).toISOString();
    const probes = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => {
        const id = `jev-4.${i}.0`;
        return [id, { requested: id, answered: id, ok: true, at: at(i) }];
      }),
    );
    await seedModelState(h, { raw: { 'engine.model_probe': probes } });
    const capped = await status(await h.buildAnother());
    expect(capped.statusCode, capped.body).toBe(200);
    expect(Object.keys(capped.json().probes).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `jev-4.${i + 2}.0`).sort(),
    );

    await seedModelState(h, {
      raw: {
        'engine.model_probe': {
          'jev-1.14.0': { requested: 'jev-1.14.0', answered: 'jev-1.14.0', ok: true, at: at(1) },
          'jev-1.15.0': { requested: 'jev-1.16.0', ok: true, at: at(2) },
          'jev-1.17.0': 'garbage',
          'jev-1.18.0': { requested: 'jev-1.18.0', ok: 'yes', at: 'not a time' },
        },
      },
    });
    const clean = await status(await h.buildAnother());
    expect(clean.statusCode, clean.body).toBe(200);
    expect(Object.keys(clean.json().probes)).toEqual(['jev-1.14.0']);
  });

  it('R1 impact and lastCheck are read; a garbage notice does not hide lastCheck', async () => {
    const at = new Date().toISOString();
    await seedModelState(h, { impact: { at, activeModels: 4 } });
    await setRow('engine.model_watch', {
      lastCheck: { at, ok: false, error: 'alias_unresolved' },
      notice: 'garbage',
    });
    const res = await status(await h.buildAnother());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().impact).toEqual({ at, activeModels: 4 });
    expect(res.json().watch).toEqual({ lastCheck: { at, ok: false, error: 'alias_unresolved' } });

    await setRow('engine.model_impact', { activeModels: 'many' });
    const garbage = await status(await h.buildAnother());
    expect(garbage.statusCode, garbage.body).toBe(200);
    expect(garbage.json().impact).toBeNull();
  });
});

describe('R2-R4: the POST routes', () => {
  it('R2 a non-admin gets 403 and an anonymous caller 401 on all three routes', async () => {
    for (const user of [reader, null]) {
      const want = user === null ? 401 : 403;
      expect((await status(h.server, user)).statusCode).toBe(want);
      const client = apiClient(h.server, user);
      expect(
        (await client.post('/admin/engine/model-probe', { model: 'jev-latest' })).statusCode,
      ).toBe(want);
      expect((await client.post('/admin/engine/model-check', {})).statusCode).toBe(want);
    }
    expect(await outbox()).toEqual([]);
  });

  it('R3 model-probe answers 202 and records one intent requested by the admin', async () => {
    const res = await apiClient(h.server, admin).post('/admin/engine/model-probe', {
      model: 'jev-1.14.0',
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect(await outbox()).toEqual([
      { queue: 'engine.model-probe', payload: { model: 'jev-1.14.0' }, user_id: admin.id },
    ]);
  });

  it('R3 a second click with a new key while undelivered keeps one undelivered intent', async () => {
    const api = apiClient(h.server, admin);
    expect((await api.post('/admin/engine/model-probe', { model: 'jev-1.14.0' })).statusCode).toBe(
      202,
    );
    expect((await api.post('/admin/engine/model-probe', { model: 'jev-1.14.0' })).statusCode).toBe(
      202,
    );
    expect((await outbox()).filter((row) => row.queue === 'engine.model-probe')).toHaveLength(1);
    // Control: another model is another intent.
    expect((await api.post('/admin/engine/model-probe', { model: 'jev-2.0.0' })).statusCode).toBe(
      202,
    );
    expect(await outbox()).toHaveLength(2);
  });

  it('R3 refuses malformed bodies and a missing Idempotency-Key with 400, recording nothing', async () => {
    const api = apiClient(h.server, admin);
    for (const body of [
      {},
      { model: '' },
      { model: 'has space' },
      { model: 'vendor/model-1' },
      { model: 'x'.repeat(65) },
      { model: 5 },
      { model: 'jev-1.14.0', extra: true },
    ]) {
      const res = await api.post('/admin/engine/model-probe', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const noKey = await api.post(
      '/admin/engine/model-probe',
      { model: 'jev-1.14.0' },
      { idempotencyKey: null },
    );
    expect(noKey.statusCode, noKey.body).toBe(400);
    expect(await outbox()).toEqual([]);
  });

  it('R3 validates the id like the setting does in the mode of the server', async () => {
    const inProd = apiClient(prod, admin);
    for (const model of ['jev-beta', 'Jev-Latest']) {
      const res = await inProd.post('/admin/engine/model-probe', { model });
      expect(res.statusCode, `${model} ${res.body}`).toBe(400);
    }
    expect(await outbox()).toEqual([]);
    for (const model of ['jev-latest', 'jev-1.14.0']) {
      const res = await inProd.post('/admin/engine/model-probe', { model });
      expect(res.statusCode, `${model} ${res.body}`).toBe(202);
    }
    // Control: outside production the test model is allowed.
    const fake = await apiClient(h.server, admin).post('/admin/engine/model-probe', {
      model: 'jev-fake',
    });
    expect(fake.statusCode, fake.body).toBe(202);
  });

  it('R4 model-check queues one house.model-watch while the setting follows the alias', async () => {
    const server = await h.buildAnother();
    await seedModelState(h, { probes: [{ requested: 'jev-latest', answered: 'jev-1.13.0' }] });
    const saved = await patch({ 'engine.typesafe_model': 'jev-latest' }, { server });
    expect(saved.statusCode, saved.body).toBe(200);
    await h.owner.query('DELETE FROM job_outbox');
    const res = await apiClient(server, admin).post('/admin/engine/model-check', {});
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect(await outbox()).toEqual([
      { queue: 'house.model-watch', payload: {}, user_id: admin.id },
    ]);
  });

  it('R4 model-check on a concrete setting is 409 not_following_alias and queues nothing', async () => {
    const res = await apiClient(h.server, admin).post('/admin/engine/model-check', {});
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(details(res)).toEqual({ reason: 'not_following_alias' });
    expect(await outbox()).toEqual([]);
  });
});

describe('R5: rate limit', () => {
  it('the 31st POST within the hour over both routes is 429; another admin is not limited', async () => {
    const server = await h.buildAnother({ env: { RATE_LIMITS_ENABLED: 'true' } });
    await seedModelState(h, { probes: [{ requested: 'jev-latest', answered: 'jev-1.13.0' }] });
    expect((await patch({ 'engine.typesafe_model': 'jev-latest' }, { server })).statusCode).toBe(
      200,
    );
    await h.owner.query('DELETE FROM rate_limit_buckets');
    const api = apiClient(server, admin);
    const hit = (i: number) =>
      i % 2 === 0
        ? api.post('/admin/engine/model-probe', { model: 'jev-1.14.0' })
        : api.post('/admin/engine/model-check', {});
    for (let i = 0; i < 30; i += 1) {
      const res = await hit(i);
      expect(res.statusCode, `request ${i + 1}: ${res.body}`).toBe(202);
    }
    for (let i = 30; i < 32; i += 1) {
      const res = await hit(i);
      expect(res.statusCode, `request ${i + 1}: ${res.body}`).toBe(429);
    }
    const other = await apiClient(server, admin2).post('/admin/engine/model-probe', {
      model: 'jev-1.14.0',
    });
    expect(other.statusCode, other.body).toBe(202);
  });
});

describe('D-304 second save before alias re-resolution', () => {
  it.each([
    ['jev-1.14.0', 409],
    ['jev-2.0.0', 200],
  ])('uses the concrete pin for target %s: %i', async (target, code) => {
    await setRow('engine.typesafe_model', 'jev-2.0.0');
    await seedModelState(h, {
      pin: { model: 'jev-2.0.0' },
      resolution: { model: 'jev-1.13.0', checkedAt: SINCE },
      probes: [{ requested: 'jev-latest', answered: 'jev-2.0.0' }, ok(target)],
    });
    expect((await setModel('jev-latest')).statusCode).toBe(200);
    const res = await setModel(target);
    expect(res.statusCode, res.body).toBe(code);
    if (code === 409) {
      expect(details(res)).toMatchObject({ reason: 'confirmation_required' });
      expect(await stored('engine.typesafe_model')).toBe('jev-latest');
      expect((await setModel(target, { acknowledge: true })).statusCode).toBe(200);
    }
  });
});

it('leaves worker state untouched on concrete and alias saves; the next watch starts a fresh candidate', async () => {
  await setRow('engine.typesafe_model', 'jev-latest');
  await seedModelState(h, {
    pin: { model: 'jev-1.13.0', alias: 'jev-latest' },
    resolution: { model: 'jev-1.13.0' },
    probes: [ok('jev-1.13.0'), { requested: 'jev-latest', answered: 'jev-1.13.0' }],
    watch: { triggeredAt: SINCE, lastCheck: { at: SINCE, ok: true } },
  });
  const candidate = {
    model: 'jev-1.14.0',
    firstSeenAt: new Date(Date.now() - 20 * MIN).toISOString(),
    count: 1,
  };
  await setRow('engine.model_candidate', candidate);
  await h.owner.query(
    `UPDATE settings SET updated_at = $1::timestamptz - interval '1 minute'
      WHERE key = 'engine.typesafe_model'`,
    [candidate.firstSeenAt],
  );
  const db = createDatabase(h.worker);
  const keys = ['engine.model_watch', 'engine.model_candidate'];
  const before = await readSettingRows(db, keys);
  const concrete = await setModel('jev-1.13.0');
  expect(concrete.statusCode, concrete.body).toBe(200);
  expect(await readSettingRows(db, keys)).toEqual(before);
  const alias = await setModel('jev-latest');
  expect(alias.statusCode, alias.body).toBe(200);
  expect(await readSettingRows(db, keys)).toEqual(before);
  const [setting] = await readSettingRows(db, ['engine.typesafe_model']);
  expect(setting!.updatedAt.getTime()).toBeGreaterThan(Date.parse(candidate.firstSeenAt));

  const at = new Date(Date.now() + MIN);
  const { createModelWatchHandler } =
    await import('../../worker/src/handlers/house-model-watch.js');
  const watch = createModelWatchHandler({
    db,
    configuredModel: async () => String(await stored('engine.typesafe_model')),
    prober: {
      probe: async (requested) => ({
        requested,
        answered: candidate.model,
        ok: true,
        at: at.toISOString(),
      }),
    },
    logger: h.server.log,
    settingsEnv: h.config,
    now: () => at,
  });
  await watch({}, { queue: 'house.model-watch', jobId: 'after-model-round-trip' });
  expect(await stored('engine.model_candidate')).toEqual({
    ...candidate,
    firstSeenAt: at.toISOString(),
  });
  expect(await stored('engine.model_resolution')).toMatchObject({ model: 'jev-1.13.0' });
});
