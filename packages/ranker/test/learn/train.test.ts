import { describe, expect, it } from 'vitest';

import {
  applyPlatt,
  FEATURE_SPEC_V1_FACET_NAMES,
  FEATURE_SPEC_V1_SHA,
  fitLogistic,
  snapshotFeatures,
} from '../../src/index.js';
import type { RawFeatureSnapshot } from '../../src/index.js';
import { api, weightOf } from './support/api.js';
import type { ContextInput, StoredModel, TrainResult, TrainingSample } from './support/api.js';
import {
  CARD_A,
  CARD_B,
  CARD_C,
  CARD_N,
  CFG,
  CONSENT,
  DAY,
  drivenSamples,
  HELD,
  NOW,
  noiseSamples,
  RATING_SHA,
  sample,
  snapshot,
  trainArgs,
} from './support/synth.js';

const ELIG = { now: NOW, historyDays: 180, ratingSha: RATING_SHA };

function withFeatures(
  s: TrainingSample,
  change: (f: RawFeatureSnapshot) => RawFeatureSnapshot,
): TrainingSample {
  if (s.features === null) throw new Error('no snapshot');
  return { ...s, features: change(s.features) };
}

let cached: TrainResult | undefined;
function goodResult(): TrainResult {
  cached ??= api.trainUserModel(trainArgs(drivenSamples(300, 'drive')), { mode: 'production' });
  return cached;
}

describe('sampleEligibility', () => {
  const base = sample(1, 1);

  it('accepts a valid sample', () => {
    expect(api.sampleEligibility(base, ELIG)).toEqual({ ok: true });
  });

  it('missing_snapshot: no event-time features', () => {
    expect(api.sampleEligibility({ ...base, features: null }, ELIG)).toEqual({
      ok: false,
      reason: 'missing_snapshot',
    });
  });

  it('spec_sha_mismatch', () => {
    const s = withFeatures(base, (f) => ({ ...f, specSha: 'b'.repeat(64) }));
    expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'spec_sha_mismatch' });
  });

  it('rating_sha_mismatch', () => {
    const s = withFeatures(base, (f) => ({ ...f, ratingSha: 'c'.repeat(64) }));
    expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'rating_sha_mismatch' });
  });

  it('a null ratingSha skips both sha checks', () => {
    const s = withFeatures(base, (f) => ({ ...f, specSha: 'b'.repeat(64), ratingSha: 'c'.repeat(64) }));
    expect(api.sampleEligibility(s, { ...ELIG, ratingSha: null })).toEqual({ ok: true });
  });

  it('too_old: snapshotAt, feedbackAt, and feedbackAt alone when snapshotAt is absent', () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    const bySnapshot = withFeatures(base, (f) => ({ ...f, snapshotAt: old.toISOString() }));
    expect(api.sampleEligibility(bySnapshot, ELIG)).toEqual({ ok: false, reason: 'too_old' });
    expect(api.sampleEligibility({ ...base, feedbackAt: old }, ELIG)).toEqual({
      ok: false,
      reason: 'too_old',
    });
    const noSnapshotAt = withFeatures({ ...base, feedbackAt: old }, (f) => ({
      ...f,
      snapshotAt: undefined as unknown as string,
    }));
    expect(api.sampleEligibility(noSnapshotAt, ELIG)).toEqual({ ok: false, reason: 'too_old' });
    expect(api.sampleEligibility({ ...base, feedbackAt: new Date(NOW.getTime() - 170 * DAY) }, ELIG).ok).toBe(
      true,
    );
  });

  it('no_facets: null facets', () => {
    const s = withFeatures(base, (f) => ({ ...f, values: { ...f.values, facets: null } }));
    expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'no_facets' });
  });

  it('invalid_facets: a missing key or a value outside [0, 1]', () => {
    const missing = withFeatures(base, (f) => {
      const facets = { ...f.values.facets };
      delete facets[FEATURE_SPEC_V1_FACET_NAMES[3] ?? ''];
      return { ...f, values: { ...f.values, facets } };
    });
    expect(api.sampleEligibility(missing, ELIG)).toEqual({ ok: false, reason: 'invalid_facets' });
    for (const bad of [1.2, -0.1]) {
      const s = withFeatures(base, (f) => ({
        ...f,
        values: { ...f.values, facets: { ...f.values.facets, depth: bad } },
      }));
      expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'invalid_facets' });
    }
  });

  it('foreign_engine: facets or a card answer from llm/laya', () => {
    const facets = withFeatures(base, (f) => ({ ...f, values: { ...f.values, facetsEngine: 'laya' } }));
    expect(api.sampleEligibility(facets, ELIG)).toEqual({ ok: false, reason: 'foreign_engine' });
    for (const engine of ['llm', 'laya']) {
      const s = withFeatures(base, (f) => ({
        ...f,
        cards: f.cards.map((c) => (c.id === CARD_B ? { ...c, engine } : c)),
      }));
      expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'foreign_engine' });
    }
  });

  it('incomplete_coverage: a positive card without a usable p, prefilter included; never cards do not count', () => {
    const nullP = withFeatures(base, (f) => ({
      ...f,
      cards: f.cards.map((c) => (c.id === CARD_B ? { ...c, p: null, engine: null } : c)),
    }));
    expect(api.sampleEligibility(nullP, ELIG)).toEqual({ ok: false, reason: 'incomplete_coverage' });
    expect(api.sampleEligibility(sample(2, 1, { pA: null }), ELIG)).toEqual({
      ok: false,
      reason: 'incomplete_coverage',
    });
    expect(api.sampleEligibility(sample(3, 1, { pN: null }), ELIG)).toEqual({ ok: true });
  });

  it('no_positive_cards: none, or only never cards', () => {
    for (const keep of [0, 1]) {
      const s = withFeatures(base, (f) => ({
        ...f,
        cards: f.cards.filter((c) => c.strength === 'never').slice(0, keep),
      }));
      expect(api.sampleEligibility(s, ELIG)).toEqual({ ok: false, reason: 'no_positive_cards' });
    }
  });
});

