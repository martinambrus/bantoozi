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

/** One reason can apply to a whole selection of held dislikes. */
export interface PendingReasons extends PendingDislike {
  additional?: readonly PendingDislike[];
}

const dislikesOf = (pending: PendingReasons | null): readonly PendingDislike[] =>
  pending === null ? [] : [pending, ...(pending.additional ?? [])];

export interface ReasonBar {
  getSnapshot(): PendingReasons | null;
  subscribe(listener: () => void): () => void;
  /** The open dislike, when it is the one held for `articleId`. */
  heldFor(articleId: string): PendingDislike | null;
  /** Opens the bar for held dislikes; previous ones are sent without a reason. */
  open(pending: PendingReasons): void;
  /** Sends every open dislike with `reason`. */
  pick(reason: RatingReason): void;
  /** Sends every open dislike without a reason, as when the time is up. */
  expire(): void;
  /** Takes all open dislikes back, or just `articleId`: nothing is sent for them. */
  undo(articleId?: string): void;
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
  let pending: PendingReasons | null = null;
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
  function finish(): PendingReasons | null {
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
    for (const dislike of dislikesOf(closing)) store.release(dislike.actionId);
  }

  /** Keep the remaining articles without restarting their countdown. */
  function retain(dislikes: readonly PendingDislike[]): void {
    const [first, ...additional] = dislikes;
    if (first === undefined) {
      finish();
      return;
    }
    pending = {
      actionId: first.actionId,
      articleId: first.articleId,
      title: first.title,
      before: first.before,
      ...(additional.length === 0 ? {} : { additional }),
    };
    notify();
  }

  store.subscribe(() => {
    const dislikes = dislikesOf(pending);
    const held = dislikes.filter((dislike) => store.get(dislike.actionId)?.status === 'held');
    if (held.length !== dislikes.length) retain(held);
  });

  return {
    getSnapshot: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    heldFor: (articleId) => dislikesOf(pending).find((d) => d.articleId === articleId) ?? null,
    open(next) {
      const previous = pending;
      stopClock();
      pending = next;
      remaining = REASON_BAR_MS;
      startClock();
      notify();
      const kept = new Set(dislikesOf(next).map((d) => d.actionId));
      for (const dislike of dislikesOf(previous)) {
        if (!kept.has(dislike.actionId)) store.release(dislike.actionId);
      }
    },
    pick(reason) {
      const closing = finish();
      for (const dislike of dislikesOf(closing)) store.release(dislike.actionId, { reason });
    },
    expire,
    undo(articleId) {
      if (articleId !== undefined) {
        const dislikes = dislikesOf(pending);
        const target = dislikes.find((d) => d.articleId === articleId);
        if (target === undefined) return;
        retain(dislikes.filter((d) => d !== target));
        store.cancel(target.actionId);
        return;
      }
      const closing = finish();
      for (const dislike of dislikesOf(closing)) store.cancel(dislike.actionId);
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
