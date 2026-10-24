import { afterEach, expect, it, vi } from 'vitest';

import { startWorkerSchedules } from '../src/boss.js';

afterEach(() => vi.useRealTimers());

it('retries missing schedules after migration while unrelated schedules start', async () => {
  vi.useFakeTimers();
  const schedule = vi.fn().mockImplementation(async (queue: string) => {
    if (queue === 'house.alerts') throw new Error('Queue house.alerts not found');
  });
  const missing = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cron = await startWorkerSchedules(
    { schedule },
    ['feed.schedule', 'house.alerts'],
    missing,
    logger,
  );
  expect(schedule).toHaveBeenCalledTimes(2);
  expect(missing).toHaveBeenCalledWith('house.alerts');
  schedule.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(schedule).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(schedule).toHaveBeenCalledTimes(3);
  cron.stop();
});

it('propagates unrelated startup errors and cancels missing schedule retries on shutdown', async () => {
  vi.useFakeTimers();
  const schedule = vi.fn().mockRejectedValue(new Error('permission denied'));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await expect(
    startWorkerSchedules({ schedule }, ['feed.schedule'], vi.fn(), logger),
  ).rejects.toThrow('permission denied');
  schedule.mockRejectedValue(new Error('Queue feed.schedule not found'));
  const cron = await startWorkerSchedules({ schedule }, ['feed.schedule'], vi.fn(), logger);
  cron.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(schedule).toHaveBeenCalledTimes(2);
});
