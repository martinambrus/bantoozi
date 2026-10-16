import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cutBudgetAfterPages } from './support/budget.js';
import { ClassifyHarness } from './support/classify.js';
import { DAY, MINUTE, RetentionWorld } from './support/retention-world.js';

/**
 * M8-T2 (PLAN §14, spec 11 §5, §6, spec 08 §1.1): `house.purge-auth`, `house.reconcile` and
 * `house.archive`, through the registered handlers against a migrated database. The clock of every
 * run is a fake `NOW` 100 days after the real one, and every fixture is placed relative to it, so a
 * handler that reads the database clock sees a different world. Each boundary is probed one minute
 * on either side. Effects are read from the database only.
 */

const NOW = new Date(Date.now() + 100 * DAY);
const before = (ms: number): Date => new Date(NOW.getTime() - ms);
const after = (ms: number): Date => new Date(NOW.getTime() + ms);

let h: ClassifyHarness;
let w: RetentionWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new RetentionWorld(h);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

/** Whether a row selected by `sql` (with `$1`) exists. */
async function exists(sql: string, value: unknown): Promise<boolean> {
  const result = await h.owner.query(sql, [value]);
  return (result.rowCount ?? 0) > 0;
}

// ── house.purge-auth ─────────────────────────────────────────────────────────────────────────

