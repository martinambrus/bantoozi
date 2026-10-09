import type { ArticleListItem } from '@bantoozi/shared';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { Sheet } from '../../components/sheet.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { formatRelativeTime } from '../article/format.js';
import { useReaderActions, useUndoAction } from './actions/provider.js';
import { UNDO_WINDOW_MS, type RecentAction } from './actions/types.js';

function ratingWord(rating: 1 | -1 | null): 'like' | 'dislike' | 'none' {
  return rating === 1 ? 'like' : rating === -1 ? 'dislike' : 'none';
}
/** How often the times of the entries are worded again. */
const REFRESH_MS = 30_000;

/** The entries that can still be undone, newest first, and the time they are worded against. */
function useEntries(): { entries: readonly RecentAction[]; now: number } {
  const store = useReaderActions();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [ticks, tick] = useReducer((count: number) => count + 1, 0);
  const entries = store.recent();
  const oldest = entries.at(-1)?.at ?? null;

  // The store drops an entry that is ten minutes old when it is asked, not when it turns ten.
  useEffect(() => {
    if (oldest === null) return;
    const wait = Math.min(REFRESH_MS, oldest + UNDO_WINDOW_MS + 1 - Date.now());
    const timer = setTimeout(tick, Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [oldest, ticks]);

  return { entries, now: Date.now() };
}

interface EntryProps {
  entry: RecentAction;
  /** The loaded article the entry is about, if the list still has it. */
  row: ArticleListItem | undefined;
  now: number;
  /** Called once the Undo of the entry has been answered, whatever the answer was. */
  onAnswered: () => void;
}

function Entry({ entry, row, now, onAnswered }: EntryProps) {
  const { t, i18n } = useTranslation('reader');
  const undo = useUndoAction();
  const [undoing, setUndoing] = useState(false);
  const textId = useId();
  const when = new Date(entry.at).toISOString();
  const what =
    entry.rating === undefined
      ? t([`recent.kind.${entry.kind}`, 'recent.kind.other'])
      : t(`recent.rating.${ratingWord(entry.rating)}`);
  // A bulk action counts what the server changed; Mark all read covers rows that were never loaded.
  const count = entry.count ?? entry.articleIds.length;
  const titled = count === 1 && row !== undefined && entry.kind !== 'markReadFilter';
  const subject = count === 0 ? null : titled ? row.title : t('recent.articles', { count });

  async function takeBack() {
    setUndoing(true);
    try {
      await undo(entry.id);
    } finally {
      setUndoing(false);
      onAnswered();
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div id={textId} className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{what}</span>
        {subject === null ? null : (
          <span lang={titled ? (row.lang ?? undefined) : undefined} className="break-words text-sm">
            {subject}
          </span>
        )}
        <time dateTime={when} className="text-xs text-slate-600 dark:text-slate-300">
          {formatRelativeTime(when, now, i18n.language)}
        </time>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={undoing}
        aria-describedby={textId}
        onClick={() => void takeBack()}
      >
        {t('common:actions.undo')}
      </Button>
    </li>
  );
}

function RecentList({ items }: { items: readonly ArticleListItem[] }) {
  const { t } = useTranslation('reader');
  const { entries, now } = useEntries();
  const rows = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const root = useRef<HTMLDivElement>(null);
  const answered = useRef<number | null>(null);
  const [answers, answer] = useReducer((count: number) => count + 1, 0);

  // The entry that was taken back took its Undo button, and the focus on it, out of the list: the
  // focus goes to the Undo button that is now in its place, else to the sheet.
  useLayoutEffect(() => {
    const position = answered.current;
    if (position === null) return;
    answered.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('li button') ?? []);
    (buttons[Math.min(position, buttons.length - 1)] ?? root.current?.closest('dialog'))?.focus();
  }, [answers]);

  return (
    <div ref={root}>
      {entries.length === 0 ? (
        <EmptyState title={t('recent.emptyTitle')} body={t('recent.emptyBody')} />
      ) : (
        <ul
          role="list"
          aria-label={t('recent.list')}
          className="divide-y divide-slate-200 dark:divide-slate-700"
        >
          {entries.map((entry, position) => (
            <Entry
              key={entry.id}
              entry={entry}
              row={entry.articleIds.length === 1 ? rows.get(entry.articleIds[0]!) : undefined}
              now={now}
              onAnswered={() => {
                answered.current = position;
                answer();
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export interface RecentActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The articles of the view that are loaded; they give the entries their titles. */
  items: readonly ArticleListItem[];
}

/** What the reader did in the last 10 minutes, each with an Undo (spec 09 §3.3). */
export function RecentActionsSheet({ open, onClose, items }: RecentActionsSheetProps) {
  const { t } = useTranslation('reader');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('recent.title')}
      description={t('recent.description')}
    >
      <RecentList items={items} />
    </Sheet>
  );
}
