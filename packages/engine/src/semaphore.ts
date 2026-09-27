import type { Priority } from './types.js';

/**
 * Process-wide priority semaphore of the engine router (spec 04 §4): at most `capacity` engine
 * attempts are in flight (`ENGINE_CONCURRENCY`; the LLM additionally takes a permit of its own
 * `OLLAMA_MAX_CONCURRENCY` semaphore). Waiters are served interactive before bulk, with aging: a
 * bulk waiter that has waited `agingMs` longer than an interactive one goes first, so bulk work is
 * never starved. Waiting is cancellable and bounded by the caller's deadline. The router holds a
 * permit only around one wire attempt, never across a backoff delay.
 */

/** How much earlier an interactive waiter is served than a bulk waiter queued at the same time. */
export const DEFAULT_AGING_MS = 30_000;

export type SemaphoreAcquisition =
  { ok: true; release: () => void } | { ok: false; reason: 'cancelled' | 'deadline' };

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms): stop waiting when it passes. */
  deadlineMs?: number;
}

export interface PrioritySemaphore {
  acquire(priority: Priority, options?: AcquireOptions): Promise<SemaphoreAcquisition>;
  /** Permits currently held. */
  readonly inUse: number;
  /** Waiters currently queued. */
  readonly waiting: number;
  readonly capacity: number;
}

export interface PrioritySemaphoreOptions {
  capacity: number;
  agingMs?: number;
  /** Clock for queue ordering and deadlines (epoch ms). */
  now?: () => number;
}

interface Waiter {
  /** Queue order: earlier is served first. */
  key: number;
  seq: number;
  settle: (result: SemaphoreAcquisition) => void;
}

/**
 * The queue order of a waiter: its enqueue time, plus `agingMs` for bulk. Interactive therefore
 * precedes bulk unless the bulk waiter has waited `agingMs` longer.
 */
export function waiterOrderKey(priority: Priority, enqueuedAt: number, agingMs: number): number {
  return enqueuedAt + (priority === 'bulk' ? agingMs : 0);
}

export function createPrioritySemaphore(options: PrioritySemaphoreOptions): PrioritySemaphore {
  const { capacity } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('capacity must be a positive integer');
  }
  const agingMs = options.agingMs ?? DEFAULT_AGING_MS;
  const now = options.now ?? Date.now;
  let inUse = 0;
  let seq = 0;
  const queue: Waiter[] = [];

  const permit = (): (() => void) => {
    inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inUse -= 1;
      dispatch();
    };
  };

  function dispatch(): void {
    while (inUse < capacity && queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i += 1) {
        const w = queue[i]!;
        const b = queue[best]!;
        if (w.key < b.key || (w.key === b.key && w.seq < b.seq)) best = i;
      }
      const [next] = queue.splice(best, 1);
      next!.settle({ ok: true, release: permit() });
    }
  }

  return {
    get inUse() {
      return inUse;
    },
    get waiting() {
      return queue.length;
    },
    capacity,
    acquire(priority, acquireOptions = {}) {
      const { signal, deadlineMs } = acquireOptions;
      if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'cancelled' });
      const start = now();
      if (deadlineMs !== undefined && deadlineMs <= start) {
        return Promise.resolve({ ok: false, reason: 'deadline' });
      }
      if (inUse < capacity && queue.length === 0) {
        return Promise.resolve({ ok: true, release: permit() });
      }
      return new Promise<SemaphoreAcquisition>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter: Waiter = {
          key: waiterOrderKey(priority, start, agingMs),
          seq: (seq += 1),
          settle: (result) => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
        };
        const leave = (reason: 'cancelled' | 'deadline') => {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1);
          waiter.settle({ ok: false, reason });
        };
        const onAbort = () => leave('cancelled');
        signal?.addEventListener('abort', onAbort, { once: true });
        if (deadlineMs !== undefined) {
          timer = setTimeout(() => leave('deadline'), Math.max(0, deadlineMs - start));
        }
        queue.push(waiter);
      });
    },
  };
}