describe('eligibleSetSha', () => {
  const set = Array.from({ length: 12 }, (_, i) => sample(i, i % 2 === 0 ? 1 : 0, { ageDays: 5 + i }));

  it('changes when one sample flips y, and not with the input order', () => {
    const sha = api.eligibleSetSha(set, ELIG);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const flipped = set.map((s, i) => (i === 4 ? { ...s, y: s.y === 1 ? (0 as const) : (1 as const) } : s));
    expect(api.eligibleSetSha(flipped, ELIG)).not.toBe(sha);
    expect(api.eligibleSetSha([...set].reverse(), ELIG)).toBe(sha);
    const reweighted = set.map((s, i) => (i === 4 ? { ...s, weight: s.weight / 2 } : s));
    expect(api.eligibleSetSha(reweighted, ELIG)).not.toBe(sha);
  });

  it('changes when `now` expires a sample, and when an ineligible one is added', () => {
    const edge = [...set, sample(50, 1, { ageDays: 179.5 })];
    const sha = api.eligibleSetSha(edge, ELIG);
    const later = api.eligibleSetSha(edge, { ...ELIG, now: new Date(NOW.getTime() + 2 * DAY) });
    expect(later).not.toBe(sha);
    expect(api.eligibleSetSha([...edge, sample(51, 1, { withSnapshot: false })], ELIG)).toBe(sha);
  });
});

describe('ownInputs', () => {
  /** n explicit samples that match card A (p 0.8) with the given classes, plus 20 non-matching. */
  function matching(classes: (0 | 1)[], extra: Partial<Parameters<typeof sample>[2]> = {}) {
    const out = classes.map((y, i) => sample(i, y, { pA: 0.8, ...extra }));
    for (let i = 0; i < 20; i += 1) out.push(sample(100 + i, i % 2 === 0 ? 1 : 0, { pA: 0.2 }));
    return out;
  }

  it('needs cardMinMatched (8) explicit matches: 7 is not enough, 8 is', () => {
    const seven = matching([1, 0, 1, 0, 1, 0, 1]);
    const eight = matching([1, 0, 1, 0, 1, 0, 1, 0]);
    expect(api.ownInputs(seven, HELD, CFG)).toEqual([]);
    expect(api.ownInputs(eight, HELD, CFG)).toEqual([CARD_A]);
  });

  it('does not count implicit samples toward the 8', () => {
    const s = [...matching([1, 0, 1, 0, 1, 0, 1]), ...[1, 0, 1].map((y, i) => sample(200 + i, y as 0 | 1, { pA: 0.8, explicit: false }))];
    expect(api.ownInputs(s, HELD, CFG)).toEqual([]);
  });

  it('needs at least one like and one dislike among the matches', () => {
    expect(api.ownInputs(matching([1, 1, 1, 1, 1, 1, 1, 1]), HELD, CFG)).toEqual([]);
    expect(api.ownInputs(matching([0, 0, 0, 0, 0, 0, 0, 0]), HELD, CFG)).toEqual([]);
  });

  it('needs the card to be held now', () => {
    const eight = matching([1, 0, 1, 0, 1, 0, 1, 0]);
    expect(api.ownInputs(eight, HELD.filter((h) => h.cardId !== CARD_A), CFG)).toEqual([]);
  });

  it('applies to a held never card too', () => {
    const s = Array.from({ length: 8 }, (_, i) => sample(i, i % 2 === 0 ? 1 : 0, { pN: 0.9 }));
    expect(api.ownInputs(s, HELD, CFG)).toEqual([CARD_N]);
  });
});

