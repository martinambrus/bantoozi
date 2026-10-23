import { createDatabase, seedQuestionSets } from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import { systemClock } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
  createSubscription,
  startFakeLibreTranslate,
  startFixtureServer,
  type FakeLibreTranslate,
  type FixtureServer,
} from '@bantoozi/testing';
import { createLibreTranslateClient, type LibreTranslateClient } from '@bantoozi/translate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer, type BuildServerOptions } from '../src/server.js';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  testConfig,
  TEST_METRICS_TOKEN,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { seedModelState } from './support/model-state.js';

/**
 * M8b-T3 (scope B3, E.2; spec 08 §11, spec 03 §4): the API consumes the live runtime settings.
 *
 * Seams the builder must add to `BuildServerOptions` (this ruler uses them; names are the contract):
 * - `runtimeSettings?: { ttlMs?: number; now?: () => number }`: the TTL and clock of the API's
 *   `RuntimeSettingsCache` (`createRuntimeSettingsCache`, default 10 s / `Date.now`). A PATCH of a
 *   runtime key through THIS process calls `invalidate()` on write; another process sees it when
 *   its cache is older than `ttlMs` by its own `now()`.
 * - `createLibreTranslate?: (baseUrl: string) => LibreTranslateClient`: builds every LibreTranslate
 *   client the server owns (the initial one from the effective URL, and each swap). The server
 *   closes a client it created when the effective URL changes, and the live one on `close()`.
 *   It applies only when `libreTranslate` is not injected (`undefined`).
 *
 * Rules chosen by this ruler:
 * - Consumers read the live value per request (rate limiter, discovery fetch, analysis snapshot
 *   model, card translation client); `GET /admin/settings` reads the DB itself, so it proves nothing
 *   here: every assertion observes behaviour.
 * - `api.rate_limits_enabled=false` switches off the global per-IP limit, the per-user mutation
 *   limit and route limits EXCEPT the always-on group: auth-request-code, auth-verify, waitlist,
 *   setup-complete and ops-event. In production only the always-on group stays on; outside
 *   production `false` turns every limit off. A stored `true` turns limits on even when the env
 *   default is false; `null` falls back to the env value.
 * - The engine.typesafe_model setting replaces `config.typesafeModel` as the fallback model when no
 *   `engine.model_pin` exists (a pin still wins). Observed in the frozen analysis snapshot
 *   (`input_snapshot.model.model`). Other uses of `config.typesafeModel` (ratingDefaultsFor, the
 *   suggestions fallback) are not observed here.
 */

type Seams = {
  runtimeSettings?: { ttlMs?: number; now?: () => number };
  createLibreTranslate?: (baseUrl: string) => LibreTranslateClient;
};

const IP = '127.0.0.1';
const bearer = { authorization: `Bearer ${TEST_METRICS_TOKEN}` };

let h: ApiHarness;
let admin: TestUser;
const servers: FastifyInstance[] = [];

async function build(
  env: Record<string, string> = {},
  seams: Seams = {},
  extra: Partial<BuildServerOptions> = {},
): Promise<FastifyInstance> {
  const options: BuildServerOptions & Seams = {
    db: h.appDb,
    config: testConfig({ FETCH_ALLOW_PRIVATE: 'true', ...env }, h.db.urls.app),
    mailer: h.mailer,
    ...seams,
    ...extra,
  };
  const server = await buildServer(options);
  await server.ready();
  servers.push(server);
  return server;
}

const PROD_ENV = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://bantoozi.test',
  MAIL_TRANSPORT: 'smtp',
  SMTP_URL: 'smtp://127.0.0.1:1',
  RATE_LIMITS_ENABLED: 'true',
  FETCH_ALLOW_PRIVATE: 'false',
  PROVIDER_HOST_ALLOWLIST: 'api.typesafe.ai,ollama.com',
};

