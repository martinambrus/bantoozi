import { describe, expect, it } from 'vitest';

import { FEATURE_SPEC_V1_SHA } from '../../src/index.js';
import type {
  EligibilityOpts as RealEligibilityOpts,
  RawFeatureSnapshot,
  TrainArgs as RealTrainArgs,
  TrainingSample as RealTrainingSample,
} from '../../src/index.js';
import { api } from './support/api.js';
import type { EligibilityOpts, TrainArgs, TrainingSample, TrainResult } from './support/api.js';
import {
  CFG,
  CONSENT,
  drivenSamples,
  FAMILIES,
  FAMILY_SHA,
  HELD,
  NOW,
  OTHER_RATING_SHA,
  RATING_SHA,
  sample,
  trainArgs,
} from './support/synth.js';

/**
 * JEV-4 T2 ruler: the families replace the exact rating sha match in the eligibility, the training
 * set sha, the context sha and the activation guard (contract section T2, ranker part).
 */

const UNREGISTERED = 'c'.repeat(64);
const FOREIGN_FAMILY = 'd'.repeat(64);

const scope = (
  over: Partial<Extract<EligibilityOpts, { ratingSha: string }>> = {},
): EligibilityOpts => ({
  now: NOW,
  historyDays: 180,
  ratingSha: RATING_SHA,
  familySha: FAMILY_SHA,
  families: FAMILIES,
  ...over,
});
const carrying = (sha: string): TrainingSample => sample(1, 1, { ratingSha: sha });
const verdict = (s: TrainingSample, opts: EligibilityOpts) => api.sampleEligibility(s, opts);
const OK = { ok: true };
const MISMATCH = { ok: false, reason: 'rating_sha_mismatch' };

