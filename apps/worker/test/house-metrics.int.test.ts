import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import {
  DAY,
  HOUR,
  MINUTE,
  MetricsWorld,
  SECRET_TITLE,
  pick,
  utcDay,
  type WorldArticle,
  type WorldUser,
} from './support/metrics-world.js';

/**
 * M8-T4 (PLAN §14, spec 10 §7, spec 11 §6 row `house.metrics`): the nightly online metrics through
 * `createMetricsHandler`, against a migrated database. The clock is a fake `NOW` (00:10 UTC, as the
 * cron `10 0 * * *` fires, 100 days after the real date); the handler computes the previous UTC day.
 * Feedback is written with the `before` snapshot of spec 06 §8.2, and the cached `user_article`
 * lane is set to something else, so a handler that joins feedback to the current lane fails.
 *
 * Shape fixed by this harness (see the S9 brief): `lanes.<lane>.{likeRate, rated}` and
 * `regret.{numerator, denominator}` for the previous day's window, and the same two under
 * `windows.d7` / `windows.d30` for the trailing 7 and 30 days ending with that day.
 */

const REAL = new Date(Date.now() + 100 * DAY);
const NOW = new Date(Date.UTC(REAL.getUTCFullYear(), REAL.getUTCMonth(), REAL.getUTCDate(), 0, 10));
const YESTERDAY = utcDay(new Date(NOW.getTime() - DAY));
/** `daysBack` days before yesterday, at 10:00 UTC. */
const onDay = (daysBack: number, hour = 10): Date =>
  new Date(Date.parse(`${YESTERDAY}T00:00:00.000Z`) - daysBack * DAY + hour * HOUR);
const dayName = (daysBack: number): string => utcDay(onDay(daysBack));

let h: ClassifyHarness;
let w: MetricsWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new MetricsWorld(h);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await w.reset();
});

async function articles(count: number): Promise<WorldArticle[]> {
  const out: WorldArticle[] = [];
  for (let i = 0; i < count; i += 1) out.push(await w.article());
  return out;
}

describe('house.metrics like-rate (spec 10 §7)', () => {
  it('writes metrics.daily.<yesterday> with the like-rate per lane from the effective rating before-lane', async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const [a, b, c, d, e, f, g, k, i, j, m] = await articles(11);
    const t = (n: number): Date => new Date(onDay(0, 9).getTime() + n * MINUTE);

    // For You: three likes, one +1 then -1 (one dislike), and u2 liking the first article too.
    await w.rate(u1, a!, 1, 'for_you', t(1));
    await w.rate(u1, b!, 1, 'for_you', t(2));
    await w.rate(u1, c!, 1, 'for_you', t(3));
    await w.rate(u1, d!, 1, 'for_you', t(4));
    await w.rate(u1, d!, -1, 'for_you', t(5));
    await w.rate(u2, a!, 1, 'for_you', t(6));
    // Maybe: one like, one dislike; a rating that was unrated and one that was undone leave no trace.
    await w.rate(u1, e!, 1, 'maybe', t(7));
    await w.rate(u1, f!, -1, 'maybe', t(8));
    await w.rate(u1, g!, 1, 'maybe', t(9));
    await w.unrate(u1, g!, 'maybe', t(10));
    await w.rate(u1, k!, -1, 'maybe', t(11));
    await w.undoRating(u1, k!, t(12));
    // Everything: one dislike.
    await w.rate(u1, i!, -1, 'everything', t(13));
    // No known pre-feedback lane: no snapshot at all, and an empty one.
    await w.rate(u1, j!, -1, null, t(14));
    await w.rateWithEmptyBefore(u1, m!, 1, t(15));
    // The cached lane has moved on since (a rerank): feedback must not be joined to it.
    for (const article of [a!, b!, c!, d!, e!, f!, g!, k!, i!, j!, m!]) {
      await w.cachedLane(u1, article, 'hidden');
    }

    await w.run(NOW);

    const snapshot = await w.snapshot(YESTERDAY);
    expect(snapshot).toBeDefined();
    expect(pick(snapshot, 'lanes.for_you.rated')).toBe(5);
    expect(pick(snapshot, 'lanes.for_you.likeRate')).toBeCloseTo(0.8, 6);
    expect(pick(snapshot, 'lanes.maybe.rated')).toBe(2);
    expect(pick(snapshot, 'lanes.maybe.likeRate')).toBeCloseTo(0.5, 6);
    expect(pick(snapshot, 'lanes.everything.rated')).toBe(1);
    expect(pick(snapshot, 'lanes.everything.likeRate')).toBe(0);
    // Nothing is rated in Hidden although every cached lane says so; unrated lanes have no rate.
    expect(pick(snapshot, 'lanes.hidden.rated') ?? 0).toBe(0);
    expect(pick(snapshot, 'lanes.hidden.likeRate') ?? null).toBeNull();
    // Only today's key exists: one snapshot per run.
    expect(await w.snapshotKeys()).toEqual([`metrics.daily.${YESTERDAY}`]);
  });

  it('reports 7-day and 30-day windows with their denominators and leaves out later events', async () => {
    const u = await w.user();
    const [w1, w2, w3, w4, w5, w6, w7] = await articles(7);
    await w.rate(u, w1!, 1, 'for_you', onDay(0));
    await w.rate(u, w2!, 1, 'for_you', onDay(0, 11));
    await w.rate(u, w3!, -1, 'for_you', onDay(5)); // still inside the 7 days ending yesterday
    await w.rate(u, w4!, 1, 'for_you', onDay(10)); // 30 days only
    await w.rate(u, w5!, -1, 'for_you', onDay(25)); // 30 days only
    await w.rate(u, w6!, 1, 'for_you', onDay(35)); // neither
    await w.rate(u, w7!, -1, 'for_you', new Date(NOW.getTime() - 5 * MINUTE)); // today: not yet

    await w.run(NOW);

    const snapshot = await w.snapshot(YESTERDAY);
    expect(pick(snapshot, 'windows.d7.lanes.for_you.rated')).toBe(3);
    expect(pick(snapshot, 'windows.d7.lanes.for_you.likeRate')).toBeCloseTo(2 / 3, 6);
    expect(pick(snapshot, 'windows.d30.lanes.for_you.rated')).toBe(5);
    expect(pick(snapshot, 'windows.d30.lanes.for_you.likeRate')).toBeCloseTo(3 / 5, 6);
    // The day itself holds only yesterday's two likes.
    expect(pick(snapshot, 'lanes.for_you.rated')).toBe(2);
    expect(pick(snapshot, 'lanes.for_you.likeRate')).toBe(1);
  });
});

