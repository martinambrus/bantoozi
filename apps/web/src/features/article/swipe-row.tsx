import { DEFAULT_USER_PREFERENCES, type ArticleListItem, type Me } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { meKey } from '../../api/query-keys.js';
import { cx } from '../../components/cx.js';
import { BookmarkIcon, CheckIcon, ThumbsDownIcon, ThumbsUpIcon } from '../../components/icons.js';
import type { ArticleActions } from './use-article-actions.js';
import { useSwipe, type Drag, type SwipeAction } from './use-swipe.js';

// Each action has its own icon and name, so the colour never carries the meaning alone.
const FEEDBACK: Record<SwipeAction, { Icon: typeof CheckIcon; tone: string }> = {
  like: { Icon: ThumbsUpIcon, tone: 'bg-emerald-700' },
  dislike: { Icon: ThumbsDownIcon, tone: 'bg-red-700' },
  bookmark: { Icon: BookmarkIcon, tone: 'bg-indigo-700' },
  read: { Icon: CheckIcon, tone: 'bg-slate-700' },
};

/** What the swipe will do to the article as it is shown now: setting a rating again removes it. */
function nameOf(t: TFunction, action: SwipeAction, item: ArticleListItem): string {
  switch (action) {
    case 'like':
      return t(item.rating === 1 ? 'swipe.removeLike' : 'swipe.like');
    case 'dislike':
      return t(item.rating === -1 ? 'swipe.removeDislike' : 'swipe.dislike');
    case 'bookmark':
      return t(item.bookmarkedAt === null ? 'swipe.bookmark' : 'swipe.removeBookmark');
    case 'read':
      return t(item.readAt === null ? 'swipe.markRead' : 'swipe.markUnread');
  }
}

/** The colour, icon and name that the content uncovers; the buttons of the row do the same for assistive technology. */
function Feedback({ drag, item }: { drag: Drag; item: ArticleListItem }) {
  const { t } = useTranslation('article');
  const { Icon, tone } = FEEDBACK[drag.action];
  return (
    <div
      aria-hidden="true"
      data-swipe-action={drag.action}
      data-armed={drag.armed ? 'true' : undefined}
      className={cx(
        'absolute inset-0 flex items-center gap-2 px-4 text-sm text-white',
        tone,
        drag.side === 'right' ? 'justify-start' : 'justify-end',
        drag.armed ? 'font-bold' : 'font-medium',
      )}
    >
      <Icon className={cx('size-6', drag.armed && 'scale-125')} />
      <span>{nameOf(t, drag.action, item)}</span>
    </div>
  );
}

export interface SwipeRowProps {
  /** The article as displayed. */
  item: ArticleListItem;
  actions: ArticleActions;
  /** The id of the element that names the article. */
  labelledBy: string;
  children: ReactNode;
}

/**
 * The card of an article in a list, which a thumb or a pen can swipe (spec 09 §3.3). The
 * preferences are read when a swipe starts, so a change made while the page is open counts.
 */
export function SwipeRow({ item, actions, labelledBy, children }: SwipeRowProps) {
  const queryClient = useQueryClient();
  const { drag, settling, handlers } = useSwipe({
    resolve: (side) => {
      const { swipe } =
        queryClient.getQueryData<Me | null>(meKey())?.preferences ?? DEFAULT_USER_PREFERENCES;
      const chosen = swipe[side];
      return chosen === 'none' ? null : chosen;
    },
    run: (action) => {
      switch (action) {
        case 'like':
          actions.rate(1);
          break;
        case 'dislike':
          actions.rate(-1);
          break;
        case 'bookmark':
          actions.toggleBookmark();
          break;
        case 'read':
          actions.toggleRead();
          break;
      }
    },
  });

  return (
    <article
      aria-labelledby={labelledBy}
      {...handlers}
      className="relative touch-pan-y touch-pinch-zoom overflow-hidden rounded-xl border border-slate-300 dark:border-slate-700"
    >
      {drag?.shows === true ? <Feedback drag={drag} item={item} /> : null}
      <div
        data-swipe-content
        style={
          drag === null || drag.offset === 0
            ? undefined
            : { transform: `translateX(${drag.offset}px)` }
        }
        className={cx(
          'relative flex gap-3 bg-white p-3 text-slate-900 dark:bg-slate-900 dark:text-slate-100',
          settling && 'transition-transform duration-200 ease-out motion-reduce:transition-none',
        )}
      >
        {children}
      </div>
    </article>
  );
}
