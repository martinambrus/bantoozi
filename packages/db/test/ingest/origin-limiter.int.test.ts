import { randomUUID } from 'node:crypto';

import type { OriginLimiter, OriginReservation } from '@bantoozi/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../src/client.js';
import { createPgOriginLimiter } from '../../src/ingest/index.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * The PostgreSQL per-origin politeness limiter (spec 03 §8.2, spec 02 §3 `origin_fetch_state`):
 * two limiter instances on separate worker-role pools stand for two worker processes.
 */

let ctx: DbTestContext;
/** A second "process": its own pool and database handle. */
let otherPool: pg.Pool;
let otherDb: Database;

beforeAll(async () => {
  ctx = await setupDbTest();
  otherPool = new pg.Pool({ connectionString: ctx.testDb.urls.worker, max: 6 });
  otherDb = createDatabase(otherPool);
});

afterAll(async () => {
  await otherPool.end();
  await ctx.close();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const newOrigin = () => `https://${randomUUID()}.example.test:443`;

function granted(r: OriginReservation): string {
  if (r.status !== 'granted') throw new Error(`expected a grant, got ${JSON.stringify(r)}`);
  return r.token;
}

type Lease = { token: string; expires_at: string };
type OriginRow = {
  leases: Lease[];
  next_start_at: string;
  blocked_until: string | null;
  last_used_at: string;
};

/** The origin row as stored, timestamps as exact UTC microsecond strings. */
async function originRow(origin: string): Promise<OriginRow | undefined> {
  const utc = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const result = await ctx.owner.query<OriginRow>(
    `SELECT leases, ${utc('next_start_at')} AS next_start_at, ${utc('blocked_until')} AS blocked_until,
            ${utc('last_used_at')} AS last_used_at
       FROM origin_fetch_state WHERE origin = $1`,
    [origin],
  );
  return result.rows[0];
}

/** Microseconds since the epoch of a `YYYY-MM-DDTHH:MM:SS.ffffffZ` string. */
function micros(iso: string): bigint {
  const match = /^(.{19})\.(\d{6})Z$/.exec(iso);
  if (match === null) throw new Error(`not a microsecond UTC timestamp: ${iso}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt(match[2]!);
}

/** The database time of a grant: its lease expiry minus the lease length. */
async function grantMicros(origin: string, token: string, leaseMs: number): Promise<bigint> {
  const lease = (await originRow(origin))?.leases.find((l) => l.token === token);
  if (lease === undefined) throw new Error('lease not found');
  return micros(lease.expires_at) - BigInt(leaseMs) * 1000n;
}

const dbNowMs = async (): Promise<number> =>
  (await ctx.owner.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t.getTime();

describe('createPgOriginLimiter (spec 03 §8.2)', () => {
  it('shares leases across processes: two concurrent requests, the third waits for a release', async () => {
    const origin = newOrigin();
    const a = createPgOriginLimiter(ctx.worker, { spacingMs: 0 });
    const b = createPgOriginLimiter(otherDb, { spacingMs: 0 });
    const t1 = granted(await a.reserve(origin, { leaseMs: 60_000 }));
    const t2 = granted(await b.reserve(origin, { leaseMs: 60_000 }));
    expect(t1).not.toBe(t2);

    const before = await dbNowMs();
    const full = await a.reserve(origin, { leaseMs: 60_000 });
    const after = await dbNowMs();
    // Both leases live for a minute: poll again after fullPollMs (250 ms by default).
    expect(full.status).toBe('wait');
    if (full.status !== 'wait') return;
    expect(full.retryAt.getTime()).toBeGreaterThanOrEqual(before + 250);
    expect(full.retryAt.getTime()).toBeLessThanOrEqual(after + 251);
    expect((await b.reserve(origin, { leaseMs: 60_000 })).status).toBe('wait');

    await a.release(origin, t1);
    const t3 = granted(await b.reserve(origin, { leaseMs: 60_000 }));
    expect((await originRow(origin))?.leases.map((l) => l.token)).toEqual([t2, t3]);
  });

  it('never grants more than two leases to many concurrent reservations of two processes', async () => {
    const origin = newOrigin();
    const limiters = [
      createPgOriginLimiter(ctx.worker, { spacingMs: 0 }),
      createPgOriginLimiter(otherDb, { spacingMs: 0 }),
    ];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => limiters[i % 2]!.reserve(origin, { leaseMs: 60_000 })),
    );
    const grants = results.filter((r) => r.status === 'granted');
    expect(grants).toHaveLength(2);
    expect(results.filter((r) => r.status === 'wait')).toHaveLength(10);
    expect((await originRow(origin))?.leases).toHaveLength(2);
  });

  it('spaces request starts at least one second apart in database time', async () => {
    const origin = newOrigin();
    const a = createPgOriginLimiter(ctx.worker);
    const b = createPgOriginLimiter(otherDb);
    const leaseMs = 30_000;
    const first = granted(await a.reserve(origin, { leaseMs }));
    const start = await grantMicros(origin, first, leaseMs);
    const row = await originRow(origin);
    // The grant sets the next start slot and last use from the same database clock reading.
    expect(micros(row!.next_start_at)).toBe(start + 1_000_000n);
    expect(micros(row!.last_used_at)).toBe(start);

    // Another process, even with a free lease slot, waits for the slot (rounded up to the ms).
    const waiting = await b.reserve(origin, { leaseMs });
    expect(waiting).toEqual({
      status: 'wait',
      retryAt: new Date(Number((start + 1_000_000n + 999n) / 1000n)),
    });
    // A wait changes neither the slot nor the last use.
    expect(await originRow(origin)).toEqual(row);
    if (waiting.status !== 'wait') return;
    await sleep(Math.max(0, waiting.retryAt.getTime() - Date.now()) + 5);
    const second = granted(await b.reserve(origin, { leaseMs }));
    expect((await grantMicros(origin, second, leaseMs)) - start).toBeGreaterThanOrEqual(1_000_000n);
  });

  it('keeps two processes looping over one origin within both limits', async () => {
    const origin = newOrigin();
    const leaseMs = 30_000;
    const starts: bigint[] = [];
    let holding = 0;
    let maxHolding = 0;
    const run = async (limiter: OriginLimiter) => {
      for (let done = 0; done < 2;) {
        const r = await limiter.reserve(origin, { leaseMs });
        if (r.status === 'blocked') throw new Error('unexpected cooldown');
        if (r.status === 'wait') {
          await sleep(Math.max(1, r.retryAt.getTime() - Date.now()));
          continue;
        }
        holding += 1;
        maxHolding = Math.max(maxHolding, holding);
        starts.push(await grantMicros(origin, r.token, leaseMs));
        await sleep(1_600); // a request outlasting the spacing: both slots are used
        holding -= 1;
        await limiter.release(origin, r.token);
        done += 1;
      }
    };
    await Promise.all([
      run(createPgOriginLimiter(ctx.worker)),
      run(createPgOriginLimiter(otherDb)),
    ]);
    expect(starts).toHaveLength(4);
    expect(maxHolding).toBe(2);
    const sorted = [...starts].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(1_000_000n);
    }
    expect((await originRow(origin))?.leases).toEqual([]);
  }, 30_000);

  it('limits each origin independently', async () => {
    const a = createPgOriginLimiter(ctx.worker);
    const one = newOrigin();
    const two = newOrigin();
    granted(await a.reserve(one, { leaseMs: 10_000 }));
    // Another origin has its own slot and leases.
    granted(await a.reserve(two, { leaseMs: 10_000 }));
    expect((await a.reserve(one, { leaseMs: 10_000 })).status).toBe('wait');
    expect((await a.reserve(two, { leaseMs: 10_000 })).status).toBe('wait');
    await a.block(one, new Date(Date.now() + 60_000));
    expect((await a.reserve(one, { leaseMs: 10_000 })).status).toBe('blocked');
    expect((await originRow(two))?.blocked_until).toBeNull();
  });

  it('persists a cooldown across a restart, never shortens it and clamps it to 24 hours', async () => {
    const origin = newOrigin();
    const a = createPgOriginLimiter(ctx.worker, { spacingMs: 0 });
    const until = new Date(Date.now() + 10 * 60_000);
    // A 429 on a first contact creates the origin row.
    await a.block(origin, until);

    // A new process (fresh pool and limiter) sees the persisted cooldown.
    const restartedPool = new pg.Pool({ connectionString: ctx.testDb.urls.worker, max: 2 });
    try {
      const restarted = createPgOriginLimiter(createDatabase(restartedPool), { spacingMs: 0 });
      expect(await restarted.reserve(origin, { leaseMs: 10_000 })).toEqual({
        status: 'blocked',
        until,
      });
      // A shorter Retry-After never shortens the longer cooldown.
      await restarted.block(origin, new Date(Date.now() + 60_000));
      await a.block(origin, new Date(Date.now() - 60_000));
      expect(await a.reserve(origin, { leaseMs: 10_000 })).toEqual({ status: 'blocked', until });
      // A longer one extends it, clamped to 24 hours of database time.
      const lower = (await dbNowMs()) + 24 * 3_600_000;
      await restarted.block(origin, new Date(Date.now() + 48 * 3_600_000));
      const upper = (await dbNowMs()) + 24 * 3_600_000;
      const clamped = await a.reserve(origin, { leaseMs: 10_000 });
      expect(clamped.status).toBe('blocked');
      if (clamped.status !== 'blocked') return;
      expect(clamped.until.getTime()).toBeGreaterThanOrEqual(lower);
      expect(clamped.until.getTime()).toBeLessThanOrEqual(upper + 1);
      expect((await originRow(origin))?.leases).toEqual([]);
    } finally {
      await restartedPool.end();
    }

    // An expired cooldown no longer blocks.
    const other = newOrigin();
    const shortly = new Date(Date.now() + 1_000);
    await a.block(other, shortly);
    expect(await a.reserve(other, { leaseMs: 10_000 })).toEqual({
      status: 'blocked',
      until: shortly,
    });
    await sleep(shortly.getTime() - Date.now() + 50);
    granted(await a.reserve(other, { leaseMs: 10_000 }));
  });

  it('reclaims the expired leases of a crashed holder', async () => {
    const origin = newOrigin();
    const crashed = createPgOriginLimiter(ctx.worker, { spacingMs: 0 });
    const survivor = createPgOriginLimiter(otherDb, { spacingMs: 0, fullPollMs: 5_000 });
    // The holder takes both leases and dies without releasing them.
    granted(await crashed.reserve(origin, { leaseMs: 1_000 }));
    granted(await crashed.reserve(origin, { leaseMs: 1_200 }));
    const [first, second] = (await originRow(origin))!.leases;
    const waiting = await survivor.reserve(origin, { leaseMs: 10_000 });
    // With a long poll interval, the retry time is the earliest lease expiry.
    expect(waiting).toEqual({
      status: 'wait',
      retryAt: new Date(Number((micros(first!.expires_at) + 999n) / 1000n)),
    });
    // Once both have expired (database time), the next reservation reclaims them.
    await sleep(Number(micros(second!.expires_at) / 1000n) - Date.now() + 50);
    const token = granted(await survivor.reserve(origin, { leaseMs: 10_000 }));
    // Both expired leases were dropped under the row lock; only the new one remains.
    expect((await originRow(origin))?.leases.map((l) => l.token)).toEqual([token]);
  });

  it('releases exactly the given token, idempotently', async () => {
    const origin = newOrigin();
    const elsewhere = newOrigin();
    const a = createPgOriginLimiter(ctx.worker, { spacingMs: 0 });
    const t1 = granted(await a.reserve(origin, { leaseMs: 60_000 }));
    const t2 = granted(await a.reserve(origin, { leaseMs: 60_000 }));
    const t3 = granted(await a.reserve(elsewhere, { leaseMs: 60_000 }));
    const tokens = async (o: string) => (await originRow(o))?.leases.map((l) => l.token);

    await a.release(origin, t1);
    expect(await tokens(origin)).toEqual([t2]);
    await a.release(origin, t1);
    await a.release(origin, randomUUID());
    await a.release(origin, t3); // another origin's token
    await a.release(origin, 'not-a-token');
    expect(await tokens(origin)).toEqual([t2]);
    expect(await tokens(elsewhere)).toEqual([t3]);
    // Releasing on an unknown origin creates nothing.
    const unknown = newOrigin();
    await a.release(unknown, t2);
    expect(await originRow(unknown)).toBeUndefined();
    await a.release(origin, t2);
    expect(await tokens(origin)).toEqual([]);
  });

  it('serves the API role (discovery) as well as the worker', async () => {
    const origin = newOrigin();
    const api = createPgOriginLimiter(ctx.app);
    const token = granted(await api.reserve(origin, { leaseMs: 5_000 }));
    expect((await api.reserve(origin, { leaseMs: 5_000 })).status).toBe('wait');
    await api.release(origin, token);
    await api.block(origin, new Date(Date.now() + 60_000));
    expect((await api.reserve(origin, { leaseMs: 5_000 })).status).toBe('blocked');
  });

  it('rejects invalid options and arguments without touching the table', async () => {
    expect(() => createPgOriginLimiter(ctx.worker, { maxConcurrent: 3 })).toThrow(TypeError);
    expect(() => createPgOriginLimiter(ctx.worker, { maxConcurrent: 0 })).toThrow(TypeError);
    expect(() => createPgOriginLimiter(ctx.worker, { spacingMs: -1 })).toThrow(TypeError);
    expect(() => createPgOriginLimiter(ctx.worker, { fullPollMs: 0 })).toThrow(TypeError);
    const a = createPgOriginLimiter(ctx.worker);
    const origin = newOrigin();
    await expect(a.reserve(origin, { leaseMs: 0 })).rejects.toThrow(TypeError);
    await expect(a.reserve('', { leaseMs: 1_000 })).rejects.toThrow(TypeError);
    await expect(a.block(origin, new Date(Number.NaN))).rejects.toThrow(TypeError);
    expect(await originRow(origin)).toBeUndefined();
    // One lease at a time when configured so.
    const single = createPgOriginLimiter(ctx.worker, { maxConcurrent: 1, spacingMs: 0 });
    granted(await single.reserve(origin, { leaseMs: 10_000 }));
    expect((await single.reserve(origin, { leaseMs: 10_000 })).status).toBe('wait');
  });
});
