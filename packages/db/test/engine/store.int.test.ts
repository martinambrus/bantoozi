import { randomUUID } from 'node:crypto';

import {
  newUuid,
  PLATFORM_USER_ID,
  type CallKind,
  type EngineCallRow,
  type InferenceAuthorization,
  type UsageRow,
} from '@bantoozi/shared';
import { encryptProviderSecret, ProviderKeyring } from '@bantoozi/shared/server/credential-crypto';
import { createArticle, createFeed, createSubscription, createUser } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../src/client.js';
import {
  claimCredentialValidation,
  createPgEngineStore,
  isInferenceAuthorized,
  stageProviderCredential,
  type PgEngineStore,
} from '../../src/engine/index.js';
import { setupDbTest, withConnection, type DbTestContext } from '../support/test-db.js';

/**
 * The PostgreSQL engine store (M2-T3; spec 04 §1.1, §5–§7; spec 02 §3.1, §3.3): atomic spend
 * admission with live demand rechecks, idempotent settlement, uncertain billing, UTC-day
 * attribution, usage rollups, budget alert crossings and the shared breaker state, as the worker
 * role against a real migrated database.
 */

let ctx: DbTestContext;
/** A second worker-role pool: a second process/router with its own connections. */
let otherPool: pg.Pool;
let other: Database;

beforeAll(async () => {
  ctx = await setupDbTest();
  otherPool = new pg.Pool({ connectionString: ctx.testDb.urls.worker, max: 6 });
  other = createDatabase(otherPool);
});

afterAll(async () => {
  await otherPool.end();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.owner.query(
    `DELETE FROM settings WHERE key IN ('engine.daily_budget_usd', 'engine.budget_alerts', 'engine.circuit')`,
  );
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** A fresh UTC day per test, far from today, so budgets never share reservations. */
let dayCounter = 0;
function freshDay(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1) + dayCounter * 86_400_000).toISOString().slice(0, 10);
}

function store(budgetUsd: number, db: Database = ctx.worker): PgEngineStore {
  return createPgEngineStore(db, { dailyBudgetUsd: budgetUsd });
}

interface Demand {
  userId: string;
  feedId: string;
  articleId: string;
  revision: string;
  authorization: Extract<InferenceAuthorization, { type: 'article' }>;
}

/** An active reader whose feed carried the article after activation (automatic witness). */
async function automaticDemand(): Promise<Demand> {
  const feed = await createFeed(ctx.owner);
  const user = await createUser(ctx.owner);
  await createSubscription(ctx.owner, {
    userId: user.id,
    feedId: feed.id,
    mode: 'active',
    activatedAt: hoursAgo(2),
  });
  const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
  return {
    userId: user.id,
    feedId: feed.id,
    articleId: article.id,
    revision: article.contentRevision,
    authorization: {
      type: 'article',
      articleId: article.id,
      articleRevision: article.contentRevision,
      witnesses: [{ kind: 'automatic', userId: user.id, feedId: feed.id, inferenceVersion: '1' }],
    },
  };
}

