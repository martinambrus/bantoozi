import type { RunAnswerRow } from '@bantoozi/db';
import { mergeRankerConfig, type RankerConfig } from '@bantoozi/ranker';
import { describe, expect, it } from 'vitest';

import {
  MIN_CELL_ITEMS,
  renderReplayReport,
  replayDiff,
  type ReplayDiff,
} from '../src/experiments/replay.js';
import { withConfigSha, type RunCard, type RunConfig } from '../src/experiments/run-config.js';
import type { RunExperimentResult } from '../src/experiments/runner.js';

/**
 * M3a-T6: the replay diff and its markdown report (spec 10 §6) on fixture runs: per-cell paired
 * ΔAUC with eligibility, the pass rule (no eligible cell drops by more than 0.03, macro AUC does not
 * drop, hard-hide false negatives do not rise, For You precision does not fall by more than 0.03),
 * mean |Δp| per question key and lane changes.
 */

function card(cardId: string, strength: RunCard['strength'], interest: string): RunCard {
  return {
    raterId: '1',
    cardId,
    strength,
    kind: 'interest',
    title: interest,
    interest,
    notFor: null,
    interestEn: null,
    notForEn: null,
    lang: 'en',
    examplesYes: [],
    examplesNo: [],
    visibility: 'shared',
    ownerUserId: null,
    textStatus: null,
  };
}

/** `n` rated articles of rater 1, alternating like/dislike, ids 1000…; all English. */
function fixture(n: number) {
  const ids = Array.from({ length: n }, (_, i) => String(1000 + i));
  const config = withConfigSha({
    experiment: 'E1',
    variant: { state: 'native', cards: 'as_written' },
    datasetVersion: 'golden-v1',
    snapshotSha: 'snap',
    splitSha: 'split',
    seed: 'seed-1',
    engine: {
      provider: 'typesafe',
      model: 'jev-fake',
      requiredEngine: 'typesafe',
      pricePerMTokUsd: 0.042,
      maxOutputTokens: null,
    },
    questionSets: null,
    translation: { articles: null, cards: null },
    langs: ['en'],
    developmentOnly: false,
    raters: [{ raterId: '1', participantKey: 'p', contextName: null, langs: ['en'] }],
    cohort: { articleIds: ids, sha: 'c' },
    assignments: { '1': ids },
    ratings: ids.map((articleId, i) => ({
      raterId: '1',
      articleId,
      rating: i % 2 === 0 ? (1 as const) : (-1 as const),
      reason: null,
      createdAt: '2026-09-20T10:00:00.000Z',
    })),
    cards: [card('10', 'like', 'batteries'), card('11', 'never', 'gossip')],
    facetLabels: [],
    maxUsd: 10,
    runtime: {},
  });
  const articles = new Map(ids.map((id, i) => [id, { lang: 'en', storyGroupId: `g${i}` }]));
  return { ids, config, articles };
}

/** Score and card rows of one run: liked items get `liked(i)`, disliked `disliked(i)`. */
function rows(
  runId: string,
  ids: string[],
  liked: (i: number) => number,
  disliked: (i: number) => number,
  options: { never?: (i: number) => number; enrich?: number } = {},
): RunAnswerRow[] {
  return ids.flatMap((articleId, i) => {
    const p = i % 2 === 0 ? liked(i) : disliked(i);
    const out: RunAnswerRow[] = [
      { runId, articleId, cardId: null, questionKey: 'score.r1', answer: { score: p } },
      {
        runId,
        articleId,
        cardId: '10',
        questionKey: 'card',
        answer: { ok: true, p, engine: 'typesafe' },
      },
      {
        runId,
        articleId,
        cardId: '11',
        questionKey: 'card',
        answer: { ok: true, p: options.never?.(i) ?? 0.02, engine: 'typesafe' },
      },
    ];
    if (options.enrich !== undefined) {
      out.push({
        runId,
        articleId,
        cardId: null,
        questionKey: 'enrich.is_news',
        answer: { ok: true, answer: { type: 'noul', p: options.enrich } },
      });
    }
    return out;
  });
}

