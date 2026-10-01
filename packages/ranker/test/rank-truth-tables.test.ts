import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  DEMOTION_FLAGS,
  type DemotionFlag,
  type DemotionUserState,
  type DislikeReason,
  isDemotionActive,
  isDemotionTriggered,
  laneFromP,
  matchBoostRules,
  matchHideRule,
  mergeRankerConfig,
  type RankerConfig,
  type RankItem,
  type RankRule,
  rankArticle,
  type ReadonlyRankerConfig,
  tierFromP,
} from '../src/index.js';
import { context, HOUR, item, NOW, rule } from './rank-support.js';
import { answers, card } from './support.js';

const DEFAULTS = DEFAULT_RANKER_CONFIG;
const OVERRIDE: RankerConfig = mergeRankerConfig({
  lanes: { forYou: 0.8, maybe: 0.2 },
  tiers: [0.1, 0.3, 0.5, 0.9],
  demotion: { autoMinDislikes: 5, clickbait: 0.6, shallowDepth: 0.4, staleAgeHours: 24 },
});
const CONFIGS: [string, ReadonlyRankerConfig][] = [
  ['the defaults', DEFAULTS],
  ['a merged override', OVERRIDE],
];

const below = (t: number) => t - 1e-9;

/** Each lane threshold at and just below it, with the lane on either side. */
function laneRows(config: ReadonlyRankerConfig) {
  const { forYou, maybe } = config.lanes;
  return [
    [1, 'for_you'],
    [forYou, 'for_you'],
    [below(forYou), 'maybe'],
    [maybe, 'maybe'],
    [below(maybe), 'everything'],
    [0, 'everything'],
  ] as const;
}

/** Each tier boundary at and just below it: tier i + 2 at the i-th boundary, i + 1 below it. */
function tierRows(config: ReadonlyRankerConfig): [number, number][] {
  return [
    [0, 1],
    [1, 5],
    ...config.tiers.flatMap((t, i): [number, number][] => [
      [t, i + 2],
      [below(t), i + 1],
    ]),
  ];
}

describe.each(CONFIGS)('lane and tier boundaries with %s (spec 06 §6.1, §11)', (_, config) => {
  it.each(laneRows(config))('laneFromP(%s) is %s', (p, lane) => {
    expect(laneFromP(p, config)).toBe(lane);
  });

  it.each(tierRows(config))('tierFromP(%s) is %s', (p, tier) => {
    expect(tierFromP(p, config)).toBe(tier);
  });

  it.each(laneRows(config))('rankArticle puts a love answer of %s in %s', (p, lane) => {
    const result = rankArticle(
      context({ config, cards: [card('10', 'love')] }),
      item({ cardAnswers: answers({ 10: p }) }),
      NOW,
    );
    expect(result).toMatchObject({
      lane,
      pLike: p,
      tier: tierFromP(p, config),
      scoreSource: 'cards',
      rulesFired: [],
    });
  });

  it('a floor raises P to lanes.forYou, so the tier matches the lane', () => {
    const p = below(config.lanes.maybe);
    const result = rankArticle(
      context({ config, cards: [card('10', 'love')], rules: [rule('boost_feed', '1')] }),
      item({ cardAnswers: answers({ 10: p }) }),
      NOW,
    );
    expect(result).toMatchObject({
      lane: 'for_you',
      pLike: config.lanes.forYou,
      tier: tierFromP(config.lanes.forYou, config),
      rulesFired: ['boost_feed'],
    });
  });
});

describe('the override really moves the boundaries', () => {
  it('differs from the defaults at every lane threshold', () => {
    expect(laneFromP(DEFAULTS.lanes.forYou, OVERRIDE)).toBe('maybe');
    expect(laneFromP(OVERRIDE.lanes.maybe, DEFAULTS)).toBe('everything');
    expect(tierFromP(DEFAULTS.tiers[3], OVERRIDE)).toBe(4);
  });
});

const REASON: Record<Exclude<DemotionFlag, 'stale'>, DislikeReason> = {
  clickbait: 'clickbait',
  promotional: 'promo',
  shallow: 'shallow',
};
const ALL_REASONS: DislikeReason[] = [
  'clickbait',
  'promo',
  'shallow',
  'seen',
  'off_topic',
  'other',
];

function user(
  flag: DemotionFlag,
  setting: 'on' | 'off' | 'auto',
  counts: Partial<Omit<DemotionUserState, 'demote'>> = {},
): DemotionUserState {
  return {
    demote: {
      clickbait: 'auto',
      promotional: 'auto',
      shallow: 'auto',
      stale: 'auto',
      [flag]: setting,
    },
    reasonCounts90d: {},
    staleDislikes90d: 0,
    ...counts,
  };
}