/** A training reader's manual analysis request for the article's current revision. */
async function manualDemand(options: { createdAt?: Date } = {}) {
  const feed = await createFeed(ctx.owner);
  const user = await createUser(ctx.owner);
  await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id, mode: 'training' });
  const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
  const requestId = randomUUID();
  await withConnection(ctx.owner, async (client) => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
                                      inference_version, input_snapshot, input_sha)
       VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb,
               encode(sha256(convert_to($6::jsonb::text, 'UTF8')), 'hex'))`,
      [requestId, user.id, feed.id, article.id, article.contentRevision, '{"title":"x"}'],
    );
    await client.query('COMMIT');
  });
  if (options.createdAt !== undefined) {
    await ctx.owner.query(
      `ALTER TABLE analysis_requests DISABLE TRIGGER analysis_requests_update_check`,
    );
    try {
      await ctx.owner.query('UPDATE analysis_requests SET created_at = $2 WHERE id = $1', [
        requestId,
        options.createdAt,
      ]);
    } finally {
      await ctx.owner.query(
        `ALTER TABLE analysis_requests ENABLE TRIGGER analysis_requests_update_check`,
      );
    }
  }
  const authorization: Extract<InferenceAuthorization, { type: 'article' }> = {
    type: 'article',
    articleId: article.id,
    articleRevision: article.contentRevision,
    witnesses: [{ kind: 'manual', analysisRequestId: requestId }],
  };
  return { userId: user.id, feedId: feed.id, articleId: article.id, requestId, authorization };
}

const reserveInput = (
  day: string,
  authorization: InferenceAuthorization,
  patch: Partial<Parameters<PgEngineStore['reserveSpend']>[0]> = {},
): Parameters<PgEngineStore['reserveSpend']>[0] => ({
  day,
  engine: 'typesafe',
  kind: 'enrich',
  estimateUsd: 0.1,
  priority: 'bulk',
  authorization,
  ...patch,
});

function callRow(patch: Partial<EngineCallRow> = {}): EngineCallRow {
  return {
    engine: 'typesafe',
    kind: 'enrich',
    model: 'jev-1.13.0',
    nQuestions: 3,
    inputTokens: 1_000,
    outputTokens: 50,
    costUsd: 0.04,
    latencyMs: 120,
    billing: 'known',
    logicalRequestId: newUuid(),
    attempts: 1,
    status: 'ok',
    createdAt: new Date(),
    ...patch,
  };
}

const usageRow = (day: string, patch: Partial<UsageRow> = {}): UsageRow => ({
  day,
  userId: PLATFORM_USER_ID,
  engine: 'typesafe',
  kind: 'enrich',
  calls: 1,
  inputTokens: 1_000,
  outputTokens: 50,
  costUsd: 0.04,
  ...patch,
});

async function reservation(id: string) {
  const { rows } = await ctx.owner.query<{
    day: string;
    status: string;
    reserved_usd: string;
    actual_usd: string | null;
    user_id: string | null;
    expires_in_s: number;
  }>(
    `SELECT day::text AS day, status, reserved_usd::text AS reserved_usd, actual_usd::text AS actual_usd,
            user_id::text AS user_id,
            extract(epoch FROM expires_at - created_at)::int AS expires_in_s
       FROM engine_reservations WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function callsOf(logicalRequestId: string) {
  const { rows } = await ctx.owner.query<{
    engine: string;
    attempts: number;
    status: string;
    billing: string;
    cost_usd: string;
    reservation_id: string | null;
    input_tokens: number;
    user_id: string | null;
  }>(
    `SELECT engine, attempts, status, billing, cost_usd::text AS cost_usd,
            reservation_id::text AS reservation_id, input_tokens, user_id::text AS user_id
       FROM engine_calls WHERE logical_request_id = $1 ORDER BY engine, attempts`,
    [logicalRequestId],
  );
  return rows;
}

async function usage(day: string, userId: string, engine = 'typesafe', kind: CallKind = 'enrich') {
  const { rows } = await ctx.owner.query<{
    calls: number;
    input_tokens: string;
    output_tokens: string;
    cost_usd: string;
  }>(
    `SELECT calls, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
            cost_usd::text AS cost_usd
       FROM usage_daily WHERE day = $1 AND user_id = $2 AND engine = $3 AND kind = $4`,
    [day, userId, engine, kind],
  );
  return rows[0];
}

async function setting(key: string): Promise<unknown> {
  const { rows } = await ctx.owner.query<{ value: unknown }>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return rows[0]?.value;
}

