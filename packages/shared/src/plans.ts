/** Plans and quotas: the single source of spec 08 §6. */
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

export const PLAN_NAMES = ['beta', 'admin'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export const PLANS: Readonly<Record<PlanName, Readonly<PlanLimits>>> = {
  beta: {
    maxFeeds: 200,
    maxCards: 50,
    maxLabels: 20,
    maxForks: 20,
    maxRules: 200,
    opmlMaxFeeds: 300,
    minFetchIntervalS: 900,
    backfillDays: 7,
    invitesOnSignup: 3,
  },
  admin: {
    maxFeeds: 2000,
    maxCards: 500,
    maxLabels: 200,
    maxForks: 200,
    maxRules: 2000,
    opmlMaxFeeds: 2000,
    minFetchIntervalS: 300,
    backfillDays: 14,
    invitesOnSignup: 50,
  },
};

/** Default plan of a new user (`users.plan` default). */
export const DEFAULT_PLAN: PlanName = 'beta';

/** Fetch interval used when a plan is unknown or a feed has no subscribers (spec 02 §6). */
export const DEFAULT_MIN_INTERVAL_S = 900;

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}

/** Limits for a stored plan name; unknown names fall back to the default plan. */
export function planLimits(plan: string): Readonly<PlanLimits> {
  return isPlanName(plan) ? PLANS[plan] : PLANS[DEFAULT_PLAN];
}

/**
 * The `p_plan_min_interval` argument of `refresh_feed_subscribers` (spec 02 §6),
 * e.g. `{"beta": 900, "admin": 300}`.
 */
export function planMinIntervalMap(): Record<PlanName, number> {
  return Object.fromEntries(PLAN_NAMES.map((p) => [p, PLANS[p].minFetchIntervalS])) as Record<
    PlanName,
    number
  >;
}
