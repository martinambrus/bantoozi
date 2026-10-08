import type { ArticleListItem } from '@bantoozi/shared';

import type { ReaderActions } from '../reader/actions/types.js';

/** Spec 08 §5.3: the most a dwell report counts for. */
const MAX_DWELL_MS = 1_800_000;

/**
 * "Read original" opens the original in front at once, so a page that goes hidden later than this
 * after the press was not hidden by it, and the time away is not the time spent on the article.
 */
const LEAVE_WINDOW_MS = 10_000;

export interface ReturnTracker {
  /** "Read original" was just pressed for this article. */
  track(item: ArticleListItem): void;
  /** Forgets the article without reporting. */
  clear(): void;
}

export interface ReturnTrackerOptions {
  store: Pick<ReaderActions, 'dispatch'>;
  /** `preferences.implicitFeedback`, read when the reader is back. */
  implicitFeedback: () => boolean;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
}

interface Pending {
  readonly item: ArticleListItem;
  readonly openedAt: number;
  hiddenAt: number | null;
}

/**
 * Reports how long the reader was away after "Read original" (spec 09 §3.6): one dwell, sent when
 * the page is visible again, only with implicit feedback on, and only when the leave can be told
 * from an unrelated tab switch. It outlives the article's detail, because the reader may close it
 * while reading the original.
 */
export function createReturnTracker(options: ReturnTrackerOptions): ReturnTracker {
  const now = options.now ?? (() => Date.now());
  let pending: Pending | null = null;
  let listening = false;

  function onVisibilityChange(): void {
    const entry = pending;
    if (entry === null) return;
    if (document.visibilityState === 'hidden') {
      if (entry.hiddenAt !== null) return;
      if (now() - entry.openedAt > LEAVE_WINDOW_MS) clear();
      else entry.hiddenAt = now();
      return;
    }
    if (entry.hiddenAt === null) return;
    const awayMs = now() - entry.hiddenAt;
    clear();
    if (!options.implicitFeedback()) return;
    const ms = Math.min(Math.max(0, awayMs), MAX_DWELL_MS);
    options.store.dispatch(entry.item, { type: 'dwell', ms });
  }

  function clear(): void {
    pending = null;
    if (listening) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      listening = false;
    }
  }

  return {
    track(item) {
      pending = { item, openedAt: now(), hiddenAt: null };
      if (!listening) {
        document.addEventListener('visibilitychange', onVisibilityChange);
        listening = true;
      }
    },
    clear,
  };
}
