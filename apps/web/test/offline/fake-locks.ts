type LockCallback = (lock: object | null) => unknown;

/** A lock manager shared by the tabs of one test, as the browser shares it between tabs. */
export class FakeLocks {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();
  readonly granted: string[] = [];

  request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean; mode?: string } | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const queue = this.waiting.get(name) ?? [];
    const free = !this.held.has(name) && queue.length === 0;
    if (options.ifAvailable === true && !free) {
      return Promise.resolve().then(() => callback(null));
    }
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        this.held.add(name);
        this.granted.push(name);
        Promise.resolve()
          .then(() => callback({ name, mode: 'exclusive' }))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            this.waiting.get(name)?.shift()?.();
          });
      };
      if (free) {
        this.held.add(name);
        grant();
      } else {
        this.waiting.set(name, [...queue, grant]);
      }
    });
  }

  get holding(): boolean {
    return this.held.size > 0;
  }
}

export function installLocks(locks: FakeLocks): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
}

export function removeLocks(): void {
  Reflect.deleteProperty(navigator, 'locks');
}
