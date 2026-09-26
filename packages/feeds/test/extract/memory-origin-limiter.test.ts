import type { OriginLimiter } from '@bantoozi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryOriginLimiter } from '../../src/extract/index.js';

const LEASE_MS = 25_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Timeline {
  starts: number[];
  active: number;
  maxActive: number;
}

/**
 * One simulated request, driven through the limiter the way `safeFetch` does (spec 03 §8.2):
 * reserve; on `wait` sleep until `retryAt` and reserve again; run; release the exact token.
 */
async function throttledRequest(
  limiter: OriginLimiter,
  origin: string,
  durationMs: number,
  timeline: Timeline,
): Promise<void> {
  for (;;) {
    const reservation = await limiter.reserve(origin, { leaseMs: LEASE_MS });
    if (reservation.status === 'blocked') throw new Error('unexpected cooldown');
    if (reservation.status === 'wait') {
      await sleep(Math.max(10, reservation.retryAt.getTime() - Date.now()));
      continue;
    }
    timeline.starts.push(Date.now());
    timeline.active += 1;
    timeline.maxActive = Math.max(timeline.maxActive, timeline.active);
    try {
      await sleep(durationMs);
    } finally {
      timeline.active -= 1;
      await limiter.release(origin, reservation.token);
    }
    return;
  }
}

describe('spec 03 §8.2 in-memory OriginLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows at most 2 concurrent requests and 1 s between starts per origin', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now() });
    const timelines = new Map<string, Timeline>();
    const run = (origin: string, durationMs: number): Promise<void> => {
      const timeline = timelines.get(origin) ?? { starts: [], active: 0, maxActive: 0 };
      timelines.set(origin, timeline);
      return throttledRequest(limiter, origin, durationMs, timeline);
    };
    const all = Promise.all([
      ...[2500, 400, 3000, 100, 1800, 2200, 50, 700].map((ms) =>
        run('https://news.example.com', ms),
      ),
      ...[5000, 5000, 5000].map((ms) => run('https://www.example.org', ms)),
    ]);
    await vi.runAllTimersAsync();
    await all;

    const news = timelines.get('https://news.example.com');
    const org = timelines.get('https://www.example.org');
    expect(news?.starts).toHaveLength(8);
    expect(org?.starts).toHaveLength(3);
    for (const timeline of [news, org]) {
      expect(timeline?.maxActive).toBeLessThanOrEqual(2);
      const starts = [...(timeline?.starts ?? [])].sort((a, b) => a - b);
      for (let index = 1; index < starts.length; index += 1) {
        expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
      }
    }
    // Both origins start at once: the throttle is per origin.
    expect(news?.starts[0]).toBe(0);
    expect(org?.starts[0]).toBe(0);
    // Two 5 s requests hold both leases, so the third starts only when the first ends.
    expect(org?.starts).toEqual([0, 1000, 5000]);
    expect(news?.maxActive).toBe(2);
  });

  it('answers wait with the next start slot, or a poll time while both leases are held', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now(), fullPollMs: 250 });
    const origin = 'https://example.com';
    const first = await limiter.reserve(origin, { leaseMs: 800 });
    expect(first.status).toBe('granted');
    await expect(limiter.reserve(origin, { leaseMs: 800 })).resolves.toEqual({
      status: 'wait',
      retryAt: new Date(1000),
    });
    vi.setSystemTime(1000);
    const second = await limiter.reserve(origin, { leaseMs: 60_000 });
    expect(second.status).toBe('granted');
    vi.setSystemTime(1500);
    // The first lease expired at 800 and was reclaimed; only the start slot (2000) blocks.
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'wait',
      retryAt: new Date(2000),
    });
    vi.setSystemTime(2000);
    const third = await limiter.reserve(origin, { leaseMs: 60_000 });
    expect(third.status).toBe('granted');
    vi.setSystemTime(5000);
    // Both leases live: poll again after fullPollMs.
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'wait',
      retryAt: new Date(5250),
    });
    if (second.status === 'granted') await limiter.release(origin, second.token);
    const fourth = await limiter.reserve(origin, { leaseMs: 1000 });
    expect(fourth.status).toBe('granted');
  });

  it('reclaims expired leases of a crashed holder', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now() });
    const origin = 'https://example.com';
    await limiter.reserve(origin, { leaseMs: 5000 });
    vi.setSystemTime(1000);
    await limiter.reserve(origin, { leaseMs: 5000 });
    vi.setSystemTime(3000);
    await expect(limiter.reserve(origin, { leaseMs: 5000 })).resolves.toMatchObject({
      status: 'wait',
    });
    vi.setSystemTime(5000);
    await expect(limiter.reserve(origin, { leaseMs: 5000 })).resolves.toMatchObject({
      status: 'granted',
    });
  });

  it('suggests the earliest lease expiry when it comes before the next poll', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now(), fullPollMs: 10_000 });
    const origin = 'https://example.com';
    await limiter.reserve(origin, { leaseMs: 3000 });
    vi.setSystemTime(1000);
    await limiter.reserve(origin, { leaseMs: 60_000 });
    vi.setSystemTime(2000);
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'wait',
      retryAt: new Date(3000),
    });
  });

  it('keeps cooldowns: blocked until the end, never shortened, clamped to 24 h', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now() });
    const origin = 'https://example.com';
    await limiter.block(origin, new Date(60_000));
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'blocked',
      until: new Date(60_000),
    });
    await limiter.block(origin, new Date(30_000));
    await limiter.block(origin, new Date(Number.NaN));
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'blocked',
      until: new Date(60_000),
    });
    await limiter.block(origin, new Date(Date.now() + 48 * 60 * 60 * 1000));
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toEqual({
      status: 'blocked',
      until: new Date(24 * 60 * 60 * 1000),
    });
    vi.setSystemTime(24 * 60 * 60 * 1000);
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toMatchObject({
      status: 'granted',
    });
  });

  it('ignores releases of unknown tokens and origins', async () => {
    const limiter = createMemoryOriginLimiter({
      now: () => Date.now(),
      maxConcurrent: 1,
      spacingMs: 0,
    });
    const origin = 'https://example.com';
    const held = await limiter.reserve(origin, { leaseMs: 10_000 });
    await limiter.release(origin, 'not-a-token');
    await limiter.release('https://other.example', 'not-a-token');
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toMatchObject({
      status: 'wait',
    });
    if (held.status === 'granted') await limiter.release(origin, held.token);
    await expect(limiter.reserve(origin, { leaseMs: 1000 })).resolves.toMatchObject({
      status: 'granted',
    });
  });

  it('forgets idle origins once many are tracked', async () => {
    const limiter = createMemoryOriginLimiter({ now: () => Date.now() });
    for (let index = 0; index < 10_000; index += 1) {
      await limiter.reserve(`https://host-${index}.example`, { leaseMs: 100 });
    }
    await limiter.block('https://host-0.example', new Date(3_600_000));
    vi.setSystemTime(5000);
    await expect(limiter.reserve('https://new.example', { leaseMs: 100 })).resolves.toMatchObject({
      status: 'granted',
    });
    // A cooling-down origin is not idle and survives the purge.
    await expect(
      limiter.reserve('https://host-0.example', { leaseMs: 100 }),
    ).resolves.toMatchObject({
      status: 'blocked',
    });
    await expect(
      limiter.reserve('https://host-1.example', { leaseMs: 100 }),
    ).resolves.toMatchObject({
      status: 'granted',
    });
  });
});
