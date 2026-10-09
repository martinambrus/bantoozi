import type { AdminUsage } from '@bantoozi/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormat } from './format.js';

const WIDTH = 640;
const HEIGHT = 200;
const LEFT = 8;
const TOP = 20;
const BOTTOM = 24;
const GAP = 2;
const DAY_MS = 86_400_000;
const MAX_DAYS = 400;

export interface DayCost {
  day: string;
  costUsd: number;
}

/** Cost per UTC day from the first to the last day with spend, days without spend included. */
export function dailyCosts(daily: AdminUsage['daily']): DayCost[] {
  const sums = new Map<string, number>();
  for (const row of daily) sums.set(row.day, (sums.get(row.day) ?? 0) + row.costUsd);
  const days = [...sums.keys()].sort();
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) return [];
  const costs: DayCost[] = [];
  const end = Date.parse(`${last}T00:00:00Z`);
  for (
    let at = Date.parse(`${first}T00:00:00Z`);
    at <= end && costs.length < MAX_DAYS;
    at += DAY_MS
  ) {
    const day = new Date(at).toISOString().slice(0, 10);
    costs.push({ day, costUsd: sums.get(day) ?? 0 });
  }
  return costs;
}

/** An inline SVG bar chart: no chart library, and the text summary carries the same information. */
export function UsageChart({ costs, days }: { costs: readonly DayCost[]; days: number }) {
  const { t } = useTranslation('admin');
  const { usd } = useFormat();
  const titleId = useId();
  const summaryId = useId();

  const total = costs.reduce((sum, { costUsd }) => sum + costUsd, 0);
  const peak = costs.reduce((best, entry) => (entry.costUsd > best.costUsd ? entry : best));
  const first = costs[0];
  const last = costs.at(-1);
  const summary =
    first === undefined || last === undefined || first.day === last.day
      ? t('usage.chart.summaryOneDay', { day: peak.day, total: usd(total) })
      : t('usage.chart.summary', {
          from: first.day,
          to: last.day,
          total: usd(total),
          day: peak.day,
          max: usd(peak.costUsd),
        });

  const plotHeight = HEIGHT - TOP - BOTTOM;
  const slot = (WIDTH - LEFT) / costs.length;
  const barWidth = Math.max(1, slot - GAP);

  return (
    <figure className="flex flex-col gap-2">
      <svg
        role="img"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full max-w-3xl text-indigo-700 dark:text-indigo-300"
      >
        <title id={titleId}>{t('usage.chart.title', { count: days })}</title>
        <g fill="currentColor">
          {costs.map((entry, index) => {
            const height = peak.costUsd > 0 ? (entry.costUsd / peak.costUsd) * plotHeight : 0;
            return (
              <rect
                key={entry.day}
                x={LEFT + index * slot}
                y={TOP + plotHeight - height}
                width={barWidth}
                height={height}
              >
                <title>{`${entry.day}: ${usd(entry.costUsd)}`}</title>
              </rect>
            );
          })}
        </g>
        <line
          x1={LEFT}
          x2={WIDTH}
          y1={TOP + plotHeight}
          y2={TOP + plotHeight}
          stroke="currentColor"
          strokeWidth={1}
        />
        <g
          fill="currentColor"
          fontSize={11}
          aria-hidden="true"
          className="text-slate-700 dark:text-slate-200"
        >
          <text x={LEFT} y={12}>
            {usd(peak.costUsd)}
          </text>
          <text x={LEFT} y={HEIGHT - 6}>
            {first?.day}
          </text>
          <text x={WIDTH} y={HEIGHT - 6} textAnchor="end">
            {last?.day}
          </text>
        </g>
      </svg>
      <figcaption id={summaryId} className="text-sm text-slate-700 dark:text-slate-200">
        {summary}
      </figcaption>
    </figure>
  );
}
