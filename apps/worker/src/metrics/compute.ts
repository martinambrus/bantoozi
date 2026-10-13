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
 * Streaming form of {@link effectiveRatings} (M8-F10 review): events arrive in any number of
 * chunks, ordered per user and article across them, and each completed pair is handed to `emit` at
 * once. Only the one open pair's state stack (ratings, not events) is retained, so the memory is
 * independent of the number of events and pairs.
 */
export class EffectiveRatingFold {
  private pair: string | undefined;
  private states: Array<EffectiveRating | null> = [];

  constructor(private readonly emit: (rating: EffectiveRating) => void) {}

  push(events: readonly MetricsRatingEvent[]): void {
    for (const event of events) {
      const id = `${event.userId}:${event.articleId}`;
      if (id !== this.pair) {
        this.flush();
        this.pair = id;
        this.states = [];
      }
      if (event.kind === 'undo') {
        this.states.pop();
      } else if (event.kind === 'unrate') {
        this.states.push(null);
      } else if (isLane(event.lane) && (event.rating === 1 || event.rating === -1)) {
        this.states.push({
          at: event.at.getTime(),
          lane: event.lane,
          liked: event.rating === 1,
          source: isSource(event.source) ? event.source : null,
          lang: event.lang !== null && LANG.test(event.lang) ? event.lang : 'unknown',
          prompted: event.prompted,
        });
      } else {
        this.states.push(null);
      }
    }
  }

  /** Emits the open pair (if it has an effective rating); call once after the last chunk. */
  finish(): void {
    this.flush();
    this.pair = undefined;
    this.states = [];
  }

  /** What the fold holds between chunks: the open pair's states only, never events or emitted ratings. */
  retained(): { openPair: string | undefined; states: number } {
    return { openPair: this.pair, states: this.states.length };
  }

  private flush(): void {
    const top = this.states.at(-1);
    if (top) this.emit(top);
  }
}

/**
 * Replays the events (ordered per user and article) into at most one effective rating per pair
 * (spec 10 §7): a rating (or a prompt answer) replaces the earlier one, an unrate clears it, and
 * the undo of a rating or of a prompt answer restores the state before it. Ratings without a known
 * pre-feedback lane are left out.
 */
export function effectiveRatings(events: readonly MetricsRatingEvent[]): EffectiveRating[] {
  const out: EffectiveRating[] = [];
  const fold = new EffectiveRatingFold((rating) => out.push(rating));
  fold.push(events);
  fold.finish();
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

type Tally = Map<string, { rated: number; likes: number }>;

/**
 * Like-rate counters of the ratings with `from <= at < to`, filled one rating at a time (M8-F10
 * review): per lane, and per lane within the ranking source, article language and origin. The
 * retained state is a few counters per distinct source/language/origin, not the ratings.
 */
export class WindowTally {
  private readonly lanes = new Map<string, { rated: number; likes: number }>();
  private readonly dims = {
    source: new Map<string, Tally>(),
    lang: new Map<string, Tally>(),
    origin: new Map<string, Tally>(),
  };
  private readonly perLanguage = new Map<string, number>();

  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {}

  add(r: EffectiveRating): void {
    if (r.at < this.from || r.at >= this.to) return;
    bump(this.lanes, r.lane, r.liked);
    if (r.source !== null) this.bucket(this.dims.source, r.source, r);
    this.bucket(this.dims.lang, r.lang, r);
    this.bucket(this.dims.origin, r.prompted ? 'prompt' : 'voluntary', r);
    this.perLanguage.set(r.lang, (this.perLanguage.get(r.lang) ?? 0) + 1);
  }

  /** Counters held: lane cells plus split cells; bounded by sources, languages and origins. */
  size(): number {
    let n = this.lanes.size;
    for (const dim of Object.values(this.dims)) for (const t of dim.values()) n += t.size;
    return n + this.perLanguage.size;
  }

  /** Like-rate and rated count per lane; a lane with no rating has a `null` rate. */
  laneStats(): MetricsSnapshot['lanes'] {
    const out: MetricsSnapshot['lanes'] = {};
    for (const lane of METRIC_LANES) {
      const cell = this.lanes.get(lane);
      out[lane] = {
        likeRate: cell === undefined ? null : cell.likes / cell.rated,
        rated: cell?.rated ?? 0,
      };
    }
    return out;
  }

  /** The like-rate per lane split by source (legacy in no bucket), language (`unknown` apart) and origin. */
  splits(): RatingSplits {
    const kept = new Set(
      [...this.perLanguage]
        .filter(([lang]) => lang !== 'unknown')
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .slice(0, MAX_LANGUAGES)
        .map(([lang]) => lang),
    );
    const render = (dim: Map<string, Tally>, name: (raw: string) => string) => {
      const merged = new Map<string, Tally>();
      for (const [raw, tally] of dim) {
        const into = merged.get(name(raw)) ?? new Map();
        for (const [lane, cell] of tally) {
          const have = into.get(lane) ?? { rated: 0, likes: 0 };
          into.set(lane, { rated: have.rated + cell.rated, likes: have.likes + cell.likes });
        }
        merged.set(name(raw), into);
      }
      return Object.fromEntries(
        [...merged]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, tally]) => [key, populated(tally)]),
      );
    };
    return {
      bySource: render(this.dims.source, (raw) => raw),
      byLanguage: render(this.dims.lang, (raw) =>
        raw === 'unknown' || kept.has(raw) ? raw : 'other',
      ),
      byOrigin: render(this.dims.origin, (raw) => raw),
    };
  }

  private bucket(dim: Map<string, Tally>, name: string, r: EffectiveRating): void {
    const tally = dim.get(name) ?? new Map();
    dim.set(name, tally);
    bump(tally, r.lane, r.liked);
  }
}

function bump(tally: Tally, lane: string, liked: boolean): void {
  const cell = tally.get(lane) ?? { rated: 0, likes: 0 };
  cell.rated += 1;
  if (liked) cell.likes += 1;
  tally.set(lane, cell);
}

/** Lanes with at least one rating, in {@link METRIC_LANES} order. */
function populated(tally: Tally): Record<string, MetricsLane> {
  const out: Record<string, MetricsLane> = {};
  for (const lane of METRIC_LANES) {
    const cell = tally.get(lane);
    if (cell !== undefined) out[lane] = { likeRate: cell.likes / cell.rated, rated: cell.rated };
  }
  return out;
}

/** Like-rate and rated count per lane over `from <= at < to`; a lane with no rating has a `null` rate. */
export function laneStats(
  ratings: readonly EffectiveRating[],
  from: number,
  to: number,
): MetricsSnapshot['lanes'] {
  const tally = new WindowTally(from, to);
  for (const r of ratings) tally.add(r);
  return tally.laneStats();
}

/**
 * The like-rate per lane split by ranking source (legacy snapshots in no bucket), article language
 * (`unknown` apart) and origin (prompt or calibration vs voluntary), for `from <= at < to`.
 */
export function ratingSplits(
  ratings: readonly EffectiveRating[],
  from: number,
  to: number,
): RatingSplits {
  const tally = new WindowTally(from, to);
  for (const r of ratings) tally.add(r);
  return tally.splits();
}

/** The start (UTC midnight, ms) of `day` (`YYYY-MM-DD`) and of the day after it. */
export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + DAY_MS };
}

/** Start of the trailing `days`-day window that ends with the day starting at `dayStart`. */
export const windowStart = (dayStart: number, days: number): number =>
  dayStart - (days - 1) * DAY_MS;
