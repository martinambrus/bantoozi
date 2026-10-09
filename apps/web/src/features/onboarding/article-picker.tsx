import type { ArticleListItem } from '@bantoozi/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../components/badge.js';
import { Checkbox } from '../../components/checkbox.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { formatRelativeTime } from '../article/format.js';
import type { ArticleSelection } from '../training/selection.js';
import { useFeedArticles } from './calibration-queries.js';

const STATUS_TONE: Record<
  Exclude<ArticleListItem['analysis']['status'], 'not_requested'>,
  BadgeTone
> = {
  pending: 'info',
  running: 'info',
  complete: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

function Option({ item, selection }: { item: ArticleListItem; selection: ArticleSelection }) {
  const { t, i18n } = useTranslation('onboarding');
  const { status } = item.analysis;
  const title = (
    <span lang={item.lang ?? undefined} className="break-words">
      {item.title}
    </span>
  );

  if (status !== 'not_requested') {
    return (
      <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        {title}
        <Badge tone={STATUS_TONE[status]}>{t(`calibrate.status.${status}`)}</Badge>
      </li>
    );
  }

  const when = formatRelativeTime(item.publishedAt ?? item.firstSeenAt, Date.now(), i18n.language);
  return (
    <li>
      <Checkbox
        label={title}
        hint={when === '' ? undefined : when}
        checked={selection.has(item.id)}
        onChange={(event) => {
          selection.toggle(item, event.target.checked);
        }}
      />
    </li>
  );
}

export interface ArticlePickerProps {
  feedId: string;
  selection: ArticleSelection;
}

/**
 * The titles a feed already has, to tick the ones to analyze. Only articles nobody has asked to
 * have analyzed can be ticked; the others say where their analysis stands.
 */
export function ArticlePicker({ feedId, selection }: ArticlePickerProps) {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const articles = useFeedArticles(feedId);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('calibrate.articles')}
      </h2>
      <QueryState
        query={articles}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState title={t('calibrate.noArticles')} body={t('calibrate.noArticlesBody')} />
        }
      >
        {(items) => (
          <ul
            role="list"
            aria-labelledby={headingId}
            className="divide-y divide-slate-200 dark:divide-slate-700"
          >
            {items.map((item) => (
              <Option key={item.id} item={item} selection={selection} />
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
