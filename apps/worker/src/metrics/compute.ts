import type { MetricsRatingEvent } from '@bantoozi/db';
import type { MetricsSnapshot } from '@bantoozi/shared';

const DAY_MS = 86_400_000;

/** The lanes whose like-rate is reported (spec 10 §7). */
export const METRIC_LANES = ['for_you', 'maybe', 'everything', 'hidden'] as const;
type MetricLane = (typeof METRIC_LANES)[number];

/** One user's effective explicit rating of one article: when it was given, the lane it was given from. */
export interface EffectiveRating {
  at: number;
  lane: MetricLane;
  liked: boolean;
}

const isLane = (lane: string | null): lane is MetricLane =>
  METRIC_LANES.some((known) => known === lane);

/**
 * Replays the events (ordered per user and article) into at most one effective rating per pair
 * (spec 10 §7): a rating replaces the earlier one, an unrate clears it, and the undo of a rating
 * restores the state before it. Ratings without a known pre-feedback lane are left out.
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
      states.push({ at: event.at.getTime(), lane: event.lane, liked: event.rating === 1 });
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

/** The start (UTC midnight, ms) of `day` (`YYYY-MM-DD`) and of the day after it. */
export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + DAY_MS };
}

/** Start of the trailing `days`-day window that ends with the day starting at `dayStart`. */
export const windowStart = (dayStart: number, days: number): number =>
  dayStart - (days - 1) * DAY_MS;
