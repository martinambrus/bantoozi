import type { ArticleListItem } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { Sheet } from '../../components/sheet.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { useAccountId } from '../../session/context.js';
import { formatRelativeTime } from '../article/format.js';
import { articleKeys } from '../article/query-keys.js';
import { useReaderActions, useUndoAction } from './actions/provider.js';
import type { RecentAction } from './actions/types.js';

/** Spec 09 §3.3: the API undoes an action for 10 minutes after it was acknowledged. */
const UNDO_WINDOW_MS = 10 * 60_000;
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
}

function Entry({ entry, row, now }: EntryProps) {
  const { t, i18n } = useTranslation('reader');
  const undo = useUndoAction();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const [undoing, setUndoing] = useState(false);
  const textId = useId();
  const when = new Date(entry.at).toISOString();
  const count = entry.articleIds.length;
  // Mark all read covers the view, and the ids hold only the loaded rows of it.
  const subject =
    entry.kind === 'markReadFilter' || count === 0
      ? null
      : count === 1 && row !== undefined
        ? row.title
        : t('recent.articles', { count });

  async function takeBack() {
    setUndoing(true);
    try {
      const result = await undo(entry.id);
      if (result.status === 'undone' || result.status === 'conflict') {
        void queryClient.invalidateQueries({
          queryKey:
            entry.kind === 'markReadFilter'
              ? articleKeys.all(accountId)
              : articleKeys.counts(accountId),
        });
      }
    } finally {
      setUndoing(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div id={textId} className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{t([`recent.kind.${entry.kind}`, 'recent.kind.other'])}</span>
        {subject === null ? null : (
          <span
            lang={count === 1 ? (row?.lang ?? undefined) : undefined}
            className="break-words text-sm"
          >
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

  if (entries.length === 0) {
    return <EmptyState title={t('recent.emptyTitle')} body={t('recent.emptyBody')} />;
  }
  return (
    <ul
      role="list"
      aria-label={t('recent.list')}
      className="divide-y divide-slate-200 dark:divide-slate-700"
    >
      {entries.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          row={entry.articleIds.length === 1 ? rows.get(entry.articleIds[0]!) : undefined}
          now={now}
        />
      ))}
    </ul>
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