/** Counts for a flag's driver: its reason, or `staleDislikes90d` for stale. */
function driver(flag: DemotionFlag, n: number): Partial<Omit<DemotionUserState, 'demote'>> {
  return flag === 'stale' ? { staleDislikes90d: n } : { reasonCounts90d: { [REASON[flag]]: n } };
}

/** Everything except the flag's driver at `n`. */
function everythingElse(flag: DemotionFlag, n: number): Partial<Omit<DemotionUserState, 'demote'>> {
  const reasons = ALL_REASONS.filter((r) => flag === 'stale' || r !== REASON[flag]);
  return {
    reasonCounts90d: Object.fromEntries(reasons.map((r) => [r, n])),
    staleDislikes90d: flag === 'stale' ? 0 : n,
  };
}

describe.each(CONFIGS)('isDemotionActive tri-state with %s (spec 06 §5)', (_, config) => {
  const min = config.demotion.autoMinDislikes;

  describe.each(DEMOTION_FLAGS)('%s', (flag) => {
    it.each([
      ['on', 0, true],
      ['on', min, true],
      ['off', 0, false],
      ['off', 1000, false],
      ['auto', 0, false],
      ['auto', min - 1, false],
      ['auto', min, true],
      ['auto', min + 1, true],
    ] as const)('%s with %s driving dislikes → %s', (setting, n, active) => {
      expect(isDemotionActive(flag, user(flag, setting, driver(flag, n)), config)).toBe(active);
    });

    it('auto ignores every count that does not drive it', () => {
      expect(isDemotionActive(flag, user(flag, 'auto', everythingElse(flag, 1000)), config)).toBe(
        false,
      );
    });
  });
});

describe('the reason mapping of auto activation (spec 06 §5)', () => {
  const min = DEFAULTS.demotion.autoMinDislikes;
  it.each([
    ['clickbait', 'clickbait'],
    ['promotional', 'promo'],
    ['shallow', 'shallow'],
  ] as const)('%s is driven by the %s reason', (flag, reason) => {
    const counts = { reasonCounts90d: { [reason]: min } };
    for (const other of DEMOTION_FLAGS) {
      expect(isDemotionActive(other, user(other, 'auto', counts), DEFAULTS)).toBe(other === flag);
    }
  });

  it('stale is driven by staleDislikes90d, not by any reason count', () => {
    const state = { staleDislikes90d: min, reasonCounts90d: {} };
    for (const other of DEMOTION_FLAGS) {
      expect(isDemotionActive(other, user(other, 'auto', state), DEFAULTS)).toBe(other === 'stale');
    }
  });
});

type TriggerItem = Pick<RankItem, 'facets' | 'publishedAt' | 'firstSeenAt'>;

function trigger(
  facets: Record<string, number> | undefined,
  ageHours: { published?: number; firstSeen?: number } = {},
): TriggerItem {
  const at = (h: number) => new Date(NOW.getTime() - h * HOUR);
  return {
    facets,
    firstSeenAt: at(ageHours.firstSeen ?? 1),
    ...(ageHours.published === undefined ? {} : { publishedAt: at(ageHours.published) }),
  };
}

