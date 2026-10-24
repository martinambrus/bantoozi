import type { LearningHistory } from '@bantoozi/shared';
import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryState } from '../../components/states/query-state.js';
import { Button } from '../../components/button.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import {
  buildSeries,
  formatQuality,
  isRough,
  milestones as milestonesOf,
  readoutOf,
  yDomain,
} from '../learning/history-model.js';
import { useLearningHistory } from '../learning/use-learning-history.js';
import { HistoryTable } from './history-table.js';
import { LearningCurve, SeriesKey } from './learning-curve.js';
import { Hint } from './section.js';

function Curve({ history }: { history: LearningHistory }) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const titleId = useId();
  const summaryId = useId();
  const sliderId = useId();
  const tableId = useId();
  const [picked, setPicked] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const { items, truncated } = history;
  const lastIndex = items.length - 1;
  const active = Math.min(picked ?? lastIndex, lastIndex);
  const date = (value: string) => formatDate(value, i18n.language, me.timezone);

  const series = buildSeries(items);
  const stones = milestonesOf(items);
  const first = items[0];
  const last = items.at(-1);
  const drawn = items.length >= 2 && series.length > 0;
  const rough = items.some(isRough);
  const selected = items[active];

  const readout =
    selected === undefined
      ? ''
      : (() => {
          const row = readoutOf(selected);
          return [
            date(row.at),
            t(`learning.history.series.${row.kind}`),
            t('learning.history.ratings', { count: row.n }),
            t('learning.history.quality', { value: formatQuality(row.quality, i18n.language) }),
            row.interestsAlone === null
              ? null
              : `${t('learning.history.series.baseline')} ${formatQuality(row.interestsAlone, i18n.language)}`,
            row.switchedOn === null
              ? null
              : t(row.switchedOn ? 'learning.history.result.on' : 'learning.history.result.off'),
          ]
            .filter((part) => part !== null)
            .join(' · ');
        })();

  const step = (event: KeyboardEvent<HTMLInputElement>) => {
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    setPicked(Math.min(Math.max(active + delta, 0), lastIndex));
  };

  return (
    <>
      {items.length === 1 ? <Hint>{t('learning.history.single')}</Hint> : null}
      {drawn && first !== undefined && last !== undefined ? (
        <>
          <Hint>{t('learning.history.description')}</Hint>
          <figure className="flex flex-col gap-2">
            <LearningCurve
              items={items}
              series={series}
              domain={yDomain(items)}
              milestones={stones}
              active={active}
              titleId={titleId}
              summaryId={summaryId}
            />
            <figcaption className="flex flex-col gap-2 text-sm text-slate-700 dark:text-slate-200">
              <span id={summaryId}>
                {t('learning.history.summary', {
                  count: items.length,
                  from: date(first.at),
                  to: date(last.at),
                })}
              </span>
              <ul
                role="list"
                aria-label={t('learning.history.legend')}
                className="flex flex-col gap-1"
              >
                {series.map(({ name, latest }) => (
                  <li key={name} className="flex items-center gap-2">
                    <SeriesKey name={name} />
                    <span>{t(`learning.history.series.${name}`)}</span>
                    <span className="font-medium tabular-nums">
                      {formatQuality(latest.value, i18n.language)}
                    </span>
                  </li>
                ))}
              </ul>
            </figcaption>
          </figure>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={sliderId} className="text-sm font-medium">
              {t('learning.history.scrubber')}
            </label>
            <input
              id={sliderId}
              type="range"
              min={1}
              max={items.length}
              step={1}
              value={active + 1}
              aria-valuetext={readout}
              onChange={(event) => {
                setPicked(Number(event.target.value) - 1);
              }}
              onKeyDown={step}
              className={cx(
                'h-11 w-full cursor-pointer accent-indigo-600 dark:accent-indigo-400',
                FOCUS_RING,
              )}
            />
            <p className="text-sm text-slate-700 dark:text-slate-200">{readout}</p>
          </div>
          {rough ? <Hint>{t('learning.history.rough')}</Hint> : null}
        </>
      ) : null}
      {truncated.model || truncated.estimate ? <Hint>{t('learning.history.capped')}</Hint> : null}
      {stones.length === 0 ? null : (
        <ol
          aria-label={t('learning.history.milestones.title')}
          className="flex flex-col gap-1 text-sm"
        >
          {stones.map((stone) => (
            <li key={`${stone.kind}-${stone.index}`}>
              {t(`learning.history.milestones.${stone.kind}`)}
              {' · '}
              <span className="text-slate-600 dark:text-slate-300">
                {date(items[stone.index]?.at ?? '')}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={tableOpen}
          aria-controls={tableId}
          onClick={() => {
            setTableOpen((open) => !open);
          }}
        >
          {t(tableOpen ? 'learning.history.table.hide' : 'learning.history.table.show')}
        </Button>
      </div>
      <div id={tableId} hidden={!tableOpen}>
        {tableOpen ? <HistoryTable items={items} /> : null}
      </div>
    </>
  );
}

/** How well each update predicted the reader's ratings; it has its own request and error state. */
export function LearningHistory() {
  const { t } = useTranslation('settings');
  const history = useLearningHistory();
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t('learning.history.title')}</h3>
      <QueryState
        query={history}
        isEmpty={(data) => data.items.length === 0}
        empty={<Hint>{t('learning.history.empty')}</Hint>}
      >
        {(data) => <Curve history={data} />}
      </QueryState>
    </div>
  );
}