describe('groupFolds', () => {
  const balanced: TrainingSample[] = Array.from({ length: 80 }, (_, i) =>
    sample(i, i % 2 === 0 ? 1 : 0, { groupId: `g-${Math.floor(i / 2)}` }),
  );
  // groups of two share a class only when i and i+1 do; mix so groups hold one article of each parity
  const grouped: TrainingSample[] = [
    ...balanced.map((s, i) => ({ ...s, y: (Math.floor(i / 4) % 2 === 0 ? 1 : 0) as 0 | 1 })),
    sample(900, 1, { explicit: false, groupId: 'g-0' }),
    sample(901, 0, { explicit: false, groupId: 'g-7' }),
  ];

  it('never lets a group span folds, implicit members included', () => {
    for (const k of [3, 4, 5]) {
      const folds = api.groupFolds(grouped, k, 'seed');
      expect(folds).toHaveLength(grouped.length);
      const byGroup = new Map<string, number>();
      grouped.forEach((s, i) => {
        const f = folds[i] ?? -1;
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThan(k);
        expect(byGroup.get(s.groupId) ?? f).toBe(f);
        byGroup.set(s.groupId, f);
      });
    }
  });

  it('puts both explicit classes in every fold for a balanced input', () => {
    for (const k of [3, 5]) {
      const folds = api.groupFolds(grouped, k, 'seed');
      for (let f = 0; f < k; f += 1) {
        const ys = new Set(grouped.filter((s, i) => folds[i] === f && s.explicit).map((s) => s.y));
        expect(ys).toEqual(new Set([0, 1]));
      }
    }
  });

  it('is deterministic for the same seed', () => {
    expect(api.groupFolds(grouped, 5, 'seed')).toEqual(api.groupFolds(grouped, 5, 'seed'));
    expect(api.groupFolds([...grouped].reverse(), 5, 'seed').reverse()).toEqual(
      api.groupFolds(grouped, 5, 'seed'),
    );
  });
});

describe('chooseLambda', () => {
  it('picks the minimum loss', () => {
    expect(
      api.chooseLambda([
        { lambda: 1, loss: 0.5 },
        { lambda: 3, loss: 0.4 },
        { lambda: 10, loss: 0.45 },
        { lambda: 30, loss: 0.6 },
      ]),
    ).toBe(3);
  });

  it('breaks exact ties (and 1e-12 near-ties) toward the larger lambda', () => {
    expect(
      api.chooseLambda([
        { lambda: 10, loss: 0.4 },
        { lambda: 1, loss: 0.4 },
        { lambda: 100, loss: 0.9 },
      ]),
    ).toBe(10);
    expect(
      api.chooseLambda([
        { lambda: 3, loss: 0.4 },
        { lambda: 30, loss: 0.4 + 1e-14 },
      ]),
    ).toBe(30);
  });
});

