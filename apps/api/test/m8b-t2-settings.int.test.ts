import { EngineModelPinSchema } from '@bantoozi/shared';
import {
  startFakeLibreTranslate,
  type FakeLibreTranslate,
  type FakeLibreTranslateLanguage,
} from '@bantoozi/testing';
import { createLibreTranslateClient } from '@bantoozi/translate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { seedModelState } from './support/model-state.js';

/**
 * M8b-T2 (scope B4, C; spec 08 §9): the admin settings API for the thirteen live runtime keys.
 *
 * Contract chosen by this ruler (the builder implements it; change it only with the lead):
 * - `GET /admin/settings` adds the runtime keys to `values` (the effective value) and two top-level
 *   records over exactly those keys: `sources` (`stored` | `env` | `last_good`) and `defaults` (the
 *   env default: from the API's own env when it has the variable, else from the `runtime.defaults`
 *   of the fresh worker heartbeats; `null` when nobody can tell). With source `env` the value equals
 *   the default (null when unknown).
 * - `PATCH /admin/settings` accepts the keys, `null` resets a key to its env default, and an optional
 *   `acknowledge: true`. An invalid value is 400 VALIDATION_FAILED with `error.details.key`.
 * - A change of `engine.typesafe_model`, `engine.llm_fallback_enabled` (or `engine.ollama_models`
 *   while the fallback is on) without `acknowledge: true` is 409 CONFLICT, details.reason
 *   `confirmation_required`, details.effects ['reenrich','rematch'], and nothing is written. With it
 *   the API only stores the value: no pin write, no reenrich/rematch intent (the worker owns that).
 * - A new `translate.libretranslate_url` is probed (`/languages`) at the NEW url when the language
 *   settings need LibreTranslate; a failure is 503 ENGINE_UNAVAILABLE and nothing is stored.
 * - A change of `engine.prefilter_min_cards` records one `house.rematch` while
 *   `engine.prefilter_enabled` is on, none while it is off.
 */

const RUNTIME_KEYS = [
  'engine.typesafe_model',
  'engine.typesafe_base_url',
  'engine.typesafe_price_per_mtok_usd',
  'engine.concurrency',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
  'engine.ollama_base_url',
  'engine.ollama_max_concurrency',
  'engine.prefilter_min_cards',
  'engine.auto_analysis_daily_cap',
  'ingest.max_age_days',
  'fetch.limits',
  'api.rate_limits_enabled',
  'translate.libretranslate_url',
] as const;

/** Keys whose change needs `acknowledge: true` (the fallback is off in these tests). */
const ACK_KEYS = new Set<string>(['engine.typesafe_model', 'engine.llm_fallback_enabled']);

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;
let lt: FakeLibreTranslate;
let ltNoSlovak: FakeLibreTranslate;
let prod: FastifyInstance;

interface OutboxRow {
  queue: string;
  payload: Record<string, unknown>;
}

async function outbox(): Promise<OutboxRow[]> {
  const result = await h.owner.query<OutboxRow>(
    'SELECT queue, payload FROM job_outbox WHERE delivered_at IS NULL ORDER BY id',
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
  if (key === 'engine.model_pin') EngineModelPinSchema.parse(value);
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

async function heartbeat(runtime: Record<string, unknown> | null, ageMs = 0): Promise<void> {
  if (runtime === null) {
    await h.owner.query("DELETE FROM settings WHERE key = 'worker.heartbeat'");
    return;
  }
  await setRow('worker.heartbeat', {
    'worker:1': {
      at: new Date(Date.now() - ageMs).toISOString(),
      queues: ['article.enrich'],
      evalIngestOnly: false,
      envCredentials: [],
      runtime,
    },
  });
}

async function resetAll(): Promise<void> {
  // The fake LibreTranslate servers record every request; clear them so a probe count is per test.
  lt.reset();
  ltNoSlovak.reset();
  await h.owner.query('DELETE FROM job_outbox');
  // JEV-5: a model change needs a fresh probe of the new value; every test seeds its own.
  await seedModelState(h, { reset: true });
  await h.owner.query(
    `DELETE FROM settings WHERE key = ANY($1::text[]) OR key IN
     ('worker.heartbeat','engine.prefilter_enabled','language_modes','card_text_mode')`,
    [[...RUNTIME_KEYS]],
  );
}

const LT_NO_SLOVAK: FakeLibreTranslateLanguage[] = [
  { code: 'en', name: 'English', targets: ['cs', 'en'] },
  { code: 'cs', name: 'Czech', targets: ['cs', 'en'] },
];

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
  lt = await startFakeLibreTranslate();
  ltNoSlovak = await startFakeLibreTranslate({ languages: LT_NO_SLOVAK });
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
});

