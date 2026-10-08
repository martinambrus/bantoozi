export type ToastTone = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastInput {
  /** Showing an id that is already on screen replaces that toast in place. */
  id?: string | undefined;
  message: string;
  tone: ToastTone;
  action?: ToastAction | undefined;
  /** Shown after `action`; a toast keeps at most MAX_TOAST_ACTIONS in all and drops the rest. */
  actions?: readonly ToastAction[] | undefined;
  /** Milliseconds on screen (default 5000); null keeps it until dismissed. */
  durationMs?: number | null | undefined;
}

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  /** The first of `actions`, for readers of the single-action shape. */
  action?: ToastAction | undefined;
  /** `action` first, then `actions`. */
  actions: readonly ToastAction[];
  durationMs: number | null;
}

export interface ToastStore {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly Toast[];
  /**
   * Starts, or carries on, the countdown of a toast on screen and returns the milliseconds it has
   * left, or null when it stays until dismissed. The time already spent is kept here, by id, so
   * whatever shows the toast next (the region moves between the page and a modal) does not start over.
   */
  resume: (id: string) => number | null;
  /** Stops the countdown and keeps the time that is left. */
  pause: (id: string) => void;
}

/** `left` is what remained when the countdown last started; `since` is when, or null while it is paused. */
interface Countdown {
  left: number | null;
  since: number | null;
}

export const DEFAULT_TOAST_DURATION_MS = 5000;
export const MAX_TOASTS = 3;
export const MAX_TOAST_ACTIONS = 3;

function actionsOf({ action, actions = [] }: ToastInput): readonly ToastAction[] {
  return (action === undefined ? actions : [action, ...actions]).slice(0, MAX_TOAST_ACTIONS);
}

/** Toasts as an external store: `useSyncExternalStore` friendly, with a snapshot that only changes on change. */
export function createToastStore(): ToastStore {
  let toasts: readonly Toast[] = [];
  let counter = 0;
  const listeners = new Set<() => void>();
  const countdowns = new Map<string, Countdown>();

  function set(next: readonly Toast[]) {
    toasts = next;
    for (const id of countdowns.keys()) {
      if (!next.some((toast) => toast.id === id)) countdowns.delete(id);
    }
    for (const listener of [...listeners]) listener();
  }

  return {
    show(input) {
      counter += 1;
      const actions = actionsOf(input);
      const toast: Toast = {
        id: input.id ?? `toast-${counter}`,
        message: input.message,
        tone: input.tone,
        action: actions[0],
        actions,
        durationMs: input.durationMs === undefined ? DEFAULT_TOAST_DURATION_MS : input.durationMs,
      };
      countdowns.set(toast.id, { left: toast.durationMs, since: null });
      set(
        toasts.some((existing) => existing.id === toast.id)
          ? toasts.map((existing) => (existing.id === toast.id ? toast : existing))
          : [...toasts, toast].slice(-MAX_TOASTS),
      );
      return toast.id;
    },
    dismiss(id) {
      if (toasts.some((toast) => toast.id === id)) set(toasts.filter((toast) => toast.id !== id));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => toasts,
    resume(id) {
      const countdown = countdowns.get(id);
      if (countdown === undefined || countdown.left === null) return null;
      countdown.since ??= Date.now();
      return Math.max(0, countdown.left - (Date.now() - countdown.since));
    },
    pause(id) {
      const countdown = countdowns.get(id);
      if (countdown === undefined || countdown.left === null || countdown.since === null) return;
      countdown.left = Math.max(0, countdown.left - (Date.now() - countdown.since));
      countdown.since = null;
    },
  };
}
