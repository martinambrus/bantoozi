import { afterEach, expect, it, vi } from 'vitest';

import { WORKER_SHUTDOWN_TIMEOUT_MS, withShutdownDeadline } from '../src/shutdown-deadline.js';

afterEach(() => vi.useRealTimers());

it.each(['settings-restart', 'SIGTERM'])('bounds a hung %s drain including cleanup', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const draining = withShutdownDeadline(() => new Promise<void>(() => {}), exit);
  const result = expect(draining).rejects.toThrow('worker shutdown deadline');
  await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_TIMEOUT_MS - 1);
  expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledOnce();
  await result;
});

it('clears the deadline after successful cleanup or a shutdown error', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  await withShutdownDeadline(async () => {}, exit);
  await expect(
    withShutdownDeadline(async () => {
      throw new Error('cleanup failed');
    }, exit),
  ).rejects.toThrow('cleanup failed');
  await vi.advanceTimersByTimeAsync(2 * WORKER_SHUTDOWN_TIMEOUT_MS);
  expect(exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
