import type { ArticleListItem } from '@bantoozi/shared';

import { useReaderActions, useReasonBar } from '../reader/actions/provider.js';
import { nextRating, type DispatchOptions, type ReaderAction } from '../reader/actions/types.js';

export interface RateOptions {
  /** SHIFT + rate or a long press: the article is hidden as well (spec 09 §3.3). */
  hide?: boolean;
}

export interface ArticleActions {
  /** "Read original" was pressed: the article counts as read (spec 09 §3.6). */
  open(): void;
  /**
   * Rating again in the same direction un-rates (spec 09 §3.3). A dislike is held and opens the
   * reason bar; pressed again while held it is taken back, and a like replaces it.
   */
  rate(pressed: 1 | -1, options?: RateOptions): void;
  toggleBookmark(): void;
  /** Read becomes unread and unread becomes read. */
  toggleRead(): void;
  addLabel(labelId: string): void;
  removeLabel(labelId: string): void;
  retryCapture(): void;
}

/**
 * The reader's actions on one article, as the buttons of a row and of the detail send them. `item`
 * is the article as displayed, so a repeated press acts on what the reader sees; `snapshot` fences
 * them against the saved copy when that is what the reader is looking at.
 */
export function useArticleActions(
  item: ArticleListItem,
  snapshot?: DispatchOptions['snapshot'],
): ArticleActions {
  const store = useReaderActions();
  const reasonBar = useReasonBar();
  const options: DispatchOptions | undefined = snapshot === undefined ? undefined : { snapshot };
  const send = (action: ReaderAction): void => {
    store.dispatch(item, action, options);
  };

  return {
    open: () => send({ type: 'open' }),
    rate: (pressed, { hide = false }: RateOptions = {}) => {
      const held = reasonBar.heldFor(item.id);
      if (held !== null) {
        reasonBar.undo();
        if (pressed === -1) return;
      }
      const rating = nextRating(held === null ? item.rating : held.before, pressed);
      const action: ReaderAction = {
        type: 'rate',
        rating,
        ...(hide ? { hide: true } : {}),
        ...(item.analysis.requestId === null ? {} : { analysisRequestId: item.analysis.requestId }),
      };
      if (rating !== -1) {
        send(action);
        return;
      }
      const handle = store.dispatch(item, action, { ...options, hold: true });
      reasonBar.open({
        actionId: handle.id,
        articleId: item.id,
        title: item.title,
        before: item.rating,
      });
    },
    toggleBookmark: () =>
      send(
        item.bookmarkedAt === null
          ? {
              type: 'bookmark',
              ...(item.feed === null ? {} : { mediaPolicyFeedId: item.feed.id }),
            }
          : { type: 'unbookmark' },
      ),
    toggleRead: () => send(item.readAt === null ? { type: 'read' } : { type: 'unread' }),
    addLabel: (labelId) => send({ type: 'addLabel', labelId }),
    removeLabel: (labelId) => send({ type: 'removeLabel', labelId }),
    retryCapture: () => {
      if (item.bookmarkCapture !== null) {
        send({ type: 'retryCapture', captureGeneration: item.bookmarkCapture.generation });
      }
    },
  };
}
