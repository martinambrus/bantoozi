import type { LearningHistoryItem } from '@bantoozi/shared';

import { QUALITY_MIN_RATINGS } from './chip-state.js';

export type SeriesName = 'model' | 'estimate' | 'baseline';
export type MilestoneKind = 'estimatesOn' | 'modelOn' | 'updated';

/** Below this many ratings a quality value is a rough guess (the chip hides it too). */
export const ROUGH_BELOW = QUALITY_MIN_RATINGS;

const FLOOR = 0.5;
const SERIES_ORDER: readonly SeriesName[] = ['model', 'estimate', 'baseline'];

export interface Point {
  /** The position among all rows, oldest first: both kinds share one axis. */
  index: number;
  value: number;
}

export interface Series {
  name: SeriesName;
  /** Unbroken stretches of consecutive entries of the series' own kind that have a value. */
  runs: Point[][];
  points: Point[];
  latest: Point;
}

function valueOf(name: SeriesName, item: LearningHistoryItem): number | null {
  return name === 'baseline' ? item.baselineAuc : item.auc;
}

function kindOf(name: SeriesName): LearningHistoryItem['kind'] {
  return name === 'estimate' ? 'estimate' : 'model';
}

/**
 * The lines of the curve. A row of the other kind never breaks a line; a row of the series' own
 * kind without a value does. A series with no value at all is left out.
 */
export function buildSeries(items: readonly LearningHistoryItem[]): Series[] {
  const result: Series[] = [];
  for (const name of SERIES_ORDER) {
    const runs: Point[][] = [];
    let open: Point[] | null = null;
    items.forEach((item, index) => {
      if (item.kind !== kindOf(name)) return;
      const value = valueOf(name, item);
      if (value === null) {
        open = null;
        return;
      }
      if (open === null) {
        open = [];
        runs.push(open);
      }
      open.push({ index, value });
    });
    const points = runs.flat();
    const latest = points.at(-1);
    if (latest !== undefined) result.push({ name, runs, points, latest });
  }
  return result;
}

export interface Domain {
  min: number;
  max: 1;
  ticks: number[];
}

/** 50% (guessing) to 100%, lowered by whole tens only when a value falls below guessing. */
export function yDomain(items: readonly LearningHistoryItem[]): Domain {
  const values = buildSeries(items).flatMap((series) => series.points.map((point) => point.value));
  const lowest = Math.min(FLOOR, ...values);
  const min = lowest < FLOOR ? Math.max(0, Math.floor(lowest * 10) / 10) : FLOOR;
  const ticks: number[] = [];
  for (let step = Math.round(min * 10); step <= 10; step += 1) ticks.push(step / 10);
  return { min, max: 1, ticks };
}

export interface Milestone {
  index: number;
  kind: MilestoneKind;
}

/**
 * What the rows say happened: a row the server marked as a turn-on, and the first model row
 * analysed by a different engine model than the model row before it. The engine id itself is
 * never part of the result.
 */
export function milestones(items: readonly LearningHistoryItem[]): Milestone[] {
  const result: Milestone[] = [];
  let engine: string | null = null;
  items.forEach((item, index) => {
    if (item.turnedOn) {
      result.push({ index, kind: item.kind === 'estimate' ? 'estimatesOn' : 'modelOn' });
    }
    if (item.kind !== 'model' || item.engineModel === null) return;
    if (engine !== null && engine !== item.engineModel) result.push({ index, kind: 'updated' });
    engine = item.engineModel;
  });
  return result;
}

/** Whether the row has a plotted value computed from few ratings. */
export function isRough(item: LearningHistoryItem): boolean {
  const plotted = item.auc !== null || (item.kind === 'model' && item.baselineAuc !== null);
  return plotted && item.n < ROUGH_BELOW;
}

export interface RowReadout {
  kind: LearningHistoryItem['kind'];
  at: string;
  n: number;
  quality: number | null;
  interestsAlone: number | null;
  /** Only a personal-model row says whether it was switched on. */
  switchedOn: boolean | null;
}

export function readoutOf(item: LearningHistoryItem): RowReadout {
  return {
    kind: item.kind,
    at: item.at,
    n: item.n,
    quality: item.auc,
    interestsAlone: item.kind === 'model' ? item.baselineAuc : null,
    switchedOn: item.kind === 'model' ? item.activated : null,
  };
}

export const NO_VALUE = '–';

const percentFormats = new Map<string, Intl.NumberFormat>();

/** "71%" in the language of the page (sk "71 %"), or a dash when there is no value. */
export function formatQuality(value: number | null, language: string): string {
  if (value === null) return NO_VALUE;
  let format = percentFormats.get(language);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 });
    percentFormats.set(language, format);
  }
  return format.format(value);
}
