type LockCallback = (lock: object | null) => unknown;

interface LockRequestOptions {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
  mode?: string;
}

interface Holder {
  /** Takes the lock from the request that holds it: that request's promise rejects. */
  revoke(): void;
}

interface Queued {
  grant(): void;
  abort(): void;
}

const abortError = () => new DOMException('The lock request was aborted.', 'AbortError');

/** A lock manager shared by the tabs of one test, as the browser shares it between tabs. */
export class FakeLocks {
  private readonly current = new Map<string, Holder>();
  private readonly waiting = new Map<string, Queued[]>();
  readonly granted: string[] = [];

  request(
    name: string,
    optionsOrCallback: LockRequestOptions | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const { signal } = options;
    if (signal?.aborted === true) return Promise.reject(abortError());
    const queue = this.waiting.get(name) ?? [];
    const free = !this.current.has(name) && queue.length === 0;
    if (options.ifAvailable === true && !free && options.steal !== true) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        let revoked = false;
        const holder: Holder = {
          revoke: () => {
            revoked = true;
            reject(abortError());
          },
        };
        this.current.set(name, holder);
        this.granted.push(name);
        Promise.resolve()
          .then(() => callback({ name, mode: 'exclusive' }))
          .then(
            (value) => {
              if (!revoked) resolve(value);
            },
            (error: unknown) => {
              if (!revoked) reject(error);
            },
          )
          .finally(() => {
            if (this.current.get(name) !== holder) return;
            this.current.delete(name);
            this.waiting.get(name)?.shift()?.grant();
          });
      };
      if (options.steal === true) {
        this.current.get(name)?.revoke();
        grant();
      } else if (free) {
        grant();
      } else {
        const entry: Queued = {
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
          },
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        this.waiting.set(name, [...queue, entry]);
      }
    });
  }

  get holding(): boolean {
    return this.current.size > 0;
  }
}

export function installLocks(locks: FakeLocks): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
}

export function removeLocks(): void {
  Reflect.deleteProperty(navigator, 'locks');
}
