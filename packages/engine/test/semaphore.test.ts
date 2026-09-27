import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPrioritySemaphore,
  DEFAULT_AGING_MS,
  waiterOrderKey,
  type SemaphoreAcquisition,
} from '../src/semaphore.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

const granted = (result: SemaphoreAcquisition): (() => void) => {
  if (!result.ok) throw new Error(`not granted: ${result.reason}`);
  return result.release;
};

describe('createPrioritySemaphore (spec 04 §4)', () => {
  it('grants up to its capacity and queues the rest', async () => {
    const semaphore = createPrioritySemaphore({ capacity: 2 });
    const a = granted(await semaphore.acquire('bulk'));
    granted(await semaphore.acquire('bulk'));
    let third: SemaphoreAcquisition | undefined;
    void semaphore.acquire('bulk').then((r) => {
      third = r;
    });
    await Promise.resolve();
    expect(third).toBeUndefined();
    expect(semaphore.inUse).toBe(2);
    expect(semaphore.waiting).toBe(1);
    a();
    a(); // releasing twice is a no-op
    await Promise.resolve();
    expect(third?.ok).toBe(true);
    expect(semaphore.inUse).toBe(2);
    expect(semaphore.capacity).toBe(2);
  });

  it('serves interactive waiters before bulk ones queued at the same time', async () => {
    const semaphore = createPrioritySemaphore({ capacity: 1 });
    const release = granted(await semaphore.acquire('bulk'));
    const order: string[] = [];
    const bulk = semaphore.acquire('bulk').then((r) => {
      order.push('bulk');
      return r;
    });
    const interactive = semaphore.acquire('interactive').then((r) => {
      order.push('interactive');
      return r;
    });
    release();
    granted(await interactive)();
    await bulk;
    expect(order).toEqual(['interactive', 'bulk']);
  });

  it('lets a bulk waiter that aged past agingMs go first', async () => {
    const semaphore = createPrioritySemaphore({ capacity: 1, agingMs: 1_000 });
    const release = granted(await semaphore.acquire('bulk'));
    const order: string[] = [];
    const bulk = semaphore.acquire('bulk').then((r) => {
      order.push('bulk');
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    const interactive = semaphore.acquire('interactive').then((r) => {
      order.push('interactive');
      return r;
    });
    release();
    granted(await bulk)();
    await interactive;
    expect(order).toEqual(['bulk', 'interactive']);
  });

  it('stops waiting on cancellation and at the deadline', async () => {
    const semaphore = createPrioritySemaphore({ capacity: 1 });
    granted(await semaphore.acquire('bulk'));
    const controller = new AbortController();
    const cancelled = semaphore.acquire('interactive', { signal: controller.signal });
    const late = semaphore.acquire('bulk', { deadlineMs: 500 });
    controller.abort();
    expect(await cancelled).toEqual({ ok: false, reason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await late).toEqual({ ok: false, reason: 'deadline' });
    expect(semaphore.waiting).toBe(0);
  });

  it('refuses at once for an aborted signal or a passed deadline', async () => {
    const semaphore = createPrioritySemaphore({ capacity: 1 });
    const controller = new AbortController();
    controller.abort();
    expect(await semaphore.acquire('bulk', { signal: controller.signal })).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(await semaphore.acquire('bulk', { deadlineMs: -1 })).toEqual({
      ok: false,
      reason: 'deadline',
    });
    expect(semaphore.inUse).toBe(0);
  });

  it('validates its capacity', () => {
    expect(() => createPrioritySemaphore({ capacity: 0 })).toThrow(RangeError);
    expect(() => createPrioritySemaphore({ capacity: 1.5 })).toThrow(RangeError);
  });

  it('orders by enqueue time plus aging for bulk', () => {
    expect(waiterOrderKey('interactive', 100, DEFAULT_AGING_MS)).toBe(100);
    expect(waiterOrderKey('bulk', 100, DEFAULT_AGING_MS)).toBe(100 + DEFAULT_AGING_MS);
  });
});
