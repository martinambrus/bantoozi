import { createPrioritySemaphore, type PrioritySemaphore } from '@bantoozi/engine';
import { describe, expect, it } from 'vitest';

/**
 * M8b-T4 (scope B2, "ENGINE_CONCURRENCY"): `PrioritySemaphore.setCapacity(n)`. A shrinking semaphore
 * makes no new grant until `inUse < n` (permits already held are never revoked); growing it serves
 * waiters at once. The type is cast, so this file compiles before the method exists and fails at
 * run time for that reason.
 */
type Resizable = PrioritySemaphore & { setCapacity(n: number): void };
const resize = (s: PrioritySemaphore, n: number): void => (s as Resizable).setCapacity(n);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function hold(s: PrioritySemaphore, n: number) {
  const releases: Array<() => void> = [];
  for (let i = 0; i < n; i += 1) {
    const r = await s.acquire('bulk');
    if (!r.ok) throw new Error('acquire failed');
    releases.push(r.release);
  }
  return releases;
}

describe('createPrioritySemaphore().setCapacity', () => {
  it('shrinking keeps held permits, grants nothing until inUse < n, then grants up to n', async () => {
    const s = createPrioritySemaphore({ capacity: 4 });
    const held = await hold(s, 4);
    const grants: number[] = [];
    const waiters = Array.from({ length: 3 }, () =>
      s.acquire('bulk').then((r) => {
        if (r.ok) grants.push(s.inUse);
        return r;
      }),
    );
    await tick();
    expect(s.waiting).toBe(3);
    resize(s, 2);
    expect(s.capacity).toBe(2);
    expect(s.inUse).toBe(4);
    held[0]!();
    held[1]!();
    await tick();
    // inUse is 2 = the new capacity: still no grant.
    expect(s.inUse).toBe(2);
    expect(grants).toEqual([]);
    held[2]!();
    await tick();
    // inUse fell to 1 < 2: exactly one waiter is granted, and the semaphore is full again.
    expect(grants).toEqual([2]);
    expect(s.inUse).toBe(2);
    expect(s.waiting).toBe(2);
    held[3]!();
    await tick();
    expect(grants).toEqual([2, 2]);
    expect(s.inUse).toBe(2);
    expect(s.waiting).toBe(1);
    expect(waiters).toHaveLength(3);
  });

  it('never exceeds the new capacity under churn after a shrink', async () => {
    const s = createPrioritySemaphore({ capacity: 6 });
    let active = 0;
    let peakAfter = 0;
    let shrunk = false;
    const work = async () => {
      const r = await s.acquire('bulk');
      if (!r.ok) return;
      active += 1;
      if (shrunk) peakAfter = Math.max(peakAfter, s.inUse);
      await tick();
      active -= 1;
      r.release();
    };
    const all = Array.from({ length: 60 }, () => work());
    await tick();
    resize(s, 2);
    shrunk = true;
    await Promise.all(all);
    expect(s.inUse).toBe(0);
    expect(active).toBe(0);
    // Permits granted before the shrink may overlap the first grants after it; once they drain every
    // grant sees inUse <= 2.
    const late = Array.from({ length: 20 }, () => work());
    peakAfter = 0;
    await Promise.all(late);
    expect(peakAfter).toBeLessThanOrEqual(2);
    expect(peakAfter).toBeGreaterThan(0);
  });

  it('growing grants the waiting acquirers at once, and capacity reads back', async () => {
    const s = createPrioritySemaphore({ capacity: 1 });
    await hold(s, 1);
    const granted: boolean[] = [];
    for (let i = 0; i < 3; i += 1) void s.acquire('interactive').then((r) => granted.push(r.ok));
    await tick();
    expect(s.waiting).toBe(3);
    resize(s, 3);
    await tick();
    expect(s.capacity).toBe(3);
    expect(granted).toEqual([true, true]);
    expect(s.inUse).toBe(3);
    expect(s.waiting).toBe(1);
  });

  it('refuses a capacity that is not a positive integer, like the constructor', () => {
    const s = createPrioritySemaphore({ capacity: 2 });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resize(s, bad)).toThrow(RangeError);
    }
    expect(s.capacity).toBe(2);
  });
});