/** Fill a rate-limit bucket past `max` so the next hit of `group` from the test IP is limited. */
async function saturate(group: string, max: number, windowSeconds: number): Promise<void> {
  await h.owner.query(
    'SELECT rate_limit_hit($1, $2::int, $3::int) FROM generate_series(1, $4::int)',
    [`${group}:ip:${IP}`, windowSeconds, max, max + 5],
  );
}
const clearBuckets = () => h.owner.query('DELETE FROM rate_limit_buckets');

async function resetSettings(): Promise<void> {
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    [
      'api.rate_limits_enabled',
      'fetch.limits',
      'translate.libretranslate_url',
      'engine.typesafe_model',
      'engine.model_pin',
      'card_text_mode',
    ],
  ]);
  await seedModelState(h, { reset: true });
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});

afterAll(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      // closed by the test
    }
  }
  await h.close();
});

beforeEach(async () => {
  await resetSettings();
  await clearBuckets();
});

const patch = (server: FastifyInstance, body: unknown) =>
  apiClient(server, admin).patch('/admin/settings', body);
const probe = (server: FastifyInstance) => apiClient(server, admin).get('/admin/settings');

describe('rate limits: api.rate_limits_enabled', () => {
  it('applies a PATCH at once in the same process and within the TTL in a second process', async () => {
    const clockA = { t: 1_000_000 };
    const clockB = { t: 1_000_000 };
    const ttlMs = 10_000;
    const a = await build(
      { RATE_LIMITS_ENABLED: 'true' },
      { runtimeSettings: { ttlMs, now: () => clockA.t } },
    );
    const b = await build(
      { RATE_LIMITS_ENABLED: 'true' },
      { runtimeSettings: { ttlMs, now: () => clockB.t } },
    );

    // Both processes load their cache with the env value (limits on).
    expect((await probe(a)).statusCode).toBe(200);
    expect((await probe(b)).statusCode).toBe(200);

    // Control: with limits on and the global bucket full, a request is limited.
    await saturate('all', 300, 60);
    expect((await probe(a)).statusCode).toBe(429);
    await clearBuckets();

    // PATCH through A: A's own cache is invalidated by the write, no clock movement needed.
    expect((await patch(a, { 'api.rate_limits_enabled': false })).statusCode).toBe(200);
    await saturate('all', 300, 60);
    expect((await probe(a)).statusCode).toBe(200);

    // B still holds the old snapshot inside its TTL (negative control: the cache is real) ...
    clockB.t += ttlMs - 1;
    expect((await probe(b)).statusCode).toBe(429);
    // ... and applies the change once the TTL has passed, without any restart.
    clockB.t += 2;
    expect((await probe(b)).statusCode).toBe(200);

    // And back: null resets to the env value (on) at once in A.
    expect((await patch(a, { 'api.rate_limits_enabled': null })).statusCode).toBe(200);
    expect((await probe(a)).statusCode).toBe(429);
  });

  it('outside production false turns every limit off, true turns them on (env default false)', async () => {
    const server = await build({ RATE_LIMITS_ENABLED: 'false' });
    await saturate('all', 300, 60);
    await saturate('auth-request-code', 20, 3600);
    // Control: env default false, nothing stored: limits are off.
    expect((await probe(server)).statusCode).toBe(200);

    expect((await patch(server, { 'api.rate_limits_enabled': true })).statusCode).toBe(200);
    expect((await probe(server)).statusCode).toBe(429);
    const code = await apiClient(server).post('/auth/request-code', { email: 'x@example.test' });
    expect(code.statusCode).toBe(429);

    await clearBuckets();
    expect((await patch(server, { 'api.rate_limits_enabled': false })).statusCode).toBe(200);
    await saturate('all', 300, 60);
    await saturate('auth-request-code', 20, 3600);
    expect((await probe(server)).statusCode).toBe(200);
    const open = await apiClient(server).post('/auth/request-code', { email: 'x@example.test' });
    expect(open.statusCode).not.toBe(429);
  });

  const STRICT: {
    name: string;
    group: string;
    max: number;
    windowSeconds: number;
    call: (
      server: FastifyInstance,
    ) => Promise<{ statusCode: number; headers: Record<string, unknown> }>;
  }[] = [
    {
      name: 'POST /auth/request-code',
      group: 'auth-request-code',
      max: 20,
      windowSeconds: 3600,
      call: (s) => apiClient(s).post('/auth/request-code', { email: 'x@example.test' }),
    },
    {
      name: 'POST /auth/verify',
      group: 'auth-verify',
      max: 10,
      windowSeconds: 600,
      call: (s) => apiClient(s).post('/auth/verify', { email: 'x@example.test', code: '000000' }),
    },
    {
      name: 'POST /waitlist',
      group: 'waitlist',
      max: 5,
      windowSeconds: 3600,
      call: (s) => apiClient(s).post('/waitlist', { email: 'x@example.test' }),
    },
    {
      name: 'POST /setup/complete',
      group: 'setup-complete',
      max: 10,
      windowSeconds: 900,
      call: (s) =>
        apiClient(s).post('/setup/complete', { token: 'wrong', email: 'x@example.test' }),
    },
    {
      name: 'POST /admin/ops-event',
      group: 'ops-event',
      max: 30,
      windowSeconds: 60,
      call: (s) =>
        apiClient(s).post(
          '/admin/ops-event',
          { kind: 'backup_ok' },
          { headers: bearer, client: null, idempotencyKey: null },
        ),
    },
  ];

  it.each(STRICT)(
    'in production false still returns 429 on $name, while the general limits are off',
    async (entry) => {
      const prod = await build(PROD_ENV, { runtimeSettings: { ttlMs: 10_000, now: () => 1 } });
      expect((await patch(prod, { 'api.rate_limits_enabled': false })).statusCode).toBe(200);

      // Negative control 1: an unsaturated bucket does not answer 429.
      expect((await entry.call(prod)).statusCode).not.toBe(429);
      await clearBuckets();

      // The general per-IP limit is off ...
      await saturate('all', 300, 60);
      expect((await probe(prod)).statusCode).toBe(200);
      // ... but this route's own always-on limit is not.
      await saturate(entry.group, entry.max, entry.windowSeconds);
      const limited = await entry.call(prod);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    },
  );

  it('in production a general route limit (subscribe) is off with false and on with null', async () => {
    const prod = await build(PROD_ENV, { runtimeSettings: { ttlMs: 10_000, now: () => 1 } });
    expect((await patch(prod, { 'api.rate_limits_enabled': false })).statusCode).toBe(200);
    await saturate('all', 300, 60);
    expect((await probe(prod)).statusCode).toBe(200);
    expect((await patch(prod, { 'api.rate_limits_enabled': null })).statusCode).toBe(200);
    expect((await probe(prod)).statusCode).toBe(429);
  });
});

