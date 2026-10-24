import type { LearningHistoryItem } from '@bantoozi/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import type { Domain, Milestone, Point, Series, SeriesName } from '../learning/history-model.js';
import { formatQuality } from '../learning/history-model.js';

/** Complete class strings only: Tailwind finds them in the source, so none is built from parts. */
export const SERIES_STYLE: Record<SeriesName, { line: string; marker: string }> = {
  model: {
    line: 'stroke-indigo-600 dark:stroke-indigo-500',
    marker: 'fill-indigo-600 stroke-white dark:fill-indigo-500 dark:stroke-slate-950',
  },
  estimate: {
    line: 'stroke-orange-700 dark:stroke-orange-600',
    marker: 'fill-white stroke-orange-700 dark:fill-slate-950 dark:stroke-orange-600',
  },
  baseline: {
    line: 'stroke-slate-500 dark:stroke-slate-500',
    marker: 'fill-slate-500 stroke-white dark:fill-slate-500 dark:stroke-slate-950',
  },
};

const TEXT = 'fill-slate-600 dark:fill-slate-300';
const GRID = 'stroke-slate-200 dark:stroke-slate-800';
const CURSOR = 'stroke-slate-400 dark:stroke-slate-500';
const MILESTONE = 'stroke-slate-500 dark:stroke-slate-400';

const FALLBACK_WIDTH = 560;
const HEIGHT = 230;
const MARGIN = { top: 14, right: 16, bottom: 46, left: 44 };
const MARKER_RADIUS = 4;
const POINT_SPACING = 16;
const MAX_MILESTONE_LINES = 8;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, width };
}

/** The key of one series, drawn the way it is on the chart; the name and latest value follow it. */
export function SeriesKey({ name }: { name: SeriesName }) {
  const style = SERIES_STYLE[name];
  return (
    <svg width={28} height={12} aria-hidden="true" className="shrink-0">
      <line
        x1={0}
        x2={28}
        y1={6}
        y2={6}
        strokeWidth={2}
        strokeLinecap="round"
        className={style.line}
      />
      <circle cx={14} cy={6} r={MARKER_RADIUS} strokeWidth={2} className={style.marker} />
    </svg>
  );
}

export interface LearningCurveProps {
  items: readonly LearningHistoryItem[];
  series: readonly Series[];
  domain: Domain;
  milestones: readonly Milestone[];
  active: number;
  titleId: string;
  summaryId: string;
}

export function LearningCurve({
  items,
  series,
  domain,
  milestones,
  active,
  titleId,
  summaryId,
}: LearningCurveProps) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const { ref, width } = useWidth();

  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 1);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const last = Math.max(items.length - 1, 1);
  const x = (index: number) => MARGIN.left + (index / last) * plotWidth;
  const y = (value: number) =>
    MARGIN.top + (1 - (value - domain.min) / (domain.max - domain.min)) * plotHeight;
  const everyPoint = items.length <= plotWidth / POINT_SPACING;
  const first = items[0];
  const end = items.at(-1);
  const edge = (item: LearningHistoryItem | undefined) =>
    item === undefined ? '' : t('learning.history.ratings', { count: item.n });

  const shown = (points: readonly Point[]) => {
    if (everyPoint) return points;
    const keep = new Set([points.at(-1)?.index, active]);
    return points.filter((point) => keep.has(point.index));
  };

  return (
    <div ref={ref} className="w-full">
      <svg
        role="img"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block max-w-full"
      >
        <title id={titleId}>{t('learning.history.chartTitle')}</title>
        {domain.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
              strokeWidth={1}
              className={GRID}
            />
            <text
              x={MARGIN.left - 8}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={12}
              className={TEXT}
            >
              {formatQuality(tick, i18n.language)}
            </text>
          </g>
        ))}
        {milestones.slice(0, MAX_MILESTONE_LINES).map((milestone) => (
          <line
            key={`${milestone.kind}-${milestone.index}`}
            x1={x(milestone.index)}
            x2={x(milestone.index)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
            strokeWidth={1}
            strokeDasharray="2 3"
            className={MILESTONE}
          />
        ))}
        <line
          x1={x(active)}
          x2={x(active)}
          y1={MARGIN.top}
          y2={MARGIN.top + plotHeight}
          strokeWidth={1}
          className={CURSOR}
        />
        {[...series].reverse().map(({ name, runs, points }) => (
          <g key={name}>
            {runs
              .filter((run) => run.length >= 2)
              .map((run) => (
                <path
                  key={run[0]?.index}
                  data-series={name}
                  d={run
                    .map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.index)} ${y(point.value)}`)
                    .join(' ')}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className={SERIES_STYLE[name].line}
                />
              ))}
            {shown(points).map((point) => (
              <circle
                key={point.index}
                data-series={name}
                cx={x(point.index)}
                cy={y(point.value)}
                r={MARKER_RADIUS}
                strokeWidth={2}
                className={SERIES_STYLE[name].marker}
              />
            ))}
          </g>
        ))}
        {first === undefined || end === undefined ? null : (
          <>
            <text x={MARGIN.left} y={HEIGHT - 26} fontSize={12} className={TEXT}>
              {formatDate(first.at, i18n.language, me.timezone)}
            </text>
            <text x={MARGIN.left} y={HEIGHT - 10} fontSize={12} className={TEXT}>
              {edge(first)}
            </text>
            <text
              x={MARGIN.left + plotWidth}
              y={HEIGHT - 26}
              textAnchor="end"
              fontSize={12}
              className={TEXT}
            >
              {formatDate(end.at, i18n.language, me.timezone)}
            </text>
            <text
              x={MARGIN.left + plotWidth}
              y={HEIGHT - 10}
              textAnchor="end"
              fontSize={12}
              className={TEXT}
            >
              {edge(end)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