const diffOf = (
  f: ReturnType<typeof fixture>,
  base: RunAnswerRow[],
  replay: RunAnswerRow[],
  replayRanker: RankerConfig = mergeRankerConfig({}),
) =>
  replayDiff({
    config: f.config,
    articles: f.articles,
    base,
    replay,
    baseRanker: mergeRankerConfig({}),
    replayRanker,
    replayStatus: 'complete',
  });

describe('replayDiff', () => {
  const f = fixture(24);
  const base = rows(
    '1',
    f.ids,
    (i) => 0.6 + (i % 5) / 20,
    (i) => 0.1 + (i % 7) / 20,
    {
      enrich: 0.8,
    },
  );

  it('passes an identical replay with ΔAUC 0 and no lane changes', () => {
    const diff = diffOf(
      f,
      base,
      rows(
        '2',
        f.ids,
        (i) => 0.6 + (i % 5) / 20,
        (i) => 0.1 + (i % 7) / 20,
        { enrich: 0.8 },
      ),
    );
    expect(diff.verdict).toBe('pass');
    expect(diff.reasons).toEqual([]);
    expect(diff.cells).toHaveLength(1);
    expect(diff.cells[0]).toMatchObject({ raterId: '1', lang: 'en', eligible: true });
    expect(diff.cells[0]?.auc).toMatchObject({ n: 24, positives: 12, negatives: 12, delta: 0 });
    expect(diff.macro.delta).toBe(0);
    expect(diff.laneChange).toEqual({ changed: 0, total: 24 });
    expect(diff.coverage).toEqual({ base: 24, replay: 24, expected: 24 });
    expect(diff.deltaP).toEqual([
      { key: 'card', meanAbs: 0, n: 48 },
      { key: 'enrich.is_news', meanAbs: 0, n: 24 },
    ]);
  });

  it('fails a replay whose AUC drops and reports |Δp| per key', () => {
    const worse = rows(
      '2',
      f.ids,
      (i) => 0.3 + (i % 5) / 20,
      (i) => 0.2 + (i % 7) / 20,
      {
        enrich: 0.5,
      },
    );
    const diff = diffOf(f, base, worse);
    expect(diff.verdict).toBe('fail');
    expect(diff.reasons.some((r) => r.startsWith('rater 1 en: AUC drops'))).toBe(true);
    expect(diff.reasons.some((r) => r.startsWith('macro AUC drops'))).toBe(true);
    expect(diff.deltaP.find((d) => d.key === 'enrich.is_news')?.meanAbs).toBeCloseTo(0.3, 10);
    expect(diff.laneChange.changed).toBeGreaterThan(0);
  });

  it('fails when a never card starts hiding liked items', () => {
    const hiding = rows(
      '2',
      f.ids,
      (i) => 0.6 + (i % 5) / 20,
      (i) => 0.1 + (i % 7) / 20,
      {
        never: (i) => (i % 4 === 0 ? 0.95 : 0.02),
        enrich: 0.8,
      },
    );
    const diff = diffOf(f, base, hiding);
    expect(diff.policy.replay.hardHideFalseNegatives).toBeGreaterThan(0);
    expect(diff.policy.base.hardHideFalseNegatives).toBe(0);
    expect(diff.verdict).toBe('fail');
    expect(diff.reasons).toContain('the hard-hide false-negative rate increases');
  });

  it('applies only the AUC rules against the B1 keyword baseline (first enablement)', () => {
    const hiding = rows(
      '2',
      f.ids,
      (i) => 0.6 + (i % 5) / 20,
      (i) => 0.1 + (i % 7) / 20,
      {
        never: (i) => (i % 4 === 0 ? 0.95 : 0.02),
        enrich: 0.8,
      },
    );
    const diff = replayDiff({
      config: f.config,
      articles: f.articles,
      base,
      replay: hiding,
      baseRanker: mergeRankerConfig({}),
      replayRanker: mergeRankerConfig({}),
      replayStatus: 'complete',
      keywordBaseline: true,
    });
    expect(diff.policy.replay.hardHideFalseNegatives).toBeGreaterThan(0);
    expect(diff.reasons).not.toContain('the hard-hide false-negative rate increases');
  });

  it('applies proposed thresholds to the replay side only', () => {
    const same = rows(
      '2',
      f.ids,
      (i) => 0.6 + (i % 5) / 20,
      (i) => 0.1 + (i % 7) / 20,
    );
    const diff = diffOf(f, base, same, mergeRankerConfig({ lanes: { forYou: 0.95 } }));
    expect(diff.policy.base.forYou).toBeGreaterThan(0);
    expect(diff.policy.replay.forYou).toBe(0);
    expect(diff.laneChange.changed).toBeGreaterThan(0);
    // A thresholds-only change that empties the For You lane fails (AUC is unchanged).
    expect(diff.verdict).toBe('fail');
    expect(diff.reasons.some((r) => r.startsWith('the For You lane is emptied'))).toBe(true);
  });

  it('is inconclusive when the For You lane is empty on both sides', () => {
    const empty = mergeRankerConfig({ lanes: { forYou: 0.95 } });
    const diff = replayDiff({
      config: f.config,
      articles: f.articles,
      base,
      replay: base,
      baseRanker: empty,
      replayRanker: empty,
      replayStatus: 'complete',
    });
    expect(diff.policy.base.forYou).toBe(0);
    expect(diff.verdict).toBe('inconclusive');
    expect(diff.reasons).toContain(
      'For You precision is unsupported: the lane is empty on both sides',
    );
  });

  it('is inconclusive without an eligible cell or with missing replay output', () => {
    const small = fixture(MIN_CELL_ITEMS - 2);
    const smallBase = rows(
      '1',
      small.ids,
      () => 0.8,
      () => 0.2,
    );
    const tooSmall = diffOf(
      small,
      smallBase,
      rows(
        '2',
        small.ids,
        () => 0.1,
        () => 0.9,
      ),
    );
    expect(tooSmall.cells[0]?.eligible).toBe(false);
    expect(tooSmall.verdict).toBe('inconclusive');

    const missing = rows(
      '2',
      f.ids,
      () => 0.8,
      () => 0.2,
    ).filter((row) => !(row.articleId === f.ids[0] && row.questionKey === 'score.r1'));
    const partial = diffOf(f, base, missing);
    expect(partial.coverage.replay).toBe(23);
    expect(partial.verdict).toBe('inconclusive');
    expect(partial.reasons[0]).toMatch(/coverage 23\/24/);
  });
});

