import { useTranslation } from 'react-i18next';

import { VisuallyHidden } from '../../components/visually-hidden.js';

export interface NewArticlesBannerProps {
  count: number;
  onShow: () => void;
}

/** Says that the view has more articles than the list shows and loads them when it is pressed (D-243). */
export function NewArticlesBanner({ count, onShow }: NewArticlesBannerProps) {
  const { t } = useTranslation('reader');
  return (
    <>
      {/* Always mounted, so a screen reader hears the number when it appears; takes no room. */}
      <VisuallyHidden>
        <span role="status" aria-live="polite">
          {count > 0 ? t('list.showNew', { count }) : ''}
        </span>
      </VisuallyHidden>
      {count > 0 ? (
        <div className="flex justify-center">
          <button
            type="button"
            aria-label={t('list.showNew', { count })}
            onClick={onShow}
            className="inline-flex min-h-11 items-center rounded-full bg-indigo-700 px-4 text-sm font-medium text-white hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 dark:bg-indigo-300 dark:text-slate-900 dark:hover:bg-indigo-200"
          >
            {t('list.newArticles', { count })}
          </button>
        </div>
      ) : null}
    </>
  );
}
