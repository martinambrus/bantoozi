import type { ArticleListItem } from '@bantoozi/shared';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ArticleRowProps } from '../article/article-row.js';
import { Button } from '../../components/button.js';
import { Checkbox } from '../../components/checkbox.js';
import { useReaderActions } from './actions/provider.js';
import { AnalyzePanel } from '../training/analyze-panel.js';
import { useArticleSelection } from '../training/selection.js';
import { useViewTitle } from './use-view-title.js';
import type { ReaderView } from './view.js';

type AnalysisStatus = ArticleListItem['analysis']['status'];

/** The articles with no request standing, which a person may ask to have analyzed (again). */
const SELECTABLE: ReadonlySet<AnalysisStatus> = new Set(['not_requested', 'failed', 'cancelled']);

export interface FeedTraining {
  /** The chosen titles and the button that sends them, above the rows; null while none is chosen. */
  panel: ReactNode;
  /** The checkbox that selects or deselects every loaded row; null where rows cannot be chosen. */
  selectAll: ReactNode;
  /** The checkbox of a row, for the rows that can be chosen. */
  selectionOf: (item: ArticleListItem) => ArticleRowProps['selection'];
}

/**
 * The panel is gone once the articles sent were all that was chosen or its last title is taken out,
 * so the focus goes to the title of the first of those articles that the list still has, else to
 * the list, and never falls to the page.
 */
function focusFirstListed(list: HTMLElement | null, articleIds: readonly string[]): void {
  const rows = Array.from(list?.children ?? []);
  for (const id of articleIds) {
    const row = rows.find(
      (child) => child instanceof HTMLElement && child.dataset['articleId'] === id,
    );
    const title = row?.querySelector<HTMLElement>('h3 button');
    if (title !== null && title !== undefined) {
      title.focus();
      return;
    }
  }
  list?.focus();
}

/** Like or dislike every selected article, one action each, then clear the selection. */
function BulkActions({
  items,
  onDone,
}: {
  items: readonly ArticleListItem[];
  onDone: (articleIds: readonly string[]) => void;
}) {
  const { t } = useTranslation('training');
  const store = useReaderActions();
  const count = items.length;

  // Like and Dislike set the rating: an article that already has it is left as it is.
  function rateAll(rating: 1 | -1) {
    for (const item of items) {
      if (store.view(item).rating === rating) continue;
      store.dispatch(item, {
        type: 'rate',
        rating,
        ...(item.analysis.requestId === null ? {} : { analysisRequestId: item.analysis.requestId }),
      });
    }
    onDone(items.map(({ id }) => id));
  }

  return (
    <>
      <Button aria-label={t('panel.likeAll', { count })} onClick={() => rateAll(1)}>
        {t('panel.like')}
      </Button>
      <Button aria-label={t('panel.dislikeAll', { count })} onClick={() => rateAll(-1)}>
        {t('panel.dislike')}
      </Button>
    </>
  );
}

/**
 * Choosing articles of a feed to have exactly those analyzed (spec 09 §3.2, spec 06 §10). Only the
 * feed view of a feed the person follows offers it, the app never chooses anything, and the choice
 * lasts as long as the view does. Only the chosen articles nobody is analyzing are ever sent. `listRef` is the list of rows the focus returns to.
 */
