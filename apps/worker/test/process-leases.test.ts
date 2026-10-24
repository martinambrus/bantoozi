import { expect, it, vi } from 'vitest';

import { ProcessLeases } from '../src/process-leases.js';

it('releases only this process resources and waits for a claim racing drain', async () => {
  const first = new ProcessLeases();
  const other = new ProcessLeases();
  const releaseFirst = vi.fn(async () => {});
  const releaseOther = vi.fn(async () => {});
  await first.acquire(
    async () => ({}),
    () => releaseFirst,
  );
  await other.acquire(
    async () => ({}),
    () => releaseOther,
  );
  let complete!: (value: object) => void;
  const lateRelease = vi.fn(async () => {});
  const late = first.acquire(
    () =>
      new Promise<object>((resolve) => {
        complete = resolve;
      }),
    () => lateRelease,
  );
  const failure = expect(late).rejects.toThrow('draining');
  const draining = first.drain();
  complete({});
  await draining;
  await failure;
  expect(releaseFirst).toHaveBeenCalledOnce();
  expect(lateRelease).toHaveBeenCalledOnce();
  expect(releaseOther).not.toHaveBeenCalled();
  await expect(
    first.acquire(
      async () => ({}),
      () => releaseFirst,
    ),
  ).rejects.toThrow('draining');
  await first.drain();
  expect(releaseFirst).toHaveBeenCalledOnce();
});

it('forgets normal completions and surfaces cleanup failures after attempting every release', async () => {
  const leases = new ProcessLeases();
  const done = vi.fn(async () => {});
  const claim = await leases.acquire(
    async () => ({}),
    () => done,
  );
  await leases.release(claim);
  const broken = vi.fn(async () => {
    throw new Error('database unavailable');
  });
  const remaining = vi.fn(async () => {});
  await leases.acquire(
    async () => ({}),
    () => broken,
  );
  await leases.acquire(
    async () => ({}),
    () => remaining,
  );
  await expect(leases.drain()).rejects.toThrow('lease cleanup failed');
  expect(done).toHaveBeenCalledOnce();
  expect(broken).toHaveBeenCalledOnce();
  expect(remaining).toHaveBeenCalledOnce();
});

it('does not run drain-only recovery for a handler that has finished', async () => {
  const leases = new ProcessLeases();
  const recover = vi.fn(async () => {});
  const claim = await leases.acquire(
    async () => ({}),
    () => recover,
  );
  leases.forget(claim);
  await leases.drain();
  expect(recover).not.toHaveBeenCalled();
});
