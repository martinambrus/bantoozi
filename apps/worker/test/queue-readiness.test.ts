import type { Executor } from '@bantoozi/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startQueueReadiness } from '../src/readiness.js';

afterEach(() => vi.useRealTimers());

describe('queue readiness refresh after an unreadable startup', () => {
  it('retries on the 30 second timer, detects the missing queue and recovers', async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [{ name: 'user.estimate' }] });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readiness = await startQueueReadiness({
      db: { execute } as unknown as Executor,
      logger,
      queues: ['user.estimate'],
    });
    try {
      expect(readiness.problems()).toEqual([]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(readiness.missing()).toEqual(['user.estimate']);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readiness.problems()).toEqual([]);
      expect(logger.info).toHaveBeenCalledOnce();
    } finally {
      readiness.stop();
    }
    const calls = execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(calls);
  });
});
