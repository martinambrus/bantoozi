export interface ToastOutlets {
  /** Offers `outlet` as a home for the toast region until the returned function is called. */
  register: (outlet: HTMLElement) => () => void;
  subscribe: (listener: () => void) => () => void;
  /** The outlet registered last and not yet released, or null while the region stays in the page. */
  getSnapshot: () => HTMLElement | null;
}

/** The outlets of the open modals, as an external store like the toasts: the latest one wins. */
export function createToastOutlets(): ToastOutlets {
  let entries: readonly { outlet: HTMLElement }[] = [];
  const listeners = new Set<() => void>();

  function set(next: typeof entries) {
    entries = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    register(outlet) {
      const entry = { outlet };
      set([...entries, entry]);
      return () => {
        if (entries.includes(entry)) set(entries.filter((other) => other !== entry));
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries.at(-1)?.outlet ?? null,
  };
}