describe('trainUserModel', () => {
  it('recovers the driving weights and activates on synthetic data (n≈300)', () => {
    const r = goodResult();
    expect(r.model).not.toBeNull();
    expect(r.activation).toEqual({ eligible: true, reasons: [] });
    expect(r.metrics.cvAuc).toBeGreaterThanOrEqual(0.9);
    expect(r.metrics.nExplicit).toBeGreaterThanOrEqual(230);
    expect(r.metrics.research).toBe(false);
    expect(r.metrics.contextSha).toMatch(/^[0-9a-f]{64}$/);
    expect(CFG.model.lambdaGrid).toContain(r.metrics.lambda);
    expect(r.metrics.ownInputs).toContain(CARD_A);
    const m = r.model as StoredModel;
    expect(weightOf(m, `card.${CARD_A}`)).toBeGreaterThan(0);
    expect(weightOf(m, 't1.technology')).toBeGreaterThan(0);
    expect(weightOf(m, 'clickbait')).toBeLessThan(0);
  });

  it('fits own inputs and the scaler per training partition (observable limitation: final model + noise)', () => {
    // Card C matches exactly 8 explicit samples overall, so it is an own input of the final model
    // but of no fold's training partition (each fold removes some of the 8). The per-fold rule is
    // not observable through the contract; assert the final-model rule and that pure noise does not
    // cross-validate above chance (a leaking fold fit would inflate it).
    const base = noiseSamples(120, 'noise');
    const withC = base.map((s, i) => {
      const matchIdx = [0, 1, 2, 3, 4, 5, 6, 7].indexOf(i);
      return matchIdx < 0 ? { ...s, features: snapshot(s.feedbackAt, { pC: 0.1, pA: 0.3, pB: 0.3, pN: 0.1 }) } : sample(i, matchIdx % 2 === 0 ? 1 : 0, { pC: 0.9, pA: 0.3, pB: 0.3, pN: 0.1 });
    });
    expect(api.ownInputs(withC, HELD, CFG)).toEqual([CARD_C]);
    const r = api.trainUserModel(trainArgs(withC), { mode: 'production' });
    expect(r.metrics.ownInputs).toEqual([CARD_C]);
    expect(r.metrics.cvAuc === null || r.metrics.cvAuc < 0.7).toBe(true);
    expect(r.activation.eligible).toBe(false);
  });

  it('fails safely: one class, too few explicit, too few groups, empty; none throws', () => {
    const one = Array.from({ length: 40 }, (_, i) => sample(i, 1, { pA: i / 40 }));
    const rOne = api.trainUserModel(trainArgs(one), { mode: 'production' });
    expect(rOne.activation.eligible).toBe(false);
    expect(rOne.activation.reasons).toContain('insufficient_class');
    expect(rOne.model === null || rOne.activation.eligible === false).toBe(true);

    const small = drivenSamples(20, 'small');
    const rSmall = api.trainUserModel(trainArgs(small.map((s) => ({ ...s, explicit: true }))), {
      mode: 'production',
    });
    expect(rSmall.activation.eligible).toBe(false);
    expect(rSmall.activation.reasons).toContain('insufficient_explicit');

    const twoGroups = drivenSamples(80, 'two').map((s, i) => ({ ...s, explicit: true, groupId: `g-${i % 2}` }));
    const rGroups = api.trainUserModel(trainArgs(twoGroups), { mode: 'production' });
    expect(rGroups.activation.eligible).toBe(false);
    expect(rGroups.activation.reasons).toContain('insufficient_validation');

    const rEmpty = api.trainUserModel(trainArgs([]), { mode: 'production' });
    expect(rEmpty.activation.eligible).toBe(false);
    expect(rEmpty.model).toBeNull();
  });

  it('excludes missing event-time snapshots and counts them, never reconstructing them', () => {
    const good = drivenSamples(60, 'miss').map((s) => ({ ...s, explicit: true }));
    const missing = Array.from({ length: 5 }, (_, i) => sample(500 + i, 1, { withSnapshot: false }));
    const r = api.trainUserModel(trainArgs([...good, ...missing]), { mode: 'production' });
    expect(r.metrics.skipped['missing_snapshot']).toBe(5);
    expect(r.metrics.nExplicit).toBe(60);
    const clean = api.trainUserModel(trainArgs(good), { mode: 'production' });
    expect(clean.metrics.skipped['missing_snapshot'] ?? 0).toBe(0);
  });

  it('research mode: below the minimums still returns a fitted model, flagged and never eligible', () => {
    const small = drivenSamples(20, 'res').map((s) => ({ ...s, explicit: true }));
    const prod = api.trainUserModel(trainArgs(small), { mode: 'production' });
    expect(prod.activation.eligible).toBe(false);
    const r = api.trainUserModel(trainArgs(small), { mode: 'research' });
    expect(r.model).not.toBeNull();
    expect(r.metrics.research).toBe(true);
    expect(r.activation.eligible).toBe(false);
  });

  it('is reproducible: same inputs and seedMaterial give identical metrics and weights', () => {
    const s = drivenSamples(100, 'repro');
    const a = api.trainUserModel(trainArgs(s), { mode: 'production' });
    const b = api.trainUserModel(trainArgs([...s].reverse()), { mode: 'production' });
    const c = api.trainUserModel(trainArgs(s), { mode: 'production' });
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(JSON.stringify(b.metrics)).toBe(JSON.stringify(a.metrics));
    expect(JSON.stringify(b.model)).toBe(JSON.stringify(a.model));
  });

  it('context sha ignores a non-own held card and follows an own input card hash', () => {
    const r = goodResult();
    expect(r.metrics.ownInputs).toContain(CARD_A);
    const s = drivenSamples(300, 'drive');
    const otherCard = HELD.find((h) => !r.metrics.ownInputs.includes(h.cardId));
    expect(otherCard).toBeDefined();
    const changedOther = api.trainUserModel(
      trainArgs(s, {
        heldCards: HELD.map((h) =>
          h.cardId === otherCard?.cardId ? { ...h, strength: 'like', cardInputSha256: 'changed' } : h,
        ),
      }),
      { mode: 'production' },
    );
    expect(changedOther.metrics.contextSha).toBe(r.metrics.contextSha);
    const changedOwn = api.trainUserModel(
      trainArgs(s, {
        heldCards: HELD.map((h) => (h.cardId === CARD_A ? { ...h, cardInputSha256: 'edited' } : h)),
      }),
      { mode: 'production' },
    );
    expect(changedOwn.metrics.contextSha).not.toBe(r.metrics.contextSha);
  });
});