describe('house.metrics recovery from Everything/Hidden (the regret rate, spec 10 §7)', () => {
  it('counts rated, bookmarked and opened downranked articles against the eligible downranked ones', async () => {
    const u: WorldUser = await w.user();
    const [r1, r2, r3, r4, r5, r6, r7] = await articles(7);
    // Recovered: opened twice (one distinct article), liked from Hidden, bookmarked.
    await w.open(u, r1!, 'everything', onDay(0, 8));
    await w.open(u, r1!, 'everything', onDay(0, 9));
    await w.rate(u, r2!, 1, 'hidden', onDay(0, 10));
    await w.bookmark(u, r3!, 'everything', onDay(0, 11));
    // Downranked and acted on, but not a recovery (a dislike).
    await w.rate(u, r4!, -1, 'everything', onDay(0, 12));
    // Downranked and never acted on: only the cached lane (what pre-action score history leaves).
    await w.cachedLane(u, r5!, 'everything');
    await w.cachedLane(u, r6!, 'hidden');
    // Never downranked: opened from For You.
    await w.open(u, r7!, 'for_you', onDay(0, 13));
    // The recovered articles are now ranked high: the denominator needs the pre-action history.
    for (const article of [r1!, r2!, r3!, r4!, r7!]) await w.cachedLane(u, article, 'for_you');

    await w.run(NOW);

    const snapshot = await w.snapshot(YESTERDAY);
    expect(pick(snapshot, 'regret.numerator')).toBe(3);
    expect(pick(snapshot, 'regret.denominator')).toBe(6);
    expect(pick(snapshot, 'windows.d7.regret.numerator')).toBe(3);
    expect(pick(snapshot, 'windows.d7.regret.denominator')).toBe(6);
    expect(pick(snapshot, 'windows.d30.regret.numerator')).toBe(3);
    expect(pick(snapshot, 'windows.d30.regret.denominator')).toBe(6);
  });
});

describe('house.metrics storage (spec 10 §7, spec 11 §6)', () => {
  it('stores no text, titles or user ids and stays below 64 KB', async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const list = await articles(6);
    for (const [index, article] of list.entries()) {
      await w.rate(
        index % 2 === 0 ? u1 : u2,
        article,
        index % 3 === 0 ? -1 : 1,
        'for_you',
        onDay(0),
      );
      await w.open(u1, article, 'everything', onDay(0, 12));
      await w.cachedLane(u1, article, 'hidden');
    }

    await w.run(NOW);

    const snapshot = await w.snapshot(YESTERDAY);
    expect(snapshot).toBeDefined();
    const text = JSON.stringify(snapshot);
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain('Marmalade-Hedgehog');
    expect(text).not.toContain('metrics.example.test');
    for (const user of [u1, u2]) {
      expect(text).not.toContain(user.id);
      expect(text).not.toContain(user.email);
    }
    for (const article of list) {
      expect(text).not.toContain(article.title);
      expect(text).not.toContain(article.url);
    }
  });

  it('replaces the snapshot of a rerun for the same day, identically when nothing changed', async () => {
    const u = await w.user();
    const [a, b] = await articles(2);
    await w.rate(u, a!, 1, 'for_you', onDay(0));

    await w.run(NOW);
    const first = await w.snapshot(YESTERDAY);
    await w.run(NOW);
    expect(await w.snapshot(YESTERDAY)).toEqual(first);
    expect(await w.snapshotKeys()).toEqual([`metrics.daily.${YESTERDAY}`]);

    await w.rate(u, b!, -1, 'for_you', onDay(0, 11));
    await w.run(new Date(NOW.getTime() + 30 * MINUTE));
    const third = await w.snapshot(YESTERDAY);
    expect(third).not.toEqual(first);
    expect(pick(third, 'lanes.for_you.rated')).toBe(2);
    expect(await w.snapshotKeys()).toEqual([`metrics.daily.${YESTERDAY}`]);
  });

  it('deletes snapshots older than 90 days, keeps the 90th, and touches no other key', async () => {
    await w.setting(`metrics.daily.${dayName(89)}`, { lanes: {} });
    await w.setting(`metrics.daily.${dayName(90)}`, { lanes: {} });
    await w.setting(`metrics.daily.${dayName(200)}`, { lanes: {} });
    await w.setting(`metrics.daily.${dayName(10)}`, { lanes: {} });
    await w.setting('card_text_mode', 'as_written');

    await w.run(NOW);

    expect(await w.snapshotKeys()).toEqual(
      [dayName(89), dayName(10), YESTERDAY].sort().map((day) => `metrics.daily.${day}`),
    );
    const other = await h.owner.query("SELECT 1 FROM settings WHERE key = 'card_text_mode'");
    expect(other.rowCount).toBe(1);
  });
});