describe('replayDiff unsupported cells (D-113 addendum)', () => {
  it('is inconclusive when one evaluated cell is supported and another is not', () => {
    // 24 English items (supported) and 6 Slovak ones (unsupported) of rater 1, scored identically.
    const f = fixture(30);
    const articles = new Map(
      f.ids.map((id, i) => [id, { lang: i < 24 ? 'en' : 'sk', storyGroupId: `g${i}` }]),
    );
    const mixed = { ...f, articles };
    const scores = (runId: string) =>
      rows(
        runId,
        f.ids,
        (i) => 0.6 + (i % 5) / 20,
        (i) => 0.1 + (i % 7) / 20,
      );
    const diff = diffOf(mixed, scores('1'), scores('2'));
    expect(diff.cells.map((c) => [c.lang, c.eligible])).toEqual([
      ['en', true],
      ['sk', false],
    ]);
    expect(diff.verdict).toBe('inconclusive');
    expect(diff.reasons.join('\n')).toMatch(
      /unsupported rater\/language cell\(s\).*rater 1 sk \(6 items, 3\/3\)/,
    );

    // A measured regression in the supported cell still fails.
    const worse = rows(
      '2',
      f.ids,
      (i) => (i < 24 ? 0.1 + (i % 7) / 20 : 0.6 + (i % 5) / 20),
      (i) => (i < 24 ? 0.6 + (i % 5) / 20 : 0.1 + (i % 7) / 20),
    );
    expect(diffOf(mixed, scores('1'), worse).verdict).toBe('fail');
  });
});