describe('own-input weight growth', () => {
  it('|weight of card.<id>| at 1,000 ratings exceeds the one at 30 under the summed-loss penalty', () => {
    const all = drivenSamples(1000, 'grow').map((s) => ({ ...s, explicit: true }));
    const fitWeight = (n: number): number => {
      const rows = all.slice(0, n).filter((s) => s.features !== null);
      const vectors = rows.map((s) =>
        snapshotFeatures(s.features as RawFeatureSnapshot, CFG, [CARD_A]),
      );
      const names = Object.keys(vectors[0] ?? {});
      const X = vectors.map((v) => names.map((k) => v[k] ?? 0));
      const fit = fitLogistic(
        X,
        rows.map((s) => s.y),
        rows.map((s) => s.weight),
        10,
      );
      if (!fit.ok) throw new Error(`fit failed: ${fit.reason}`);
      return Math.abs(fit.weights[names.indexOf(`card.${CARD_A}`)] ?? 0);
    };
    const w30 = fitWeight(30);
    const w1000 = fitWeight(1000);
    expect(w30).toBeGreaterThan(0);
    expect(w1000).toBeGreaterThan(w30);
  });
});

describe('decideActivation', () => {
  const ctx = (): { currentRatingSha: string; currentContextSha: string } => ({
    currentRatingSha: RATING_SHA,
    currentContextSha: goodResult().metrics.contextSha ?? 'missing',
  });

  it('activates a good candidate whose fingerprint and context are current', () => {
    expect(api.decideActivation(goodResult(), ctx())).toEqual({ activate: true, reasons: [] });
  });

  it('rating_fingerprint_changed', () => {
    const d = api.decideActivation(goodResult(), { ...ctx(), currentRatingSha: 'd'.repeat(64) });
    expect(d.activate).toBe(false);
    expect(d.reasons).toContain('rating_fingerprint_changed');
  });

  it('context_changed', () => {
    const d = api.decideActivation(goodResult(), { ...ctx(), currentContextSha: 'e'.repeat(64) });
    expect(d.activate).toBe(false);
    expect(d.reasons).toContain('context_changed');
  });

  it.each([
    'insufficient_explicit',
    'insufficient_class',
    'insufficient_validation',
    'singular',
    'nonfinite',
    'nonconverged',
    'low_auc',
    'below_baseline_auc',
    'worse_logloss',
  ])('candidate reason %s blocks activation and is passed through', (reason) => {
    const bad: TrainResult = { ...goodResult(), activation: { eligible: false, reasons: [reason] } };
    const d = api.decideActivation(bad, ctx());
    expect(d.activate).toBe(false);
    expect(d.reasons).toContain(reason);
  });
});