describe('house.purge-auth', () => {
  async function loginCode(expiresAt: Date): Promise<string> {
    const email = `code-${randomUUID()}@example.test`;
    await h.owner.query(
      `INSERT INTO login_codes (email, challenge_nonce, code_hash, purpose, expires_at, created_at)
       VALUES ($1, $2, 'x', 'signup', $3::timestamptz, $3::timestamptz - interval '15 minutes')`,
      [email, randomUUID(), expiresAt],
    );
    return email;
  }

  async function session(
    userId: string,
    expiresAt: Date,
    revokedAt: Date | null = null,
  ): Promise<string> {
    const token = randomUUID();
    await h.owner.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [userId, token, expiresAt, revokedAt, before(90 * DAY)],
    );
    return token;
  }

  it('deletes login codes one day after their expiry and keeps the rest', async () => {
    const old = await loginCode(before(DAY + MINUTE));
    const recent = await loginCode(before(DAY - MINUTE));
    const live = await loginCode(after(10 * MINUTE));
    await w.run('house.purge-auth', NOW);
    const has = (email: string) => exists('SELECT 1 FROM login_codes WHERE email = $1', email);
    expect(await has(old)).toBe(false);
    expect(await has(recent)).toBe(true);
    expect(await has(live)).toBe(true);
  });

  it('deletes sessions 30 days after expiry or revocation and keeps the rest', async () => {
    const user = await h.user();
    const expiredOld = await session(user, before(30 * DAY + MINUTE));
    const expiredNew = await session(user, before(30 * DAY - MINUTE));
    const revokedOld = await session(user, after(5 * DAY), before(30 * DAY + MINUTE));
    const revokedNew = await session(user, after(5 * DAY), before(30 * DAY - MINUTE));
    const live = await session(user, after(5 * DAY));
    await w.run('house.purge-auth', NOW);
    const has = (token: string) => exists('SELECT 1 FROM sessions WHERE token_hash = $1', token);
    expect(await has(expiredOld)).toBe(false);
    expect(await has(revokedOld)).toBe(false);
    expect(await has(expiredNew)).toBe(true);
    expect(await has(revokedNew)).toBe(true);
    expect(await has(live)).toBe(true);
  });

  it('deletes rate-limit buckets whose window ended over a day ago, never a window that may still run', async () => {
    const bucket = async (windowStart: Date): Promise<string> => {
      const key = `rl:${randomUUID()}`;
      await h.owner.query(
        `INSERT INTO rate_limit_buckets (key, window_start, hits) VALUES ($1, $2, 3)`,
        [key, windowStart],
      );
      return key;
    };
    // The window length is not stored; the longest configured one is a day (86,400 s), so a bucket
    // that started 30 days ago ended long before the one-day grace, and one that started within the
    // last 23 hours may still be inside its window.
    const stale = await bucket(before(30 * DAY));
    const justStarted = await bucket(before(60 * MINUTE));
    const dayOld = await bucket(before(23 * 60 * MINUTE));
    await w.run('house.purge-auth', NOW);
    const has = (key: string) => exists('SELECT 1 FROM rate_limit_buckets WHERE key = $1', key);
    expect(await has(stale)).toBe(false);
    expect(await has(justStarted)).toBe(true);
    expect(await has(dayOld)).toBe(true);
  });

  describe('origin_fetch_state', () => {
    async function origin(options: {
      lastUsedAt: Date;
      nextStartAt?: Date;
      blockedUntil?: Date | null;
      leases?: Date[];
    }): Promise<string> {
      const key = `https://o-${randomUUID()}.example.test`;
      await h.owner.query(
        `INSERT INTO origin_fetch_state (origin, next_start_at, blocked_until, leases, last_used_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          key,
          options.nextStartAt ?? before(8 * DAY),
          options.blockedUntil ?? null,
          JSON.stringify(
            (options.leases ?? []).map((expires) => ({
              token: randomUUID(),
              expires_at: expires.toISOString(),
            })),
          ),
          options.lastUsedAt,
        ],
      );
      return key;
    }
    const has = (key: string) => exists('SELECT 1 FROM origin_fetch_state WHERE origin = $1', key);

    it('deletes an idle origin 7 days after its last use, not before', async () => {
      const idle = await origin({ lastUsedAt: before(7 * DAY + MINUTE) });
      const recent = await origin({ lastUsedAt: before(7 * DAY - MINUTE) });
      await w.run('house.purge-auth', NOW);
      expect(await has(idle)).toBe(false);
      expect(await has(recent)).toBe(true);
    });

    it('retains source policy across long quiet-feed intervals and purges only a fully faded floor', async () => {
      const learned = await origin({ lastUsedAt: before(10 * DAY) });
      const crawl = await origin({ lastUsedAt: before(30 * DAY) });
      const faded = await origin({ lastUsedAt: before(30 * DAY) });
      const budget = await origin({ lastUsedAt: before(30 * DAY) });
      await h.owner.query(
        'UPDATE origin_fetch_state SET learned_interval_s = 600, learned_updated_at = $2 WHERE origin = $1',
        [learned, before(10 * DAY)],
      );
      await h.owner.query('UPDATE origin_fetch_state SET crawl_delay_s = 30 WHERE origin = $1', [
        crawl,
      ]);
      await h.owner.query(
        'UPDATE origin_fetch_state SET learned_interval_s = 1, learned_updated_at = $2 WHERE origin = $1',
        [faded, before(30 * DAY)],
      );
      await h.owner.query(
        'UPDATE origin_fetch_state SET feed_next_start_at = $2 WHERE origin = $1',
        [budget, after(MINUTE)],
      );
      await w.run('house.purge-auth', NOW);
      expect(await has(learned)).toBe(true);
      expect(await has(crawl)).toBe(true);
      expect(await has(budget)).toBe(true);
      expect(await has(faded)).toBe(false);
    });

    it('keeps an old origin while its next start, cooldown or a lease is still ahead', async () => {
      const old = before(30 * DAY);
      const pending = await origin({ lastUsedAt: old, nextStartAt: after(MINUTE) });
      const blocked = await origin({ lastUsedAt: old, blockedUntil: after(MINUTE) });
      const leased = await origin({ lastUsedAt: old, leases: [before(DAY), after(MINUTE)] });
      await w.run('house.purge-auth', NOW);
      expect(await has(pending)).toBe(true);
      expect(await has(blocked)).toBe(true);
      expect(await has(leased)).toBe(true);
    });

    it('deletes an old origin once its cooldown and every lease have passed', async () => {
      const old = before(30 * DAY);
      const cooled = await origin({ lastUsedAt: old, blockedUntil: before(MINUTE) });
      const released = await origin({ lastUsedAt: old, leases: [before(MINUTE), before(DAY)] });
      await w.run('house.purge-auth', NOW);
      expect(await has(cooled)).toBe(false);
      expect(await has(released)).toBe(false);
    });
  });

  it('deletes expired api_mutations receipts and keeps the live ones', async () => {
    const user = await h.user();
    const receipt = async (expiresAt: Date): Promise<string> => {
      const id = randomUUID();
      await h.owner.query(
        `INSERT INTO api_mutations (user_id, id, request_hash, route, status, response, created_at, expires_at)
         VALUES ($1, $2, 'h', 'POST /test', 200, '{}'::jsonb, $3, $4)`,
        [user, id, new Date(expiresAt.getTime() - 8 * DAY), expiresAt],
      );
      return id;
    };
    const expired = await receipt(before(MINUTE));
    const live = await receipt(after(MINUTE));
    await w.run('house.purge-auth', NOW);
    const has = (id: string) => exists('SELECT 1 FROM api_mutations WHERE id = $1', id);
    expect(await has(expired)).toBe(false);
    expect(await has(live)).toBe(true);
  });

  describe('invites and waitlist', () => {
    async function invite(options: {
      expiresAt: Date;
      usedAt?: Date;
      createdBy?: string | null;
      usedBy?: string | null;
    }): Promise<string> {
      const code = `inv-${randomUUID()}`;
      await h.owner.query(
        `INSERT INTO invites (code, created_by, used_by, used_at, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          code,
          options.createdBy ?? null,
          options.usedBy ?? null,
          options.usedAt ?? null,
          before(400 * DAY),
          options.expiresAt,
        ],
      );
      return code;
    }
    const has = (code: string) => exists('SELECT 1 FROM invites WHERE code = $1', code);

    it('deletes an unused invite 30 days after expiry, nulls the waitlist link, and keeps the rest', async () => {
      const old = await invite({ expiresAt: before(30 * DAY + MINUTE) });
      const recent = await invite({ expiresAt: before(30 * DAY - MINUTE) });
      const email = `wl-${randomUUID()}@example.test`;
      await h.owner.query(
        `INSERT INTO waitlist (email, created_at, invited_at, invite_code) VALUES ($1, $2, $2, $3)`,
        [email, before(40 * DAY), old],
      );
      await w.run('house.purge-auth', NOW);
      expect(await has(old)).toBe(false);
      expect(await has(recent)).toBe(true);
      const row = await h.owner.query<{ invite_code: string | null }>(
        'SELECT invite_code FROM waitlist WHERE email = $1',
        [email],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.invite_code).toBeNull();
    });

    it('deletes a used invite only once both of its accounts are erased', async () => {
      const creator = await h.user();
      const consumer = await h.user();
      const used = before(200 * DAY);
      const bothGone = await invite({ expiresAt: before(100 * DAY), usedAt: used });
      const creatorStays = await invite({
        expiresAt: before(100 * DAY),
        usedAt: used,
        createdBy: creator,
      });
      const consumerStays = await invite({
        expiresAt: before(100 * DAY),
        usedAt: used,
        usedBy: consumer,
      });
      const bothStay = await invite({
        expiresAt: before(100 * DAY),
        usedAt: used,
        createdBy: creator,
        usedBy: consumer,
      });
      // An unused invite made by the CLI has no creator and must follow the unused rule only.
      const cliInvite = await invite({ expiresAt: after(5 * DAY) });
      await w.run('house.purge-auth', NOW);
      expect(await has(bothGone)).toBe(false);
      expect(await has(creatorStays)).toBe(true);
      expect(await has(consumerStays)).toBe(true);
      expect(await has(bothStay)).toBe(true);
      expect(await has(cliInvite)).toBe(true);
    });

    it('deletes waitlist rows 365 days after creation, not before', async () => {
      const row = async (createdAt: Date): Promise<string> => {
        const email = `wl-${randomUUID()}@example.test`;
        await h.owner.query(`INSERT INTO waitlist (email, created_at) VALUES ($1, $2)`, [
          email,
          createdAt,
        ]);
        return email;
      };
      const old = await row(before(365 * DAY + MINUTE));
      const recent = await row(before(365 * DAY - MINUTE));
      await w.run('house.purge-auth', NOW);
      const has = (email: string) => exists('SELECT 1 FROM waitlist WHERE email = $1', email);
      expect(await has(old)).toBe(false);
      expect(await has(recent)).toBe(true);
    });
  });

  it('gives the same result when it runs twice', async () => {
    const user = await h.user();
    await session(user, before(31 * DAY));
    await session(user, after(DAY));
    await loginCode(before(2 * DAY));
    await loginCode(after(MINUTE));
    await h.owner.query(`INSERT INTO waitlist (email, created_at) VALUES ($1, $2), ($3, $4)`, [
      `a-${randomUUID()}@example.test`,
      before(400 * DAY),
      `b-${randomUUID()}@example.test`,
      before(DAY),
    ]);
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const table of [
        'login_codes',
        'sessions',
        'rate_limit_buckets',
        'origin_fetch_state',
        'invites',
        'waitlist',
        'api_mutations',
      ]) {
        const rows = await h.owner.query(`SELECT to_jsonb(t) AS r FROM ${table} t`);
        out[table] = rows.rows.map((row: { r: unknown }) => JSON.stringify(row.r)).sort();
      }
      return out;
    };
    await w.run('house.purge-auth', NOW);
    const first = await snapshot();
    await w.run('house.purge-auth', NOW);
    expect(await snapshot()).toEqual(first);
    expect((first['sessions'] as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── house.reconcile ──────────────────────────────────────────────────────────────────────────

describe('house.reconcile', () => {
  async function reservation(status: string, expiresAt: Date): Promise<string> {
    const id = randomUUID();
    await h.owner.query(
      `INSERT INTO engine_reservations (id, day, engine, kind, reserved_usd, status, actual_usd,
                                        settled_at, created_at, expires_at)
       VALUES ($1, $2::date, 'typesafe', 'enrich', 0.01, $3, $4, $5, $6, $7)`,
      [
        id,
        before(DAY).toISOString().slice(0, 10),
        status,
        status === 'settled' ? 0.005 : null,
        status === 'settled' ? before(2 * DAY) : null,
        new Date(expiresAt.getTime() - 5 * MINUTE),
        expiresAt,
      ],
    );
    return id;
  }

  async function stateOf(id: string) {
    const result = await h.owner.query<{
      status: string;
      actual_usd: string | null;
      settled_at: Date | null;
      reserved_usd: string;
    }>(
      `SELECT status, actual_usd::text, settled_at, reserved_usd::text FROM engine_reservations WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  it('turns reserved reservations past their expiry into uncertain, never settled or released', async () => {
    const expired = await reservation('reserved', before(MINUTE));
    const live = await reservation('reserved', after(MINUTE));
    await w.run('house.reconcile', NOW);
    const done = await stateOf(expired);
    expect(done).toBeDefined();
    expect(done!.status).toBe('uncertain');
    expect(done!.actual_usd).toBeNull();
    expect(done!.settled_at).toBeNull();
    expect(Number(done!.reserved_usd)).toBe(0.01);
    expect((await stateOf(live))!.status).toBe('reserved');
  });

  it('leaves settled and uncertain reservations untouched and is idempotent', async () => {
    const settled = await reservation('settled', before(DAY));
    const uncertain = await reservation('uncertain', before(DAY));
    const expired = await reservation('reserved', before(MINUTE));
    await w.run('house.reconcile', NOW);
    const first = [await stateOf(settled), await stateOf(uncertain), await stateOf(expired)];
    expect(first.map((row) => row!.status)).toEqual(['settled', 'uncertain', 'uncertain']);
    expect(first[0]!.actual_usd).toBe('0.00500000');
    await w.run('house.reconcile', NOW);
    expect([await stateOf(settled), await stateOf(uncertain), await stateOf(expired)]).toEqual(
      first,
    );
  });

  it('records one user.rank intent for a due next_rank_at, none for a future one, and not again on a second run', async () => {
    const feed = await h.feed();
    const due = await h.user();
    const later = await h.user();
    for (const [userId, at] of [
      [due, before(MINUTE)],
      [later, after(MINUTE)],
    ] as const) {
      await h.subscribe(userId, feed, 'active');
      const article = await w.article([{ feedId: feed, at: before(DAY) }]);
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, next_rank_at) VALUES ($1, $2, $3)`,
        [userId, article, at],
      );
    }
    const pending = async (userId: string): Promise<number> => {
      const result = await h.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_outbox
          WHERE queue = 'user.rank' AND delivered_at IS NULL AND payload ->> 'userId' = $1`,
        [userId],
      );
      return result.rows[0]!.n;
    };
    expect(await pending(due)).toBe(0);
    await w.run('house.reconcile', NOW);
    expect(await pending(due)).toBe(1);
    expect(await pending(later)).toBe(0);
    await w.run('house.reconcile', NOW);
    expect(await pending(due)).toBe(1);
    expect(await pending(later)).toBe(0);
  });

  it('resumes the due-user sweep after the position a budget-cut run saved, and clears it when the sweep ends (R12)', async () => {
    const feed = await h.feed();
    const article = await w.article([{ feedId: feed, at: before(DAY) }]);
    // More due users than one page (500), so a run cut after its first page leaves later ids unqueued.
    for (let i = 0; i < 505; i += 1) {
      const userId = await h.user();
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, next_rank_at) VALUES ($1, $2, $3)`,
        [userId, article, before(MINUTE)],
      );
    }
    const due = (
      await h.owner.query<{ id: string }>(
        `SELECT u.id::text AS id FROM users u
          WHERE u.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM user_article ua WHERE ua.user_id = u.id
                         AND ua.next_rank_at <= $1::timestamptz)
          ORDER BY u.id`,
        [NOW],
      )
    ).rows.map((row) => row.id);
    expect(due.length).toBeGreaterThanOrEqual(505);
    const queued = async (): Promise<Set<string>> =>
      new Set(
        (
          await h.owner.query<{ id: string }>(
            `SELECT DISTINCT payload ->> 'userId' AS id FROM job_outbox
              WHERE queue = 'user.rank' AND delivered_at IS NULL`,
          )
        ).rows.map((row) => row.id),
      );
    const position = async (): Promise<string | undefined> => {
      const row = (
        await h.owner.query<{
          value: Record<string, { cursor?: { sweeps?: { rank?: string } } }>;
        }>("SELECT value FROM settings WHERE key = 'house.progress'")
      ).rows[0];
      return row?.value['house.reconcile']?.cursor?.sweeps?.rank;
    };
    // The run reads the clock for its start, once for the reservation page and once per user page.
    const cut = async (): Promise<void> => {
      const restore = cutBudgetAfterPages('house-reconcile', 2);
      try {
        await w.run('house.reconcile', NOW);
      } finally {
        restore();
      }
    };
    await h.owner.query("DELETE FROM job_outbox WHERE queue = 'user.rank'");

    await cut();
    const first = await queued();
    expect([...first].sort(), 'the cut run queued the first page').toEqual(due.slice(0, 500));
    expect(await position(), 'and saved where it stopped').toBe(due[499]);

    await cut();
    const second = await queued();
    expect(second.has(due.at(-1)!), 'the next run continues after the saved position').toBe(true);
    expect(second.size).toBe(due.length);
    expect(await position(), 'a sweep that reached its end clears the position').toBeUndefined();

    // The pass after a finished one starts from the beginning again.
    await h.owner.query("DELETE FROM job_outbox WHERE queue = 'user.rank'");
    await w.run('house.reconcile', NOW);
    expect((await queued()).size).toBe(due.length);
  }, 120_000);
});

