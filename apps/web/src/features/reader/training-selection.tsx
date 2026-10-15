import type { ArticleListItem } from '@bantoozi/shared';
import { useState, type ReactNode, type RefObject } from 'react';
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
  // analysis may have started since. One the list no longer holds keeps the way it was chosen.
  const current = new Map(rows.map((row) => [row.id, row]));
  const chosenNow = selection.items.map((item) => current.get(item.id) ?? item);
  const analyzable = chosenNow
    .filter((item) => SELECTABLE.has(item.analysis.status))
    .sort((a, b) => (position.get(a.id) ?? rows.length) - (position.get(b.id) ?? rows.length));
  const chosen = rows.filter((row) => selection.has(row.id)).length;
  const every = rows.length > 0 && chosen === rows.length;
  // A refusal can remove every chosen article; the panel stays to say so.
  const [refused, setRefused] = useState(false);

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