describe('fetch.limits in discovery and subscribe', () => {
  let fixture: FixtureServer;

  const rss = (title: string, padding = 0) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>` +
    `<link>http://127.0.0.1/</link><description>d</description>` +
    `<item><title>One</title><link>http://127.0.0.1/1</link><guid>1</guid>` +
    `<description>${'x'.repeat(padding)}</description></item></channel></rss>`;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });
  afterAll(async () => {
    await fixture.close();
  });

  const subscribe = (server: FastifyInstance, user: TestUser, path: string) =>
    apiClient(server, user).post('/subscriptions', { url: fixture.url(path) });

  it('uses the stored maxBytes at once and restores the default on null', async () => {
    const server = await build();
    const user = await createTestUser(h);
    const body = rss('Big', 200_000);
    for (const p of ['/big-a.xml', '/big-b.xml', '/big-c.xml']) {
      fixture.route(p, { body, headers: { 'content-type': 'application/rss+xml' } });
    }
    // Control: the default 5 MiB limit accepts the 200 KB feed.
    const first = await subscribe(server, user, '/big-a.xml');
    expect(first.statusCode, first.body).toBe(201);

    expect(
      (await patch(server, { 'fetch.limits': { timeoutMs: 20_000, maxBytes: 65_536 } })).statusCode,
    ).toBe(200);
    const refused = await subscribe(server, user, '/big-b.xml');
    expect(refused.statusCode, refused.body).not.toBe(201);
    const rows = await h.owner.query('SELECT 1 FROM feeds WHERE url LIKE $1', ['%/big-b.xml']);
    expect(rows.rowCount).toBe(0);

    expect((await patch(server, { 'fetch.limits': null })).statusCode).toBe(200);
    const again = await subscribe(server, user, '/big-c.xml');
    expect(again.statusCode, again.body).toBe(201);
  });

  it('uses the stored timeoutMs at once', async () => {
    const server = await build();
    const user = await createTestUser(h);
    fixture.route('/slow-a.xml', {
      body: rss('Slow A'),
      headers: { 'content-type': 'application/rss+xml' },
      delayMs: 1_500,
    });
    fixture.route('/slow-b.xml', {
      body: rss('Slow B'),
      headers: { 'content-type': 'application/rss+xml' },
      delayMs: 1_500,
    });
    // Control: the default 20 s timeout waits the 1.5 s out.
    const slow = await subscribe(server, user, '/slow-a.xml');
    expect(slow.statusCode, slow.body).toBe(201);

    expect(
      (await patch(server, { 'fetch.limits': { timeoutMs: 1_000, maxBytes: 5_242_880 } }))
        .statusCode,
    ).toBe(200);
    const startedAt = Date.now();
    const timedOut = await subscribe(server, user, '/slow-b.xml');
    expect(timedOut.statusCode, timedOut.body).not.toBe(201);
    expect(Date.now() - startedAt).toBeLessThan(1_450);
  });

  it('a second process applies a stored limit once its cache is older than the TTL', async () => {
    const clock = { t: 5_000 };
    const ttlMs = 10_000;
    const a = await build();
    const b = await build({}, { runtimeSettings: { ttlMs, now: () => clock.t } });
    const user = await createTestUser(h);
    const body = rss('Big', 200_000);
    for (const p of ['/p-a.xml', '/p-b.xml', '/p-c.xml']) {
      fixture.route(p, { body, headers: { 'content-type': 'application/rss+xml' } });
    }
    expect((await subscribe(b, user, '/p-a.xml')).statusCode).toBe(201); // B cache loaded
    expect(
      (await patch(a, { 'fetch.limits': { timeoutMs: 20_000, maxBytes: 65_536 } })).statusCode,
    ).toBe(200);
    clock.t += ttlMs - 1;
    expect((await subscribe(b, user, '/p-b.xml')).statusCode).toBe(201); // stale inside the TTL
    clock.t += 2;
    expect((await subscribe(b, user, '/p-c.xml')).statusCode).not.toBe(201);
  });
});

