import { createLibreTranslateClient } from '@bantoozi/translate';
import {
  createFeed,
  createSubscription,
  createUser,
  startFakeLibreTranslate,
  type FakeLibreTranslate,
} from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestSession,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T9 (spec 08 §9): admin-only access, the settings allow-list with every side effect, the
 * breaker reset request, the translation reprocess, overview/usage, feeds, users, invites and the
 * waitlist, against the real `bantoozi_app` role.
 */

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;
let lt: FakeLibreTranslate;
let ltServer: FastifyInstance;
let ltDownServer: FastifyInstance;

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

async function clearOutbox(): Promise<void> {
  await h.owner.query('DELETE FROM job_outbox');
}

async function storedSetting(key: string): Promise<unknown> {
  const result = await h.owner.query<{ value: unknown }>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value;
}

async function createQuestionSet(kind: string): Promise<string> {
  const version = `${kind}-test-${Math.random().toString(36).slice(2)}`;
  const result = await h.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ($1, $2, md5($2) || md5($2), '{}'::jsonb) RETURNING id::text AS id`,
    [kind, version],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
  lt = await startFakeLibreTranslate();
  ltServer = await h.buildAnother({
    libreTranslate: createLibreTranslateClient({ baseUrl: lt.url, maxAttempts: 1 }),
  });
  // A LibreTranslate that refuses connections (a closed local port): "down".
  ltDownServer = await h.buildAnother({
    libreTranslate: createLibreTranslateClient({ baseUrl: 'http://127.0.0.1:9', maxAttempts: 1 }),
  });
});

afterAll(async () => {
  await lt.close();
  await h.close();
});

beforeEach(async () => {
  await clearOutbox();
});

describe('admin access (spec 08 §9)', () => {
  const routes: [string, string][] = [
    ['GET', '/admin/overview'],
    ['GET', '/admin/usage'],
    ['GET', '/admin/settings'],
    ['PATCH', '/admin/settings'],
    ['POST', '/admin/engine/reset-breaker'],
    ['POST', '/admin/translations/reprocess'],
    ['GET', '/admin/engine/credentials'],
    ['PUT', '/admin/engine/credentials/typesafe'],
    ['GET', '/admin/feeds'],
    ['GET', '/admin/users'],
    ['GET', '/admin/invites'],
    ['GET', '/admin/waitlist'],
    ['GET', '/admin/library'],
    ['GET', '/admin/library/candidates'],
    ['POST', '/admin/library/promote'],
  ];

  it('answers 403 to an ordinary user and 401 without a session', async () => {
    for (const [method, url] of routes) {
      const client = apiClient(h.server, reader);
      const res =
        method === 'GET'
          ? await client.get(url)
          : method === 'PUT'
            ? await client.put(url, {})
            : method === 'PATCH'
              ? await client.patch(url, {})
              : await client.post(url, {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      const anonymous = await apiClient(h.server).get(url);
      expect([401, 404]).toContain(anonymous.statusCode);
      if (method === 'GET') expect(anonymous.statusCode).toBe(401);
    }
  });

  it('requires the CSRF header and an Idempotency-Key on admin mutations', async () => {
    const noCsrf = await apiClient(h.server, admin).patch(
      '/admin/settings',
      { signup_mode: 'open' },
      { client: null },
    );
    expect(noCsrf.statusCode).toBe(403);
    const noKey = await apiClient(h.server, admin).patch(
      '/admin/settings',
      { signup_mode: 'open' },
      { idempotencyKey: null },
    );
    expect(noKey.statusCode).toBe(400);
  });
});

describe('settings (spec 08 §9, spec 02 §2)', () => {
  it('lists the allow-listed keys with their effective values', async () => {
    const res = await apiClient(h.server, admin).get('/admin/settings');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.values).sort()).toEqual(
      [
        'card_text_mode',
        'engine.daily_budget_usd',
        'engine.laya',
        'engine.llm_daily_cap',
        'engine.prefilter_enabled',
        'language_modes',
        'question_sets.active',
        'ranker.thresholds',
        'signup_mode',
        'translate.tier2_daily_cap',
      ].sort(),
    );
    expect(body.values['engine.llm_daily_cap']).toBe(200);
    expect(body.values.card_text_mode).toBe('as_written');
  });

  it('rejects keys outside the allow-list, invalid values and an invalid merged ranker config', async () => {
    const client = apiClient(h.server, admin);
    for (const patch of [
      { 'engine.circuit': {} },
      { 'ops.events': [] },
      { 'worker.heartbeat': {} },
      { signup_mode: 'everyone' },
      { 'engine.llm_daily_cap': -1 },
      { 'engine.daily_budget_usd': 'two' },
      { 'ranker.thresholds': { lanes: { unknown: 1 } } },
      {},
    ]) {
      const res = await client.patch('/admin/settings', patch);
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    // maybe (0.9) must stay below forYou (default 0.65): the merged configuration is validated.
    const merged = await client.patch('/admin/settings', {
      'ranker.thresholds': { lanes: { maybe: 0.9 } },
    });
    expect(merged.statusCode).toBe(400);
    expect(await storedSetting('ranker.thresholds')).toBeUndefined();
  });

  it('stores plain keys without side effects; an unchanged value is a no-op', async () => {
    const client = apiClient(h.server, admin);
    const res = await client.patch('/admin/settings', {
      signup_mode: 'open',
      'engine.llm_daily_cap': 50,
      'translate.tier2_daily_cap': 10,
      'engine.daily_budget_usd': 3.5,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed.sort()).toEqual(
      [
        'engine.daily_budget_usd',
        'engine.llm_daily_cap',
        'signup_mode',
        'translate.tier2_daily_cap',
      ].sort(),
    );
    expect(await storedSetting('signup_mode')).toBe('open');
    expect(await outbox()).toEqual([]);
    const row = await h.owner.query<{ updated_by: string }>(
      "SELECT updated_by::text AS updated_by FROM settings WHERE key = 'signup_mode'",
    );
    expect(row.rows[0]?.updated_by).toBe(admin.id);

    const again = await client.patch('/admin/settings', { signup_mode: 'open' });
    expect(again.statusCode).toBe(200);
    expect(again.json().changed).toEqual([]);
  });

  it('ranker.thresholds bumps the settings version, ranks users active in 7 days and learns on weight/model changes', async () => {
    const active = await createUser(h.owner, { lastActiveAt: new Date() });
    const idle = await createUser(h.owner, {
      lastActiveAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    });
    const before = await h.owner.query<{ id: string; rank_revision: string }>(
      'SELECT id::text AS id, rank_revision::text AS rank_revision FROM users WHERE id = ANY($1)',
      [[active.id, idle.id]],
    );
    const client = apiClient(h.server, admin);

    const lanes = await client.patch('/admin/settings', {
      'ranker.thresholds': { lanes: { forYou: 0.7 } },
    });
    expect(lanes.statusCode).toBe(200);
    expect(lanes.json().rankerSettingsVersion).toBe(1);
    expect(await storedSetting('ranker.settings_version')).toBe(1);
    let jobs = await outbox();
    const ranked = jobs.filter((j) => j.queue === 'user.rank').map((j) => j.payload['userId']);
    expect(ranked).toContain(active.id);
    expect(ranked).not.toContain(idle.id);
    expect(
      jobs.filter((j) => j.queue === 'user.rank').every((j) => j.payload['full'] === true),
    ).toBe(true);
    expect(jobs.some((j) => j.queue === 'user.learn')).toBe(false);
    const after = await h.owner.query<{ id: string; rank_revision: string }>(
      'SELECT id::text AS id, rank_revision::text AS rank_revision FROM users WHERE id = ANY($1)',
      [[active.id, idle.id]],
    );
    const revision = (rows: { id: string; rank_revision: string }[], id: string) =>
      BigInt(rows.find((r) => r.id === id)!.rank_revision);
    expect(revision(after.rows, active.id)).toBe(revision(before.rows, active.id) + 1n);
    expect(revision(after.rows, idle.id)).toBe(revision(before.rows, idle.id));

    await clearOutbox();
    const weights = await client.patch('/admin/settings', {
      'ranker.thresholds': { lanes: { forYou: 0.7 }, strengthWeights: { like: 0.6 } },
    });
    expect(weights.statusCode).toBe(200);
    expect(weights.json().rankerSettingsVersion).toBe(2);
    jobs = await outbox();
    expect(jobs.filter((j) => j.queue === 'user.learn').map((j) => j.payload['userId'])).toContain(
      active.id,
    );
  });

  it('question_sets.active validates existence and kind; enrich re-enriches and match rematches', async () => {
    const enrich = await createQuestionSet('enrich');
    const match = await createQuestionSet('match');
    const client = apiClient(h.server, admin);

    const wrongKind = await client.patch('/admin/settings', {
      'question_sets.active': { enrich: match },
    });
    expect(wrongKind.statusCode).toBe(400);
    const missing = await client.patch('/admin/settings', {
      'question_sets.active': { enrich: '999999' },
    });
    expect(missing.statusCode).toBe(400);
    expect(await outbox()).toEqual([]);

    const res = await client.patch('/admin/settings', {
      'question_sets.active': { enrich, match },
    });
    expect(res.statusCode).toBe(200);
    const jobs = await outbox();
    expect(jobs).toContainEqual({ queue: 'house.reenrich', payload: {} });
    expect(jobs).toContainEqual({ queue: 'house.rematch', payload: {} });
  });

  it('engine.prefilter_enabled changes enqueue house.rematch', async () => {
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.prefilter_enabled': true,
    });
    expect(res.statusCode).toBe(200);
    expect(await outbox()).toEqual([{ queue: 'house.rematch', payload: {} }]);
  });

  it('refuses translate modes and english card text while LibreTranslate is down, accepts them once its probe lists the languages', async () => {
    const down = await apiClient(ltDownServer, admin).patch('/admin/settings', {
      card_text_mode: 'english',
    });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe('ENGINE_UNAVAILABLE');
    const unconfigured = await apiClient(h.server, admin).patch('/admin/settings', {
      language_modes: { en: 'native', sk: 'translate', cs: 'native' },
    });
    expect(unconfigured.statusCode).toBe(503);

    lt.setOptions({ mode: 'status', status: 503 });
    const failing = await apiClient(ltServer, admin).patch('/admin/settings', {
      language_modes: { en: 'native', sk: 'translate', cs: 'native' },
    });
    expect(failing.statusCode).toBe(503);

    // Reachable, but without the Slovak model.
    lt.reset({
      languages: [
        { code: 'en', name: 'English', targets: ['cs', 'en'] },
        { code: 'cs', name: 'Czech', targets: ['cs', 'en'] },
      ],
    });
    const missing = await apiClient(ltServer, admin).patch('/admin/settings', {
      language_modes: { en: 'native', sk: 'translate', cs: 'native' },
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.details.missing).toEqual(['sk-en']);
    expect(await storedSetting('language_modes')).toBeUndefined();
    expect(await outbox()).toEqual([]);

    lt.reset();
    const modes = await apiClient(ltServer, admin).patch('/admin/settings', {
      language_modes: { en: 'native', sk: 'translate', cs: 'native' },
    });
    expect(modes.statusCode).toBe(200);
    expect(await outbox()).toEqual([{ queue: 'house.reenrich', payload: { lang: 'sk' } }]);

    await clearOutbox();
    const english = await apiClient(ltServer, admin).patch('/admin/settings', {
      card_text_mode: 'english',
    });
    expect(english.statusCode).toBe(200);
    const jobs = await outbox();
    expect(jobs).toContainEqual({ queue: 'house.translate-cards', payload: {} });
    expect(jobs).toContainEqual({ queue: 'house.rematch', payload: {} });
    expect(lt.requests.some((r) => r.path === '/languages')).toBe(true);

    // Back to as_written needs no probe and still rematches.
    await clearOutbox();
    const back = await apiClient(ltDownServer, admin).patch('/admin/settings', {
      card_text_mode: 'as_written',
    });
    expect(back.statusCode).toBe(200);
    expect(await outbox()).toEqual([{ queue: 'house.rematch', payload: {} }]);
  });

  it('refuses a non-empty engine.laya without a fresh worker consuming both Laya queues', async () => {
    const client = apiClient(h.server, admin);
    const refused = await client.patch('/admin/settings', { 'engine.laya': { enrich: ['sk'] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.reason).toBe('laya_worker_missing');

    // A stale heartbeat (older than 90 s) and one without the Laya queues do not count.
    const old = new Date(Date.now() - 120_000).toISOString();
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          'laya:1': {
            at: old,
            queues: ['article.enrich.laya', 'analysis.process.laya'],
            evalIngestOnly: false,
            envCredentials: [],
          },
          'main:2': {
            at: new Date().toISOString(),
            queues: ['article.enrich'],
            evalIngestOnly: false,
            envCredentials: [],
          },
        }),
      ],
    );
    expect(
      (await client.patch('/admin/settings', { 'engine.laya': { enrich: ['sk'] } })).statusCode,
    ).toBe(409);

    await h.owner.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'worker.heartbeat'`, [
      JSON.stringify({
        'laya:1': {
          at: new Date().toISOString(),
          queues: ['article.enrich.laya', 'analysis.process.laya'],
          evalIngestOnly: false,
          envCredentials: [],
        },
      }),
    ]);
    const accepted = await client.patch('/admin/settings', { 'engine.laya': { enrich: ['sk'] } });
    expect(accepted.statusCode).toBe(200);
    expect(await outbox()).toEqual([{ queue: 'house.reenrich', payload: { lang: 'sk' } }]);

    // Removing a language needs no worker and re-enriches it too.
    await h.owner.query("DELETE FROM settings WHERE key = 'worker.heartbeat'");
    await clearOutbox();
    const removed = await client.patch('/admin/settings', { 'engine.laya': {} });
    expect(removed.statusCode).toBe(200);
    expect(await outbox()).toEqual([{ queue: 'house.reenrich', payload: { lang: 'sk' } }]);
  });

  it('replays the same Idempotency-Key without a second side effect', async () => {
    const key = crypto.randomUUID();
    const client = apiClient(h.server, admin);
    const first = await client.patch(
      '/admin/settings',
      { 'engine.prefilter_enabled': false },
      { idempotencyKey: key },
    );
    const second = await client.patch(
      '/admin/settings',
      { 'engine.prefilter_enabled': false },
      { idempotencyKey: key },
    );
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await outbox()).filter((j) => j.queue === 'house.rematch')).toHaveLength(1);
  });
});