describe('JEV-4 sampleEligibility with families', () => {
  it('E1 the current exact sha is eligible with an empty registry', () => {
    expect(verdict(carrying(RATING_SHA), scope({ families: {} }))).toEqual(OK);
  });

  it('E2 another exact sha registered to the same family is eligible', () => {
    expect(verdict(carrying(OTHER_RATING_SHA), scope())).toEqual(OK);
  });

  it('E3 negative control: a same-family sha missing from the registry is a mismatch', () => {
    expect(verdict(carrying(UNREGISTERED), scope())).toEqual(MISMATCH);
    expect(
      verdict(carrying(OTHER_RATING_SHA), scope({ families: { [RATING_SHA]: FAMILY_SHA } })),
    ).toEqual(MISMATCH);
  });

  it('E4 a sha registered to another family is a mismatch', () => {
    const families = { ...FAMILIES, [UNREGISTERED]: FOREIGN_FAMILY };
    expect(verdict(carrying(UNREGISTERED), scope({ families }))).toEqual(MISMATCH);
    expect(verdict(carrying(OTHER_RATING_SHA), scope({ familySha: FOREIGN_FAMILY }))).toEqual(
      MISMATCH,
    );
  });

  it('E5 a null ratingSha skips the spec and the rating checks', () => {
    const s = sample(1, 1, { ratingSha: UNREGISTERED });
    const broken = {
      ...s,
      features: { ...(s.features as RawFeatureSnapshot), specSha: 'b'.repeat(64) },
    };
    expect(verdict(broken, { now: NOW, historyDays: 180, ratingSha: null })).toEqual(OK);
    expect(verdict(broken, scope())).toEqual({ ok: false, reason: 'spec_sha_mismatch' });
  });

  it('E6 the spec sha is still checked before the rating sha', () => {
    const s = sample(1, 1, { ratingSha: UNREGISTERED });
    const broken = {
      ...s,
      features: { ...(s.features as RawFeatureSnapshot), specSha: 'b'.repeat(64) },
    };
    expect(verdict(broken, scope())).toEqual({ ok: false, reason: 'spec_sha_mismatch' });
  });

  it.each([
    ['families missing', { families: undefined }],
    ['families null', { families: null }],
    ['families a string', { families: 'x' }],
    ['families a number', { families: 5 }],
    ['familySha missing', { familySha: undefined }],
    ['familySha a number', { familySha: 5 }],
    ['familySha null', { familySha: null }],
  ])('E7 a non-null ratingSha with %s throws a TypeError', (_name, over) => {
    const opts = { ...scope(), ...over } as never;
    expect(() => verdict(carrying(RATING_SHA), opts)).toThrow(TypeError);
    expect(() => verdict(carrying(OTHER_RATING_SHA), opts)).toThrow(TypeError);
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'E8 the prototype key %s as a sample sha never matches',
    (key) => {
      expect(verdict(carrying(key), scope())).toEqual(MISMATCH);
      expect(verdict(carrying(key), scope({ families: {} }))).toEqual(MISMATCH);
      const inherited = Object.create({ [key]: FAMILY_SHA }) as Record<string, string>;
      expect(verdict(carrying(key), scope({ families: inherited }))).toEqual(MISMATCH);
    },
  );

  it('E9 an inherited registry entry is not a registry entry', () => {
    const inherited = Object.create({ [OTHER_RATING_SHA]: FAMILY_SHA }) as Record<string, string>;
    expect(verdict(carrying(OTHER_RATING_SHA), scope({ families: inherited }))).toEqual(MISMATCH);
  });
});

describe('JEV-4 eligibleSetSha and eligibilityOf', () => {
  const set = (): TrainingSample[] =>
    Array.from({ length: 8 }, (_, i) =>
      sample(i, i % 2 === 0 ? 1 : 0, { ratingSha: OTHER_RATING_SHA }),
    );

  it('H1 identical whether the samples are eligible via the exact sha or via the family', () => {
    const exact = api.eligibleSetSha(set(), scope({ ratingSha: OTHER_RATING_SHA, families: {} }));
    const viaFamily = api.eligibleSetSha(set(), scope());
    expect(viaFamily).toBe(exact);
    expect(exact).toMatch(/^[0-9a-f]{64}$/);
  });

  it('H2 negative control: ineligible samples change the sha', () => {
    const viaFamily = api.eligibleSetSha(set(), scope());
    const unregistered = api.eligibleSetSha(
      set(),
      scope({ families: { [RATING_SHA]: FAMILY_SHA } }),
    );
    expect(unregistered).not.toBe(viaFamily);
  });

  it('H3 eligibilityOf returns the options with the scope for a non-null ratingSha', () => {
    const args = trainArgs(drivenSamples(10, 'e'));
    expect(api.eligibilityOf(args)).toEqual({
      now: NOW,
      historyDays: CFG.model.historyDays,
      ratingSha: RATING_SHA,
      familySha: FAMILY_SHA,
      families: FAMILIES,
    });
  });

  it('H4 eligibilityOf for a null ratingSha has no scope', () => {
    const args = trainArgs(drivenSamples(10, 'e'), { ratingSha: null });
    const opts = api.eligibilityOf(args);
    expect(opts).toMatchObject({ now: NOW, historyDays: CFG.model.historyDays, ratingSha: null });
    expect((opts as { families?: unknown }).families).toBeUndefined();
  });

  it('H5 eligibilityOf feeds the same eligibility as the direct options', () => {
    const args = trainArgs([]);
    const s = carrying(OTHER_RATING_SHA);
    expect(verdict(s, api.eligibilityOf(args))).toEqual(OK);
    expect(verdict(carrying(UNREGISTERED), api.eligibilityOf(args))).toEqual(MISMATCH);
  });
});

describe('JEV-4 modelContextSha familySha', () => {
  const base = {
    familySha: FAMILY_SHA,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    strengthWeights: CFG.strengthWeights,
    modelConfig: CFG.model,
    consent: CONSENT,
    ownInputs: [{ cardId: '101', strength: 'love', scopeFeedId: null, cardInputSha256: 'h-a' }],
  };

  it('C1 changing familySha changes the hash', () => {
    const a = api.modelContextSha(base);
    const b = api.modelContextSha({ ...base, familySha: FOREIGN_FAMILY });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
  });

  it('C2 ratingSha is no longer an input', () => {
    const a = api.modelContextSha(base);
    expect(api.modelContextSha({ ...base, ratingSha: RATING_SHA } as never)).toBe(a);
    expect(api.modelContextSha({ ...base, ratingSha: OTHER_RATING_SHA } as never)).toBe(a);
  });
});

describe('JEV-4 decideActivation with the family sha', () => {
  const candidate = (metrics: Record<string, unknown>): TrainResult =>
    ({
      model: { ratingSha: RATING_SHA } as never,
      metrics: { contextSha: 'ctx', ...metrics } as never,
      activation: { eligible: true, reasons: [] },
    }) as TrainResult;
  const current = { currentFamilySha: FAMILY_SHA, currentContextSha: 'ctx' };

  it('A1 no rating_fingerprint_changed when the family matches, even if the exact sha differs', () => {
    const d = api.decideActivation(
      candidate({ ratingSha: OTHER_RATING_SHA, familySha: FAMILY_SHA }),
      current,
    );
    expect(d).toEqual({ activate: true, reasons: [] });
  });

  it('A2 the reason is present when the family differs', () => {
    const d = api.decideActivation(
      candidate({ ratingSha: RATING_SHA, familySha: FOREIGN_FAMILY }),
      current,
    );
    expect(d.activate).toBe(false);
    expect(d.reasons).toContain('rating_fingerprint_changed');
  });

  it('A3 a candidate without a family sha is not current', () => {
    const d = api.decideActivation(candidate({ ratingSha: RATING_SHA, familySha: null }), current);
    expect(d.activate).toBe(false);
    expect(d.reasons).toContain('rating_fingerprint_changed');
  });

  it('A4 the context check is unchanged', () => {
    const d = api.decideActivation(candidate({ ratingSha: RATING_SHA, familySha: FAMILY_SHA }), {
      ...current,
      currentContextSha: 'other',
    });
    expect(d.activate).toBe(false);
    expect(d.reasons).toEqual(['context_changed']);
  });
});

describe('JEV-4 trainUserModel across two releases of one family', () => {
  const driven = drivenSamples(300, 'drive');
  const mixed = (): TrainingSample[] =>
    driven.map((s, i) =>
      i % 2 === 1 && s.features !== null
        ? { ...s, features: { ...s.features, ratingSha: OTHER_RATING_SHA } }
        : s,
    );
  const run = (samples: TrainingSample[], over: Partial<TrainArgs> = {}): TrainResult =>
    api.trainUserModel(trainArgs(samples, over), { mode: 'production' });
  const baseline = run(driven);

  it('T1 both shas train: same counts, family sha set, same context and weights as an all-current run', () => {
    const r = run(mixed());
    expect(r.metrics.skipped['rating_sha_mismatch']).toBeUndefined();
    expect(r.metrics.nExplicit).toBe(baseline.metrics.nExplicit);
    expect(r.metrics.nExplicit).toBeGreaterThan(200);
    expect(r.metrics.familySha).toBe(FAMILY_SHA);
    expect(r.metrics.ratingSha).toBe(RATING_SHA);
    expect(r.metrics.contextSha).toBe(baseline.metrics.contextSha);
    expect(r.model?.weights).toEqual(baseline.model?.weights);
    const own = r.metrics.ownInputs.flatMap((id) => HELD.filter((h) => h.cardId === id));
    expect(r.metrics.contextSha).toBe(
      api.modelContextSha({
        familySha: FAMILY_SHA,
        featureSpecSha: FEATURE_SPEC_V1_SHA,
        strengthWeights: CFG.strengthWeights,
        modelConfig: CFG.model,
        consent: CONSENT,
        ownInputs: own,
      }),
    );
  });

  it('T2 the all-current run carries the family sha too', () => {
    expect(baseline.metrics.familySha).toBe(FAMILY_SHA);
    expect(baseline.metrics.ratingSha).toBe(RATING_SHA);
    expect(baseline.metrics.skipped['rating_sha_mismatch']).toBeUndefined();
  });

  it('T3 negative control: with the second sha unregistered those samples are skipped', () => {
    const r = run(mixed(), { families: { [RATING_SHA]: FAMILY_SHA } } as Partial<TrainArgs>);
    expect(r.metrics.skipped['rating_sha_mismatch']).toBe(150);
    expect(r.metrics.nExplicit).toBeLessThan(baseline.metrics.nExplicit);
  });

  it('T4 a null ratingSha has no family sha and no context sha', () => {
    const r = run(mixed(), { ratingSha: null });
    expect(r.metrics.familySha ?? null).toBeNull();
    expect(r.metrics.contextSha).toBeNull();
  });
});

describe('JEV-4 types', () => {
  const rest = {
    samples: [] as RealTrainingSample[],
    now: NOW,
    config: CFG,
    heldCards: [],
    consent: CONSENT,
    seedMaterial: 's',
    feedbackCutoffEventId: null,
  };
  const some = (): string | null => (Math.random() < 2 ? 'x' : null);
  const takeElig = (o: RealEligibilityOpts): RealEligibilityOpts => o;
  const takeTrain = (a: RealTrainArgs): RealTrainArgs => a;

  it('Y1 EligibilityOpts refuses a ratingSha without its scope', () => {
    // @ts-expect-error a string ratingSha needs familySha and families
    takeElig({ now: NOW, historyDays: 1, ratingSha: 'x' });
    // @ts-expect-error a string-or-null ratingSha cannot be narrowed to either member
    takeElig({ now: NOW, historyDays: 1, ratingSha: some() });
    takeElig({ now: NOW, historyDays: 1, ratingSha: null });
    takeElig({ now: NOW, historyDays: 1, ratingSha: 'x', familySha: 'f', families: {} });
    expect(true).toBe(true);
  });

  it('Y2 TrainArgs refuses a ratingSha without its scope', () => {
    // @ts-expect-error a string ratingSha needs familySha and families
    takeTrain({ ...rest, ratingSha: 'x' });
    // @ts-expect-error a string-or-null ratingSha cannot be narrowed to either member
    takeTrain({ ...rest, ratingSha: some() });
    takeTrain({ ...rest, ratingSha: null });
    takeTrain({ ...rest, ratingSha: 'x', familySha: 'f', families: {} });
    expect(true).toBe(true);
  });
});
