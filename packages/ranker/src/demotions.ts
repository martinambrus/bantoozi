import type { Tri } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from './config.js';
import { RULE_CODES } from './rule-codes.js';
import type { RankItem } from './types.js';

/** Quality flags (spec 06 §5). */
export const DEMOTION_FLAGS = ['clickbait', 'promotional', 'shallow', 'stale'] as const;
export type DemotionFlag = (typeof DEMOTION_FLAGS)[number];

/** Dislike reasons (`user_article.reason`, spec 06 §1). */
export type DislikeReason = 'clickbait' | 'promo' | 'shallow' | 'seen' | 'off_topic' | 'other';

/** The dislike reason that drives a flag's `auto` activation; `stale` uses `staleDislikes90d`. */
const FLAG_REASON: Readonly<Record<Exclude<DemotionFlag, 'stale'>, DislikeReason>> = {
  clickbait: 'clickbait',
  promotional: 'promo',
  shallow: 'shallow',
};

const FLAG_CODE: Readonly<Record<DemotionFlag, string>> = {
  clickbait: RULE_CODES.demoteClickbait,
  promotional: RULE_CODES.demotePromotional,
  shallow: RULE_CODES.demoteShallow,
  stale: RULE_CODES.demoteStale,
};

/** What decides whether a flag is active for the user. */
export interface DemotionUserState {
  /** `prefs.demote` (spec 08 §3.1). */
  demote: Readonly<Record<DemotionFlag, Tri>>;
  /** Current distinct disliked articles per reason in the last `autoWindowDays` days. */
  reasonCounts90d: Readonly<Partial<Record<DislikeReason, number>>>;
  /** Dislikes (any reason) on items that were stale when rated, in the same window. */
  staleDislikes90d: number;
}

/**
 * Whether a flag is active for the user (spec 06 §5): `on` always, `off` never, and `auto` (the
 * default) once the user has at least `autoMinDislikes` current dislikes with the matching reason
 * in the window (`stale`: dislikes of any reason on items that were stale when rated).
 */
export function isDemotionActive(
  flag: DemotionFlag,
  user: DemotionUserState,
  config: Pick<ReadonlyRankerConfig, 'demotion'>,
): boolean {
  const setting = user.demote[flag];
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  const count =
    flag === 'stale' ? user.staleDislikes90d : (user.reasonCounts90d[FLAG_REASON[flag]] ?? 0);
  return count >= config.demotion.autoMinDislikes;
}

/** Article age in hours (§5): `now − min(publishedAt ?? firstSeenAt, firstSeenAt)`, floored at 0. */
export function articleAgeMs(
  item: Pick<RankItem, 'publishedAt' | 'firstSeenAt'>,
  now: Date,
): number {
  const first = item.firstSeenAt.getTime();
  const published = item.publishedAt?.getTime();
  const born =
    published === undefined || Number.isNaN(published) ? first : Math.min(published, first);
  return Math.max(0, now.getTime() - born);
}

/** The time the item becomes old enough for the stale flag (age > `staleAgeHours`). */
export function staleAgeReachedAt(
  item: Pick<RankItem, 'publishedAt' | 'firstSeenAt'>,
  now: Date,
  config: Pick<ReadonlyRankerConfig, 'demotion'>,
): Date {
  const born = now.getTime() - articleAgeMs(item, now);
  return new Date(born + config.demotion.staleAgeHours * 3_600_000);
}

/** A facet value when it is a finite probability; missing or invalid values are unknown. */
function facet(facets: RankItem['facets'], key: string): number | undefined {
  if (facets === undefined || !Object.hasOwn(facets, key)) return undefined;
  const value = facets[key];
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Whether the item's facets meet a flag's condition (spec 06 §5); missing facets never trigger.
 * `stale` needs `time_sensitive ≥ staleTimeSensitive` and an age strictly above `staleAgeHours`.
 */
export function isDemotionTriggered(
  flag: DemotionFlag,
  item: Pick<RankItem, 'facets' | 'publishedAt' | 'firstSeenAt'>,
  now: Date,
  config: Pick<ReadonlyRankerConfig, 'demotion'>,
): boolean {
  const d = config.demotion;
  switch (flag) {
    case 'clickbait': {
      const v = facet(item.facets, 'clickbait');
      return v !== undefined && v >= d.clickbait;
    }
    case 'promotional': {
      const v = facet(item.facets, 'promotional');
      return v !== undefined && v >= d.promotional;
    }
    case 'shallow': {
      const v = facet(item.facets, 'depth');
      return v !== undefined && v <= d.shallowDepth;
    }
    case 'stale': {
      const v = facet(item.facets, 'time_sensitive');
      return (
        v !== undefined &&
        v >= d.staleTimeSensitive &&
        articleAgeMs(item, now) > d.staleAgeHours * 3_600_000
      );
    }
  }
}

/** The result of the quality demotions on a card score. */
export interface Demotion {
  /** P after every active and triggered flag multiplied it by `demotion.factor`. */
  p: number;
  /** The flags applied, in {@link DEMOTION_FLAGS} order. */
  flags: DemotionFlag[];
  /** Their rule codes (`demote:<flag>`). */
  codes: string[];
}

/**
 * Quality demotions (spec 06 §5), applied only to a card score: each flag that is active for the
 * user and triggered by the item multiplies P by `demotion.factor` and fires `demote:<flag>`.
 */
export function applyDemotions(
  p: number,
  item: Pick<RankItem, 'facets' | 'publishedAt' | 'firstSeenAt'>,
  user: DemotionUserState,
  now: Date,
  config: Pick<ReadonlyRankerConfig, 'demotion'>,
): Demotion {
  const flags = DEMOTION_FLAGS.filter(
    (flag) => isDemotionActive(flag, user, config) && isDemotionTriggered(flag, item, now, config),
  );
  let demoted = p;
  for (let i = 0; i < flags.length; i += 1) demoted *= config.demotion.factor;
  return { p: demoted, flags, codes: flags.map((flag) => FLAG_CODE[flag]) };
}
