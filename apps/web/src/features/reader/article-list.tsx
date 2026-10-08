import type { ArticleListItem } from '@bantoozi/shared';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { cx } from '../../components/cx.js';
import { errorMessage } from '../../components/error-message.js';
import { WarningIcon } from '../../components/icons.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { ArticleRow } from '../article/article-row.js';
import { useReaderActions } from './actions/provider.js';
import { HiddenCauses } from './hidden-causes.js';
import { useFeedTraining } from './training-selection.js';
import { isCursorRefused, type useArticleList } from './use-article-list.js';
import { listsUnread, type ReaderView } from './view.js';

/** Spec 09 §3.3: a rated item leaves an unread list after a 400 ms animation. */
export const EXIT_MS = 400;

const NONE: ReadonlySet<string> = new Set();

function without(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const rest = new Set(ids);
  rest.delete(id);
  return rest;
}

const isMarked = (item: ArticleListItem) => item.rating !== null || item.archivedAt !== null;

/**
 * Which rows to show in a list of unread articles: one that is rated or hidden leaves after the exit
 * animation, one that is only read stays until the list is loaded again (spec 09 §3.1, §3.3).
 */
function useExitingRows(
  items: readonly ArticleListItem[],
  firstPage: unknown,
  listRef: React.RefObject<HTMLUListElement | null>,
  enabled: boolean,
) {
  const store = useReaderActions();
  // Every change of what the rows show comes through the store.
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE);
  // The ids that left, for the page one they left from; loading it again lets them come back.
  const [left, setLeft] = useState<{ page: unknown; ids: ReadonlySet<string> }>({
    page: firstPage,
    ids: NONE,
  });
  const marked = useRef(new Map<string, boolean>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    for (const item of items) {
      const now = isMarked(store.view(item));
      const before = marked.current.get(item.id);
      marked.current.set(item.id, now);
      const timer = timers.current.get(item.id);
      if (now && before === false && timer === undefined) {
        setLeaving((current) => new Set(current).add(item.id));
        timers.current.set(
          item.id,
          setTimeout(() => {
            timers.current.delete(item.id);
            const row = Array.from(listRef.current?.children ?? []).find(
              (child) => child instanceof HTMLElement && child.dataset['articleId'] === item.id,
            );
            // The focus would fall to the page when its row goes: it goes to the next one instead.
            if (row?.contains(document.activeElement)) {
              const next = row.nextElementSibling ?? row.previousElementSibling;
              refocus.current = next instanceof HTMLElement ? next : null;
            }
            setLeft((current) => ({
              page: firstPage,
              ids: new Set(current.page === firstPage ? current.ids : NONE).add(item.id),
            }));
            setLeaving((current) => without(current, item.id));
          }, EXIT_MS),
        );
      } else if (!now && timer !== undefined) {
        clearTimeout(timer);
        timers.current.delete(item.id);
        setLeaving((current) => without(current, item.id));
      }
    }
  }, [enabled, items, store, listRef, firstPage, version]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const gone = left.page === firstPage ? left.ids : NONE;
  useLayoutEffect(() => {
    const next = refocus.current;
    if (next === null) return;
    refocus.current = null;
    next.querySelector<HTMLElement>('h3 button')?.focus();
  }, [gone]);

  // A row that left comes back if its rating was taken back or did not go through.
  const visible = enabled
    ? items.filter((item) => !gone.has(item.id) || !isMarked(store.view(item)))
    : items;
  return { visible, leaving };
}

type ReaderList = ReturnType<typeof useArticleList>;

export interface VisibleRows {
  /** The rows the list shows, those on their way out included. */
  visible: readonly ArticleListItem[];
  /** The ids of the rows that are on their way out. */
  leaving: ReadonlySet<string>;
  /** The rows the list shows and keeps. */
  staying: readonly ArticleListItem[];
  listRef: React.RefObject<HTMLUListElement | null>;
}

