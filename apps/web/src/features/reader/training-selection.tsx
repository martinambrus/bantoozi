import type { ArticleListItem } from '@bantoozi/shared';
import { useState, type ReactNode } from 'react';

import type { ArticleRowProps } from '../article/article-row.js';
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
  /** The checkbox of a row, for the rows that can be chosen. */
  selectionOf: (item: ArticleListItem) => ArticleRowProps['selection'];
}

/**
 * Choosing articles of a feed to have exactly those analyzed (spec 09 §3.2, spec 06 §10). Only the
 * feed view of a feed the person follows offers it, the app never chooses anything, and the choice
 * lasts as long as the view does.
 */
export function useFeedTraining(view: ReaderView): FeedTraining {
  const { subscription } = useViewTitle(view);
  const selection = useArticleSelection();
  // A refusal can remove every chosen article; the panel stays to say so.
  const [refused, setRefused] = useState(false);

  if (view.kind !== 'feed' || subscription === undefined) {
    return { panel: null, selectionOf: () => undefined };
  }

  return {
    panel:
      selection.items.length > 0 || refused ? (
        <div className="rounded-xl border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <AnalyzePanel
            subscription={subscription}
            items={selection.items}
            onDrop={(articleIds) => {
              setRefused(true);
              selection.remove(articleIds);
            }}
            onSubmitted={() => {
              setRefused(false);
              selection.clear();
            }}
          />
        </div>
      ) : null,
    selectionOf: (item) =>
      SELECTABLE.has(item.analysis.status)
        ? {
            selected: selection.has(item.id),
            onChange: (selected) => {
              setRefused(false);
              selection.toggle(item, selected);
            },
          }
        : undefined,
  };
}