describe('replayDiff guards and lane shares', () => {
  const f = fixture(24);
  const liked = (i: number) => 0.6 + (i % 5) / 20;
  const disliked = (i: number) => 0.1 + (i % 7) / 20;

  it('is inconclusive when the base run is missing output', () => {
    const base = rows('1', f.ids, liked, disliked).filter(
      (row) => !(row.articleId === f.ids[1] && row.questionKey === 'score.r1'),
    );
    const diff = diffOf(f, base, rows('2', f.ids, liked, disliked));
    expect(diff.coverage.base).toBe(23);
    expect(diff.verdict).toBe('inconclusive');
    expect(diff.reasons).toContain('base output coverage 23/24 is incomplete');
  });

  it('counts the Maybe lane per side', () => {
    const base = rows('1', f.ids, liked, disliked);
    // Scores between maybe (0.35) and forYou (0.65) land in Maybe.
    const replay = rows(
      '2',
      f.ids,
      () => 0.5,
      () => 0.4,
    );
    const diff = diffOf(f, base, replay);
    expect(diff.policy.replay.items).toBe(24);
    expect(diff.policy.replay.maybe).toBe(24);
    expect(diff.policy.replay.maybeLiked).toBe(12);
    expect(diff.policy.base.items).toBe(24);
    expect(diff.policy.base.maybe).toBeLessThan(24);
  });
});

