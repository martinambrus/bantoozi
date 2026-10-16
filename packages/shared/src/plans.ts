import { z } from 'zod';

/**
 * Plan limits (spec 08 §6). The values live in the `plans` table (D-255) and are edited in
 * Admin → Plans; this file holds the shape, its validation and the constants that are not plan data.
 */
export interface PlanLimits {
  /** Subscriptions. */
  maxFeeds: number;
  /** Interest cards, including `never` cards. */
  maxCards: number;
  maxLabels: number;
  /** Private interest-card forks (label forks count toward `maxLabels`). */
  maxForks: number;
  maxRules: number;
  /** Per OPML import. */
  opmlMaxFeeds: number;
  /** Lower bound for `feeds.min_interval_s` contributed by a subscriber on this plan. */
  minFetchIntervalS: number;
  backfillDays: number;
  invitesOnSignup: number;
}

/** Fetch interval bounds of a plan (the `plans` check constraint). */
export const MIN_FETCH_INTERVAL_MIN_S = 60;
export const MIN_FETCH_INTERVAL_MAX_S = 86_400;

const Limit = z.number().int().min(0).max(1_000_000);

/** A plan's limits as stored and edited. */
export const PlanLimitsSchema = z
  .object({
    maxFeeds: Limit,
    maxCards: Limit,
    maxLabels: Limit,
    maxForks: Limit,
    maxRules: Limit,
    opmlMaxFeeds: Limit,
    minFetchIntervalS: z.number().int().min(MIN_FETCH_INTERVAL_MIN_S).max(MIN_FETCH_INTERVAL_MAX_S),
    backfillDays: Limit,
    invitesOnSignup: Limit,
  })
  .strict();

/** Fetch interval used when a feed has no subscribers (spec 02 §6). */
export const DEFAULT_MIN_INTERVAL_S = 900;