describe('translate.libretranslate_url swaps the API client', () => {
  let ltA: FakeLibreTranslate;
  let ltB: FakeLibreTranslate;

  beforeAll(async () => {
    ltA = await startFakeLibreTranslate();
    ltB = await startFakeLibreTranslate();
  });
  afterAll(async () => {
    await ltA.close();
    await ltB.close();
  });

  const SLOVAK = 'Nové chémie batérií pre elektrické autá, ich výroba a výskum na Slovensku';
  let n = 0;
  const createCard = (server: FastifyInstance, user: TestUser) => {
    n += 1;
    return apiClient(server, user).post('/cards', { interest: `${SLOVAK} ${n}`, strength: 'like' });
  };
  const translates = (fake: FakeLibreTranslate) =>
    fake.requests.filter((r) => r.path === '/translate').length;

  it('creates the new client, routes card translation to it, and closes the old one', async () => {
    ltA.reset();
    ltB.reset();
    const created: { url: string; closed: boolean }[] = [];
    const server = await build(
      { LIBRETRANSLATE_URL: ltA.url },
      {
        createLibreTranslate: (baseUrl) => {
          const real = createLibreTranslateClient({ baseUrl, clock: systemClock, backoffMs: 1 });
          const entry = { url: baseUrl, closed: false };
          created.push(entry);
          return {
            ...real,
            async close() {
              entry.closed = true;
              await real.close();
            },
          };
        },
      },
    );
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ('card_text_mode', '"english"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const user = await createTestUser(h, { locale: 'sk' });
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });

    // Control: before the change the env URL serves the translation.
    expect((await createCard(server, user)).statusCode).toBe(201);
    expect(translates(ltA)).toBe(1);
    expect(translates(ltB)).toBe(0);
    expect(created.map((c) => c.url)).toEqual([ltA.url]);

    const res = await patch(server, { 'translate.libretranslate_url': ltB.url });
    expect(res.statusCode, res.body).toBe(200);

    expect((await createCard(server, user)).statusCode).toBe(201);
    expect((await createCard(server, user)).statusCode).toBe(201);
    expect(translates(ltB)).toBe(2);
    expect(translates(ltA)).toBe(1); // nothing more to the old URL
    expect(created.map((c) => c.url)).toEqual([ltA.url, ltB.url]); // one swap, not one per request

    await expect.poll(() => created[0]?.closed, { timeout: 2_000 }).toBe(true);
    expect(created[1]?.closed).toBe(false);

    // null goes back to the env URL: a third client, the second one closed.
    expect((await patch(server, { 'translate.libretranslate_url': null })).statusCode).toBe(200);
    expect((await createCard(server, user)).statusCode).toBe(201);
    expect(translates(ltA)).toBe(2);
    expect(created.map((c) => c.url)).toEqual([ltA.url, ltB.url, ltA.url]);
    await expect.poll(() => created[1]?.closed, { timeout: 2_000 }).toBe(true);

    // Closing the server closes the live client.
    await server.close();
    expect(created[2]?.closed).toBe(true);
  });
});