afterAll(async () => {
  await lt.close();
  await ltNoSlovak.close();
  await h.close();
});

beforeEach(resetAll);

const get = async (server: FastifyInstance = h.server) => {
  const res = await apiClient(server, admin).get('/admin/settings');
  expect(res.statusCode).toBe(200);
  return res.json();
};
const patch = (body: unknown, server: FastifyInstance = h.server) =>
  apiClient(server, admin).patch('/admin/settings', body);

describe('GET /admin/settings runtime keys', () => {
  it('lists every runtime key with value, source and default; nothing stored means env', async () => {
    const body = await get();
    for (const key of RUNTIME_KEYS) {
      expect(body.values, key).toHaveProperty([key]);
      expect(body.sources[key], key).toBe('env');
      expect(body.defaults, key).toHaveProperty([key]);
    }
    expect(Object.keys(body.sources).sort()).toEqual([...RUNTIME_KEYS].sort());
    expect(Object.keys(body.defaults).sort()).toEqual([...RUNTIME_KEYS].sort());
    // The API process knows these env defaults itself.
    expect(body.defaults['engine.typesafe_model']).toBe('jev-1.13.0');
    expect(body.defaults['api.rate_limits_enabled']).toBe(false); // harness: RATE_LIMITS_ENABLED=false
    expect(body.defaults['translate.libretranslate_url']).toBe('http://127.0.0.1:9');
    expect(body.defaults['fetch.limits']).toEqual({ timeoutMs: 20000, maxBytes: 5242880 });
    expect(body.values['engine.typesafe_model']).toBe('jev-1.13.0');
    // Worker-only env: unknown without a heartbeat.
    for (const key of ['engine.concurrency', 'engine.prefilter_min_cards', 'ingest.max_age_days']) {
      expect(body.defaults[key], key).toBeNull();
    }
    // The pre-existing keys stay.
    expect(body.values.signup_mode).toBeDefined();
  });

  it('takes worker-only defaults from a fresh heartbeat runtime.defaults, not from a stale one', async () => {
    const defaults = {
      'engine.concurrency': 8,
      'engine.prefilter_min_cards': 60,
      'ingest.max_age_days': 14,
      'engine.ollama_models': { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
      'engine.llm_fallback_enabled': false,
    };
    await heartbeat({ defaults }, 5 * 60_000); // stale: ignored (negative control)
    expect((await get()).defaults['engine.concurrency']).toBeNull();

    await heartbeat({ defaults });
    const body = await get();
    for (const [key, value] of Object.entries(defaults)) {
      expect(body.defaults[key], key).toEqual(value);
      expect(body.values[key], key).toEqual(value);
      expect(body.sources[key], key).toBe('env');
    }
    // A stored value wins over the default and reports `stored`.
    expect((await patch({ 'engine.concurrency': 3 })).statusCode).toBe(200);
    const after = await get();
    expect(after.values['engine.concurrency']).toBe(3);
    expect(after.sources['engine.concurrency']).toBe('stored');
    expect(after.defaults['engine.concurrency']).toBe(8);
  });

  it('reports last_good for a stored row that no longer validates', async () => {
    expect((await patch({ 'engine.concurrency': 5 })).statusCode).toBe(200);
    await setRow('engine.concurrency', 'many'); // corrupt row written behind the API's back
    const body = await get();
    expect(body.sources['engine.concurrency']).toBe('last_good');
    expect(body.values['engine.concurrency']).toBe(5);
  });
});

describe('PATCH /admin/settings runtime keys', () => {
  const cases: [string, unknown, unknown?][] = [
    ['engine.typesafe_model', 'jev-1.14.0'],
    ['engine.typesafe_base_url', 'https://api.typesafe.ai/', 'https://api.typesafe.ai'],
    ['engine.typesafe_price_per_mtok_usd', 0.05],
    ['engine.concurrency', 4],
    ['engine.llm_fallback_enabled', true],
    ['engine.ollama_models', { fast: 'glm-5.3-flash', strong: 'gemma4:31b' }],
    ['engine.ollama_base_url', 'https://ollama.com'],
    ['engine.ollama_max_concurrency', 3],
    ['engine.prefilter_min_cards', 75],
    ['ingest.max_age_days', 30],
    ['fetch.limits', { timeoutMs: 15000, maxBytes: 2097152 }],
    ['api.rate_limits_enabled', true],
    ['translate.libretranslate_url', '__lt__'],
  ];

  it.each(cases)('round-trips %s', async (key, value, expectedStored) => {
    const url = key === 'translate.libretranslate_url' ? lt.url : undefined;
    const sent = url ?? value;
    if (key === 'engine.typesafe_model') {
      await seedModelState(h, { probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0' }] });
    }
    const want = url ?? expectedStored ?? value;
    const res = await patch({ [key]: sent, ...(ACK_KEYS.has(key) ? { acknowledge: true } : {}) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual([key]);
    expect(await stored(key)).toEqual(want);
    const body = await get();
    expect(body.values[key]).toEqual(want);
    expect(body.sources[key]).toBe('stored');
    expect(body.stored.map((s: { key: string }) => s.key)).toContain(key);
  });

  it('rejects out-of-range and malformed values with 400 naming the key, storing nothing', async () => {
    const bad: [string, unknown][] = [
      ['engine.concurrency', 0],
      ['engine.concurrency', 65],
      ['engine.ollama_max_concurrency', 0],
      ['engine.prefilter_min_cards', 0],
      ['engine.prefilter_min_cards', 10001],
      ['ingest.max_age_days', 366],
      ['fetch.limits', { timeoutMs: 500, maxBytes: 2097152 }],
      ['fetch.limits', { timeoutMs: 15000, maxBytes: 1000 }],
      ['fetch.limits', { timeoutMs: 15000, maxBytes: 100 * 1024 * 1024 }],
      ['engine.typesafe_price_per_mtok_usd', 11],
      ['engine.typesafe_base_url', 'https://user:pw@api.typesafe.ai'],
      ['engine.typesafe_base_url', 'ftp://api.typesafe.ai'],
      ['engine.ollama_models', { fast: 'no-such-model', strong: 'glm-5.3' }],
      ['api.rate_limits_enabled', 'yes'],
    ];
    for (const [key, value] of bad) {
      const res = await patch({ [key]: value, acknowledge: true });
      expect(res.statusCode, `${key}=${JSON.stringify(value)}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      expect(res.json().error.details.key, key).toBe(key);
      expect(await stored(key), key).toBeUndefined();
    }
    // Negative control: the boundary values are accepted.
    const ok = await patch({ 'engine.concurrency': 64, 'ingest.max_age_days': 365 });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('null resets a key to its env default', async () => {
    await heartbeat({ defaults: { 'engine.concurrency': 8 } });
    expect((await patch({ 'engine.concurrency': 2, 'ingest.max_age_days': 20 })).statusCode).toBe(
      200,
    );
    const res = await patch({ 'engine.concurrency': null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual(['engine.concurrency']);
    const body = await get();
    expect(body.sources['engine.concurrency']).toBe('env');
    expect(body.values['engine.concurrency']).toBe(8);
    expect(body.sources['ingest.max_age_days']).toBe('stored'); // untouched
    // Resetting a key with no override is a no-op.
    expect((await patch({ 'engine.concurrency': null })).json().changed).toEqual([]);
  });

  it('answers 403 to a non-admin, 401 without a session, and stores nothing', async () => {
    const body = { 'engine.concurrency': 3 };
    expect((await apiClient(h.server, reader).patch('/admin/settings', body)).statusCode).toBe(403);
    expect((await apiClient(h.server, null).patch('/admin/settings', body)).statusCode).toBe(401);
    expect((await apiClient(h.server, reader).get('/admin/settings')).statusCode).toBe(403);
    expect(await stored('engine.concurrency')).toBeUndefined();
  });
});

describe('production validation', () => {
  it('refuses http, off-allowlist hosts, unpinned models and a zero price, naming the key', async () => {
    const bad: [string, unknown][] = [
      ['engine.typesafe_base_url', 'http://api.typesafe.ai'],
      ['engine.typesafe_base_url', 'https://evil.example.com'],
      ['engine.ollama_base_url', 'https://evil.example.com'],
      ['engine.ollama_base_url', 'http://ollama.com'],
      ['engine.typesafe_model', 'jev-beta'],
      ['engine.typesafe_model', 'Jev-Latest'],
      ['engine.typesafe_model', 'jev-fake'],
      ['engine.typesafe_price_per_mtok_usd', 0],
    ];
    for (const [key, value] of bad) {
      const res = await patch({ [key]: value, acknowledge: true }, prod);
      expect(res.statusCode, `${key}=${JSON.stringify(value)} ${res.body}`).toBe(400);
      expect(res.json().error.details.key, key).toBe(key);
      expect(await stored(key), key).toBeUndefined();
    }
    // Negative control: the same keys with valid production values are accepted (the model needs a
    // fresh probe that confirms it, JEV-5).
    await seedModelState(h, { probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0' }] });
    const ok = await patch(
      {
        'engine.typesafe_base_url': 'https://api.typesafe.ai/',
        'engine.ollama_base_url': 'https://ollama.com',
        'engine.typesafe_model': 'jev-1.14.0',
        'engine.typesafe_price_per_mtok_usd': 0.05,
        acknowledge: true,
      },
      prod,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await stored('engine.typesafe_base_url')).toBe('https://api.typesafe.ai');
    // JEV-2: the alias is accepted in production (stored, no pin write, no intent), like a model change.
    await setRow('engine.model_pin', {
      model: 'jev-1.13.0',
      since: '2026-10-01T00:00:00Z',
    });
    await h.owner.query('DELETE FROM job_outbox');
    // The alias resolves to another family than the stored model: personal models restart, so the
    // acknowledgement is required (JEV-5: a same-family answer would need none).
    await seedModelState(h, { probes: [{ requested: 'jev-latest', answered: 'jev-2.0.0' }] });
    const needsAck = await patch({ 'engine.typesafe_model': 'jev-latest' }, prod);
    expect(needsAck.statusCode, needsAck.body).toBe(409);
    expect(needsAck.json().error.details.reason).toBe('confirmation_required');
    expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
    const alias = await patch({ 'engine.typesafe_model': 'jev-latest', acknowledge: true }, prod);
    expect(alias.statusCode, alias.body).toBe(200);
    expect(alias.json().changed).toEqual(['engine.typesafe_model']);
    expect(await stored('engine.typesafe_model')).toBe('jev-latest');
    expect(await stored('engine.model_pin')).toEqual({
      model: 'jev-1.13.0',
      since: '2026-10-01T00:00:00Z',
    });
    expect(await outbox()).toEqual([]);
    // Control: near misses of the alias stay refused in production and leave the stored alias alone.
    const near = await patch({ 'engine.typesafe_model': 'jev-latest ', acknowledge: true }, prod);
    expect(near.statusCode, near.body).toBe(400);
    expect(near.json().error.details.key).toBe('engine.typesafe_model');
    expect(await stored('engine.typesafe_model')).toBe('jev-latest');
    // The same invalid values are accepted outside production (http, jev-fake): control for the env split.
    expect((await patch({ 'engine.ollama_base_url': 'http://localhost:11434' })).statusCode).toBe(
      200,
    );
    await seedModelState(h, { probes: [{ requested: 'jev-fake', answered: 'jev-fake' }] });
    expect(
      (await patch({ 'engine.typesafe_model': 'jev-fake', acknowledge: true })).statusCode,
    ).toBe(200);
  });
});

describe('model-affecting keys need acknowledge', () => {
  const modelPin = async () => stored('engine.model_pin');

  it('answers 409 confirmation_required without acknowledge and writes nothing', async () => {
    await setRow('engine.model_pin', {
      model: 'jev-1.13.0',
      since: '2026-10-01T00:00:00Z',
    });
    // Another family than the env model jev-1.13.0, with a fresh confirming probe: personal models restart.
    await seedModelState(h, { probes: [{ requested: 'jev-2.0.0', answered: 'jev-2.0.0' }] });
    for (const body of [
      { 'engine.typesafe_model': 'jev-2.0.0' },
      { 'engine.llm_fallback_enabled': true },
      { 'engine.typesafe_model': 'jev-2.0.0', 'engine.concurrency': 3 }, // whole patch refused
      { 'engine.typesafe_model': 'jev-2.0.0', acknowledge: false },
    ]) {
      const res = await patch(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error.code).toBe('CONFLICT');
      expect(res.json().error.details.reason).toBe('confirmation_required');
      expect(res.json().error.details.effects).toEqual(['reenrich', 'rematch']);
    }
    expect(await stored('engine.typesafe_model')).toBeUndefined();
    expect(await stored('engine.llm_fallback_enabled')).toBeUndefined();
    expect(await stored('engine.concurrency')).toBeUndefined();
    expect(await outbox()).toEqual([]);
  });

  it('with acknowledge stores the value and writes no pin and no rebuild intent', async () => {
    const pin = { model: 'jev-1.13.0', since: '2026-10-01T00:00:00Z' };
    await setRow('engine.model_pin', pin);
    await seedModelState(h, { probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0' }] });
    const res = await patch({
      'engine.typesafe_model': 'jev-1.14.0',
      'engine.llm_fallback_enabled': true,
      acknowledge: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed.sort()).toEqual([
      'engine.llm_fallback_enabled',
      'engine.typesafe_model',
    ]);
    expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
    expect(await modelPin()).toEqual(pin);
    const queues = (await outbox()).map((row) => row.queue);
    expect(queues).not.toContain('house.reenrich');
    expect(queues).not.toContain('house.rematch');
    expect(queues).toEqual([]);
  });

  it('needs no acknowledge for an unchanged model value or a reset of an unset key', async () => {
    // The API's env model is jev-1.13.0: writing the effective value changes nothing.
    const same = await patch({ 'engine.typesafe_model': 'jev-1.13.0' });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().changed).toEqual([]);
    expect((await patch({ 'engine.typesafe_model': null })).statusCode).toBe(200);
  });

  it('asks for acknowledge on a model reset and on Ollama models only while the fallback is on', async () => {
    const models = { fast: 'glm-5.3-flash', strong: 'gemma4:31b' };
    // Fallback off: the Ollama models are not in the pin, so no acknowledge is needed.
    expect((await patch({ 'engine.ollama_models': models })).statusCode).toBe(200);
    await patch({ 'engine.llm_fallback_enabled': true, acknowledge: true });
    const res = await patch({
      'engine.ollama_models': { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('confirmation_required');
    expect(await stored('engine.ollama_models')).toEqual(models);
    const ack = await patch({
      'engine.ollama_models': { fast: 'glm-5.3-flash', strong: 'glm-5.3' },
      acknowledge: true,
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(await outbox()).toEqual([]);

    // Resetting a stored model to the env default is a change too: it is gated on a probe of the
    // env default (jev-1.13.0) and, from another family, on the acknowledgement.
    const probe2 = { requested: 'jev-2.0.0', answered: 'jev-2.0.0' };
    await seedModelState(h, { probes: [probe2] });
    expect(
      (await patch({ 'engine.typesafe_model': 'jev-2.0.0', acknowledge: true })).statusCode,
    ).toBe(200);
    const unprobed = await patch({ 'engine.typesafe_model': null, acknowledge: true });
    expect(unprobed.statusCode, unprobed.body).toBe(409);
    expect(unprobed.json().error.details).toEqual({
      reason: 'model_probe_required',
      model: 'jev-1.13.0',
    });
    await seedModelState(h, {
      probes: [probe2, { requested: 'jev-1.13.0', answered: 'jev-1.13.0' }],
    });
    const unacknowledged = await patch({ 'engine.typesafe_model': null });
    expect(unacknowledged.statusCode, unacknowledged.body).toBe(409);
    expect(unacknowledged.json().error.details.reason).toBe('confirmation_required');
    expect(await stored('engine.typesafe_model')).toBe('jev-2.0.0');
    expect((await patch({ 'engine.typesafe_model': null, acknowledge: true })).statusCode).toBe(
      200,
    );
    expect((await get()).sources['engine.typesafe_model']).toBe('env');
  });

  it('JEV-5: another release of the same major needs a probe but no acknowledge', async () => {
    await seedModelState(h, { probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0' }] });
    const res = await patch({ 'engine.typesafe_model': 'jev-1.14.0' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual(['engine.typesafe_model']);
    expect(await stored('engine.typesafe_model')).toBe('jev-1.14.0');
  });

  it('JEV-5: a missing, failed or stale probe refuses the change and writes nothing', async () => {
    const missing = await patch({ 'engine.typesafe_model': 'jev-1.14.0', acknowledge: true });
    expect(missing.statusCode, missing.body).toBe(409);
    expect(missing.json().error.details).toEqual({
      reason: 'model_probe_required',
      model: 'jev-1.14.0',
    });
    await seedModelState(h, {
      probes: [{ requested: 'jev-1.14.0', ok: false, error: 'model_unavailable' }],
    });
    const failed = await patch({ 'engine.typesafe_model': 'jev-1.14.0', acknowledge: true });
    expect(failed.statusCode, failed.body).toBe(409);
    expect(failed.json().error.details.reason).toBe('model_probe_failed');
    await seedModelState(h, {
      probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0', offsetMs: -11 * 60_000 }],
    });
    const stale = await patch({ 'engine.typesafe_model': 'jev-1.14.0', acknowledge: true });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.details.reason).toBe('model_probe_required');
    expect(await stored('engine.typesafe_model')).toBeUndefined();
  });
});

describe('prefilter minimum cards', () => {
  it('records one house.rematch while the prefilter is enabled', async () => {
    await setRow('engine.prefilter_enabled', true);
    const res = await patch({ 'engine.prefilter_min_cards': 80 });
    expect(res.statusCode, res.body).toBe(200);
    expect((await outbox()).map((row) => row.queue)).toEqual(['house.rematch']);
    // An unchanged value records nothing (negative control).
    await h.owner.query('DELETE FROM job_outbox');
    expect((await patch({ 'engine.prefilter_min_cards': 80 })).json().changed).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('records nothing while the prefilter is disabled', async () => {
    await setRow('engine.prefilter_enabled', false);
    expect((await patch({ 'engine.prefilter_min_cards': 80 })).statusCode).toBe(200);
    expect(await outbox()).toEqual([]);
  });
});

describe('translate.libretranslate_url probe', () => {
  const slovak = { language_modes: { en: 'native', sk: 'translate', cs: 'native' } };

  it('probes the NEW url: missing language pairs answer 503 and nothing is stored', async () => {
    // The current client talks to a LibreTranslate that has every pair.
    const server = await h.buildAnother({
      libreTranslate: createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 }),
    });
    expect((await patch(slovak, server)).statusCode).toBe(200);
    const res = await patch({ 'translate.libretranslate_url': ltNoSlovak.url }, server);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('ENGINE_UNAVAILABLE');
    expect(res.json().error.details.missing).toEqual(['sk-en']);
    expect(await stored('translate.libretranslate_url')).toBeUndefined();
    expect(ltNoSlovak.requests.some((r) => r.path === '/languages')).toBe(true);
  });

  it('accepts a new url that has the pairs even when the current one is down (control)', async () => {
    const server = await h.buildAnother({
      libreTranslate: createLibreTranslateClient({ baseUrl: 'http://127.0.0.1:9', maxAttempts: 1 }),
    });
    await setRow('language_modes', slovak.language_modes);
    const res = await patch({ 'translate.libretranslate_url': `${lt.url}/` }, server);
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored('translate.libretranslate_url')).toBe(lt.url);
  });

  it('is not probed when no language needs LibreTranslate', async () => {
    const res = await patch({ 'translate.libretranslate_url': ltNoSlovak.url });
    expect(res.statusCode, res.body).toBe(200);
    expect(ltNoSlovak.requests.filter((r) => r.path === '/languages')).toEqual([]);
  });
});
