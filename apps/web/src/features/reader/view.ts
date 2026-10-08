import type { ArticleCounts, ArticleViewLane, MarkReadLane } from '@bantoozi/shared';

import type { Lane, ScopedLane } from './lanes.js';

/**
 * What a reader route shows (spec 09 §2): a lane, or one feed, folder or label, narrowed to a lane
 * of it (`all` unless the reader chose another).
 */
export type ReaderView =
  | { kind: 'lane'; lane: Lane }
  | { kind: 'feed'; feedId: string; lane: ScopedLane }
  | { kind: 'folder'; name: string; lane: ScopedLane }
  | { kind: 'label'; labelId: string; lane: ScopedLane };

/** The feed, folder or label of a view, as the list, the counts and mark-read name it. */
export type ViewScope = { feedId?: string; folder?: string; labelId?: string };

export function scopeOf(view: ReaderView): ViewScope {
  switch (view.kind) {
    case 'lane':
      return {};
    case 'feed':
      return { feedId: view.feedId };
    case 'folder':
      return { folder: view.name };
    case 'label':
      return { labelId: view.labelId };
  }
}

/** The feed whose projection of an article is asked for, or the saved copy (spec 08 §5.2). */
export function detailScope(view: ReaderView): {
  sourceFeedId: string | undefined;
  saved: boolean;
} {
  return {
    sourceFeedId: view.kind === 'feed' ? view.feedId : undefined,
    saved: view.lane === 'bookmarks',
  };
}

/** Tells two views apart, whatever their names contain. */
export function viewKey(view: ReaderView): string {
  const { feedId, folder, labelId } = scopeOf(view);
  return JSON.stringify([view.lane, feedId ?? null, folder ?? null, labelId ?? null]);
}

/** The lanes whose rows the minimum tier filters (spec 08 §5.1). */
export function usesTier(lane: ArticleViewLane): boolean {
  return lane === 'for_you' || lane === 'maybe' || lane === 'all';
}

export function usesSort(lane: ArticleViewLane): boolean {
  return lane === 'for_you';
}

/** Bookmarks and Hidden list every article, read or not; the other views list the unread ones. */
export function listsUnread(lane: ArticleViewLane): boolean {
  return lane !== 'bookmarks' && lane !== 'hidden';
}

/** The lane a mark-all-read filter can name; null for the views that are not about unread articles. */
export function markReadLane(lane: ArticleViewLane): MarkReadLane | null {
  return lane === 'bookmarks' || lane === 'hidden' ? null : lane;
}

/** The number the counts hold for a lane; `all` counts every unread lane. */
export function countOf(counts: ArticleCounts, lane: ArticleViewLane): number {
  switch (lane) {
    case 'for_you':
      return counts.forYou;
    case 'maybe':
      return counts.maybe;
    case 'everything':
      return counts.everything;
    case 'new':
      return counts.new;
    case 'bookmarks':
      return counts.bookmarks;
    case 'hidden':
      return counts.hidden;
    case 'all':
      return counts.total;
  }
}
