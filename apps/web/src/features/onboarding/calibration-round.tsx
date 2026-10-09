import type { ArticleListItem } from '@bantoozi/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryState } from '../../components/states/query-state.js';
import { RateButtons } from '../article/article-buttons.js';
import { useObserveItems, useReaderActions, useReaderItem } from '../reader/actions/provider.js';
import { nextRating } from '../reader/actions/types.js';
import { useCalibrationRound } from './calibration-queries.js';

function RoundRow({ item }: { item: ArticleListItem }) {
  const shown = useReaderItem(item);
  const actions = useReaderActions();
  const titleId = useId();

  function rate(pressed: 1 | -1) {
    actions.dispatch(shown, {
      type: 'rate',
      rating: nextRating(shown.rating, pressed),
      selection: 'calibration',
      ...(shown.analysis.requestId === null ? {} : { analysisRequestId: shown.analysis.requestId }),
    });
  }

  return (
    <li
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-xl border border-slate-300 p-3 dark:border-slate-700"
    >
      {shown.feed === null ? null : (
        <p className="truncate text-xs font-medium text-slate-600 dark:text-slate-300">
          {shown.feed.title}
        </p>
      )}
      <p id={titleId} lang={shown.lang ?? undefined} className="break-words font-semibold">
        {shown.title}
      </p>
      {shown.excerpt === null || shown.excerpt === '' ? null : (
        <p
          lang={shown.lang ?? undefined}
          className="line-clamp-2 text-sm text-slate-700 dark:text-slate-200"
        >
          {shown.excerpt}
        </p>
      )}
      <div className="flex items-center gap-1">
        <RateButtons rating={shown.rating} onRate={rate} />
      </div>
    </li>
  );
}

function RoundList({ items }: { items: ArticleListItem[] }) {
  const { t } = useTranslation('onboarding');
  useObserveItems(items);
  return (
    <ul role="list" aria-label={t('calibrate.round.list')} className="flex flex-col gap-3">
      {items.map((item) => (
        <RoundRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

/**
 * A few of the articles that were analyzed, to like or dislike (spec 06 §10). The round only shows
 * what the API already offers; it never selects or analyzes anything.
 */
export function CalibrationRound() {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const round = useCalibrationRound(true);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('calibrate.round.title')}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('calibrate.round.lead')}</p>
      <QueryState
        query={round}
        isEmpty={(response) => response.items.length === 0}
        empty={<p className="text-sm font-medium">{t('calibrate.round.empty')}</p>}
      >
        {(response) => <RoundList items={response.items} />}
      </QueryState>
    </section>
  );
}
