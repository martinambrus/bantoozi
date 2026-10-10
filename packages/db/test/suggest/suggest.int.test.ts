import { createCard, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimSuggestLease,
  finishSuggestRun,
  releaseSuggestLease,
  renewSuggestLease,
} from '../../src/suggest/index.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/** The suggest lease, daily gate and finishing transaction (M7-T6; spec 05 §7) against a real database. */

let ctx: DbTestContext;
let setId: string;
let cardA: string;
let cardB: string;

beforeAll(async () => {
  ctx = await setupDbTest();
  const set = await ctx.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('suggest', 'suggest-t6', repeat('a', 64), '{}'::jsonb) RETURNING id::text AS id`,
  );
  setId = set.rows[0]!.id;
  await ctx.owner.query(
    `INSERT INTO settings (key, value) VALUES ('question_sets.active', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ suggest: setId })],
  );
  const make = (title: string) =>
    createCard(ctx.owner, { visibility: 'public', origin: 'library', title, interest: title });
  cardA = (await make('Card one')).id;
  cardB = (await make('Card two')).id;
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const rows = async (userId: string) =>
  (
    await ctx.owner.query<{ card_id: string; dismissed: boolean }>(
      `SELECT card_id::text AS card_id, dismissed_at IS NOT NULL AS dismissed
         FROM card_suggestions WHERE user_id = $1 ORDER BY card_id`,
      [userId],
    )
  ).rows;

describe('suggest lease', () => {
  it('claims once, refuses a live lease, renews and releases with the token', async () => {
    const user = await createUser(ctx.owner);
    const first = await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') return;
    expect((await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 })).status).toBe('busy');
    expect(await renewSuggestLease(ctx.worker, user.id, first.leaseToken, 60_000)).toBe(true);
    expect(await renewSuggestLease(ctx.worker, user.id, crypto.randomUUID(), 60_000)).toBe(false);
    await releaseSuggestLease(ctx.worker, user.id, crypto.randomUUID());
    expect(
      (await ctx.owner.query(`SELECT suggest_lease_token FROM users WHERE id = $1`, [user.id]))
        .rows[0].suggest_lease_token,
    ).toBe(first.leaseToken);
    await releaseSuggestLease(ctx.worker, user.id, first.leaseToken);
    expect((await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 })).status).toBe(
      'claimed',
    );
  });

  it('is gated for 24 hours after a stamp, and refuses missing and deleted users', async () => {
    const user = await createUser(ctx.owner);
    await ctx.owner.query(
      `UPDATE users SET last_suggested_at = now() - interval '23 hours' WHERE id = $1`,
      [user.id],
    );
    expect((await claimSuggestLease(ctx.worker, user.id, { leaseMs: 1000 })).status).toBe('gated');
    await ctx.owner.query(
      `UPDATE users SET last_suggested_at = now() - interval '25 hours' WHERE id = $1`,
      [user.id],
    );
    expect((await claimSuggestLease(ctx.worker, user.id, { leaseMs: 1000 })).status).toBe(
      'claimed',
    );
    const gone = await createUser(ctx.owner, { deletedAt: new Date() });
    expect((await claimSuggestLease(ctx.worker, gone.id, { leaseMs: 1000 })).status).toBe(
      'missing',
    );
  });

  it('does not renew a lease that has already expired', async () => {
    const user = await createUser(ctx.owner);
    const claim = await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 });
    if (claim.status !== 'claimed') throw new Error('fixture: not claimed');
    await ctx.owner.query(
      `UPDATE users SET suggest_lease_until = now() - interval '1 minute' WHERE id = $1`,
      [user.id],
    );
    const before = (
      await ctx.owner.query(`SELECT suggest_lease_until FROM users WHERE id = $1`, [user.id])
    ).rows[0];
    expect(await renewSuggestLease(ctx.worker, user.id, claim.leaseToken, 60_000)).toBe(false);
    expect(
      (await ctx.owner.query(`SELECT suggest_lease_until FROM users WHERE id = $1`, [user.id]))
        .rows[0],
    ).toEqual(before);
  });

  it('reclaims an expired lease', async () => {
    const user = await createUser(ctx.owner);
    await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 });
    await ctx.owner.query(
      `UPDATE users SET suggest_lease_until = now() - interval '1 second' WHERE id = $1`,
      [user.id],
    );
    expect((await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 })).status).toBe(
      'claimed',
    );
  });
});

