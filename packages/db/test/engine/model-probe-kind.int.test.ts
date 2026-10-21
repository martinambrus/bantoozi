import {
  newUuid,
  PLATFORM_USER_ID,
  type CallKind,
  type EngineCallRow,
  type InferenceAuthorization,
  type UsageRow,
} from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPgEngineStore, type PgEngineStore } from '../../src/engine/index.js';
import { sqlState } from '../../src/errors.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * JEV-1 (db): the `model_probe` call kind. Migration 0033 widens `engine_calls_kind_check`, the
 * store admits a `model_probe` reservation only under the matching `{ type: 'model_probe' }`
 * authorization (and that authorization only for the kind), and settlement rolls it up.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.owner.query(
    `DELETE FROM settings WHERE key IN ('engine.daily_budget_usd', 'engine.budget_alerts', 'engine.circuit')`,
  );
});

let dayCounter = 0;
/** A fresh UTC day per test, far from today, so budgets never share reservations. */
function freshDay(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2033, 0, 1) + dayCounter * 86_400_000).toISOString().slice(0, 10);
}

const store = (budgetUsd = 2): PgEngineStore =>
  createPgEngineStore(ctx.worker, { dailyBudgetUsd: budgetUsd });

const probeAuth = (model = 'jev-latest'): InferenceAuthorization => ({
  type: 'model_probe',
  model,
});

const reserve = (
  s: PgEngineStore,
  day: string,
  kind: CallKind,
  authorization: InferenceAuthorization,
) =>
  s.reserveSpend({
    day,
    engine: 'typesafe',
    kind,
    estimateUsd: 0.001,
    priority: 'interactive',
    authorization,
  });

function callRow(patch: Partial<EngineCallRow> = {}): EngineCallRow {
  return {
    engine: 'typesafe',
    kind: 'model_probe',
    model: 'jev-1.13.0',
    nQuestions: 1,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.0004,
    latencyMs: 80,
    billing: 'known',
    logicalRequestId: newUuid(),
    attempts: 1,
    status: 'ok',
    createdAt: new Date(),
    ...patch,
  };
}

describe('engine_calls.kind accepts model_probe (migration 0033)', () => {
  it('D1 accepts a model_probe row and rejects an unknown kind with 23514', async () => {
    const insert = (kind: string, logical: string) =>
      ctx.owner.query(
        `INSERT INTO engine_calls (engine, kind, model, logical_request_id, cost_usd, status)
         VALUES ('typesafe', $1, 'jev-1.13.0', $2, 0, 'ok')`,
        [kind, logical],
      );
    const logical = newUuid();
    await insert('model_probe', logical);
    const { rows } = await ctx.owner.query<{ kind: string }>(
      `SELECT kind FROM engine_calls WHERE logical_request_id = $1`,
      [logical],
    );
    expect(rows).toEqual([{ kind: 'model_probe' }]);

    // Negative control: any other string is still refused by the same check.
    const error = await insert('bogus', newUuid()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    expect(sqlState(error)).toBe('23514');
  });

  it('D1 the check constraint names model_probe', async () => {
    const { rows } = await ctx.owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'engine_calls_kind_check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.def).toContain('model_probe');
    expect(rows[0]?.def).toContain('credential_probe');
  });
});

describe('reserveSpend pairs the kind with its authorization', () => {
  it('D2 admits model_probe with the model_probe authorization only', async () => {
    const s = store();
    const day = freshDay();
    const id = await reserve(s, day, 'model_probe', probeAuth());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // A concrete id is admitted as well (control for the malformed ids below).
    expect(await reserve(s, day, 'model_probe', probeAuth('jev-1.13.0'))).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const others: InferenceAuthorization[] = [
      { type: 'eval', runId: newUuid() },
      {
        type: 'credential_probe',
        provider: 'typesafe',
        candidateVersion: '1',
        validationToken: newUuid(),
      },
      { type: 'card_draft', userId: newUuid(), draftId: newUuid() },
      {
        type: 'article',
        articleId: '1',
        articleRevision: '1',
        witnesses: [{ kind: 'manual', analysisRequestId: newUuid() }],
      },
      { type: 'suggest', userId: newUuid(), eligibleArticleIds: ['1'], leaseToken: newUuid() },
    ];
    for (const auth of others) {
      expect(await reserve(s, day, 'model_probe', auth), `model_probe + ${auth.type}`).toBeNull();
    }
    for (const kind of ['enrich', 'eval', 'credential_probe', 'card_draft'] as CallKind[]) {
      expect(await reserve(s, day, kind, probeAuth()), `${kind} + model_probe`).toBeNull();
    }
    for (const model of ['', 'a b', 'x'.repeat(65), "x'; drop"]) {
      expect(await reserve(s, day, 'model_probe', probeAuth(model)), `model ${model}`).toBeNull();
    }
  });

  it('D4 authorizeInference admits a well-formed model_probe and refuses a malformed one', async () => {
    const s = store();
    expect(await s.authorizeInference(probeAuth('jev-latest'))).toBe(true);
    expect(await s.authorizeInference(probeAuth('jev-1.13.0'))).toBe(true);
    expect(await s.authorizeInference(probeAuth('a b'))).toBe(false);
    expect(await s.authorizeInference(probeAuth(''))).toBe(false);
    expect(await s.authorizeInference(probeAuth('y'.repeat(65)))).toBe(false);
  });
});

describe('settling a model_probe reservation', () => {
  it('D3 writes one call row, one usage_daily row and settles the reservation', async () => {
    const s = store();
    const day = freshDay();
    const id = await reserve(s, day, 'model_probe', probeAuth());
    expect(id).not.toBeNull();
    const logical = newUuid();
    const usageRow: UsageRow = {
      day,
      userId: PLATFORM_USER_ID,
      engine: 'typesafe',
      kind: 'model_probe',
      calls: 1,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.0004,
    };
    await s.settleReservation(
      id!,
      callRow({ logicalRequestId: logical, reservationId: id! }),
      usageRow,
      'known',
    );

    const calls = await ctx.owner.query<{ kind: string; engine: string; reservation_id: string }>(
      `SELECT kind, engine, reservation_id::text AS reservation_id FROM engine_calls
        WHERE logical_request_id = $1`,
      [logical],
    );
    expect(calls.rows).toEqual([{ kind: 'model_probe', engine: 'typesafe', reservation_id: id }]);
    const usage = await ctx.owner.query<{ calls: number; kind: string; engine: string }>(
      `SELECT calls, kind, engine FROM usage_daily WHERE day = $1 AND user_id = $2`,
      [day, PLATFORM_USER_ID],
    );
    expect(usage.rows).toEqual([{ calls: 1, kind: 'model_probe', engine: 'typesafe' }]);
    const reservation = await ctx.owner.query<{ status: string }>(
      `SELECT status FROM engine_reservations WHERE id = $1`,
      [id],
    );
    expect(reservation.rows).toEqual([{ status: 'settled' }]);
  });
});
