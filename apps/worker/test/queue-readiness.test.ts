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

describe('ongoing queue readiness', () => {
  it('checks healthy queues every 10 minutes and switches to 30 seconds after deletion', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({ rows: [{ name: 'user.estimate' }] });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readiness = await startQueueReadiness({
      db: { execute } as unknown as Executor,
      logger,
      queues: ['user.estimate'],
    });
    try {
      execute.mockResolvedValue({ rows: [] });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(readiness.missing()).toEqual(['user.estimate']);
      expect(readiness.problems()[0]?.key).toBe('queues.missing');
      expect(logger.error).toHaveBeenCalledOnce();
      execute.mockResolvedValue({ rows: [{ name: 'user.estimate' }] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readiness.problems()).toEqual([]);
      expect(logger.info).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(599_999);
      expect(execute).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      readiness.stop();
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('shares a slow check with timer ticks and manual refreshes, and stops during it', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const readiness = await startQueueReadiness({
      db: { execute } as unknown as Executor,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      queues: ['user.estimate'],
    });
    let complete!: (value: { rows: { name: string }[] }) => void;
    execute.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      const first = readiness.refresh();
      const second = readiness.refresh();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(execute).toHaveBeenCalledTimes(2);
      readiness.stop();
      complete({ rows: [{ name: 'user.estimate' }] });
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      readiness.stop();
      complete({ rows: [] });
    }
  });

  it('logs an unreadable catalog once until a successful read changes the state', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValue(new Error('permission denied'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const readiness = await startQueueReadiness({
      db: { execute } as unknown as Executor,
      logger,
      queues: ['user.estimate'],
    });
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(execute).toHaveBeenCalledTimes(4);
      expect(logger.warn).toHaveBeenCalledOnce();
      execute.mockResolvedValueOnce({ rows: [] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readiness.missing()).toEqual(['user.estimate']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(readiness.missing()).toEqual(['user.estimate']);
    } finally {
      readiness.stop();
    }
  });
});