describe('reserveSpend and settleReservation (spec 04 §6)', () => {
  it('reserves, audits one call per attempt and rolls usage up on the reservation', async () => {
    const demand = await automaticDemand();
    const s = store(2);
    const day = freshDay();
    const id = await s.reserveSpend(
      reserveInput(day, demand.authorization, { userId: demand.userId, estimateUsd: 0.05 }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const reserved = await reservation(id!);
    expect(reserved).toMatchObject({
      day,
      status: 'reserved',
      reserved_usd: '0.05000000',
      user_id: demand.userId,
      expires_in_s: 600,
    });

    const logical = newUuid();
    await s.settleReservation(
      id!,
      callRow({
        logicalRequestId: logical,
        reservationId: id!,
        userId: demand.userId,
        articleId: demand.articleId,
        articleRevision: demand.revision,
        credentialVersion: '4',
        cardIds: ['1', '2'],
      }),
      usageRow(day, { userId: demand.userId }),
      'known',
    );
    expect(await reservation(id!)).toMatchObject({ status: 'settled', actual_usd: '0.04000000' });
    expect(await callsOf(logical)).toEqual([
      {
        engine: 'typesafe',
        attempts: 1,
        status: 'ok',
        billing: 'known',
        cost_usd: '0.04000000',
        reservation_id: id,
        input_tokens: 1_000,
        user_id: demand.userId,
      },
    ]);
    expect(await usage(day, demand.userId)).toEqual({
      calls: 1,
      input_tokens: '1000',
      output_tokens: '50',
      cost_usd: '0.04000000',
    });
    const snapshot = await s.getBudgetSnapshot(day, { excludeKinds: ['eval'] });
    expect(snapshot).toEqual({
      settledUsd: 0.04,
      reservedUsd: 0,
      uncertainUsd: 0,
      callsByEngineKind: { 'typesafe:enrich': 1 },
    });
  });

  it('replays a settlement idempotently (a retried settlement adds nothing)', async () => {
    const demand = await automaticDemand();
    const s = store(2);
    const day = freshDay();
    const id = (await s.reserveSpend(reserveInput(day, demand.authorization)))!;
    const call = callRow({ reservationId: id, userId: demand.userId });
    const rollup = usageRow(day, { userId: demand.userId });
    await s.settleReservation(id, call, rollup, 'known');
    await s.settleReservation(id, call, rollup, 'known');
    // Another connection replaying it concurrently changes nothing either.
    await Promise.all([
      store(2, other).settleReservation(id, call, rollup, 'known'),
      s.settleReservation(id, call, rollup, 'known'),
    ]);
    expect(await callsOf(call.logicalRequestId)).toHaveLength(1);
    expect(await usage(day, demand.userId)).toMatchObject({ calls: 1, cost_usd: '0.04000000' });
  });

  it('keeps unknown billing charged at the reserve until a known settlement reconciles it', async () => {
    const demand = await automaticDemand();
    const s = store(1);
    const day = freshDay();
    const id = (await s.reserveSpend(
      reserveInput(day, demand.authorization, { estimateUsd: 0.3 }),
    ))!;
    const call = callRow({ reservationId: id, status: 'timeout', costUsd: 0.2 });
    await s.settleReservation(id, call, usageRow(day), 'uncertain');
    expect(await reservation(id)).toMatchObject({ status: 'uncertain', actual_usd: null });
    expect(await callsOf(call.logicalRequestId)).toMatchObject([
      { billing: 'uncertain', cost_usd: '0.00000000', status: 'timeout' },
    ]);
    // Still charged at the full reserve: 0.3 of 1.0 is committed.
    expect(await s.getBudgetSnapshot(day, { excludeKinds: ['eval'] })).toMatchObject({
      uncertainUsd: 0.3,
      settledUsd: 0,
    });
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.71 })),
    ).toBeNull();
    // A replay with unknown billing changes nothing.
    await s.settleReservation(id, call, usageRow(day), 'uncertain');
    expect(await usage(day, PLATFORM_USER_ID)).toMatchObject({ calls: 1, cost_usd: '0.00000000' });

    // Reconciliation with the provider's figure replaces the reserve by the actual cost.
    await s.settleReservation(
      id,
      { ...call, inputTokens: 1_200, outputTokens: 60 },
      usageRow(day),
      'known',
    );
    expect(await reservation(id)).toMatchObject({ status: 'settled', actual_usd: '0.20000000' });
    expect(await callsOf(call.logicalRequestId)).toMatchObject([
      { billing: 'known', cost_usd: '0.20000000', input_tokens: 1_200 },
    ]);
    expect(await usage(day, PLATFORM_USER_ID)).toEqual({
      calls: 1,
      input_tokens: '1200',
      output_tokens: '60',
      cost_usd: '0.20000000',
    });
    // A late replay of the reconciled settlement is a no-op.
    await s.settleReservation(id, call, usageRow(day), 'known');
    expect(await usage(day, PLATFORM_USER_ID)).toMatchObject({ cost_usd: '0.20000000' });
  });

  it('attributes a settlement after UTC midnight to the reservation day', async () => {
    const demand = await automaticDemand();
    const s = store(2);
    const day = freshDay();
    const id = (await s.reserveSpend(reserveInput(day, demand.authorization)))!;
    // The attempt finished (and settles) on a later UTC day.
    const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 + 5_000);
    const next = nextDay.toISOString().slice(0, 10);
    await s.settleReservation(
      id,
      callRow({ reservationId: id, createdAt: nextDay }),
      usageRow(next),
      'known',
    );
    expect(await usage(day, PLATFORM_USER_ID)).toMatchObject({ calls: 1, cost_usd: '0.04000000' });
    expect(await usage(next, PLATFORM_USER_ID)).toBeUndefined();
    expect((await s.getBudgetSnapshot(day, { excludeKinds: ['eval'] })).settledUsd).toBe(0.04);
    expect((await s.getBudgetSnapshot(next, { excludeKinds: ['eval'] })).settledUsd).toBe(0);
  });

  it('rejects settlements that do not match their reservation', async () => {
    const demand = await automaticDemand();
    const s = store(2);
    const day = freshDay();
    const id = (await s.reserveSpend(reserveInput(day, demand.authorization)))!;
    await expect(
      s.settleReservation(
        id,
        callRow({ engine: 'llm' }),
        usageRow(day, { engine: 'llm' }),
        'known',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      s.settleReservation(id, callRow(), usageRow(day, { kind: 'match' }), 'known'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      s.settleReservation(newUuid(), callRow(), usageRow(day), 'known'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      s.settleReservation(id, callRow({ reservationId: newUuid() }), usageRow(day), 'known'),
    ).rejects.toThrow(RangeError);
    await expect(
      s.settleReservation(id, callRow({ attempts: 0 }), usageRow(day), 'known'),
    ).rejects.toThrow(RangeError);
    // Two reservations cannot claim the same attempt ordinal of one logical request.
    const call = callRow({ reservationId: id });
    await s.settleReservation(id, call, usageRow(day), 'known');
    const second = (await s.reserveSpend(reserveInput(day, demand.authorization)))!;
    await expect(
      s.settleReservation(second, { ...call, reservationId: second }, usageRow(day), 'known'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('validates reservation inputs before touching the database', async () => {
    const demand = await automaticDemand();
    const s = store(2);
    const day = freshDay();
    await expect(s.reserveSpend(reserveInput('2026-02-30', demand.authorization))).rejects.toThrow(
      RangeError,
    );
    await expect(
      s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: -1 })),
    ).rejects.toThrow(RangeError);
    await expect(
      s.reserveSpend(reserveInput(day, demand.authorization, { userId: 'nobody' })),
    ).rejects.toThrow(RangeError);
    await expect(
      s.reserveSpend(reserveInput(day, demand.authorization, { kind: 'bogus' as CallKind })),
    ).rejects.toThrow(RangeError);
    expect(() => createPgEngineStore(ctx.worker, { dailyBudgetUsd: -1 })).toThrow(RangeError);
  });
});

describe('budget admission (spec 04 §6, spec 02 §3.3)', () => {
  it('lets concurrent reservations of two connections never exceed the budget', async () => {
    const demand = await automaticDemand();
    const day = freshDay();
    const a = store(1);
    const b = store(1, other);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 === 0 ? a : b).reserveSpend(
          reserveInput(day, demand.authorization, { estimateUsd: 0.3 }),
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    expect((await a.getBudgetSnapshot(day, { excludeKinds: ['eval'] })).reservedUsd).toBeCloseTo(
      0.9,
      8,
    );
  });

  it('gives interactive requests a 10 % allowance and stops bulk at 100 %', async () => {
    const demand = await automaticDemand();
    const day = freshDay();
    const s = store(1);
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 1 })),
    ).not.toBeNull();
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.01 })),
    ).toBeNull();
    const interactive = reserveInput(day, demand.authorization, {
      estimateUsd: 0.06,
      priority: 'interactive',
    });
    expect(await s.reserveSpend(interactive)).not.toBeNull();
    expect(await s.reserveSpend(interactive)).toBeNull();
  });

  it('prefers the stored daily budget setting over the host default', async () => {
    const demand = await automaticDemand();
    const day = freshDay();
    const s = store(5);
    await s.setSetting('engine.daily_budget_usd', 0.1);
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.2 })),
    ).toBeNull();
    await s.setSetting('engine.daily_budget_usd', 1);
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.2 })),
    ).not.toBeNull();
    await expect(s.setSetting('engine.daily_budget_usd', -5)).rejects.toThrow();
    expect(await s.getSetting('engine.daily_budget_usd')).toBe(1);
  });

  it('keeps eval spend out of the production budget, and needs eval authorization for it', async () => {
    const demand = await automaticDemand();
    const day = freshDay();
    const s = store(0.5);
    const evalAuth: InferenceAuthorization = { type: 'eval', runId: 'run-2031' };
    const since = new Date();
    const evalId = await s.reserveSpend(
      reserveInput(day, evalAuth, { kind: 'eval', estimateUsd: 3 }),
    );
    expect(evalId).not.toBeNull();
    // Production is unaffected by the eval reservation…
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.5 })),
    ).not.toBeNull();
    expect(await s.getBudgetSnapshot(day, { excludeKinds: ['eval'] })).toMatchObject({
      reservedUsd: 0.5,
    });
    expect(
      (await s.getBudgetSnapshot(day, { excludeKinds: 'none' })).callsByEngineKind,
    ).toMatchObject({ 'typesafe:eval': 1, 'typesafe:enrich': 1 });
    // …and eval spend is admitted beyond it.
    expect(
      await s.reserveSpend(reserveInput(day, evalAuth, { kind: 'eval', estimateUsd: 1 })),
    ).not.toBeNull();
    // kind 'eval' and the eval authorization only go together.
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { kind: 'eval' })),
    ).toBeNull();
    expect(await s.reserveSpend(reserveInput(day, evalAuth))).toBeNull();
    expect(
      await s.reserveSpend(reserveInput(day, { type: 'eval', runId: ' ' }, { kind: 'eval' })),
    ).toBeNull();
    expect(await s.spendSince(since, { excludeKinds: ['eval'] })).toBe(0.5);
    expect(await s.spendSince(since, { excludeKinds: 'none' })).toBe(4.5);
  });

  it('counts one daily call cap across the decision kinds of an engine', async () => {
    const demand = await automaticDemand();
    const day = freshDay();
    const s = store(10);
    const llm = (kind: CallKind) =>
      s.reserveSpend(
        reserveInput(day, demand.authorization, {
          engine: 'llm',
          kind,
          callCap: 2,
          priority: 'interactive',
        }),
      );
    expect(await llm('enrich')).not.toBeNull();
    expect(await llm('match')).not.toBeNull();
    expect(await llm('cluster')).toBeNull();
    // Another engine has its own count.
    expect(
      await s.reserveSpend(reserveInput(day, demand.authorization, { callCap: 2 })),
    ).not.toBeNull();
  });
});

