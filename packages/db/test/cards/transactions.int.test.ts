import { createArticle } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCardFromArticle, createUserCard } from '../../src/cards/index.js';
import { createSessionDatabase } from '../../src/client.js';
import { withTenant, type TenantTx } from '../../src/tenant.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';
import {
  appErrorOf,
  asUser,
  createReader,
  feedCards,
  holdings,
  insertCard,
  numeric,
  rankRevision,
  storedCard,
} from './helpers.js';

/**
 * The transaction contract of the card repository (spec 05 §5.1, spec 02 §6 "Callers"):
 * `refresh_feed_cards` and the outbox intents are part of the caller's transaction (visible inside
 * it, gone after a rollback), concurrent identical creates converge on one card row, and quotas are
 * re-checked under the users-row lock.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let sequence = 0;
function uniqueText(label: string): string {
  sequence += 1;
  return `${label} under concurrency ${sequence}`;
}

type Peek = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * `fn` in `withTenant` as `bantoozi_app` on one superuser session, with `peek` reading as the
 * superuser inside the same (uncommitted) transaction — the API role cannot read `feed_cards` or
 * `job_outbox` itself.
 */
async function inSession<T>(userId: string, fn: (tx: TenantTx, peek: Peek) => Promise<T>) {
  const client = await ctx.adminPool.connect();
  try {
    await client.query('SET ROLE bantoozi_app');
    const peek: Peek = async (text, params = []) => {
      await client.query('RESET ROLE');
      try {
        return (await client.query(text, params)).rows as Array<Record<string, unknown>>;
      } finally {
        await client.query('SET ROLE bantoozi_app');
      }
    };
    return await withTenant(createSessionDatabase(client), userId, (tx) => fn(tx, peek));
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

class Rollback extends Error {}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait until some backend of this database waits for a lock (the second writer is queued). */
async function waitForLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await ctx.adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the second transaction never waited for a lock');
}

async function cardsWithText(interest: string): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ id: string }>(
    "SELECT id::text AS id FROM interest_cards WHERE body->>'interest' = $1 ORDER BY id",
    [interest],
  );
  return rows.map((r) => r.id);
}

async function pendingIntents(userId: string): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ queue: string }>(
    'SELECT queue FROM job_outbox WHERE user_id = $1 AND delivered_at IS NULL ORDER BY id',
    [userId],
  );
  return rows.map((r) => r.queue);
}

describe('same-transaction effects', () => {
  it('refreshes feed_cards and records intents inside the caller’s transaction; a rollback leaves nothing', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Rolled back interest');
    const revision = await rankRevision(ctx, r.id);
    let cardId = '';
    const error = await inSession(r.id, async (tx, peek) => {
      const created = await createUserCard(tx, { interest, strength: 'love' });
      cardId = created.card.id;
      // Inside the transaction: the refresh already materialized the holding, the intents exist.
      const rows = await peek(
        `SELECT feed_id::text || ':' || card_id::text || ':' || holders AS row FROM feed_cards
          WHERE feed_id = ANY($1::bigint[]) ORDER BY feed_id`,
        [r.active],
      );
      expect(rows.map((row) => row['row'])).toEqual(
        numeric(r.active).map((feedId) => `${feedId}:${cardId}:1`),
      );
      const queues = await peek('SELECT queue FROM job_outbox WHERE user_id = $1 ORDER BY id', [
        r.id,
      ]);
      expect(queues.map((row) => row['queue'])).toEqual([
        'card.backfill',
        'user.rank',
        'user.learn',
      ]);
      // Other sessions see none of it before the commit.
      expect(await feedCards(ctx, r.active)).toEqual([]);
      expect(await pendingIntents(r.id)).toEqual([]);
      throw new Rollback('roll back');
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Rollback);

    expect(cardId).not.toBe('');
    expect(await feedCards(ctx, r.active)).toEqual([]);
    expect(await pendingIntents(r.id)).toEqual([]);
    expect(await cardsWithText(interest)).toEqual([]);
    expect(await holdings(ctx, r.id)).toEqual([]);
    expect(await rankRevision(ctx, r.id)).toBe(revision);
  });

  it('commits the refresh and the intents together with the holding', async () => {
    const r = await createReader(ctx);
    const created = await inSession(r.id, async (tx, peek) => {
      const result = await createUserCard(tx, {
        interest: uniqueText('Committed'),
        strength: 'like',
      });
      expect(
        await peek('SELECT 1 FROM feed_cards WHERE card_id = $1', [result.card.id]),
      ).toHaveLength(2);
      expect(await feedCards(ctx, r.active)).toEqual([]);
      return result;
    });
    expect(await feedCards(ctx, r.active)).toEqual(
      numeric(r.active).map((feedId) => `${feedId}:${created.card.id}:1`),
    );
    expect(await pendingIntents(r.id)).toEqual(['card.backfill', 'user.rank', 'user.learn']);
  });
});