// ── house.archive ────────────────────────────────────────────────────────────────────────────

describe('house.archive', () => {
  /** A reader subscribed (active) to the given feeds. */
  async function reader(...feeds: string[]): Promise<string> {
    const userId = await h.user();
    for (const feedId of feeds) await h.subscribe(userId, feedId, 'active');
    return userId;
  }

  it('archives a read, unprotected item 31 days after its latest carrier arrival, not before', async () => {
    const feed = await h.feed();
    const user = await reader(feed);
    const oldArrival = before(31 * DAY + MINUTE);
    const youngArrival = before(31 * DAY - MINUTE);
    const old = await w.article([{ feedId: feed, at: oldArrival }]);
    const young = await w.article([{ feedId: feed, at: youngArrival }]);
    await w.read(user, old, oldArrival);
    await w.read(user, young, youngArrival);
    const oldBefore = await w.reader(user, old);
    const youngBefore = await w.reader(user, young);
    const events = await w.events(user);

    await w.run('house.archive', NOW);

    const oldAfter = await w.reader(user, old);
    expect(oldAfter.archived_at?.getTime()).toBe(NOW.getTime());
    expect(BigInt(oldAfter.state_version)).toBe(BigInt(oldBefore.state_version) + 1n);
    expect(oldAfter.read_at).not.toBeNull();
    const youngAfter = await w.reader(user, young);
    expect(youngAfter.archived_at).toBeNull();
    expect(youngAfter.state_version).toBe(youngBefore.state_version);
    expect(await w.events(user)).toBe(events);
  });

  it('counts the latest carrier arrival: an old article newly carried by another feed today is not archived', async () => {
    const feedA = await h.feed();
    const feedB = await h.feed();
    const user = await reader(feedA, feedB);
    const article = await w.article(
      [
        { feedId: feedA, at: before(60 * DAY) },
        { feedId: feedB, at: before(MINUTE) },
      ],
      before(60 * DAY),
    );
    await w.read(user, article, before(50 * DAY));
    const version = (await w.reader(user, article)).state_version;
    await w.run('house.archive', NOW);
    const row = await w.reader(user, article);
    expect(row.archived_at).toBeNull();
    expect(row.state_version).toBe(version);
  });

  it('does not archive unread items by the 31-day rule', async () => {
    const feed = await h.feed();
    const user = await reader(feed);
    const article = await w.article([{ feedId: feed, at: before(60 * DAY) }]);
    await h.owner.query(`INSERT INTO user_article (user_id, article_id) VALUES ($1, $2)`, [
      user,
      article,
    ]);
    await w.run('house.archive', NOW);
    expect((await w.reader(user, article)).archived_at).toBeNull();
  });

  it('never archives bookmarked, rated or labelled items, and archives one whose rating was cleared', async () => {
    const feed = await h.feed();
    const user = await reader(feed);
    const arrival = before(40 * DAY);
    const make = async () => {
      const id = await w.article([{ feedId: feed, at: arrival }]);
      await w.read(user, id, arrival);
      return id;
    };
    const bookmarked = await make();
    const rated = await make();
    const labelled = await make();
    const cleared = await make();
    const plain = await make();
    await w.bookmark(user, bookmarked, arrival);
    await w.rate(user, rated, arrival, 1);
    await w.label(user, labelled, arrival);
    await w.rate(user, cleared, arrival, -1);
    await w.rate(user, cleared, arrival, null);

    await w.run('house.archive', NOW);

    expect((await w.reader(user, bookmarked)).archived_at).toBeNull();
    expect((await w.reader(user, rated)).archived_at).toBeNull();
    expect((await w.reader(user, labelled)).archived_at).toBeNull();
    expect((await w.reader(user, cleared)).archived_at?.getTime()).toBe(NOW.getTime());
    expect((await w.reader(user, plain)).archived_at?.getTime()).toBe(NOW.getTime());
  });

  it('archives per user: another reader who has not read the item keeps it', async () => {
    const feed = await h.feed();
    const reads = await reader(feed);
    const skips = await reader(feed);
    const arrival = before(40 * DAY);
    const article = await w.article([{ feedId: feed, at: arrival }]);
    await w.read(reads, article, arrival);
    await h.owner.query(`INSERT INTO user_article (user_id, article_id) VALUES ($1, $2)`, [
      skips,
      article,
    ]);
    await w.run('house.archive', NOW);
    expect((await w.reader(reads, article)).archived_at).not.toBeNull();
    expect((await w.reader(skips, article)).archived_at).toBeNull();
  });

  describe('unread cap', () => {
    const CAP = 1_000;
    const COUNT = 1_005;
    let single: string;
    let double: string;
    let both: string;
    let ranked: string[];
    let sideFeed: string;
    let recentReads: string[];
    let protectedId: string;

    beforeAll(async () => {
      const feedX = await h.feed('cap X');
      sideFeed = await h.feed('cap Y');
      single = await reader(feedX);
      double = await reader(feedX, sideFeed);
      both = single;
      // Rank r (1 = newest carrier) arrived r minutes before NOW - 1 day.
      ranked = await w.bulkUnread([single, double], feedX, COUNT, before(DAY));
      // The article ranked 1,003 is bookmarked: a protected row beyond the cap.
      protectedId = ranked[1_002]!;
      await h.owner.query(
        `UPDATE user_article SET bookmarked_at = $3, bookmark_capture_status = 'pending'
          WHERE user_id = $1 AND article_id = $2`,
        [single, protectedId, before(DAY)],
      );
      // Three read items newer than every unread one must not count towards the cap.
      recentReads = [];
      for (let i = 0; i < 3; i += 1) {
        const id = await w.article([{ feedId: feedX, at: before(DAY - (i + 1) * MINUTE) }]);
        await h.owner.query(
          `INSERT INTO user_article (user_id, article_id, read_at) VALUES ($1, $2, $3)`,
          [single, id, before(DAY)],
        );
        recentReads.push(id);
      }
      // The oldest article (rank 1,005) is also carried by the side feed, where it is the newest.
      await h.owner.query(
        `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at) VALUES ($1, $2, 'side-1', $3)`,
        [sideFeed, ranked[COUNT - 1], before(MINUTE)],
      );
      await w.run('house.archive', NOW);
    }, 120_000);

    const archived = async (user: string): Promise<number[]> => {
      const result = await h.owner.query<{ article_id: string }>(
        `SELECT article_id::text FROM user_article WHERE user_id = $1 AND archived_at IS NOT NULL`,
        [user],
      );
      const rank = new Map(ranked.map((id, index) => [id, index + 1]));
      return result.rows.map((row) => rank.get(row.article_id) ?? -1).sort((a, b) => a - b);
    };

    it('archives the unread items ranked beyond 1,000 by carrier arrival, newest first', async () => {
      // 1,001..1,005 minus the bookmarked 1,003 (this reader does not follow the side feed).
      expect(await archived(single)).toEqual([1_001, 1_002, 1_004, 1_005]);
    });

    it('keeps a bookmarked item beyond the cap and does not archive the read items that are not counted', async () => {
      const row = await w.reader(single, protectedId);
      expect(row.archived_at).toBeNull();
      for (const id of recentReads) expect((await w.reader(single, id)).archived_at).toBeNull();
    });

    it('archives only items beyond the cap in every feed that carries them', async () => {
      // `double` also reads the side feed (two items there): the oldest article is its newest.
      expect(both).toBeDefined();
      expect(await archived(double)).toEqual([1_001, 1_002, 1_003, 1_004]);
      expect(ranked.length).toBe(COUNT);
      expect(CAP).toBeLessThan(COUNT);
    });

    it('bumps the reader version of every archived item by one and records no feedback event', async () => {
      const ids = await archived(double);
      expect(ids).toHaveLength(4);
      const versions = await h.owner.query<{ v: string }>(
        `SELECT DISTINCT state_version::text AS v FROM user_article
          WHERE user_id = $1 AND archived_at IS NOT NULL`,
        [double],
      );
      expect(versions.rows.map((row) => row.v)).toEqual(['1']);
      expect(await w.events(double)).toBe(0);
    });
  });

  it('makes an offline unread built before the archive fail with STALE_STATE, and succeed on the fresh version', async () => {
    const feed = await h.feed();
    const user = await reader(feed);
    const arrival = before(45 * DAY);
    const article = await w.article([{ feedId: feed, at: arrival }]);
    await w.read(user, article, arrival);
    const offlineFence = await w.fence(user, article);

    await w.run('house.archive', NOW);
    expect((await w.reader(user, article)).archived_at).not.toBeNull();

    await expect(w.unread(user, article, after(MINUTE), offlineFence)).rejects.toMatchObject({
      code: 'STALE_STATE',
    });
    expect((await w.reader(user, article)).archived_at).not.toBeNull();

    const fresh = await w.unread(user, article, after(2 * MINUTE));
    expect(fresh.changed).toBe(true);
    const row = await w.reader(user, article);
    expect(row.archived_at).toBeNull();
    expect(row.read_at).toBeNull();
  });

  it('changes nothing on a second run: versions are not bumped twice', async () => {
    const feed = await h.feed();
    const user = await reader(feed);
    const arrival = before(50 * DAY);
    const ids = [
      await w.article([{ feedId: feed, at: arrival }]),
      await w.article([{ feedId: feed, at: arrival }]),
    ];
    for (const id of ids) await w.read(user, id, arrival);
    const versions = [(await w.reader(user, ids[0]!)).state_version];
    const snapshot = async () => {
      const result = await h.owner.query(
        `SELECT to_jsonb(u) AS r FROM user_article u ORDER BY user_id, article_id`,
      );
      return result.rows.map((row: { r: unknown }) => JSON.stringify(row.r));
    };
    await w.run('house.archive', NOW);
    const first = await snapshot();
    expect((await w.reader(user, ids[0]!)).state_version).toBe(String(Number(versions[0]) + 1));
    await w.run('house.archive', NOW);
    expect(await snapshot()).toEqual(first);
    await w.run('house.archive', NOW);
    expect(await snapshot()).toEqual(first);
  });
});