/** The rows the view shows, worked out beside the page so that the header counts the same ones. */
export function useVisibleRows(view: ReaderView, list: ReaderList): VisibleRows {
  const listRef = useRef<HTMLUListElement>(null);
  const { visible, leaving } = useExitingRows(
    list.items,
    list.query.data?.pages[0],
    listRef,
    listsUnread(view.lane),
  );
  return { visible, leaving, staying: visible.filter((item) => !leaving.has(item.id)), listRef };
}

/** Calls `onReach` when the element the returned ref is put on comes near the viewport. */
function useSentinel(enabled: boolean, onReach: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onReach);
  useEffect(() => {
    latest.current = onReach;
  });
  useEffect(() => {
    const target = ref.current;
    if (!enabled || target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);
  return ref;
}

const EMPTY_STATES = {
  for_you: 'forYou',
  maybe: 'maybe',
  everything: 'everything',
  new: 'new',
  bookmarks: 'bookmarks',
  hidden: 'hidden',
} as const;

function EmptyView({ view }: { view: ReaderView }) {
  const { t } = useTranslation('reader');
  const key = view.kind === 'lane' ? EMPTY_STATES[view.lane] : 'scoped';
  return <EmptyState title={t(`empty.${key}.title`)} body={t(`empty.${key}.body`)} />;
}

export interface ArticleListProps {
  view: ReaderView;
  list: ReaderList;
  rows: VisibleRows;
  expandedId: string | null;
  onToggle: (item: ArticleListItem) => void;
  /** Opens the "Why this?" drawer for the article of a row. */
  onWhyThis: (item: ArticleListItem) => void;
  simple: boolean;
}

/** The rows of the view with the means to load more of them (spec 09 §3.1). */
export function ArticleList({
  view,
  list,
  rows: { visible, leaving, listRef },
  expandedId,
  onToggle,
  onWhyThis,
  simple,
}: ArticleListProps) {
  const { t } = useTranslation('reader');
  const { query, canLoadMore, loadMore, reload } = list;
  const training = useFeedTraining(view);
  const sentinel = useSentinel(canLoadMore, () => void loadMore());
  const failed = query.isError && query.data !== undefined && !isCursorRefused(query.error);

  return (
    <QueryState
      query={{
        data: query.data === undefined ? undefined : visible,
        error: query.error,
        status: query.status,
        refetch: () => void reload(),
      }}
      isEmpty={(rows) => rows.length === 0 && !canLoadMore}
      empty={<EmptyView view={view} />}
    >
      {(rows) => (
        <div className="flex flex-col gap-3">
          {training.panel}
          <ul ref={listRef} role="list" className="flex flex-col gap-3">
            {rows.map((item) => (
              <li
                key={item.id}
                data-article-id={item.id}
                className={cx(
                  'rounded-xl transition-all duration-400 motion-reduce:transition-none',
                  item.id === expandedId && 'ring-2 ring-indigo-600 dark:ring-indigo-300',
                  leaving.has(item.id) && 'pointer-events-none -translate-x-4 opacity-0',
                )}
              >
                <ArticleRow
                  item={item}
                  expanded={item.id === expandedId}
                  onToggleExpand={() => onToggle(item)}
                  onWhyThis={() => onWhyThis(item)}
                  simple={simple}
                  selection={training.selectionOf(item)}
                />
                {view.lane === 'hidden' ? <HiddenCauses item={item} /> : null}
              </li>
            ))}
          </ul>
          {failed ? (
            <p
              role="alert"
              className="flex items-start gap-2 text-sm font-medium text-red-700 dark:text-red-300"
            >
              <WarningIcon className="mt-0.5 size-4" />
              {errorMessage(t, query.error)}
            </p>
          ) : null}
          {canLoadMore ? (
            <>
              <div ref={sentinel} aria-hidden="true" className="h-px" />
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  loading={query.isFetchingNextPage}
                  onClick={() => void loadMore()}
                >
                  {t('list.loadMore')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </QueryState>
  );
}