describe('budget alert crossings (spec 04 §6, spec 11 §6)', () => {
  it('records 80 % and 100 % once per UTC day in engine.budget_alerts, without email', async () => {
    const demand = await automaticDemand();
    const s = store(1);
    const day = freshDay();
    const outboxBefore = await ctx.owner.query('SELECT count(*)::int AS n FROM job_outbox');
    await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.5 }));
    expect(await setting('engine.budget_alerts')).toBeUndefined();
    await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.35 }));
    const p80 = (await setting('engine.budget_alerts')) as Record<string, string>;
    expect(Object.keys(p80).sort()).toEqual(['day', 'p80At']);
    expect(p80['day']).toBe(day);
    await s.reserveSpend(reserveInput(day, demand.authorization, { estimateUsd: 0.1 }));
    expect(await setting('engine.budget_alerts')).toEqual(p80);
    await s.reserveSpend(
      reserveInput(day, demand.authorization, { estimateUsd: 0.1, priority: 'interactive' }),
    );
    const p100 = (await setting('engine.budget_alerts')) as Record<string, string>;
    expect(p100).toMatchObject({ day, p80At: p80['p80At'] });
    expect(typeof p100['p100At']).toBe('string');
    // A later day starts a new record; an earlier day's late settlement never replaces it.
    const later = freshDay();
    await s.reserveSpend(reserveInput(later, demand.authorization, { estimateUsd: 0.9 }));
    expect(await setting('engine.budget_alerts')).toMatchObject({ day: later });
    expect(await setting('engine.budget_alerts')).not.toHaveProperty('p100At');
    const earlier = (await s.reserveSpend(
      reserveInput(day, demand.authorization, { estimateUsd: 0.01, priority: 'interactive' }),
    ))!;
    await s.settleReservation(
      earlier,
      callRow({ reservationId: earlier, costUsd: 0.01 }),
      usageRow(day, { costUsd: 0.01 }),
      'known',
    );
    expect(await setting('engine.budget_alerts')).toMatchObject({ day: later });
    // No email or other job is queued by a crossing (house.alerts notifies, spec 11 §6).
    const outboxAfter = await ctx.owner.query('SELECT count(*)::int AS n FROM job_outbox');
    expect(outboxAfter.rows).toEqual(outboxBefore.rows);
  });
});

