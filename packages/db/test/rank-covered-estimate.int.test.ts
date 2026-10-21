import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { withTenant } from '../src/tenant.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

async function intent(userId: string, payload: Record<string, unknown>): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO job_outbox (queue, payload, dedupe_key, user_id)
     VALUES ('user.rank', $1::jsonb, $2, NULL)`,
    [JSON.stringify({ userId, ...payload }), `${userId}:${JSON.stringify(payload)}`],
  );
}

async function covered(userId: string): Promise<boolean> {
  return withTenant(ctx.app, userId, async (tx) => {
    const result = await tx.execute<{ covered: boolean }>(sql`SELECT rank_covered() AS covered`);
    return result.rows[0]?.covered === true;
  });
}

describe('rank_covered() and estimate intents', () => {
  it('is false with no intent at all', async () => {
    const user = await createUser(ctx.owner);
    expect(await covered(user.id)).toBe(false);
  });

  it('is false with only an undelivered estimate refresh intent', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'estimate', estimate: {} });
    expect(await covered(user.id)).toBe(false);
  });

  it('is false with an estimate intent that carries version, up and down', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'estimate', estimate: { version: 2, up: 1, down: 0 } });
    expect(await covered(user.id)).toBe(false);
  });

  it('is true with a plain undelivered rank intent (pins existing behaviour)', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'x' });
    expect(await covered(user.id)).toBe(true);
  });

  it('is true with a full rank intent (pins existing behaviour)', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'x', full: true });
    expect(await covered(user.id)).toBe(true);
  });

  it('is false with a cursor intent (pins existing behaviour)', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, {
      reason: 'x',
      full: true,
      snapshotAt: '2026-10-01T10:00:00.000Z',
      cursor: { arrival: '2026-10-01T10:00:00.000Z', articleId: '5' },
    });
    expect(await covered(user.id)).toBe(false);
  });

  it('is true again when a plain intent exists next to an estimate intent', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'estimate', estimate: {} });
    expect(await covered(user.id)).toBe(false);
    await intent(user.id, { reason: 'x' });
    expect(await covered(user.id)).toBe(true);
  });

  it('is false once the plain intent is delivered and only the estimate intent is left', async () => {
    const user = await createUser(ctx.owner);
    await intent(user.id, { reason: 'estimate', estimate: {} });
    await intent(user.id, { reason: 'x' });
    await ctx.owner.query(
      `UPDATE job_outbox SET delivered_at = now() WHERE payload->>'userId' = $1 AND NOT (payload ? 'estimate')`,
      [user.id],
    );
    expect(await covered(user.id)).toBe(false);
  });

  it('does not count another user’s plain intent', async () => {
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    await intent(b.id, { reason: 'x' });
    expect(await covered(a.id)).toBe(false);
    expect(await covered(b.id)).toBe(true);
  });
});
