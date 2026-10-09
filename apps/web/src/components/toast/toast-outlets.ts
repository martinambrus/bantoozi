export interface ToastOutlets {
  /** Offers `outlet` as a home for the toast region until the returned function is called. */
  register: (outlet: HTMLElement) => () => void;
  subscribe: (listener: () => void) => () => void;
  /** The outlet registered last and not yet released, or null while the region stays in the page. */
  getSnapshot: () => HTMLElement | null;
  /** Notes the toast control that has the focus now, for the toast that replaces it in a new outlet. */
  holdFocus: () => void;
  /** The control, by position in the toast, that `holdFocus` noted for toast `id`; given out once. */
  takeFocus: (id: string) => number | null;
  /** Forgets a noted control that no toast took. */
  dropFocus: () => void;
}

/** The controls of one toast, in the order the focus visits them. */
export function toastControls(toast: Element): HTMLButtonElement[] {
  return Array.from(toast.querySelectorAll('button'));
}

function focusedToastControl(): { id: string; control: number } | null {
  const active = document.activeElement;
  const toast = active?.closest<HTMLElement>('[data-toast-id]') ?? null;
  const id = toast?.dataset.toastId ?? null;
  if (toast === null || id === null) return null;
  const control = toastControls(toast).findIndex((button) => button === active);
  return control < 0 ? null : { id, control };
}

/** The outlets of the open modals, as an external store like the toasts: the latest one wins. */
export function createToastOutlets(): ToastOutlets {
  let entries: readonly { outlet: HTMLElement }[] = [];
  let held: { id: string; control: number } | null = null;
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
    holdFocus() {
      held = focusedToastControl();
    },
    takeFocus(id) {
      if (held === null || held.id !== id) return null;
      const { control } = held;
      held = null;
      return control;
    },
    dropFocus() {
      held = null;
    },
  };
}
