import type { MetricsRatingEvent } from '@bantoozi/db';
import type { MetricsSnapshot } from '@bantoozi/shared';

const DAY_MS = 86_400_000;

/** The lanes whose like-rate is reported (spec 10 §7). */
export const METRIC_LANES = ['for_you', 'maybe', 'everything', 'hidden'] as const;
type MetricLane = (typeof METRIC_LANES)[number];

/** The ranking path of spec 06 §8.2 `before.scoreSource` that produced the rated item's P. */
export const METRIC_SOURCES = ['cards', 'model', 'degraded'] as const;
type MetricSource = (typeof METRIC_SOURCES)[number];

/**
 * One user's effective explicit rating of one article: when it was given, the lane it was given
 * from, the ranking source then (`null` for a legacy snapshot), the article language (`unknown`
 * when none) and whether a prompt or the calibration round asked for it.
 */
export interface EffectiveRating {
  at: number;
  lane: MetricLane;
  liked: boolean;
  source: MetricSource | null;
  lang: string;
  prompted: boolean;
}

const isSource = (source: string | null): source is MetricSource =>
  METRIC_SOURCES.some((known) => known === source);
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const isLane = (lane: string | null): lane is MetricLane =>
  METRIC_LANES.some((known) => known === lane);

/**
 * Replays the events (ordered per user and article) into at most one effective rating per pair
 * (spec 10 §7): a rating (or a prompt answer) replaces the earlier one, an unrate clears it, and
 * the undo of a rating or of a prompt answer restores the state before it. Ratings without a known
 * pre-feedback lane are left out.
 */
export function effectiveRatings(events: readonly MetricsRatingEvent[]): EffectiveRating[] {
  const out: EffectiveRating[] = [];
  let pair: string | undefined;
  let states: Array<EffectiveRating | null> = [];
  const flush = (): void => {
    const top = states.at(-1);
    if (top) out.push(top);
  };
  for (const event of events) {
    const id = `${event.userId}:${event.articleId}`;
    if (id !== pair) {
      flush();
      pair = id;
      states = [];
    }
    if (event.kind === 'undo') {
      states.pop();
    } else if (event.kind === 'unrate') {
      states.push(null);
    } else if (isLane(event.lane) && (event.rating === 1 || event.rating === -1)) {
      states.push({
        at: event.at.getTime(),
        lane: event.lane,
        liked: event.rating === 1,
        source: isSource(event.source) ? event.source : null,
        lang: event.lang !== null && LANG.test(event.lang) ? event.lang : 'unknown',
        prompted: event.prompted,
      });
    } else {
      states.push(null);
    }
  }
  flush();
  return out;
}

/** Like-rate and rated count per lane over `from <= at < to`; a lane with no rating has a `null` rate. */
export function laneStats(
  ratings: readonly EffectiveRating[],
  from: number,
  to: number,
): MetricsSnapshot['lanes'] {
  const lanes: MetricsSnapshot['lanes'] = {};
  for (const lane of METRIC_LANES) {
    const inLane = ratings.filter((r) => r.lane === lane && r.at >= from && r.at < to);
    const likes = inLane.filter((r) => r.liked).length;
    lanes[lane] = {
      likeRate: inLane.length === 0 ? null : likes / inLane.length,
      rated: inLane.length,
    };
  }
  return lanes;
}

/** Like-rate and rated count per lane of the ratings with `at` in `[from, to)`, empty lanes left out. */
function populatedLanes(ratings: readonly EffectiveRating[]): Record<string, MetricsLane> {
  const out: Record<string, MetricsLane> = {};
  for (const lane of METRIC_LANES) {
    const inLane = ratings.filter((r) => r.lane === lane);
    if (inLane.length > 0) {
      out[lane] = {
        likeRate: inLane.filter((r) => r.liked).length / inLane.length,
        rated: inLane.length,
      };
    }
  }
  return out;
}

type MetricsLane = { likeRate: number | null; rated: number };
export interface RatingSplits {
  bySource: Record<string, Record<string, MetricsLane>>;
  byLanguage: Record<string, Record<string, MetricsLane>>;
  byOrigin: Record<string, Record<string, MetricsLane>>;
}

/** Most languages reported separately; the rest fold into `other` so a snapshot stays bounded. */
export const MAX_LANGUAGES = 20;

/**
 * The like-rate per lane split by ranking source (legacy snapshots in no bucket), article language
 * (`unknown` apart) and origin (prompt or calibration vs voluntary), for `from <= at < to`.
 */
export function ratingSplits(
  ratings: readonly EffectiveRating[],
  from: number,
  to: number,
): RatingSplits {
  const inWindow = ratings.filter((r) => r.at >= from && r.at < to);
  const group = (key: (r: EffectiveRating) => string | null) => {
    const buckets = new Map<string, EffectiveRating[]>();
    for (const rating of inWindow) {
      const name = key(rating);
      if (name !== null) buckets.set(name, [...(buckets.get(name) ?? []), rating]);
    }
    return Object.fromEntries(
      [...buckets]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, rows]) => [name, populatedLanes(rows)]),
    );
  };
  const perLanguage = new Map<string, number>();
  for (const r of inWindow) perLanguage.set(r.lang, (perLanguage.get(r.lang) ?? 0) + 1);
  const kept = new Set(
    [...perLanguage]
      .filter(([lang]) => lang !== 'unknown')
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .slice(0, MAX_LANGUAGES)
      .map(([lang]) => lang),
  );
  return {
    bySource: group((r) => r.source),
    byLanguage: group((r) => (r.lang === 'unknown' || kept.has(r.lang) ? r.lang : 'other')),
    byOrigin: group((r) => (r.prompted ? 'prompt' : 'voluntary')),
  };
}

/** The start (UTC midnight, ms) of `day` (`YYYY-MM-DD`) and of the day after it. */
export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + DAY_MS };
}

/** Start of the trailing `days`-day window that ends with the day starting at `dayStart`. */
export const windowStart = (dayStart: number, days: number): number =>
  dayStart - (days - 1) * DAY_MS;
