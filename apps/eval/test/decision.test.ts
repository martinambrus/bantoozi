import { describe, expect, it } from 'vitest';

import {
  chooseCardMode,
  chooseLanguageMode,
  chooseTier2Cap,
  composeConfiguration,
  confirmGate,
  grid,
  recommendDailyBudget,
  runEligibility,
  selectBaseline,
  selectCore,
  selectDemotionCutoff,
  selectForYou,
  selectMaybe,
  selectTiers,
  weightPool,
  type PoolItem,
  type RunCheck,
} from '../src/report/decision.js';

/** M3a-T7: every branch of the spec 10 §5 decision rules. */

const okCheck: RunCheck = {
  experiment: 'E1',
  runId: '14',
  status: 'complete',
  datasetMatches: true,
  cohortMatches: true,
  groundTruthMatches: true,
  coverage: {
    byLang: { en: { expected: 100, valid: 100 } },
    byRater: { '1': { expected: 50, valid: 49 } },
  },
  foreignEngineAnswers: 0,
};

describe('E* eligibility and the insufficient-coverage INCONCLUSIVE state', () => {
  it('accepts a complete, matching run with ≥95 % coverage', () => {
    expect(runEligibility(okCheck)).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    [{ runId: null }, 'no run'],
    [{ status: 'partial' }, 'status partial'],
    [{ status: null }, 'status unfinished'],
    [{ datasetMatches: false }, 'dataset or split hash mismatch'],
    [{ cohortMatches: false }, 'cohort differs from the reference run'],
    [{ groundTruthMatches: false }, 'ratings differ from the reference run'],
    [{ foreignEngineAnswers: 3 }, '3 answers from an engine other than the pinned one'],
  ] as const)('refuses %o', (patch, reason) => {
    const result = runEligibility({ ...okCheck, ...patch } as RunCheck);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it('is inconclusive below 95 % valid coverage for any language or rater', () => {
    const lang = runEligibility({
      ...okCheck,
      coverage: { byLang: { sk: { expected: 100, valid: 94 } }, byRater: {} },
    });
    expect(lang.eligible).toBe(false);
    expect(lang.reasons[0]).toMatch(/coverage 94\.0% < 95% for language sk/);
    const rater = runEligibility({
      ...okCheck,
      coverage: { byLang: {}, byRater: { '7': { expected: 20, valid: 18 } } },
    });
    expect(rater.reasons[0]).toMatch(/for rater 7/);
    // Exactly 95 % passes (no floating-point surprise).
    expect(
      runEligibility({
        ...okCheck,
        coverage: { byLang: { en: { expected: 20, valid: 19 } }, byRater: {} },
      }).eligible,
    ).toBe(true);
  });
});

describe('step 1: baseline and E* selection on development', () => {
  it('chooses the better keyword baseline, ties to native B1', () => {
    expect(
      selectBaseline([
        { experiment: 'B1', eligible: true, devMacroAuc: 0.6 },
        { experiment: 'B1-T', eligible: true, devMacroAuc: 0.62 },
      ]),
    ).toBe('B1-T');
    expect(
      selectBaseline([
        { experiment: 'B1', eligible: true, devMacroAuc: 0.6 },
        { experiment: 'B1-T', eligible: true, devMacroAuc: 0.6 },
      ]),
    ).toBe('B1');
    expect(
      selectBaseline([
        { experiment: 'B1', eligible: true, devMacroAuc: 0.6 },
        { experiment: 'B1-T', eligible: false, devMacroAuc: 0.7 },
      ]),
    ).toBe('B1');
    expect(selectBaseline([{ experiment: 'B1', eligible: true, devMacroAuc: null }])).toBeNull();
  });

  it('selects E* by development macro AUC among eligible E1/E2/E3/E3b; ties prefer cheaper native', () => {
    expect(
      selectCore([
        { experiment: 'E1', eligible: true, devMacroAuc: 0.7 },
        { experiment: 'E3', eligible: true, devMacroAuc: 0.75 },
        { experiment: 'E4', eligible: true, devMacroAuc: 0.9 },
      ]),
    ).toBe('E3');
    expect(
      selectCore([
        { experiment: 'E3b', eligible: true, devMacroAuc: 0.75 },
        { experiment: 'E3', eligible: true, devMacroAuc: 0.75 },
        { experiment: 'E2', eligible: true, devMacroAuc: 0.75 },
      ]),
    ).toBe('E2');
    expect(
      selectCore([
        { experiment: 'E1', eligible: false, devMacroAuc: 0.95 },
        { experiment: 'E2', eligible: true, devMacroAuc: 0.7 },
      ]),
    ).toBe('E2');
    // E4/E5 are never all-language candidates.
    expect(selectCore([{ experiment: 'E4', eligible: true, devMacroAuc: 0.9 }])).toBeNull();
  });
});

describe('step 2: card text mode', () => {
  it('chooses english at a paired gain ≥0.02, as_written below, and marks a missing cohort unmeasured', () => {
    expect(chooseCardMode({ asWritten: 0.7, english: 0.72 })).toMatchObject({
      mode: 'english',
      status: 'measured',
    });
    expect(chooseCardMode({ asWritten: 0.7, english: 0.719 }).mode).toBe('as_written');
    expect(chooseCardMode({ asWritten: null, english: 0.8 })).toEqual({
      mode: 'as_written',
      status: 'unmeasured',
      gain: null,
    });
  });
});

describe('step 3: language modes, the Laya track and the tier-2 cap', () => {
  const both = { native: 0.7, english: 0.72 };
  it('translates only when translation adds ≥0.02 over native', () => {
    expect(
      chooseLanguageMode({ lang: 'sk', native: 0.7, translated: 0.72, bilingual: both }),
    ).toMatchObject({
      mode: 'translate',
      englishComparison: 'native_suffices',
      layaRecommended: false,
    });
    expect(
      chooseLanguageMode({ lang: 'sk', native: 0.7, translated: 0.715, bilingual: both }).mode,
    ).toBe('native');
    expect(
      chooseLanguageMode({ lang: 'sk', native: 0.7, translated: null, bilingual: both }),
    ).toMatchObject({ mode: 'native', translationGain: null });
  });

  it('keeps native and recommends Laya when native falls >0.05 short of English and translation does not help', () => {
    const decision = chooseLanguageMode({
      lang: 'cs',
      native: 0.6,
      translated: 0.61,
      bilingual: { native: 0.6, english: 0.7 },
    });
    expect(decision).toMatchObject({
      mode: 'native',
      englishComparison: 'native_short',
      layaRecommended: true,
    });
    // Short of English but translation helps: translate, no Laya.
    expect(
      chooseLanguageMode({
        lang: 'cs',
        native: 0.6,
        translated: 0.65,
        bilingual: { native: 0.6, english: 0.7 },
      }),
    ).toMatchObject({ mode: 'translate', layaRecommended: false });
  });

  it('uses the within-language gain and flags the English comparison inconclusive without bilingual raters', () => {
    expect(
      chooseLanguageMode({
        lang: 'sk',
        native: 0.7,
        translated: 0.75,
        bilingual: { native: null, english: 0.8 },
      }),
    ).toMatchObject({
      mode: 'translate',
      englishComparison: 'inconclusive',
      layaRecommended: false,
    });
  });

  it('leaves an unmeasured language unset (its current setting stays)', () => {
    expect(
      chooseLanguageMode({
        lang: 'cs',
        native: null,
        translated: 0.8,
        bilingual: { native: null, english: null },
      }),
    ).toMatchObject({ mode: null, layaRecommended: false });
  });

  it('raises the tier-2 cap to 1000 only for a ≥0.05 E4 gain in SK or CS', () => {
    expect(chooseTier2Cap({ sk: 0.05, cs: 0 })).toMatchObject({ cap: 1000, status: 'measured' });
    expect(chooseTier2Cap({ sk: 0.049, cs: -0.1 })).toMatchObject({ cap: 300, status: 'measured' });
    expect(chooseTier2Cap({ sk: null, cs: null })).toMatchObject({
      cap: 300,
      status: 'unmeasured',
    });
    expect(chooseTier2Cap({})).toMatchObject({ cap: 300, status: 'unmeasured' });
  });
});

describe('the actual composed production configuration', () => {
  it('maps every language to the run of its mode within the selected card mode', () => {
    expect(
      composeConfiguration(['en', 'sk', 'cs'], 'as_written', { sk: 'translate', cs: 'native' }),
    ).toEqual({ cs: 'E1', en: 'E1', sk: 'E3' });
    expect(composeConfiguration(['en', 'sk'], 'english', { sk: 'translate' })).toEqual({
      en: 'E2',
      sk: 'E3b',
    });
    // English is never translated; an unmeasured language keeps native.
    expect(composeConfiguration(['en', 'cs'], 'english', { en: 'translate', cs: null })).toEqual({
      cs: 'E2',
      en: 'E2',
    });
  });
});

function pool(
  items: { p: number; liked: boolean; participant?: string; context?: string }[],
): PoolItem[] {
  return items.map((item, i) => ({
    participantKey: item.participant ?? 'owner',
    contextId: item.context ?? 'c1',
    articleId: String(1000 + i),
    p: item.p,
    liked: item.liked,
  }));
}

/** n items at score p with the given like count. */
function block(
  n: number,
  p: number,
  likes: number,
  extra: Partial<{ participant: string; context: string }> = {},
) {
  return Array.from({ length: n }, (_, i) => ({ p, liked: i < likes, ...extra }));
}

describe('step 4: per-language pooling weights', () => {
  it('weights participants equally, then contexts, then articles', () => {
    const weighted = weightPool(
      pool([
        ...block(3, 0.5, 1, { participant: 'owner', context: 'web' }),
        { p: 0.5, liked: true, participant: 'owner', context: 'cooking' },
        ...block(2, 0.5, 0, { participant: 'b', context: 'b1' }),
      ]),
    );
    expect(weighted.map((w) => w.weight)).toEqual([1 / 6, 1 / 6, 1 / 6, 0.5, 0.5, 0.5]);
  });
});

describe('step 4: lanes.forYou and lanes.maybe', () => {
  it('selects the smallest qualifying For You threshold', () => {
    const items = weightPool(
      pool([...block(40, 0.9, 36), ...block(40, 0.6, 20), ...block(120, 0.1, 5)]),
    );
    const decision = selectForYou(items, 'owner_pilot');
    // At 0.50–0.60 the like-rate is 56/80 = 0.70 → 0.50 qualifies already.
    expect(decision).toMatchObject({ value: 0.5, status: 'selected' });
    const stricter = selectForYou(
      weightPool(pool([...block(40, 0.9, 36), ...block(40, 0.6, 10), ...block(120, 0.1, 5)])),
      'owner_pilot',
    );
    expect(stricter).toMatchObject({ value: 0.65, status: 'selected' });
  });

  it('keeps 0.65 and marks the target unmet when nothing qualifies (never "achieved at 0.85")', () => {
    const decision = selectForYou(
      weightPool(pool([...block(100, 0.9, 50), ...block(100, 0.1, 10)])),
      'owner_pilot',
    );
    expect(decision).toMatchObject({ value: 0.65, status: 'unmet' });
    expect(decision.rows.find((r) => r.t === 0.85)?.ok).toBe(false);
  });

  it('requires 30 distinct items, 10 % coverage and, for beta, two participants', () => {
    expect(
      selectForYou(weightPool(pool([...block(29, 0.9, 29), ...block(100, 0.1, 0)])), 'owner_pilot')
        .status,
    ).toBe('unmet');
    // 40 of 1000 items: coverage 4 % < 10 %.
    expect(
      selectForYou(weightPool(pool([...block(40, 0.9, 40), ...block(960, 0.1, 0)])), 'owner_pilot')
        .status,
    ).toBe('unmet');
    const single = weightPool(pool([...block(60, 0.9, 60), ...block(60, 0.1, 0)]));
    expect(selectForYou(single, 'owner_pilot').status).toBe('selected');
    expect(selectForYou(single, 'multi_person_beta').status).toBe('unmet');
  });

  it('selects the largest qualifying Maybe threshold below forYou', () => {
    const items = weightPool(
      pool([...block(60, 0.1, 3), ...block(60, 0.3, 3), ...block(60, 0.45, 30)]),
    );
    // Below 0.35..0.45: 6/120 = 5 %; below 0.50 adds the 0.45 block → 36/180 = 20 %.
    expect(selectMaybe(items, 0.65, 'owner_pilot')).toMatchObject({
      value: 0.45,
      status: 'selected',
    });
    expect(selectMaybe(items, 0.4, 'owner_pilot')).toMatchObject({
      value: 0.35,
      status: 'selected',
    });
  });

  it('falls back to 0.35, or the largest grid point below forYou, marked unmet', () => {
    const items = weightPool(pool([...block(60, 0.1, 30), ...block(60, 0.9, 30)]));
    expect(selectMaybe(items, 0.65, 'owner_pilot')).toMatchObject({ value: 0.35, status: 'unmet' });
    expect(selectMaybe(items, 0.3, 'owner_pilot')).toMatchObject({ value: 0.25, status: 'unmet' });
  });
});

describe('step 4: tiers and the isotonic fallback', () => {
  it('keeps the defaults when the development ECE is ≤0.10', () => {
    const calibrated = weightPool(pool([...block(50, 0.2, 10), ...block(50, 0.8, 40)]));
    expect(selectTiers(calibrated)).toMatchObject({
      value: [0.25, 0.45, 0.65, 0.85],
      status: 'calibrated',
    });
  });

  it('uses isotonic cuts when miscalibrated and all four levels are reached in increasing order', () => {
    // Scores far below their like-rates (ECE 0.35): 0.05→10 %, 0.10→30 %, … 0.25→90 %.
    const items = weightPool(
      pool([
        ...block(50, 0.05, 5),
        ...block(50, 0.1, 15),
        ...block(50, 0.15, 25),
        ...block(50, 0.2, 35),
        ...block(50, 0.25, 45),
      ]),
    );
    const decision = selectTiers(items);
    expect(decision.status).toBe('isotonic');
    expect(decision.ece).toBeCloseTo(0.35, 9);
    expect(decision.value).toEqual([0.1, 0.15, 0.2, 0.25]);
  });

  it('retains every default when a level is never reached (the isotonic fallback)', () => {
    const items = weightPool(pool([...block(100, 0.9, 30), ...block(100, 0.1, 25)]));
    const decision = selectTiers(items);
    expect(decision.status).toBe('fallback');
    expect(decision.value).toEqual([0.25, 0.45, 0.65, 0.85]);
    expect(decision.cuts?.slice(2)).toEqual([null, null]);
  });

  it('is unmeasured without development scores', () => {
    expect(selectTiers([]).status).toBe('unmeasured');
  });
});

describe('step 4: demotion cutoff selection', () => {
  const samples = (rows: [value: number, n: number, positives: number][]) =>
    rows.flatMap(([value, n, positives]) =>
      Array.from({ length: n }, (_, i) => ({ value, positive: i < positives })),
    );

  it('takes the smallest counted cutoff with precision ≥0.80 for a ≥ flag', () => {
    const decision = selectDemotionCutoff(
      'clickbait',
      samples([
        [0.95, 15, 15],
        [0.75, 10, 7],
        [0.55, 20, 5],
        [0.1, 50, 2],
      ]),
    );
    // ≥0.75 flags 25 with 22 yes (0.88); ≥0.55 flags 45 with 27 (0.6).
    expect(decision).toMatchObject({ value: 0.6, status: 'selected', default: 0.8 });
  });

  it('takes the largest counted cutoff for shallow depth (≤)', () => {
    const decision = selectDemotionCutoff(
      'shallowDepth',
      samples([
        [0, 25, 24],
        [0.25, 10, 8],
        [0.5, 30, 3],
      ]),
    );
    // ≤0.25 flags 35 with 32 (0.91); ≤0.50 flags 65 with 35 (0.54).
    expect(decision).toMatchObject({ value: 0.45, status: 'selected', default: 0.25 });
  });

  it('keeps the default, unmet, when counted candidates miss the precision bar', () => {
    const decision = selectDemotionCutoff(
      'promotional',
      samples([
        [0.9, 30, 10],
        [0.1, 30, 0],
      ]),
    );
    expect(decision).toMatchObject({ value: 0.8, status: 'unmet' });
  });

  it('keeps the default, unmeasured, when no candidate flags 20 articles', () => {
    const decision = selectDemotionCutoff(
      'staleTimeSensitive',
      samples([
        [0.9, 19, 19],
        [0.1, 100, 0],
      ]),
    );
    expect(decision).toMatchObject({ value: 0.7, status: 'unmeasured' });
  });

  it('uses exact decimal grids', () => {
    expect(grid(50, 95)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
    expect(grid(10, 50)[2]).toBe(0.2);
  });
});

describe('confirmation on test', () => {
  const participants = (entries: [string, number | null, number | null][]) =>
    new Map(entries.map(([k, candidate, baseline]) => [k, { candidate, baseline }]));

  it('passes with macro ≥ baseline + 0.05, ≥ 0.70 and every participant beating the baseline', () => {
    expect(
      confirmGate({
        macro: 0.75,
        baselineMacro: 0.7,
        participants: participants([['owner', 0.75, 0.7]]),
      }),
    ).toEqual({ status: 'pass', reasons: [] });
  });

  it('fails on a small gain, a low AUC or a participant below the baseline', () => {
    expect(
      confirmGate({
        macro: 0.74,
        baselineMacro: 0.7,
        participants: participants([['o', 0.74, 0.7]]),
      }).status,
    ).toBe('fail');
    expect(
      confirmGate({
        macro: 0.69,
        baselineMacro: 0.6,
        participants: participants([['o', 0.69, 0.6]]),
      }).reasons,
    ).toContain('macro AUC 0.690 < 0.70');
    const one = confirmGate({
      macro: 0.8,
      baselineMacro: 0.6,
      participants: participants([
        ['a', 0.95, 0.6],
        ['b', 0.6, 0.6],
      ]),
    });
    expect(one).toEqual({ status: 'fail', reasons: ['participant b does not beat the baseline'] });
  });

  it('is needs_more_data without a supported macro or participant AUC', () => {
    expect(
      confirmGate({ macro: null, baselineMacro: 0.6, participants: participants([]) }).status,
    ).toBe('needs_more_data');
    expect(
      confirmGate({
        macro: 0.9,
        baselineMacro: 0.6,
        participants: participants([['o', null, 0.6]]),
      }).status,
    ).toBe('needs_more_data');
    expect(
      confirmGate({ macro: 0.9, baselineMacro: 0.6, participants: participants([]) }).status,
    ).toBe('needs_more_data');
  });
});

describe('budget', () => {
  it('applies the ÷1000 divisor, doubles, rounds up to $0.50 and keeps a $1 minimum', () => {
    // $1.20 per 1,000 revisions × 1,500/1000 × 2 = $3.60 → $4.00.
    expect(recommendDailyBudget(1.2, 1500)).toEqual({ value: 4, status: 'measured' });
    expect(recommendDailyBudget(0.5, 2000)).toEqual({ value: 2, status: 'measured' });
    expect(recommendDailyBudget(0.01, 100)).toEqual({ value: 1, status: 'measured' });
    expect(recommendDailyBudget(null, 1000)).toEqual({ value: 1, status: 'unmeasured' });
  });
});