describe('finishSuggestRun', () => {
  async function claimed(): Promise<{ userId: string; leaseToken: string }> {
    const user = await createUser(ctx.owner);
    const claim = await claimSuggestLease(ctx.worker, user.id, { leaseMs: 60_000 });
    if (claim.status !== 'claimed') throw new Error('claim');
    return { userId: user.id, leaseToken: claim.leaseToken };
  }
  const finish = (
    base: { userId: string; leaseToken: string },
    extra: Partial<Parameters<typeof finishSuggestRun>[1]> = {},
  ) =>
    finishSuggestRun(ctx.worker, {
      ...base,
      results: [],
      asked: { questionSetId: setId, pin: 'jev-x' },
      fallbackModel: 'jev-x',
      ...extra,
    });

  it('stores results, skips held cards, replaces other undismissed rows and releases the lease', async () => {
    const run = await claimed();
    await ctx.owner.query(
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score) VALUES ($1, $2, $3, 'jev-x', 0.5)`,
      [run.userId, cardB, setId],
    );
    expect(await finish(run, { results: [{ cardId: cardA, score: 0.7 }] })).toBe('written');
    expect(await rows(run.userId)).toEqual([{ card_id: cardA, dismissed: false }]);
    const user = await ctx.owner.query(
      `SELECT suggest_lease_token, last_suggested_at FROM users WHERE id = $1`,
      [run.userId],
    );
    expect(user.rows[0]).toEqual({ suggest_lease_token: null, last_suggested_at: null });

    const held = await claimed();
    await ctx.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [held.userId, cardA],
    );
    await finish(held, { results: [{ cardId: cardA, score: 0.7 }] });
    expect(await rows(held.userId)).toEqual([]);
  });

  it('keeps recent dismissals, revives old ones, and deletes stale-set, stale-pin and ancient rows', async () => {
    const run = await claimed();
    const other = await ctx.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition) VALUES ('suggest', 'suggest-old', repeat('b', 64), '{}'::jsonb) RETURNING id::text AS id`,
    );
    const insert = (card: string, set: string, pin: string, dismissedDays: number | null) =>
      ctx.owner.query(
        `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score, dismissed_at)
         VALUES ($1, $2, $3, $4, 0.5, CASE WHEN $5::int IS NULL THEN NULL ELSE now() - $5::int * interval '1 day' END)`,
        [run.userId, card, set, pin, dismissedDays],
      );
    await insert(cardA, other.rows[0]!.id, 'jev-old', 20);
    await insert(cardB, setId, 'jev-old', null);
    expect(await finish(run, { results: [] })).toBe('written');
    expect(await rows(run.userId)).toEqual([{ card_id: cardA, dismissed: true }]);

    const again = await claimed();
    await ctx.owner.query(
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score, dismissed_at)
       VALUES ($1, $2, $3, 'jev-x', 0.5, now() - interval '100 days')`,
      [again.userId, cardA, setId],
    );
    await finish(again, { results: [] });
    expect(await rows(again.userId)).toEqual([]);
  });

  it('discards the results when the active set or pin moved, and does nothing without the lease', async () => {
    const run = await claimed();
    expect(
      await finish(run, {
        results: [{ cardId: cardA, score: 0.7 }],
        asked: { questionSetId: setId, pin: 'jev-other' },
      }),
    ).toBe('discarded');
    expect(await rows(run.userId)).toEqual([]);
    const stale = await claimed();
    expect(
      await finish(
        { ...stale, leaseToken: crypto.randomUUID() },
        { results: [{ cardId: cardA, score: 0.7 }] },
      ),
    ).toBe('lost');
    expect(await rows(stale.userId)).toEqual([]);
    expect(
      (await ctx.owner.query(`SELECT suggest_lease_token FROM users WHERE id = $1`, [stale.userId]))
        .rows[0].suggest_lease_token,
    ).toBe(stale.leaseToken);
  });
});
