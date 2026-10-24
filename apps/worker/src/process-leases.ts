/** Token-fenced releases owned by this process; no database-wide sweep can touch another worker. */
export class ProcessLeases {
  private draining = false;
  private readonly acquiring = new Set<Promise<unknown>>();
  private readonly held = new Map<object, { release(): Promise<void>; pending?: Promise<void> }>();
  private readonly errors: unknown[] = [];

  async acquire<T extends object | null>(
    claim: () => Promise<T>,
    releaseFor: (value: T) => (() => Promise<void>) | undefined,
  ): Promise<T> {
    if (this.draining) throw new Error('worker draining');
    const pending = (async () => {
      const value = await claim();
      const release = releaseFor(value);
      if (value !== null && release !== undefined) this.held.set(value, { release });
      if (this.draining) {
        if (value !== null) await this.release(value);
        throw new Error('worker draining');
      }
      return value;
    })();
    this.acquiring.add(pending);
    try {
      return await pending;
    } finally {
      this.acquiring.delete(pending);
    }
  }

  /** A handler that finished normally keeps its own release/error semantics. */
  forget(value: object): void {
    if (this.held.get(value)?.pending === undefined) this.held.delete(value);
  }

  async release(value: object): Promise<void> {
    const entry = this.held.get(value);
    if (entry === undefined) return;
    entry.pending ??= entry
      .release()
      .catch((error: unknown) => {
        this.errors.push(error);
        throw error;
      })
      .finally(() => this.held.delete(value));
    await entry.pending;
  }

  async drain(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.acquiring]);
    await Promise.allSettled([...this.held.keys()].map((value) => this.release(value)));
    if (this.errors.length > 0)
      throw new AggregateError(this.errors, 'worker lease cleanup failed');
  }
}

/** Tests and callers without a process lifecycle keep the existing claim path. */
export function acquireProcessLease<T extends object | null>(
  leases: ProcessLeases | undefined,
  claim: () => Promise<T>,
  releaseFor: (value: T) => (() => Promise<void>) | undefined,
): Promise<T> {
  return leases === undefined ? claim() : leases.acquire(claim, releaseFor);
}
