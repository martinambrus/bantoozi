import type { Database, Transaction } from '@bantoozi/db';
import { expect, it, vi } from 'vitest';

import type { WorkerDeps } from '../src/handlers/deps.js';
import { recoverStaleRebuild } from '../src/handlers/house-purge-auth.js';
import { recoverStaleJob } from '../src/handlers/stale-job-recovery.js';
import { StaleWorkerError } from '../src/stale-worker.js';

it.each(['outbox', 'house.reenrich', 'house.rematch'] as const)(
  'preserves the original stale error when the %s recovery write fails',
  async (kind) => {
    const stale = new StaleWorkerError('old', 'new');
    const writeError = new Error('injected recovery write failure');
    const execute = vi.fn().mockRejectedValue(writeError);
    const db = {
      transaction: async (fn: (tx: Transaction) => Promise<unknown>) =>
        fn({ execute } as unknown as Transaction),
    } as Database;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = { db, logger } as unknown as WorkerDeps;
    const handle = async () => {
      throw stale;
    };
    if (kind === 'outbox') {
      await expect(
        recoverStaleJob<'article.enrich'>(deps, handle)(
          { articleId: '1' },
          {
            queue: 'article.enrich',
            jobId: 'write-failure',
            retry: { count: 1, limit: 1 },
          },
        ),
      ).rejects.toBe(stale);
    } else {
      await expect(
        recoverStaleRebuild(
          deps,
          kind,
          handle,
        )(
          {},
          {
            queue: kind,
            jobId: 'write-failure',
            retry: { count: 1, limit: 1 },
          },
        ),
      ).rejects.toBe(stale);
    }
    expect(execute).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      {
        err: writeError,
        queue: kind === 'outbox' ? 'article.enrich' : kind,
        jobId: 'write-failure',
      },
      'stale worker recovery failed',
    );
  },
);
