import { randomUUID } from 'node:crypto';

import { CALL_KINDS, type CallKind, type InferenceAuthorization } from '@bantoozi/shared';
import { createArticle, createFeed, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgEngineStore } from '../../src/engine/index.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/** The call kind table against the database: the CHECK list and the card draft pairing. */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

describe('call kinds in the database', () => {
  it.each(['engine_calls', 'engine_reservations', 'usage_daily'])(
    '%s kind CHECK lists exactly the kinds of the table',
    async (table) => {
      const { rows } = await ctx.owner.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND conname = $2`,
        [table, `${table}_kind_check`],
      );
      expect(rows).toHaveLength(1);
      const literals = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      expect([...new Set(literals)].sort()).toEqual([...CALL_KINDS].sort());
    },
  );

  it.each(['engine_calls', 'engine_reservations', 'usage_daily'])(
    '%s rejects unknown kinds and admits every current kind',
    async (table) => {
      const insert = (kind: string) => {
        if (table === 'engine_reservations') {
          return ctx.workerPool.query(
            `INSERT INTO engine_reservations (id, day, engine, kind, reserved_usd, status, expires_at)
             VALUES ($1, '2035-01-01', 'llm', $2, 0, 'reserved', now() + interval '1 minute')`,
            [randomUUID(), kind],
          );
        }
        if (table === 'usage_daily') {
          return ctx.workerPool.query(
            `INSERT INTO usage_daily (day, user_id, engine, kind)
             VALUES ('2035-01-01', $1, 'llm', $2)`,
            [randomUUID(), kind],
          );
        }
        return ctx.workerPool.query(
          `INSERT INTO engine_calls (engine, kind, logical_request_id, status)
           VALUES ('llm', $1, $2, 'ok')`,
          [kind, randomUUID()],
        );
      };
      await expect(insert('unknown_kind')).rejects.toMatchObject({
        code: '23514',
        constraint: `${table}_kind_check`,
      });
      for (const kind of CALL_KINDS) await insert(kind);
    },
  );

  it('admits a card draft only under its own authorization, with a pending draft', async () => {
    const store = createPgEngineStore(ctx.worker, { dailyBudgetUsd: 2 });
    const user = await createUser(ctx.owner);
    const feed = await createFeed(ctx.owner);
    const article = await createArticle(ctx.owner, { feedIds: [feed.id] });
    const draftId = randomUUID();
    await ctx.owner.query(
      `INSERT INTO card_drafts (id, user_id, article_ids, locale) VALUES ($1, $2, ARRAY[$3::bigint], 'en')`,
      [draftId, user.id, article.id],
    );
    const own: InferenceAuthorization = { type: 'card_draft', userId: user.id, draftId };
    let dayCounter = 0;
    const reserve = (kind: CallKind, authorization: InferenceAuthorization) => {
      dayCounter += 1;
      const day = new Date(Date.UTC(2034, 0, 1) + dayCounter * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return store.reserveSpend({
        day,
        engine: 'llm',
        kind,
        estimateUsd: 0.001,
        priority: 'interactive',
        authorization,
      });
    };
    expect(await reserve('card_draft', own)).not.toBeNull();
    const admitted: CallKind[] = [];
    for (const kind of CALL_KINDS) {
      if (kind !== 'card_draft' && (await reserve(kind, own)) !== null) admitted.push(kind);
    }
    expect(admitted, 'other kinds admitted under a card draft authorization').toEqual([]);
    // Both are valid on their own (stateless), so a refusal is the pairing's.
    const others: InferenceAuthorization[] = [
      { type: 'eval', runId: randomUUID() },
      { type: 'model_probe', model: 'jev-latest' },
    ];
    for (const authorization of others) {
      expect(await reserve('card_draft', authorization), authorization.type).toBeNull();
    }
  });
});
