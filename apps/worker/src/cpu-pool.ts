import { availableParallelism } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

import type { EstimateOptions, EstimateSample, FoldResult, TrainArgs } from '@bantoozi/ranker';

type TrainMode = 'production' | 'research';

/**
 * A value serialized once into shared memory (D-262): every task that carries it shares the bytes
 * instead of copying the value. Posting a training's arguments (about 19 MB for 3,800 samples) to
 * each of its tasks cost the event loop ~200 ms per task; serializing once costs ~75 ms, and each
 * thread decodes its own copy. V8's serializer keeps what structured cloning keeps (dates, -0, NaN).
 */
export interface Shared<T> {
  readonly buffer: SharedArrayBuffer;
  /** Type only. */
  readonly value?: T;
}

export function share<T>(value: T): Shared<T> {
  const bytes = serialize(value);
  const buffer = new SharedArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return { buffer };
}

export function unshare<T>(shared: Shared<T>): T {
  return deserialize(new Uint8Array(shared.buffer)) as T;
}

/** The CPU-bound tasks the pool runs; each is pure and its input and result are plain data. */
export type CpuTask =
  | { kind: 'trainFold'; args: Shared<TrainArgs>; mode: TrainMode; f: number }
  | { kind: 'trainingSetSha'; args: Shared<TrainArgs> }
  | {
      kind: 'trainEstimate';
      args: Shared<{ samples: EstimateSample[]; options: Partial<EstimateOptions> }>;
    }
  | {
      kind: 'finishTraining';
      args: Shared<TrainArgs>;
      mode: TrainMode;
      folds: FoldResult[];
      setSha: string;
    };

export interface CpuRequest {
  id: number;
  task: CpuTask;
}

export type CpuResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; stack: string | undefined } };

/**
 * Pool threads for a machine (D-262): every core but a reserve of `max(2, ⌈cores / 8⌉)` for the
 * operating system, PostgreSQL, the API and the worker's own event loop (8 cores → 6, 16 → 14,
 * 128 → 112). `WORKER_CPU_THREADS` overrides it.
 */
export function cpuPoolSize(cores: number = availableParallelism(), override?: number): number {
  if (override !== undefined) return Math.max(1, Math.floor(override));
  return Math.max(1, cores - Math.max(2, Math.ceil(cores / 8)));
}

/** A thread with nothing to do for this long exits; the next task starts a new one. */
export const CPU_POOL_IDLE_MS = 60_000;

/**
 * The thread module next to this one: `.ts` when running from sources (the thread registers tsx
 * itself), `.js` in the compiled app.
 */
const WORKER_URL = new URL(
  `./cpu-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

interface Pending {
  id: number;
  task: CpuTask;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  current: Pending | null;
  idle: NodeJS.Timeout | null;
}

export interface CpuPoolOptions {
  size: number;
  idleMs?: number;
  /** Thread flags; the default inherits the process's (its source conditions). */
  execArgv?: string[];
}

/**
 * A shared pool of CPU threads (D-262). Tasks queue in arrival order and run one per thread;
 * threads start only when tasks wait (up to `size`) and exit after `idleMs` without work, so a
 * quiet worker holds none. With many users training at once their tasks share the pool instead of
 * each run taking its own cores. A thread that crashes fails only its task and is replaced.
 */
export class CpuPool {
  readonly size: number;
  private readonly idleMs: number;
  private readonly execArgv: string[] | undefined;
  private readonly slots = new Set<Slot>();
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: CpuPoolOptions) {
    this.size = Math.max(1, options.size);
    this.idleMs = options.idleMs ?? CPU_POOL_IDLE_MS;
    this.execArgv = options.execArgv;
  }

  /** Threads currently started (busy or idle). */
  get threads(): number {
    return this.slots.size;
  }

  run<T>(task: CpuTask): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The CPU pool is closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        task,
        resolve: resolve as (r: unknown) => void,
        reject,
      });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) pending.reject(new Error('The CPU pool is closed'));
    await Promise.all([...this.slots].map((slot) => this.retire(slot)));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let slot = [...this.slots].find((candidate) => candidate.current === null);
      if (slot === undefined) {
        if (this.slots.size >= this.size) return;
        slot = this.spawn();
      }
      const pending = this.queue.shift() as Pending;
      if (slot.idle !== null) clearTimeout(slot.idle);
      slot.idle = null;
      slot.current = pending;
      slot.worker.postMessage({ id: pending.id, task: pending.task } satisfies CpuRequest);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      name: 'bantoozi-cpu',
      ...(this.execArgv === undefined ? {} : { execArgv: this.execArgv }),
    });
    worker.unref();
    const slot: Slot = { worker, current: null, idle: null };
    this.slots.add(slot);
    worker.on('message', (response: CpuResponse) => {
      const pending = slot.current;
      if (pending === null || pending.id !== response.id) return;
      slot.current = null;
      if (response.ok) pending.resolve(response.result);
      else {
        const error = new Error(response.error.message);
        if (response.error.stack !== undefined) error.stack = response.error.stack;
        pending.reject(error);
      }
      slot.idle = setTimeout(() => void this.retire(slot), this.idleMs);
      slot.idle.unref();
      this.dispatch();
    });
    let crash: Error | undefined;
    worker.on('error', (error: unknown) => {
      crash ??= error instanceof Error ? error : new Error(String(error));
    });
    worker.on('exit', (code: number) => {
      this.slots.delete(slot);
      if (slot.idle !== null) clearTimeout(slot.idle);
      const pending = slot.current;
      slot.current = null;
      pending?.reject(crash ?? new Error(`A CPU pool thread exited with code ${code}`));
      if (!this.closed) this.dispatch();
    });
    return slot;
  }

  private async retire(slot: Slot): Promise<void> {
    if (slot.current !== null && !this.closed) return;
    this.slots.delete(slot);
    if (slot.idle !== null) clearTimeout(slot.idle);
    await slot.worker.terminate();
  }
}