describe.each(CONFIGS)('isDemotionTriggered boundaries with %s (spec 06 §5)', (_, config) => {
  const d = config.demotion;
  const ts = d.staleTimeSensitive;
  const old = d.staleAgeHours + 1;

  it.each([
    ['clickbait', { clickbait: d.clickbait }, true],
    ['clickbait', { clickbait: 1 }, true],
    ['clickbait', { clickbait: below(d.clickbait) }, false],
    ['promotional', { promotional: d.promotional }, true],
    ['promotional', { promotional: below(d.promotional) }, false],
    ['shallow', { depth: d.shallowDepth }, true],
    ['shallow', { depth: 0 }, true],
    ['shallow', { depth: d.shallowDepth + 1e-9 }, false],
  ] as const)('%s with %o → %s', (flag, facets, triggered) => {
    expect(isDemotionTriggered(flag, trigger(facets), NOW, config)).toBe(triggered);
  });

  it.each([
    ['at the threshold and old', ts, { firstSeen: old }, true],
    ['just below the threshold', below(ts), { firstSeen: old }, false],
    ['exactly staleAgeHours old', ts, { firstSeen: d.staleAgeHours }, false],
    ['one ms past staleAgeHours', ts, { firstSeen: d.staleAgeHours + 1 / 3_600_000 }, true],
    ['old by publishedAt, freshly seen', ts, { published: old, firstSeen: 1 }, true],
    [
      'publishedAt after firstSeenAt (firstSeenAt counts)',
      ts,
      { published: 1, firstSeen: old },
      true,
    ],
    ['publishedAt in the future, fresh', ts, { published: -old, firstSeen: 1 }, false],
    ['firstSeenAt in the future (age floors at 0)', 1, { firstSeen: -old }, false],
  ] as const)('stale: %s', (_name, timeSensitive, age, triggered) => {
    const subject = trigger({ time_sensitive: timeSensitive }, age);
    expect(isDemotionTriggered('stale', subject, NOW, config)).toBe(triggered);
  });

  it('an invalid publishedAt falls back to firstSeenAt', () => {
    const base = trigger({ time_sensitive: ts }, { firstSeen: old });
    expect(
      isDemotionTriggered('stale', { ...base, publishedAt: new Date(Number.NaN) }, NOW, config),
    ).toBe(true);
  });

  const invalid = [undefined, {}, { x: 1 }].map((f) => [f] as const);
  const badValues = [Number.NaN, -0.1, 1.1, Number.POSITIVE_INFINITY];
  it.each(invalid)('missing facets (%o) never trigger', (facets) => {
    for (const flag of DEMOTION_FLAGS) {
      expect(isDemotionTriggered(flag, trigger(facets, { firstSeen: 1000 }), NOW, config)).toBe(
        false,
      );
    }
  });

  it.each(badValues)('an invalid facet value (%s) never triggers', (v) => {
    const facets = { clickbait: v, promotional: v, depth: v, time_sensitive: v };
    for (const flag of DEMOTION_FLAGS) {
      expect(isDemotionTriggered(flag, trigger(facets, { firstSeen: 1000 }), NOW, config)).toBe(
        false,
      );
    }
  });
});

const ruleItem = item({
  feedIds: ['1', '2'],
  domain: 'example.com',
  author: 'Jana Nováková',
  clusterId: '44',
  titleNorm: 'battery prices fall again',
  excerptNorm: 'lithium cells are cheaper than ever',
  translatedTitleNorm: 'baterie zlevnily',
});

function hide(rules: RankRule[], subject: RankItem = ruleItem) {
  const match = matchHideRule(rules, subject);
  return match === null ? null : { code: match.code, ruleId: match.ruleId };
}

describe('matchHideRule truth table (spec 06 §3.1)', () => {
  it.each([
    ['mute_keyword', 'prices fall', 'mute_keyword:prices fall'],
    ['mute_keyword', 'Prices   FALL!', 'mute_keyword:Prices   FALL!'],
    ['mute_keyword', 'cells', 'mute_keyword:cells'],
    ['mute_keyword', 'zlevnily', 'mute_keyword:zlevnily'],
    ['mute_keyword', 'price', null],
    ['mute_keyword', 'fall battery', null],
    ['mute_keyword', ' !! ', null],
    ['mute_story', '44', 'mute_story'],
    ['mute_story', '45', null],
    ['block_domain', 'example.com', 'block_domain'],
    ['block_domain', ' Example.COM ', 'block_domain'],
    ['block_domain', 'sub.example.com', null],
    ['block_domain', '', null],
    ['block_author', 'jana novakova', 'block_author'],
    ['block_author', '  JANA   Nováková ', 'block_author'],
    ['block_author', 'Jana', null],
    ['block_author', '', null],
    ['boost_feed', '1', null],
    ['boost_domain', 'example.com', null],
  ] as const)('%s %j → %s', (kind, value, code) => {
    const r = rule(kind, value);
    expect(hide([r])).toEqual(code === null ? null : { code, ruleId: r.id });
  });

  it.each([
    [['1'], ['1'], true],
    [['1', '2'], ['1'], false],
    [['1', '2'], ['1', '2'], true],
    [['1', '2'], ['1', '2', '3'], true],
    [['1', '1'], ['1'], true],
    [[], ['1'], false],
  ] as const)('block_feed: carriers %j, blocked %j → %s', (feedIds, blocked, hidden) => {
    const rules = blocked.map((v) => rule('block_feed', v));
    expect(hide(rules, item({ feedIds }))?.code ?? null).toBe(hidden ? 'block_feed' : null);
  });

  it('mute_story and block_author need the item to have a cluster and an author', () => {
    const bare = item({ clusterId: undefined, author: null });
    expect(hide([rule('mute_story', '44'), rule('block_author', 'Jana Nováková')], bare)).toBe(
      null,
    );
  });

  it('reports the first kind in table order, then the lowest numeric rule id', () => {
    const rules = [
      rule('block_author', 'jana novakova', { id: '1' }),
      rule('block_domain', 'example.com', { id: '2' }),
      rule('mute_story', '44', { id: '3' }),
      rule('mute_keyword', 'cells', { id: '100' }),
      rule('mute_keyword', 'prices', { id: '20' }),
    ];
    expect(hide(rules)).toEqual({ code: 'mute_keyword:prices', ruleId: '20' });
    expect(hide(rules.slice(0, 3))).toEqual({ code: 'mute_story', ruleId: '3' });
    expect(hide(rules.slice(0, 2))).toEqual({ code: 'block_domain', ruleId: '2' });
  });
});