describe('renderReplayReport', () => {
  it('writes the markdown sections of spec 10 §6', () => {
    const f = fixture(24);
    const base = rows(
      '1',
      f.ids,
      () => 0.8,
      () => 0.2,
    );
    const diff: ReplayDiff = diffOf(
      f,
      base,
      rows(
        '2',
        f.ids,
        () => 0.8,
        () => 0.2,
      ),
    );
    const run: RunExperimentResult = {
      runId: '2',
      status: 'complete',
      estimate: { estimatedUsd: 0, uncachedCalls: 0, cacheHits: 72 },
      results: {
        status: 'complete',
        coverage: { byLang: {}, byRater: {} },
        cost: {
          estimatedUsd: 0,
          billedUsd: 0,
          cacheHits: 72,
          cacheMisses: 0,
          cacheSavingsUsd: 0.0123,
          failedCallUsd: 0,
          tokens: { input: 0, output: 0 },
          byLang: { en: { estimatedUsd: 0, billedUsd: 0, cacheSavingsUsd: 0.0123 } },
        },
        latencyMs: {},
        cacheLookupMs: { p50: 0, p95: 0, n: 72 },
      },
    };
    const report = renderReplayReport({
      baseRunId: '1',
      baseExperiment: 'E1',
      replayRunId: '2',
      config: f.config as RunConfig,
      change: {
        of: '1',
        engine: 'typesafe',
        model: 'jev-fake',
        questionSet: 'enrich-v1',
        thresholds: { lanes: { forYou: 0.7 } },
      },
      engine: f.config.engine!,
      run,
      diff,
    });
    expect(report).toContain('# Replay 2 vs run 1 (E1)');
    expect(report).toContain('## Verdict: PASS');
    expect(report).toContain('## ΔAUC per rater and language');
    expect(report).toContain('| 1 | en | 24 | 12 | 12 | 1.000 | 1.000 | 0.000 |');
    expect(report).toContain('## Mean |Δp| per question key');
    expect(report).toContain('## Lanes and policy');
    expect(report).toMatch(/- base: .*Maybe share \d+\/24 \(/);
    expect(report).toMatch(/- replay: .*Maybe share \d+\/24 \(/);
    expect(report).toContain('72 cache hit(s), savings $0.0123');
    expect(report).toContain('thresholds `{"lanes":{"forYou":0.7}}`');
    expect(report).toContain('regression checks, not new independent quality proof');
  });
});

describe('replay macro AUC (the gate’s hierarchical macro, D-110)', () => {
  // Raters 1–3 are reading contexts of participant p1, rater 4 the only context of p2. Each rates
  // 20 English articles (10 liked at 0.50…0.68, 10 disliked at 0.30…0.39); the base misorders two
  // pairs per rater (AUC 0.98).
  const raters = ['1', '2', '3', '4'];
  const participant = (raterId: string) => (raterId === '4' ? 'p2' : 'p1');
  const idsOf = (raterId: string) =>
    Array.from({ length: 20 }, (_, i) => String(2000 + Number(raterId) * 100 + i));
  const f = fixture(2);
  const config = withConfigSha({
    ...f.config,
    raters: raters.map((raterId) => ({
      raterId,
      participantKey: participant(raterId),
      contextName: null,
      langs: ['en'],
    })),
    cohort: { articleIds: raters.flatMap(idsOf), sha: 'c4' },
    assignments: Object.fromEntries(raters.map((r) => [r, idsOf(r)])),
    ratings: raters.flatMap((raterId) =>
      idsOf(raterId).map((articleId, i) => ({
        raterId,
        articleId,
        rating: i < 10 ? (1 as const) : (-1 as const),
        reason: null,
        createdAt: '2026-09-20T10:00:00.000Z',
      })),
    ),
    cards: [],
  });
  const articles = new Map(
    raters.flatMap(idsOf).map((id) => [id, { lang: 'en', storyGroupId: `g${id}` }]),
  );
  /** Scores with the disliked items at `overrides[k]` (else 0.30 + 0.01·k). */
  const scores = (runId: string, overrides: (raterId: string) => Record<number, number>) =>
    raters.flatMap((raterId) =>
      idsOf(raterId).map((articleId, i): RunAnswerRow => {
        const k = i - 10;
        const p = i < 10 ? 0.5 + 0.02 * i : (overrides(raterId)[k] ?? 0.3 + 0.01 * k);
        return {
          runId,
          articleId,
          cardId: null,
          questionKey: `score.r${raterId}`,
          answer: { score: p },
        };
      }),
    );
  const base = scores('1', () => ({ 0: 0.51, 1: 0.505 }));
  // p1's contexts each fix one misordered pair (+0.01); p2's context adds two (−0.02).
  const replay = scores('2', (raterId) =>
    raterId === '4' ? { 0: 0.51, 1: 0.505, 2: 0.515, 3: 0.518 } : { 0: 0.51 },
  );

  it('weights participants equally: three +0.01 contexts and one −0.02 context fail', () => {
    const diff = replayDiff({
      config,
      articles,
      base,
      replay,
      baseRanker: mergeRankerConfig({}),
      replayRanker: mergeRankerConfig({}),
      replayStatus: 'complete',
    });
    const deltas = Object.fromEntries(diff.cells.map((c) => [c.raterId, c.auc.delta]));
    for (const raterId of ['1', '2', '3']) expect(deltas[raterId]).toBeCloseTo(0.01, 9);
    expect(deltas['4']).toBeCloseTo(-0.02, 9);
    // A flat mean over the four cells would be +0.0025; the hierarchical macro is −0.005.
    expect(diff.macro.participants).toBe(2);
    expect(diff.macro.delta).toBeCloseTo((0.01 - 0.02) / 2, 9);
    expect(diff.macro.ci).not.toBeNull();
    expect(diff.verdict).toBe('fail');
    expect(diff.reasons).toContain('macro AUC drops by 0.005');
    expect(diff.reasons.some((r) => r.includes('AUC drops by 0.020'))).toBe(false);
  });
});
