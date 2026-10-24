import { BUDGET_EXEMPT_KINDS, CALL_KINDS } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createPgEngineStore } from '../../src/engine/index.js';
import { asTenant, setupDbTest, type DbTestContext } from '../support/test-db.js';

let ctx: DbTestContext;
beforeAll(async () => {
  ctx = await setupDbTest();
});
afterAll(async () => {
  await ctx.close();
});

it('uses the guard ledger, UTC day and kind exemptions and reconciles uncertainty once', async () => {
  const admin = await createUser(ctx.owner, { role: 'admin' });
  const day = '2036-01-02';
  const read = () =>
    asTenant(ctx.appPool, admin.id, async (client) => {
      const result = await client.query<{ usd: string }>(
        'SELECT admin_committed_spend($1::date, $2::text[])::text AS usd',
        [day, [...BUDGET_EXEMPT_KINDS]],
      );
      return Number(result.rows[0]!.usd);
    });
  expect(await read()).toBe(0);
  for (const kind of CALL_KINDS) {
    await ctx.owner.query(
      `INSERT INTO engine_reservations
      (id, day, engine, kind, reserved_usd, status, actual_usd, settled_at, expires_at, created_at)
      SELECT gen_random_uuid(), $1::date, 'llm', $2, x.reserve, x.status, x.actual,
        CASE WHEN x.status = 'settled' THEN now() END, now(), '2000-01-01'
      FROM (VALUES (0.9, 'settled', 0.1), (0.2, 'reserved', NULL), (0.3, 'uncertain', NULL))
        AS x(reserve, status, actual)`,
      [day, kind],
    );
  }
  await ctx.owner.query(`INSERT INTO engine_reservations
    (id, day, engine, kind, reserved_usd, status, expires_at)
    SELECT gen_random_uuid(), d, 'llm', 'match', 9, 'reserved', now()
    FROM unnest(ARRAY['2036-01-01'::date, '2036-01-03'::date]) AS d`);
  const store = createPgEngineStore(ctx.worker, { dailyBudgetUsd: 0.01 });
  const snapshot = await store.getBudgetSnapshot(day, { excludeKinds: [...BUDGET_EXEMPT_KINDS] });
  expect(await read()).toBeCloseTo(
    snapshot.settledUsd + snapshot.reservedUsd + snapshot.uncertainUsd,
    8,
  );
  expect(await read()).toBeCloseTo((CALL_KINDS.length - BUDGET_EXEMPT_KINDS.length) * 0.6, 8);
  expect(
    await store.reserveSpend({
      day,
      engine: 'llm',
      kind: 'model_probe',
      estimateUsd: 0.1,
      priority: 'bulk',
      authorization: { type: 'model_probe', model: 'spend-test' },
    }),
  ).toBeNull();
  const before = await read();
  await ctx.workerPool.query(
    `UPDATE engine_reservations
    SET status = 'settled', actual_usd = 0.05, settled_at = now()
    WHERE day = $1 AND kind = 'credential_probe' AND status = 'uncertain'`,
    [day],
  );
  expect(await read()).toBeCloseTo(before - 0.3 + 0.05, 8);
});

it('requires an active admin context and keeps raw ledger access forbidden', async () => {
  const admin = await createUser(ctx.owner, { role: 'admin' });
  const reader = await createUser(ctx.owner);
  const deleted = await createUser(ctx.owner, { role: 'admin', deletedAt: new Date() });
  for (const user of [reader.id, deleted.id, null]) {
    await expect(
      asTenant(ctx.appPool, user, (client) =>
        client.query("SELECT admin_committed_spend('2036-01-02', ARRAY['eval'])"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    asTenant(ctx.appPool, admin.id, (client) => client.query('SELECT * FROM engine_reservations')),
  ).rejects.toMatchObject({ code: '42501' });
});