describe('matchBoostRules truth table (spec 06 §3.1)', () => {
  const kinds = (rules: RankRule[], subject: RankItem = ruleItem) =>
    matchBoostRules(rules, subject).map((m) => [m.floor.kind, m.rule.id]);

  it.each([
    ['boost_feed', '1', true],
    ['boost_feed', '2', true],
    ['boost_feed', '3', false],
    ['boost_domain', 'example.com', true],
    ['boost_domain', 'EXAMPLE.com', true],
    ['boost_domain', 'other.com', false],
    ['boost_domain', '', false],
    ['block_feed', '1', false],
    ['block_domain', 'example.com', false],
    ['mute_story', '44', false],
  ] as const)('%s %j → %s', (kind, value, matches) => {
    const r = rule(kind, value);
    expect(kinds([r])).toEqual(matches ? [[kind, r.id]] : []);
  });

  it('gives at most one floor per kind, the lowest id, boost_feed first', () => {
    const rules = [
      rule('boost_domain', 'example.com', { id: '5' }),
      rule('boost_domain', 'example.com', { id: '40' }),
      rule('boost_feed', '2', { id: '30' }),
      rule('boost_feed', '1', { id: '9' }),
    ];
    expect(kinds(rules)).toEqual([
      ['boost_feed', '9'],
      ['boost_domain', '5'],
    ]);
  });
});

describe('never/must/boost interplay through rankArticle (spec 06 §2 steps 3, 6iii, 6iv)', () => {
  const base = card('10', 'love');
  const must = card('12', 'must');
  const never = card('13', 'never');
  const floors = (m: number, boost: boolean) => [
    ...(m >= DEFAULTS.mustFloor ? ['must:12'] : []),
    ...(boost ? ['boost_feed'] : []),
  ];

  // [love p, never p, must p, boost, lane, P, rulesFired]
  const rows: [number, number, number, boolean, string, number | null, string[]][] = [];
  for (const boost of [false, true]) {
    for (const m of [0.49, 0.5]) {
      const floor = m >= 0.5 || boost;
      // A confident never-card hides first, whatever the floors.
      for (const love of [0.9, 0.4]) rows.push([love, 0.7, m, boost, 'hidden', null, ['never:13']]);
      // Base P 0.9 (For you): the floor fires only when it beats a never_soft cap.
      rows.push([0.9, 0.49, m, boost, 'for_you', 0.9, []]);
      for (const n of [0.5, 0.69]) {
        rows.push(
          floor
            ? [0.9, n, m, boost, 'for_you', 0.9, floors(m, boost)]
            : [0.9, n, m, boost, 'maybe', 0.9, ['never_soft:13']],
        );
      }
      // Base P max(0.4, must p) (Maybe): never_soft lowers nothing; the floor raises P.
      for (const n of [0.49, 0.5, 0.69]) {
        rows.push(
          floor
            ? [0.4, n, m, boost, 'for_you', DEFAULTS.lanes.forYou, floors(m, boost)]
            : [0.4, n, m, boost, 'maybe', m, []],
        );
      }
    }
  }

  it('covers never × must × boost × base lane', () => {
    expect(rows).toHaveLength(2 * 2 * 2 * 4);
  });

  it.each(rows)(
    'love %s, never %s, must %s, boost %s → %s, P %s, %j',
    (love, n, m, boost, lane, p, fired) => {
      const result = rankArticle(
        context({
          cards: [base, must, never],
          rules: boost ? [rule('boost_feed', '1', { id: '30' })] : [],
        }),
        item({ cardAnswers: answers({ 10: love, 12: m, 13: n }) }),
        NOW,
      );
      expect(result).toMatchObject({
        lane,
        pLike: p,
        tier: p === null ? null : tierFromP(p, DEFAULTS),
        rulesFired: fired,
      });
      if (lane !== 'hidden') expect(result.explain.decidingCardId).toBe(love >= m ? '10' : '12');
    },
  );
});