describe('authorization rechecks at admission (spec 04 §1.1)', () => {
  it('drops an automatic witness when its subscription, article or account changes', async () => {
    const s = store(10);
    const day = freshDay();
    const admit = (auth: InferenceAuthorization) => s.reserveSpend(reserveInput(day, auth));

    const off = await automaticDemand();
    expect(await s.authorizeInference(off.authorization)).toBe(true);
    await ctx.owner.query(
      `UPDATE subscriptions SET inference_mode = 'off', inference_version = inference_version + 1,
              inference_activated_at = NULL WHERE user_id = $1 AND feed_id = $2`,
      [off.userId, off.feedId],
    );
    expect(await admit(off.authorization)).toBeNull();
    expect(await s.authorizeInference(off.authorization)).toBe(false);

    const revised = await automaticDemand();
    await ctx.owner.query(
      'UPDATE articles SET content_revision = content_revision + 1 WHERE id = $1',
      [revised.articleId],
    );
    expect(await admit(revised.authorization)).toBeNull();

    const stale = await automaticDemand();
    await ctx.owner.query(`UPDATE articles SET pipeline_state = 'stale' WHERE id = $1`, [
      stale.articleId,
    ]);
    expect(await admit(stale.authorization)).toBeNull();

    const deleted = await automaticDemand();
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.userId]);
    expect(await admit(deleted.authorization)).toBeNull();

    // Activation is prospective: a carrier arrival before activation is no demand.
    const early = await automaticDemand();
    const before = await createArticle(ctx.owner, {
      feedIds: [early.feedId],
      firstSeenAt: hoursAgo(3),
    });
    expect(
      await admit({
        ...early.authorization,
        articleId: before.id,
        articleRevision: before.contentRevision,
      }),
    ).toBeNull();

    // A witness at an older inference version, or of another user, does not count.
    const versioned = await automaticDemand();
    const automatic = (patch: { userId?: string; inferenceVersion?: string }) => ({
      kind: 'automatic' as const,
      userId: patch.userId ?? versioned.userId,
      feedId: versioned.feedId,
      inferenceVersion: patch.inferenceVersion ?? '1',
    });
    expect(
      await admit({
        ...versioned.authorization,
        witnesses: [automatic({ inferenceVersion: '0' })],
      }),
    ).toBeNull();
    expect(
      await admit({ ...versioned.authorization, witnesses: [automatic({ userId: randomUUID() })] }),
    ).toBeNull();
    // One valid witness among invalid ones is enough.
    expect(
      await admit({
        ...versioned.authorization,
        witnesses: [
          { kind: 'manual', analysisRequestId: randomUUID() },
          automatic({ userId: 'not-a-uuid' }),
          automatic({}),
        ],
      }),
    ).not.toBeNull();
    expect(await admit({ ...versioned.authorization, witnesses: [] })).toBeNull();
    expect(await admit({ ...versioned.authorization, articleId: '0' })).toBeNull();
  });

  it('keeps a manual request valid for its frozen revision while it is live', async () => {
    const s = store(10);
    const day = freshDay();
    const admit = (auth: InferenceAuthorization) => s.reserveSpend(reserveInput(day, auth));

    const manual = await manualDemand();
    expect(await admit(manual.authorization)).not.toBeNull();
    // The live article moves on; the frozen request still completes its own snapshot.
    await ctx.owner.query(
      'UPDATE articles SET content_revision = content_revision + 1 WHERE id = $1',
      [manual.articleId],
    );
    expect(await admit(manual.authorization)).not.toBeNull();
    // But not for another revision.
    expect(await admit({ ...manual.authorization, articleRevision: '2' })).toBeNull();
    // A cancelled request is no demand.
    await ctx.owner.query(
      `UPDATE analysis_requests SET status = 'cancelled', completed_at = now() WHERE id = $1`,
      [manual.requestId],
    );
    expect(await admit(manual.authorization)).toBeNull();

    const switchedOff = await manualDemand();
    await ctx.owner.query(
      `UPDATE subscriptions SET inference_mode = 'off', inference_version = inference_version + 1
        WHERE user_id = $1 AND feed_id = $2`,
      [switchedOff.userId, switchedOff.feedId],
    );
    expect(await admit(switchedOff.authorization)).toBeNull();

    const old = await manualDemand({ createdAt: new Date(Date.now() - 181 * 86_400_000) });
    expect(await admit(old.authorization)).toBeNull();
  });

  it('admits suggestions only under the live lease and stamps the first attempt', async () => {
    const s = store(10);
    const day = freshDay();
    const demand = await automaticDemand();
    const lease = randomUUID();
    await ctx.owner.query(
      `UPDATE users SET suggest_lease_token = $2, suggest_lease_until = now() + interval '5 minutes'
        WHERE id = $1`,
      [demand.userId, lease],
    );
    const suggest: InferenceAuthorization = {
      type: 'suggest',
      userId: demand.userId,
      eligibleArticleIds: [demand.articleId],
      leaseToken: lease,
    };
    const suggestion = (auth: InferenceAuthorization) =>
      s.reserveSpend(
        reserveInput(day, auth, {
          kind: 'suggest',
          priority: 'interactive',
          userId: demand.userId,
        }),
      );
    const stamp = async () =>
      (
        await ctx.owner.query<{ at: Date | null }>(
          'SELECT last_suggested_at AS at FROM users WHERE id = $1',
          [demand.userId],
        )
      ).rows[0]?.at;
    expect(await stamp()).toBeNull();
    expect(await suggestion(suggest)).not.toBeNull();
    const first = await stamp();
    expect(first).toBeInstanceOf(Date);
    // A retry of the same logical request keeps the first stamp.
    expect(await suggestion(suggest)).not.toBeNull();
    expect(await stamp()).toEqual(first);
    // Wrong token, an ineligible article, or an expired lease: denied.
    expect(await suggestion({ ...suggest, leaseToken: randomUUID() })).toBeNull();
    const unrelated = await createArticle(ctx.owner, {});
    expect(
      await suggestion({ ...suggest, eligibleArticleIds: [demand.articleId, unrelated.id] }),
    ).toBeNull();
    await ctx.owner.query(
      `UPDATE users SET suggest_lease_until = now() - interval '1 second' WHERE id = $1`,
      [demand.userId],
    );
    expect(await suggestion(suggest)).toBeNull();
  });

  it('admits a credential probe only under its live validation lease', async () => {
    const s = store(10);
    const day = freshDay();
    const keyring = ProviderKeyring.parse(
      'k1',
      JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') }),
    );
    if (!keyring.ok) throw new Error('keyring');
    const staged = await stageProviderCredential(ctx.worker, {
      provider: 'ollama',
      expectedRevision: '0',
      envelope: encryptProviderSecret({
        keyring: keyring.keyring,
        provider: 'ollama',
        secretVersion: '1',
        secret: 'fake-ollama-key',
      }),
    });
    type ProbeAuthorization = Extract<InferenceAuthorization, { type: 'credential_probe' }>;
    const probe = (validationToken: string): ProbeAuthorization => ({
      type: 'credential_probe',
      provider: 'ollama',
      candidateVersion: staged.candidateVersion,
      validationToken,
    });
    const reserveProbe = (auth: InferenceAuthorization, kind: CallKind = 'credential_probe') =>
      s.reserveSpend(reserveInput(day, auth, { engine: 'llm', kind, estimateUsd: 0.01 }));
    const claim = async () => {
      const lease = await claimCredentialValidation(ctx.worker, {
        provider: 'ollama',
        candidateVersion: staged.candidateVersion,
        leaseMs: 60_000,
      });
      if (lease === null) throw new Error('the candidate could not be claimed');
      return probe(lease.validationToken);
    };
    // Pending: no lease yet.
    expect(await reserveProbe(probe(newUuid()))).toBeNull();
    const first = await claim();
    expect(await reserveProbe(first)).not.toBeNull();
    expect(await isInferenceAuthorized(ctx.worker, first)).toBe(true);
    expect(await reserveProbe({ ...first, candidateVersion: '99' })).toBeNull();
    // Only the lease's own token admits: another token, or a malformed one, is refused (D-90).
    expect(await reserveProbe(probe(newUuid()))).toBeNull();
    expect(await reserveProbe(probe('not-a-token'))).toBeNull();
    // A probe reservation needs the probe authorization, and vice versa for other kinds.
    const article = await automaticDemand();
    expect(await reserveProbe(article.authorization)).toBeNull();
    await ctx.owner.query(
      `UPDATE provider_credentials SET validation_until = now() - interval '1 second'
        WHERE provider = 'ollama'`,
    );
    expect(await reserveProbe(first)).toBeNull();
    // Another validator reclaims the expired lease: the first validator stays refused under it.
    const second = await claim();
    expect(await reserveProbe(first)).toBeNull();
    expect(await isInferenceAuthorized(ctx.worker, first)).toBe(false);
    expect(await reserveProbe(second)).not.toBeNull();
  });
});

