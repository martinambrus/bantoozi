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
import { SavedNotice } from '../offline/saved-notice.js';
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

const isRatedOrHidden = (item: ArticleListItem) => item.rating !== null || item.archivedAt !== null;
const isHidden = (item: ArticleListItem) => item.archivedAt !== null;

/** A row the reader read in this view that the list no longer returns, and the row it came after. */
interface KeptRow {
  item: ArticleListItem;
  after: string | null;
}

interface Membership {
  items: readonly ArticleListItem[];
  generation: number;
  /** The rows the page returns with the kept ones put back where they were. */
  merged: readonly ArticleListItem[];
  kept: ReadonlyMap<string, KeptRow>;
}

const NO_KEPT: ReadonlyMap<string, KeptRow> = new Map();

function mergeKept(
  items: readonly ArticleListItem[],
  kept: ReadonlyMap<string, KeptRow>,
): readonly ArticleListItem[] {
  if (kept.size === 0) return items;
  const after = new Map<string | null, ArticleListItem[]>();
  for (const row of kept.values()) {
    after.set(row.after, [...(after.get(row.after) ?? []), row.item]);
  }
  const out: ArticleListItem[] = [];
  const put = (id: string | null) => {
    for (const row of after.get(id) ?? []) {
      out.push(row);
      put(row.id);
    }
  };
  put(null);
  for (const row of items) {
    out.push(row);
    put(row.id);
  }
  return out;
}

/**
 * The rows of a list of unread articles: the page's, and those the reader read in this view that a
 * reload no longer returns, which stay where they were until the list is loaded on request
 * (`generation` changes) or the view is left.
 */
function useKeptRows(
  items: readonly ArticleListItem[],
  generation: number,
  enabled: boolean,
  isMarked: (item: ArticleListItem) => boolean,
): readonly ArticleListItem[] {
  const store = useReaderActions();
  const [state, setState] = useState<Membership>({
    items,
    generation,
    merged: items,
    kept: NO_KEPT,
  });
  if (!enabled) return items;
  if (state.items === items && state.generation === generation) return state.merged;

  let next: Membership;
  if (state.generation !== generation) {
    next = { items, generation, merged: items, kept: NO_KEPT };
  } else {
    const present = new Set(items.map((row) => row.id));
    const kept = new Map<string, KeptRow>();
    let previous: string | null = null;
    for (const row of state.merged) {
      if (present.has(row.id)) {
        previous = row.id;
        continue;
      }
      const shown = store.view(row);
      if (state.kept.has(row.id) || (shown.readAt !== null && !isMarked(shown))) {
        kept.set(row.id, { item: row, after: previous });
        previous = row.id;
      }
    }
    next = { items, generation, merged: mergeKept(items, kept), kept };
  }
  setState(next);
  return next.merged;
}

/**
 * Which rows to show in a list of unread articles: one that is rated or hidden leaves after the exit
 * animation and stays gone while it is still rated or hidden, one that is only read stays until the
 * list is loaded on request (spec 09 §3.1, §3.3). With "Show read" only a hidden one leaves (D-234).
 */
function useExitingRows(
  items: readonly ArticleListItem[],
  generation: number,
  listRef: React.RefObject<HTMLUListElement | null>,
  enabled: boolean,
  isMarked: (item: ArticleListItem) => boolean,
) {
  const store = useReaderActions();
  // Every change of what the rows show comes through the store.
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE);
  // The ids that left; loading the list on request lets them come back.
  const [gone, setGone] = useState<ReadonlySet<string>>(NONE);
  const marked = useRef(new Map<string, boolean>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refocus = useRef<HTMLElement | null>(null);
  const rows = useKeptRows(items, generation, enabled, isMarked);

  useEffect(() => {
    setGone(NONE);
  }, [generation]);

  useEffect(() => {
    if (!enabled) return;
    for (const item of rows) {
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
            // The focus would fall to the page with its row: it goes to the next row, else to main.
            if (row?.contains(document.activeElement)) {
              const next = row.nextElementSibling ?? row.previousElementSibling;
              refocus.current = next instanceof HTMLElement ? next : null;
              if (refocus.current === null) {
                document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
              }
            }
            setGone((current) => new Set(current).add(item.id));
            setLeaving((current) => without(current, item.id));
          }, EXIT_MS),
        );
      } else if (!now && timer !== undefined) {
        clearTimeout(timer);
        timers.current.delete(item.id);
        setLeaving((current) => without(current, item.id));
      } else if (!now && before === true) {
        // It left and is back (Undo): forgotten as gone, so the next rating makes it leave again.
        setGone((current) => (current.has(item.id) ? without(current, item.id) : current));
      }
    }
    // The ids that no page holds any more need no mark.
    const present = new Set(rows.map((row) => row.id));
    setGone((current) => {
      const rest = new Set(Array.from(current).filter((id) => present.has(id)));
      return rest.size === current.size ? current : rest;
    });
  }, [enabled, rows, store, listRef, version, isMarked]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    const next = refocus.current;
    if (next === null) return;
    refocus.current = null;
    next.querySelector<HTMLElement>('h3 button')?.focus();
  }, [gone]);

  // A row that left comes back if its rating was taken back or did not go through.
  const visible = enabled
    ? rows.filter((item) => !gone.has(item.id) || !isMarked(store.view(item)))
    : rows;
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

/**
 * The rows the view shows, worked out beside the page so that the header counts the same ones.
 * `generation` changes when the reader asks for the list to be loaded again.
 */
export function useVisibleRows(
  view: ReaderView,
  list: ReaderList,
  showRead: boolean,
  generation: number,
): VisibleRows {
  const listRef = useRef<HTMLUListElement>(null);
  const { visible, leaving } = useExitingRows(
    list.items,
    generation,
    listRef,
    listsUnread(view.lane),
    showRead ? isHidden : isRatedOrHidden,
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
  const { query, canLoadMore, loadMore, reload, saved, looking } = list;
  const training = useFeedTraining(view, listRef, visible);
  const sentinel = useSentinel(canLoadMore, () => void loadMore());
  const failed = query.isError && query.data !== undefined && !isCursorRefused(query.error);

  if (looking) return null;

  return (
    <QueryState
      query={{
        data: query.data === undefined && saved === null ? undefined : visible,
        error: query.error,
        status: query.status,
        refetch: () => void reload(),
      }}
      isEmpty={(rows) => rows.length === 0 && !canLoadMore}
      empty={<EmptyView view={view} />}
    >
      {(rows) => (
        <div className="flex flex-col gap-3">
          {saved === null ? null : <SavedNotice savedAt={saved.savedAt} />}
          {training.panel}
          {training.selectAll}
          <ul ref={listRef} role="list" tabIndex={-1} className="flex flex-col gap-3 outline-none">
            {rows.map((item) => (
              <li
                key={item.id}
                data-article-id={item.id}
                className={cx(
                  'rounded-xl transition-[transform,opacity] duration-400 motion-reduce:transition-none',
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