describe('modelContextSha', () => {
  const base: ContextInput = {
    ratingSha: RATING_SHA,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    strengthWeights: CFG.strengthWeights,
    modelConfig: CFG.model,
    consent: CONSENT,
    ownInputs: [
      { cardId: CARD_A, strength: 'love', scopeFeedId: null, cardInputSha256: 'h-a' },
      { cardId: CARD_N, strength: 'never', scopeFeedId: '7', cardInputSha256: 'h-n' },
    ],
  };
  const sha = api.modelContextSha;
  const ownA = base.ownInputs[0] as ContextInput['ownInputs'][number];

  it('changes with a strength weight, a consent flag, an own input strength or card hash', () => {
    const b = sha(base);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    const variants: ContextInput[] = [
      { ...base, strengthWeights: { ...CFG.strengthWeights, love: CFG.strengthWeights.love - 0.01 } },
      { ...base, consent: { ...CONSENT, implicitFeedback: true } },
      { ...base, consent: { ...CONSENT, implicitNegative: true } },
      { ...base, modelConfig: { ...CFG.model, minCvAuc: 0.65 } },
      { ...base, ratingSha: 'f'.repeat(64) },
      { ...base, ownInputs: [{ ...ownA, strength: 'like' }, ...base.ownInputs.slice(1)] },
      { ...base, ownInputs: [{ ...ownA, cardInputSha256: 'x' }, ...base.ownInputs.slice(1)] },
      { ...base, ownInputs: [{ ...ownA, scopeFeedId: '9' }, ...base.ownInputs.slice(1)] },
    ];
    const shas = variants.map((v) => sha(v));
    for (const s of shas) expect(s).not.toBe(b);
    expect(new Set(shas).size).toBe(shas.length);
  });

  it('is unchanged by own-input order and by a card that is not an own input', () => {
    const b = sha(base);
    expect(sha({ ...base, ownInputs: [...base.ownInputs].reverse() })).toBe(b);
    const withNonOwn = { ...base, heldCards: HELD, nonOwn: { cardId: CARD_B, strength: 'like' } };
    expect(sha(withNonOwn)).toBe(b);
  });
});

describe('scoreModel', () => {
  const hand: StoredModel = {
    features: ['a', 'b', 'c', 'd'],
    weights: [0.5, -0.5, 0.2, 0.5],
    scaler: { mean: [0, 0, 0, 0], scale: [1, 1, 1, 1] },
    intercept: 0.25,
    platt: { a: 1.5, b: -0.1 },
  };

  it('returns the top 3 contributions by |a·w·x| with a name tie-break and keeps the sign', () => {
    const r = api.scoreModel(hand, { a: 1, b: 1, c: 1, d: 1, extra: 9 });
    expect(r).not.toBeNull();
    expect(r?.contributions.map((c) => c.feature)).toEqual(['a', 'b', 'd']);
    expect(r?.contributions[1]?.contribution).toBeLessThan(0);
    expect(r?.logit).toBeCloseTo(0.25 + 0.5 - 0.5 + 0.2 + 0.5, 12);
  });

  it('orders by absolute value before name', () => {
    const r = api.scoreModel(hand, { a: 0.1, b: 1, c: 4, d: 2 });
    // a·w·x: a 0.075, b −0.75, c 1.2, d 1.5
    expect(r?.contributions.map((c) => c.feature)).toEqual(['d', 'c', 'b']);
  });

  it('returns null when a stored feature is missing from x', () => {
    expect(api.scoreModel(hand, { a: 1, b: 1, d: 1 })).toBeNull();
  });

  it('returns p = applyPlatt(platt, logit) for hand-built and trained models', () => {
    const r = api.scoreModel(hand, { a: 1, b: 0, c: 2, d: -1 });
    expect(r?.p).toBeCloseTo(applyPlatt(hand.platt, r?.logit ?? Number.NaN), 12);
    const trained = goodResult().model as StoredModel;
    const ownInputs = (trained['ownInputs'] as string[] | undefined) ?? [];
    const x = snapshotFeatures(snapshot(NOW, { pA: 0.9 }), CFG, ownInputs);
    const t = api.scoreModel(trained, x);
    expect(t).not.toBeNull();
    expect(t?.p).toBeCloseTo(applyPlatt(trained.platt, t?.logit ?? Number.NaN), 12);
    expect(t?.contributions.length).toBeLessThanOrEqual(3);
    const mags = (t?.contributions ?? []).map((c) => Math.abs(c.contribution));
    expect([...mags].sort((p, q) => q - p)).toEqual(mags);
  });
});