describe('concurrency', () => {
  it('converges concurrent identical creates on one card row; the first committer is its creator', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const interest = uniqueText('Concurrent identical text');
    const inserted = deferred<string>();
    const release = deferred();
    const first = asUser(ctx, a.id, async (tx) => {
      const result = await createUserCard(tx, { title: 'First', interest, strength: 'like' });
      inserted.resolve(result.card.id);
      await release.promise;
      return result;
    });
    const cardId = await inserted.promise;
    // The second insert of the same text_hash waits for the first transaction.
    const second = asUser(ctx, b.id, (tx) =>
      createUserCard(tx, { title: 'Second', interest: interest.toUpperCase(), strength: 'must' }),
    );
    await waitForLockWait();
    release.resolve();
    const [one, two] = await Promise.all([first, second]);

    expect(one.card.id).toBe(cardId);
    expect(two.card.id).toBe(cardId);
    expect(two).toMatchObject({
      created: true,
      card: { title: 'Second', titleOverride: 'Second', cardTitle: 'First', strength: 'must' },
    });
    expect(await cardsWithText(interest)).toEqual([cardId]);
    expect(await storedCard(ctx, cardId)).toMatchObject({ creator_user_id: a.id, title: 'First' });
    expect(await holdings(ctx, a.id)).toEqual([`${cardId}:like:*:-`]);
    expect(await holdings(ctx, b.id)).toEqual([`${cardId}:must:*:Second`]);
  });

  it('lets the waiting writer insert the card when the first transaction rolls back', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const interest = uniqueText('Abandoned text');
    const inserted = deferred();
    const release = deferred();
    const first = asUser(ctx, a.id, async (tx) => {
      await createUserCard(tx, { interest, strength: 'like' });
      inserted.resolve();
      await release.promise;
      throw new Rollback('abandon');
    }).catch((e: unknown) => e);
    await inserted.promise;
    const second = asUser(ctx, b.id, (tx) => createUserCard(tx, { interest, strength: 'like' }));
    await waitForLockWait();
    release.resolve();
    expect(await first).toBeInstanceOf(Rollback);
    const created = await second;
    expect(await cardsWithText(interest)).toEqual([created.card.id]);
    expect(await storedCard(ctx, created.card.id)).toMatchObject({ creator_user_id: b.id });
    expect(await holdings(ctx, a.id)).toEqual([]);
  });

  it('re-checks quotas under the users-row lock: two concurrent creates at 49 cards admit one', async () => {
    const r = await createReader(ctx);
    for (let i = 0; i < 49; i += 1) {
      const id = await insertCard(ctx, { visibility: 'shared', interest: uniqueText('Filler') });
      await ctx.owner.query(
        "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
        [r.id, id],
      );
    }
    const inserted = deferred();
    const release = deferred();
    const first = asUser(ctx, r.id, async (tx) => {
      const result = await createUserCard(tx, {
        interest: uniqueText('Fiftieth'),
        strength: 'like',
      });
      inserted.resolve();
      await release.promise;
      return result;
    });
    await inserted.promise;
    const secondText = uniqueText('Fifty-first');
    const second = appErrorOf(
      asUser(ctx, r.id, (tx) => createUserCard(tx, { interest: secondText, strength: 'like' })),
    );
    await waitForLockWait();
    release.resolve();
    expect((await first).created).toBe(true);
    expect(await second).toEqual({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxCards', used: 50, max: 50 },
    });
    expect(await cardsWithText(secondText)).toEqual([]);
    expect(await holdings(ctx, r.id)).toHaveLength(50);
  });

  it('serializes a from-article create with a concurrent create of its text-only card', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const article = await createArticle(ctx.owner, {
      feedIds: [b.active[0]],
      title: 'A concurrent example',
    });
    const interest = uniqueText('Text-only card raced by a fork');
    const inserted = deferred();
    const release = deferred();
    const first = asUser(ctx, a.id, async (tx) => {
      const result = await createUserCard(tx, { interest, strength: 'like' });
      inserted.resolve();
      await release.promise;
      return result;
    });
    await inserted.promise;
    const second = asUser(ctx, b.id, (tx) =>
      createCardFromArticle(tx, { articleId: article.id, interest, strength: 'like' }),
    );
    await waitForLockWait();
    release.resolve();
    const [shared, fork] = await Promise.all([first, second]);
    expect(fork.card).toMatchObject({
      isPrivateFork: true,
      parentCardId: shared.card.id,
      examplesYes: ['A concurrent example'],
    });
    expect(await cardsWithText(interest)).toEqual([shared.card.id, fork.card.id]);
  });
});