describe('zero-cost calls, usage and settings', () => {
  it('records zero-cost calls idempotently and counts them in the snapshot', async () => {
    const s = store(2);
    const day = freshDay();
    const createdAt = new Date(`${day}T10:00:00Z`);
    const row = callRow({
      engine: 'libretranslate',
      kind: 'translate',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      createdAt,
    });
    delete row.model;
    await s.insertCall(row);
    await s.insertCall(row);
    expect(await callsOf(row.logicalRequestId)).toHaveLength(1);
    expect(await usage(day, PLATFORM_USER_ID, 'libretranslate', 'translate')).toMatchObject({
      calls: 1,
    });
    expect((await s.getBudgetSnapshot(day, { excludeKinds: ['eval'] })).callsByEngineKind).toEqual({
      'libretranslate:translate': 1,
    });
    await expect(s.insertCall({ ...row, costUsd: 0.01 })).rejects.toThrow(RangeError);
    await expect(s.insertCall({ ...row, reservationId: newUuid() })).rejects.toThrow(RangeError);
  });

  it('upserts usage rows by day, user, engine and kind', async () => {
    const s = store(2);
    const day = freshDay();
    const user = await createUser(ctx.owner);
    await s.upsertUsage(usageRow(day, { userId: user.id, engine: 'llm', kind: 'translate' }));
    await s.upsertUsage(
      usageRow(day, { userId: user.id, engine: 'llm', kind: 'translate', calls: 2, costUsd: 0.01 }),
    );
    expect(await usage(day, user.id, 'llm', 'translate')).toEqual({
      calls: 3,
      input_tokens: '2000',
      output_tokens: '100',
      cost_usd: '0.05000000',
    });
    await expect(s.upsertUsage(usageRow('2031-13-01'))).rejects.toThrow(RangeError);
    await expect(s.upsertUsage(usageRow(day, { userId: 'x' }))).rejects.toThrow(RangeError);
  });

  it('validates settings before writing them', async () => {
    const s = store(2);
    await s.setSetting('engine.llm_daily_cap', 150);
    expect(await s.getSetting('engine.llm_daily_cap')).toBe(150);
    await expect(s.setSetting('engine.llm_daily_cap', 'lots')).rejects.toThrow();
    expect(await s.getSetting('engine.missing_key_for_test')).toBeUndefined();
    await ctx.owner.query(`DELETE FROM settings WHERE key = 'engine.llm_daily_cap'`);
  });
});

