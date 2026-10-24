import type { LearningHistoryItem } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { FOCUS_RING, cx } from '../../components/cx.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import { NO_VALUE, formatQuality, readoutOf } from '../learning/history-model.js';

const HEAD = 'whitespace-nowrap px-3 py-2 text-start font-medium';
const CELL = 'whitespace-nowrap px-3 py-2 tabular-nums';

/** Every update, newest first: the same numbers as the chart, for reading and for screen readers. */
export function HistoryTable({ items }: { items: readonly LearningHistoryItem[] }) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const count = new Intl.NumberFormat(i18n.language);
  const columns = [
    'date',
    'update',
    'ratings',
    'quality',
    'interestsAlone',
    'switchedOn',
    'reason',
  ] as const;
  return (
    // A table wider than a phone scrolls inside this region, which the keyboard can reach.
    <div
      role="region"
      aria-label={t('learning.history.table.caption')}
      tabIndex={0}
      className={cx('overflow-x-auto', FOCUS_RING)}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">{t('learning.history.table.caption')}</caption>
        <thead className="border-b border-slate-300 dark:border-slate-600">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={HEAD}>
                {t(`learning.history.table.columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {items
            .map((item, index) => ({ item, index }))
            .reverse()
            .map(({ item, index }) => {
              const row = readoutOf(item);
              return (
                <tr key={index}>
                  <td className={CELL}>{formatDate(row.at, i18n.language, me.timezone)}</td>
                  <td className={CELL}>{t(`learning.history.series.${row.kind}`)}</td>
                  <td className={CELL}>{count.format(row.n)}</td>
                  <td className={CELL}>{formatQuality(row.quality, i18n.language)}</td>
                  <td className={CELL}>{formatQuality(row.interestsAlone, i18n.language)}</td>
                  <td className={CELL}>
                    {row.switchedOn === null
                      ? NO_VALUE
                      : t(row.switchedOn ? 'learning.history.yes' : 'learning.history.no')}
                  </td>
                  <td className="px-3 py-2">
                    {item.reason === null
                      ? NO_VALUE
                      : item.reason
                          .split(',')
                          .map((reason) =>
                            t(`learning.history.reasons.${reason}`, {
                              defaultValue: t('learning.history.reasons.unknown'),
                            }),
                          )
                          .join('; ')}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