export function useFeedTraining(
  view: ReaderView,
  listRef: RefObject<HTMLElement | null>,
  rows: readonly ArticleListItem[],
): FeedTraining {
  const { t } = useTranslation('training');
  const { subscription } = useViewTitle(view);
  const selection = useArticleSelection(Infinity);
  // The first ones sent are the first ones in the list.
  const position = new Map(rows.map((row, index) => [row.id, index]));
  // The chosen articles as the list has them now, not as they were when they were ticked: their
  // analysis may have started since. One the list no longer holds is not chosen any more (see below).
  const current = new Map(rows.map((row) => [row.id, row]));
  const chosenNow = selection.items.map((item) => current.get(item.id) ?? item);
  const analyzable = chosenNow
    .filter((item) => SELECTABLE.has(item.analysis.status))
    .sort((a, b) => (position.get(a.id) ?? rows.length) - (position.get(b.id) ?? rows.length));
  const chosen = rows.filter((row) => selection.has(row.id)).length;
  const every = rows.length > 0 && chosen === rows.length;
  // A refusal can remove every chosen article; the panel stays to say so.
  const [refused, setRefused] = useState(false);
  // A list left with no rows shows neither the chosen articles nor a way to let go of them.
  const empty = rows.length === 0 && selection.items.length > 0;
  const { clear } = selection;
  useEffect(() => {
    if (empty) clear();
  }, [empty, clear]);

  // A selected article rated or hidden on its own (not by the bulk buttons, which take their own
  // articles out) leaves the selection, so a later bulk action cannot re-rate it.
  const store = useReaderActions();
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion);
  const seen = useRef(new Map<string, { rating: number | null; hidden: boolean }>());
  const { remove } = selection;
  const selectedItems = selection.items;
  // The selection as it is now, for an answer that comes after the render that sent the request.
  const latestItems = useRef(selectedItems);
  useEffect(() => {
    latestItems.current = selectedItems;
  });
  // A chosen article the rows no longer hold (rated or hidden on another device, dropped by a
  // reload, or on a page a refresh did not bring back) leaves the selection: it is not on the
  // screen, so it must not be rated or analyzed by a bulk action. A list that is merely replaced
  // by a placeholder holds the same rows, so nothing is missing then.
  const missing = selectedItems.filter((chosenItem) => !current.has(chosenItem.id));
  const missingKey = missing.map((chosenItem) => chosenItem.id).join(',');
  useEffect(() => {
    if (missingKey !== '') remove(missingKey.split(','));
  }, [missingKey, remove]);
  useEffect(() => {
    const known = seen.current;
    const ids = new Set(selectedItems.map((chosenItem) => chosenItem.id));
    for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
    const changed: string[] = [];
    for (const chosenItem of selectedItems) {
      const shown = store.view(current.get(chosenItem.id) ?? chosenItem);
      const now = { rating: shown.rating, hidden: shown.archivedAt !== null };
      const before = known.get(chosenItem.id);
      if (before === undefined) known.set(chosenItem.id, now);
      else if (before.rating !== now.rating || before.hidden !== now.hidden) {
        changed.push(chosenItem.id);
        known.delete(chosenItem.id);
      }
    }
    if (changed.length > 0) remove(changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- current is rebuilt every render
  }, [storeVersion, selectedItems, store, remove]);

  if (view.kind !== 'feed' || subscription === undefined) {
    return { panel: null, selectAll: null, selectionOf: () => undefined };
  }

  return {
    panel:
      selection.items.length > 0 || refused ? (
        <div className="rounded-xl border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <AnalyzePanel
            subscription={subscription}
            items={analyzable}
            selectedCount={selection.items.length}
            showAnalyze={analyzable.length > 0 || selection.items.length === 0}
            onDrop={(articleIds) => {
              setRefused(true);
              selection.remove(articleIds);
            }}
            listSelected={false}
            actions={
              <BulkActions
                items={chosenNow}
                onDone={(articleIds) => {
                  setRefused(false);
                  selection.remove(articleIds);
                }}
              />
            }
            returnFocus={(articleIds) => {
              focusFirstListed(listRef.current, articleIds);
            }}
            onSubmitted={(_requests, sentIds) => {
              setRefused(false);
              // The panel went while the request was on its way (the list dropped every article
              // sent): the focus it had fell to the page, so it returns to the list as well.
              const active = document.activeElement;
              const nothingElse = latestItems.current.every(({ id }) => sentIds.includes(id));
              if (nothingElse && (active === null || active === document.body)) {
                focusFirstListed(listRef.current, sentIds);
              }
              // An article chosen while the request was on its way stays chosen.
              selection.remove(sentIds);
            }}
          />
        </div>
      ) : null,
    selectAll:
      rows.length === 0 ? null : (
        <Checkbox
          label={t(every ? 'selectAll.deselect' : 'selectAll.select')}
          checked={every}
          indeterminate={chosen > 0 && !every}
          onChange={() => {
            setRefused(false);
            // Deselecting all also lets go of chosen articles a reload no longer lists.
            if (every) selection.clear();
            else selection.addAll(rows);
          }}
        />
      ),
    selectionOf: (item) => ({
      selected: selection.has(item.id),
      onChange: (selected) => {
        setRefused(false);
        selection.toggle(item, selected);
      },
    }),
  };
}
