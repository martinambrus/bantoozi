import type { RatingReason } from '@bantoozi/shared';

import type { ReaderActions } from '../reader/actions/types.js';

/** Spec 09 §3.3: how long a dislike waits for its reason. */
export const REASON_BAR_MS = 5000;

/** A dislike that is held until its reason is picked, it is taken back or the time is up. */
export interface PendingDislike {
  /** The held action in the reader action store. */
  actionId: string;
  articleId: string;
  /** What the bar names the article by. */
  title: string;
  /** The rating the dislike replaced: a like pressed meanwhile rates from it. */
  before: 1 | -1 | null;
}

export interface ReasonBar {
  getSnapshot(): PendingDislike | null;
  subscribe(listener: () => void): () => void;
  /** The open dislike, when it is the one held for `articleId`. */
  heldFor(articleId: string): PendingDislike | null;
  /** Opens the bar for a held dislike; the one that was open is sent without a reason. */
  open(pending: PendingDislike): void;
  /** Sends the open dislike with `reason`. */
  pick(reason: RatingReason): void;
  /** Sends the open dislike without a reason, as when the time is up. */
  expire(): void;
  /** Takes the open dislike back: nothing is sent. */
  undo(): void;
  /** Stops the countdown while the pointer or the focus is in the bar, and goes on after it. */
  pause(paused: boolean): void;
  /** Closes the bar and leaves the held action as it is. */
  close(): void;
}

/**
 * The one reason bar of an account (spec 09 §3.3). It outlives the row that opened it, answers a
 * held dislike exactly once, and closes by itself when the store drops the held action.
 */
export function createReasonBar(store: ReaderActions): ReasonBar {
  const listeners = new Set<() => void>();
  let pending: PendingDislike | null = null;
  let paused = false;
  let remaining = REASON_BAR_MS;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function stopClock(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  }

  function startClock(): void {
    if (pending === null || paused || timer !== null) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      expire();
    }, remaining);
  }

  /** Closes the bar and returns the dislike it was open for. */
  function finish(): PendingDislike | null {
    const closing = pending;
    stopClock();
    pending = null;
    paused = false;
    remaining = REASON_BAR_MS;
    if (closing !== null) notify();
    return closing;
  }

  function expire(): void {
    const closing = finish();
    if (closing !== null) store.release(closing.actionId);
  }

  store.subscribe(() => {
    if (pending !== null && store.get(pending.actionId)?.status !== 'held') finish();
  });

  return {
    getSnapshot: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    heldFor: (articleId) => (pending?.articleId === articleId ? pending : null),
    open(next) {
      const previous = pending;
      stopClock();
      pending = next;
      remaining = REASON_BAR_MS;
      startClock();
      notify();
      if (previous !== null && previous.actionId !== next.actionId) {
        store.release(previous.actionId);
      }
    },
    pick(reason) {
      const closing = finish();
      if (closing !== null) store.release(closing.actionId, { reason });
    },
    expire,
    undo() {
      const closing = finish();
      if (closing !== null) store.cancel(closing.actionId);
    },
    pause(next) {
      if (paused === next) return;
      paused = next;
      if (next) stopClock();
      else startClock();
    },
    close() {
      finish();
    },
  };
}
