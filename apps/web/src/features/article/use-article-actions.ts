import type { ArticleListItem } from '@bantoozi/shared';

import { useReaderActions } from '../reader/actions/provider.js';
import { nextRating, type DispatchOptions, type ReaderAction } from '../reader/actions/types.js';

export interface ArticleActions {
  /** "Read original" was pressed: the article counts as read (spec 09 §3.6). */
  open(): void;
  /** Rating again in the same direction un-rates (spec 09 §3.3). */
  rate(pressed: 1 | -1): void;
  toggleBookmark(): void;
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
  const options: DispatchOptions | undefined = snapshot === undefined ? undefined : { snapshot };
  const send = (action: ReaderAction): void => {
    store.dispatch(item, action, options);
  };

  return {
    open: () => send({ type: 'open' }),
    rate: (pressed) =>
      send({
        type: 'rate',
        rating: nextRating(item.rating, pressed),
        ...(item.analysis.requestId === null ? {} : { analysisRequestId: item.analysis.requestId }),
      }),
    toggleBookmark: () =>
      send(
        item.bookmarkedAt === null
          ? {
              type: 'bookmark',
              ...(item.feed === null ? {} : { mediaPolicyFeedId: item.feed.id }),
            }
          : { type: 'unbookmark' },
      ),
    addLabel: (labelId) => send({ type: 'addLabel', labelId }),
    removeLabel: (labelId) => send({ type: 'removeLabel', labelId }),
    retryCapture: () => {
      if (item.bookmarkCapture !== null) {
        send({ type: 'retryCapture', captureGeneration: item.bookmarkCapture.generation });
      }
    },
  };
}