describe('engine operations (spec 08 §9)', () => {
  it('reset-breaker writes engine.circuit.resetRequested', async () => {
    const res = await apiClient(h.server, admin).post('/admin/engine/reset-breaker', {
      engine: 'typesafe',
    });
    expect(res.statusCode).toBe(200);
    const circuit = (await storedSetting('engine.circuit')) as {
      typesafe: { state: string };
      resetRequested: { typesafe?: string; llm?: string };
    };
    expect(circuit.resetRequested.typesafe).toBe(res.json().resetRequestedAt);
    expect(circuit.resetRequested.llm).toBeUndefined();
    expect(circuit.typesafe.state).toBe('closed');

    const llm = await apiClient(h.server, admin).post('/admin/engine/reset-breaker', {
      engine: 'llm',
    });
    expect(llm.statusCode).toBe(200);
    const both = (await storedSetting('engine.circuit')) as {
      resetRequested: { typesafe?: string; llm?: string };
    };
    expect(both.resetRequested.typesafe).toBe(res.json().resetRequestedAt);
    expect(both.resetRequested.llm).toBe(llm.json().resetRequestedAt);

    const invalid = await apiClient(h.server, admin).post('/admin/engine/reset-breaker', {
      engine: 'ollama',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('translations/reprocess enqueues house.retranslate-skipped', async () => {
    const all = await apiClient(h.server, admin).post('/admin/translations/reprocess', {});
    expect(all.statusCode).toBe(202);
    expect(all.json()).toEqual({ queued: true });
    const some = await apiClient(h.server, admin).post('/admin/translations/reprocess', {
      reasons: ['cap'],
    });
    expect(some.statusCode).toBe(202);
    expect(await outbox()).toEqual([
      { queue: 'house.retranslate-skipped', payload: { reasons: ['no_key', 'cap', 'budget'] } },
      { queue: 'house.retranslate-skipped', payload: { reasons: ['cap'] } },
    ]);
    const invalid = await apiClient(h.server, admin).post('/admin/translations/reprocess', {
      reasons: ['other'],
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('overview reports users, feeds, queues, breakers, spend and translations', async () => {
    await createFeed(h.owner, { status: 'quarantined' });
    await h.owner.query(
      `INSERT INTO usage_daily (day, user_id, engine, kind, calls, cost_usd)
       VALUES ((now() AT TIME ZONE 'UTC')::date, '00000000-0000-0000-0000-000000000000', 'typesafe', 'match', 4, 0.25),
              ((now() AT TIME ZONE 'UTC')::date, '00000000-0000-0000-0000-000000000000', 'llm', 'enrich', 3, 0.01),
              ((now() AT TIME ZONE 'UTC')::date, '00000000-0000-0000-0000-000000000000', 'llm', 'translate', 2, 0.01)
       ON CONFLICT DO NOTHING`,
    );
    const res = await apiClient(h.server, admin).get('/admin/overview');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users.total).toBeGreaterThanOrEqual(2);
    expect(body.feeds.quarantined).toBeGreaterThanOrEqual(1);
    expect(body.engine.breakers.typesafe.state).toBe('closed');
    expect(body.engine.spendTodayUsd).toBeCloseTo(0.27, 5);
    expect(body.engine.llmCallsToday).toBe(3);
    expect(body.translations.tier2CallsToday).toBe(2);
    expect(body.queues.length).toBeGreaterThan(0);
    expect(body.queues[0]).toEqual(
      expect.objectContaining({ queue: expect.any(String), created: expect.any(Number) }),
    );
  });

  it('usage uses admin_usage_attribution and validates days 1..90', async () => {
    const spender = await createUser(h.owner);
    await h.owner.query(
      `INSERT INTO usage_daily (day, user_id, engine, kind, calls, cost_usd)
       VALUES ((now() AT TIME ZONE 'UTC')::date - 1, $1, 'typesafe', 'backfill', 5, 1.5)`,
      [spender.id],
    );
    const res = await apiClient(h.server, admin).get('/admin/usage', { query: { days: '7' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(7);
    expect(body.topUsers[0]).toEqual({
      userId: spender.id,
      email: spender.email,
      directUsd: 1.5,
      sharedUsd: 0,
      totalUsd: 1.5,
    });
    expect(body.daily).toContainEqual(
      expect.objectContaining({ engine: 'typesafe', kind: 'backfill', calls: 5, costUsd: 1.5 }),
    );
    for (const days of ['0', '91', 'x']) {
      const bad = await apiClient(h.server, admin).get('/admin/usage', { query: { days } });
      expect(bad.statusCode).toBe(400);
    }
    expect((await apiClient(h.server, admin).get('/admin/usage')).json().days).toBe(30);
  });
});

describe('feeds (spec 08 §9)', () => {
  it('lists by status and search with cursor pagination, edits fetch options and resets', async () => {
    const dead = await createFeed(h.owner, { status: 'dead', title: 'Zeta dead feed' });
    await h.owner.query(
      `UPDATE feeds SET consecutive_errors = 12, quarantine_count = 3, first_error_at = now(),
                        quarantined_until = now() + interval '1 day'
        WHERE id = $1`,
      [dead.id],
    );
    await createFeed(h.owner, { status: 'dead', title: 'Zeta second' });
    const client = apiClient(h.server, admin);

    const page1 = await client.get('/admin/feeds', {
      query: { status: 'dead', q: 'Zeta', limit: '1' },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items).toHaveLength(1);
    expect(page1.json().items[0].id).toBe(dead.id);
    const cursor = page1.json().nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    const page2 = await client.get('/admin/feeds', {
      query: { status: 'dead', q: 'Zeta', limit: '1', cursor },
    });
    expect(page2.json().items).toHaveLength(1);
    expect(page2.json().nextCursor).toBeNull();
    // A cursor is bound to its query.
    const mismatch = await client.get('/admin/feeds', { query: { status: 'active', cursor } });
    expect(mismatch.statusCode).toBe(400);

    const patched = await client.patch(`/admin/feeds/${dead.id}`, {
      fetchOptions: { userAgent: 'CustomBot/2.0', translateStrong: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().feed.fetchOptions).toEqual({
      userAgent: 'CustomBot/2.0',
      translateStrong: true,
    });
    const stored = await h.owner.query<{ fetch_options: unknown }>(
      'SELECT fetch_options FROM feeds WHERE id = $1',
      [dead.id],
    );
    expect(stored.rows[0]?.fetch_options).toEqual({
      user_agent: 'CustomBot/2.0',
      translate_strong: true,
    });
    for (const fetchOptions of [
      { userAgent: 'Bot\r\nAuthorization: x' },
      { allowPrivate: true },
      { headers: { authorization: 'x' } },
    ]) {
      expect((await client.patch(`/admin/feeds/${dead.id}`, { fetchOptions })).statusCode).toBe(
        400,
      );
    }
    expect((await client.patch('/admin/feeds/999999', { fetchOptions: {} })).statusCode).toBe(404);

    const reset = await client.post(`/admin/feeds/${dead.id}/reset`);
    expect(reset.statusCode).toBe(200);
    expect(reset.json().feed).toEqual(
      expect.objectContaining({
        status: 'active',
        consecutiveErrors: 0,
        quarantineCount: 0,
        quarantinedUntil: null,
      }),
    );
    expect((await client.post('/admin/feeds/999999/reset')).statusCode).toBe(404);
  });
});

describe('users, invites and waitlist (spec 08 §9)', () => {
  it('edits plan and invites, recomputing feed intervals on a plan change', async () => {
    const user = await createUser(h.owner, { email: 'plan-change@example.test' });
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
    await h.owner.query(
      `SELECT refresh_feed_subscribers(ARRAY[$1::bigint], '{"beta":900,"admin":300}'::jsonb)`,
      [feed.id],
    );
    const interval = async () =>
      (
        await h.owner.query<{ min_interval_s: number }>(
          'SELECT min_interval_s FROM feeds WHERE id = $1',
          [feed.id],
        )
      ).rows[0]?.min_interval_s;
    expect(await interval()).toBe(900);

    const res = await apiClient(h.server, admin).patch(`/admin/users/${user.id}`, {
      plan: 'admin',
      invitesLeft: 7,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual(
      expect.objectContaining({ id: user.id, plan: 'admin', invitesLeft: 7, role: 'user' }),
    );
    expect(await interval()).toBe(300);

    for (const body of [
      { plan: 'gold' },
      { invitesLeft: -1 },
      { role: 'owner' },
      {},
      { email: 'x' },
    ]) {
      const bad = await apiClient(h.server, admin).patch(`/admin/users/${user.id}`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    const missing = await apiClient(h.server, admin).patch(
      '/admin/users/00000000-0000-7000-8000-000000000000',
      { plan: 'beta' },
    );
    expect(missing.statusCode).toBe(404);
  });

  it('refuses to demote the last active admin and revokes sessions on a downgrade', async () => {
    // Only `admin` is an active administrator so far.
    const self = await apiClient(h.server, admin).patch(`/admin/users/${admin.id}`, {
      role: 'user',
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.details.reason).toBe('last_admin');

    const second = await createTestUser(h, { role: 'admin' });
    const secondDevice = await createTestSession(h, second);
    expect((await apiClient(h.server, second).get('/admin/overview')).statusCode).toBe(200);

    const demoted = await apiClient(h.server, admin).patch(`/admin/users/${second.id}`, {
      role: 'user',
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json().sessionsRevoked).toBe(2);
    expect(demoted.json().user.role).toBe('user');
    expect((await apiClient(h.server, second).get('/admin/overview')).statusCode).toBe(401);
    expect((await apiClient(h.server, secondDevice).get('/admin/overview')).statusCode).toBe(401);

    const promoted = await apiClient(h.server, admin).patch(`/admin/users/${second.id}`, {
      role: 'admin',
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().sessionsRevoked).toBe(0);
  });

  it('lists users with search and pagination', async () => {
    await createUser(h.owner, { email: 'searchable-one@example.test' });
    await createUser(h.owner, { email: 'searchable-two@example.test' });
    const client = apiClient(h.server, admin);
    const first = await client.get('/admin/users', { query: { q: 'searchable-', limit: '1' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    const next = await client.get('/admin/users', {
      query: { q: 'searchable-', limit: '1', cursor: first.json().nextCursor },
    });
    expect(next.json().items).toHaveLength(1);
    expect(next.json().items[0].email).not.toBe(first.json().items[0].email);
    expect(next.json().nextCursor).toBeNull();
    expect((await client.get('/admin/users', { query: { q: 'x'.repeat(201) } })).statusCode).toBe(
      400,
    );
    expect((await client.get('/admin/users', { query: { limit: '101' } })).statusCode).toBe(400);
    // Another admin's cursor is not valid for this admin.
    const other = await createTestUser(h, { role: 'admin' });
    const foreign = await apiClient(h.server, other).get('/admin/users', {
      query: { q: 'searchable-', limit: '1', cursor: first.json().nextCursor },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it('lists invites by status and the waitlist (read-only)', async () => {
    await h.owner.query(
      `INSERT INTO invites (code, created_by, email, expires_at, used_by, used_at) VALUES
         ('UNUSED0001', $1, NULL, now() + interval '30 days', NULL, NULL),
         ('EXPIRED001', $1, 'late@example.test', now() - interval '1 day', NULL, NULL),
         ('USED000001', $1, NULL, now() + interval '30 days', $2, now())`,
      [admin.id, reader.id],
    );
    await h.owner.query(
      "INSERT INTO waitlist (email, locale, note) VALUES ('wait-1@example.test', 'sk', 'hi'), ('wait-2@example.test', 'en', NULL)",
    );
    const client = apiClient(h.server, admin);
    const all = await client.get('/admin/invites');
    expect(all.statusCode).toBe(200);
    expect(
      all
        .json()
        .items.map((i: { code: string }) => i.code)
        .sort(),
    ).toEqual(['EXPIRED001', 'UNUSED0001', 'USED000001'].sort());
    for (const [status, code] of [
      ['unused', 'UNUSED0001'],
      ['used', 'USED000001'],
      ['expired', 'EXPIRED001'],
    ] as const) {
      const res = await client.get('/admin/invites', { query: { status } });
      expect(res.json().items.map((i: { code: string }) => i.code)).toEqual([code]);
      expect(res.json().items[0].status).toBe(status);
    }
    const paged = await client.get('/admin/invites', { query: { limit: '2' } });
    expect(paged.json().items).toHaveLength(2);
    const rest = await client.get('/admin/invites', {
      query: { limit: '2', cursor: paged.json().nextCursor },
    });
    expect(rest.json().items).toHaveLength(1);

    const waitlist = await client.get('/admin/waitlist');
    expect(waitlist.statusCode).toBe(200);
    expect(waitlist.json().items.map((w: { email: string }) => w.email)).toEqual([
      'wait-2@example.test',
      'wait-1@example.test',
    ]);
    expect(waitlist.json().items[1]).toEqual(
      expect.objectContaining({ locale: 'sk', note: 'hi', invitedAt: null, inviteCode: null }),
    );
  });
});
