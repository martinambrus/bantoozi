import type { ArticleListItem } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/icon-button.js';
import { CloseIcon } from '../../components/icons.js';
import { Sheet } from '../../components/sheet.js';
import { ArticleDetail } from '../article/article-detail.js';
import { detailScope, type ReaderView } from './view.js';

export interface DetailPaneProps {
  view: ReaderView;
  /** The expanded article; none leaves the pane empty. */
  item: ArticleListItem | null;
  /** A wide screen shows the article beside the list, a narrow one in a sheet over it. */
  desktop: boolean;
  onClose: () => void;
  /** Opens the "Why this?" drawer for the article. */
  onWhyThis: (item: ArticleListItem) => void;
}

function DetailOfView({
  view,
  item,
  onWhyThis,
}: Pick<DetailPaneProps, 'view' | 'onWhyThis'> & { item: ArticleListItem }) {
  const { sourceFeedId, saved } = detailScope(view);
  return (
    <ArticleDetail
      item={item}
      sourceFeedId={sourceFeedId}
      saved={saved}
      onWhyThis={() => onWhyThis(item)}
    />
  );
}

/** The expanded article of the list (spec 09 §3.1): a pane beside it, or a sheet from the bottom. */
export function DetailPane({ view, item, desktop, onClose, onWhyThis }: DetailPaneProps) {
  const { t } = useTranslation('reader');

  if (!desktop) {
    return (
      <Sheet open={item !== null} onClose={onClose} title={item?.title ?? ''} side="bottom">
        {item === null ? null : <DetailOfView view={view} item={item} onWhyThis={onWhyThis} />}
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={t('pane.label')}
      className="sticky top-16 flex max-h-[calc(100dvh-5rem)] flex-col gap-4 self-start overflow-y-auto rounded-xl border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      {item === null ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('pane.empty')}</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <h2 lang={item.lang ?? undefined} className="min-w-0 break-words text-lg font-semibold">
              {item.title}
            </h2>
            <IconButton label={t('common:actions.close')} onClick={onClose} className="-me-2 -mt-2">
              <CloseIcon />
            </IconButton>
          </div>
          <DetailOfView view={view} item={item} onWhyThis={onWhyThis} />
        </>
      )}
    </aside>
  );
}