describe('shared breaker state (spec 04 §5)', () => {
  it('reads the all-closed default and writes one engine entry, keeping the other', async () => {
    const s = store(2);
    expect(await s.readCircuit()).toEqual({
      typesafe: { state: 'closed', reopenCount: 0 },
      llm: { state: 'closed', reopenCount: 0 },
      resetRequested: {},
    });
    const opened = await s.updateCircuit('typesafe', () => ({
      state: 'open',
      reopenCount: 1,
      openUntil: new Date(Date.now() + 120_000).toISOString(),
    }));
    expect(opened.changed).toBe(true);
    await ctx.owner.query(
      `UPDATE settings SET value = jsonb_set(value, '{resetRequested,llm}', to_jsonb($1::text))
        WHERE key = 'engine.circuit'`,
      [new Date().toISOString()],
    );
    await s.updateCircuit('llm', (c) => ({ ...c.llm, reopenCount: 3 }));
    const stored = (await setting('engine.circuit')) as Record<string, unknown>;
    expect(stored['typesafe']).toMatchObject({ state: 'open', reopenCount: 1 });
    expect(stored['llm']).toEqual({ state: 'closed', reopenCount: 3 });
    expect(stored['resetRequested']).toEqual({ llm: expect.any(String) });
    expect(await s.updateCircuit('llm', () => null)).toMatchObject({ changed: false });
    await expect(s.updateCircuit('laya' as never, () => null)).rejects.toThrow(RangeError);
  });

  it('loses no update when two stores transition concurrently', async () => {
    const a = store(2);
    const b = store(2, other);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).updateCircuit(i % 4 < 2 ? 'typesafe' : 'llm', (current) => {
          const engine = i % 4 < 2 ? current.typesafe : current.llm;
          return { ...engine, reopenCount: engine.reopenCount + 1 };
        }),
      ),
    );
    const circuit = await a.readCircuit();
    expect(circuit.typesafe.reopenCount).toBe(10);
    expect(circuit.llm.reopenCount).toBe(10);
  });

  it('lets only the still-active credential version put a breaker into auth mode', async () => {
    const s = store(2);
    const auth = () => ({ state: 'auth' as const, reopenCount: 0 });
    // No DB row: only an environment key's failure (version null) counts.
    await ctx.owner.query(`DELETE FROM provider_credentials WHERE provider = 'ollama'`);
    expect(
      (await s.updateCircuit('llm', auth, { credential: { provider: 'ollama', version: '1' } }))
        .changed,
    ).toBe(false);
    expect(
      (await s.updateCircuit('llm', auth, { credential: { provider: 'ollama', version: null } }))
        .changed,
    ).toBe(true);
    await s.updateCircuit('llm', () => ({ state: 'closed', reopenCount: 0 }));
    // A DB credential: the active version counts, a superseded one does not.
    await ctx.owner.query(
      `INSERT INTO provider_credentials (provider, revision, enabled, active_version, active_envelope)
       VALUES ('typesafe', 5, true, 5, '{}') ON CONFLICT (provider) DO UPDATE
          SET revision = 5, enabled = true, active_version = 5, active_envelope = '{}'`,
    );
    const guard = (version: string | null) => ({
      credential: { provider: 'typesafe' as const, version },
    });
    expect((await s.updateCircuit('typesafe', auth, guard('4'))).changed).toBe(false);
    expect((await s.updateCircuit('typesafe', auth, guard(null))).changed).toBe(false);
    expect((await s.readCircuit()).typesafe.state).toBe('closed');
    expect((await s.updateCircuit('typesafe', auth, guard('5'))).changed).toBe(true);
    expect((await s.readCircuit()).typesafe.state).toBe('auth');
  });
});