describe('engine.typesafe_model is the API fallback model', () => {
  async function seedActiveQuestionSets(): Promise<void> {
    const versions = {} as Record<QuestionSetKind, string>;
    for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
    await createDatabase(h.owner).transaction((tx) =>
      seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
    );
  }

  async function analyzeModel(
    server: FastifyInstance,
    user: TestUser,
    feedId: string,
    version: string,
    first: boolean,
  ): Promise<unknown> {
    const article = await createArticle(h.owner, { feedIds: [feedId] });
    const res = await apiClient(server, user).post(`/subscriptions/${feedId}/analyze`, {
      articles: [{ id: article.id, contentRevision: article.contentRevision }],
      expectedInferenceVersion: version,
      ...(first ? { startTraining: true } : {}),
    });
    expect(res.statusCode, res.body).toBe(202);
    const { rows } = await h.owner.query<{ input_snapshot: { model: { model: string } } }>(
      'SELECT input_snapshot FROM analysis_requests WHERE id = $1',
      [res.json().requests[0].id],
    );
    return rows[0]?.input_snapshot.model.model;
  }

  it('freezes the stored model, falls back to env on null, and lets a model pin win', async () => {
    await seedActiveQuestionSets();
    const server = await build();
    const user = await createTestUser(h);
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });

    // Control: env model (TYPESAFE_MODEL default jev-1.13.0), no pin.
    expect(await analyzeModel(server, user, feed.id, '0', true)).toBe('jev-1.13.0');

    // JEV-5: a model change needs a fresh probe of the new value.
    await seedModelState(h, { probes: [{ requested: 'jev-1.14.0', answered: 'jev-1.14.0' }] });
    const set = await patch(server, { 'engine.typesafe_model': 'jev-1.14.0', acknowledge: true });
    expect(set.statusCode, set.body).toBe(200);
    expect(await analyzeModel(server, user, feed.id, '1', false)).toBe('jev-1.14.0');

    // A stored pin still wins over the setting.
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.model_pin', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ model: 'jev-1.12.0', since: '2026-10-01T00:00:00Z' })],
    );
    expect(await analyzeModel(server, user, feed.id, '1', false)).toBe('jev-1.12.0');
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);

    // The reset targets the env default, which needs its own fresh probe.
    await seedModelState(h, { probes: [{ requested: 'jev-1.13.0', answered: 'jev-1.13.0' }] });
    const reset = await patch(server, { 'engine.typesafe_model': null, acknowledge: true });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await analyzeModel(server, user, feed.id, '1', false)).toBe('jev-1.13.0');
  });
});
