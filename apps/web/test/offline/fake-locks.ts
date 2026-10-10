type LockCallback = (lock: object | null) => unknown;

interface LockRequestOptions {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
  mode?: string;
}

interface Holder {
  shared: boolean;
  /** Takes the lock from the request that holds it: that request's promise rejects. */
  revoke(): void;
}

interface Queued {
  shared: boolean;
  grant(): void;
  abort(): void;
}

const abortError = () => new DOMException('The lock request was aborted.', 'AbortError');

/** A lock manager shared by the tabs of one test, as the browser shares it between tabs. */
export class FakeLocks {
  private readonly current = new Map<string, Set<Holder>>();
  private readonly waiting = new Map<string, Queued[]>();
  readonly granted: string[] = [];

  private holders(name: string): Set<Holder> {
    return this.current.get(name) ?? new Set<Holder>();
  }

  private compatible(name: string, shared: boolean): boolean {
    const holders = this.holders(name);
    return holders.size === 0 || (shared && [...holders].every((holder) => holder.shared));
  }

  /** Grants the queue from its head, as long as the next request fits with the holders. */
  private drain(name: string): void {
    for (;;) {
      const head = this.waiting.get(name)?.[0];
      if (head === undefined || !this.compatible(name, head.shared)) return;
      this.waiting.get(name)!.shift();
      head.grant();
    }
  }

  request(
    name: string,
    optionsOrCallback: LockRequestOptions | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const { signal } = options;
    const shared = options.mode === 'shared';
    if (signal?.aborted === true) return Promise.reject(abortError());
    const queue = this.waiting.get(name) ?? [];
    const free = this.compatible(name, shared) && queue.length === 0;
    if (options.ifAvailable === true && !free && options.steal !== true) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        let revoked = false;
        const holder: Holder = {
          shared,
          revoke: () => {
            revoked = true;
            reject(abortError());
          },
        };
        const holders = this.holders(name);
        holders.add(holder);
        this.current.set(name, holders);
        this.granted.push(name);
        Promise.resolve()
          .then(() => callback({ name, mode: shared ? 'shared' : 'exclusive' }))
          .then(
            (value) => {
              if (!revoked) resolve(value);
            },
            (error: unknown) => {
              if (!revoked) reject(error);
            },
          )
          .finally(() => {
            if (!this.holders(name).delete(holder)) return;
            this.drain(name);
          });
      };
      if (options.steal === true) {
        for (const holder of [...this.holders(name)]) {
          holder.revoke();
          this.holders(name).delete(holder);
        }
        grant();
      } else if (free) {
        grant();
      } else {
        const entry: Queued = {
          shared,
          grant: () => {
            signal?.removeEventListener('abort', entry.abort);
            grant();
          },
          abort: () => {
            this.waiting.set(
              name,
              (this.waiting.get(name) ?? []).filter((queued) => queued !== entry),
            );
            reject(abortError());
            this.drain(name);
          },
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        this.waiting.set(name, [...queue, entry]);
      }
    });
  }

  get holding(): boolean {
    return [...this.current.values()].some((holders) => holders.size > 0);
  }
}

export function installLocks(locks: FakeLocks): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
}

export function removeLocks(): void {
  Reflect.deleteProperty(navigator, 'locks');
}
