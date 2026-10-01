import { describe, expect, it } from 'vitest';

import { G1Schema, g1ConfigSha, parseG1, type G1File } from '../src/report/g1-schema.js';

/** M3a-T7: `apps/eval/config/g1.json` validates against its zod schema (spec 10 §1). */

const sha = (c: string) => c.repeat(64);

function exampleG1(): G1File {
  const base = {
    language_modes: { en: 'native', sk: 'translate' } as const,
    card_text_mode: 'as_written' as const,
    ranker_thresholds: {
      lanes: { forYou: 0.6, maybe: 0.3 },
      tiers: [0.2, 0.4, 0.6, 0.8] as [number, number, number, number],
      demotion: { clickbait: 0.75, promotional: 0.8, shallowDepth: 0.25, staleTimeSensitive: 0.7 },
    },
    recommended_daily_budget_usd: 2.5,
    translate_tier2_daily_cap: 300 as const,
    laya_track_recommended: false,
    runs: { B0: '11', B1: '12', E1: '14', E3: '16' },
    dataset: { version: 'golden-v1', snapshotSha: sha('a'), splitSha: sha('b') },
  };
  return {
    ...base,
    notes: 'owner_pilot: one actual participant.',
    selection: {
      developmentRunIds: ['11', '12', '14', '16'],
      lockedAt: '2026-10-01T08:00:00.000Z',
      configSha: g1ConfigSha({ ...base, profile: 'owner_pilot' }),
    },
    gate: { profile: 'owner_pilot', participants: 1, status: 'pass', reportSha: sha('c') },
  };
}

describe('g1.json schema', () => {
  it('accepts a complete decision file and round-trips through JSON', () => {
    const g1 = exampleG1();
    expect(parseG1(JSON.parse(JSON.stringify(g1)))).toEqual(g1);
    expect(G1Schema.safeParse({ ...g1, dryRun: true }).success).toBe(true);
  });

  it.each([
    ['an unknown field', { extra: 1 }],
    ['a numeric run id', { runs: { E1: 14 } }],
    ['a non-canonical run id', { runs: { E1: '014' } }],
    ['a tier-2 cap other than 300/1000', { translate_tier2_daily_cap: 500 }],
    ['a budget below $1', { recommended_daily_budget_usd: 0.5 }],
    ['an unknown language mode', { language_modes: { sk: 'laya' } }],
    ['a card mode outside the enum', { card_text_mode: 'translated' }],
    [
      'thresholds with maybe ≥ forYou',
      { ranker_thresholds: { lanes: { forYou: 0.5, maybe: 0.5 } } },
    ],
    ['non-increasing tiers', { ranker_thresholds: { tiers: [0.2, 0.2, 0.6, 0.8] } }],
    ['an unknown threshold key', { ranker_thresholds: { windowDays: 14 } }],
    ['a short hash', { dataset: { version: 'golden-v1', snapshotSha: 'abc', splitSha: sha('b') } }],
  ])('rejects %s', (_name, patch) => {
    expect(G1Schema.safeParse({ ...exampleG1(), ...patch }).success).toBe(false);
  });

  it('rejects an unknown profile or status and a fractional participant count', () => {
    const g1 = exampleG1();
    for (const gate of [
      { ...g1.gate, profile: 'persona_pilot' },
      { ...g1.gate, status: 'passed' },
      { ...g1.gate, participants: 1.5 },
    ]) {
      expect(G1Schema.safeParse({ ...g1, gate }).success).toBe(false);
    }
  });

  it('hashes every applied setting and the evidence, but not notes or the status', () => {
    const g1 = exampleG1();
    const hash = (x: G1File) => g1ConfigSha({ ...x, profile: x.gate.profile });
    expect(hash(g1)).toBe(g1.selection.configSha);
    expect(hash({ ...g1, notes: 'changed' })).toBe(g1.selection.configSha);
    expect(hash({ ...g1, recommended_daily_budget_usd: 3 })).not.toBe(g1.selection.configSha);
    expect(hash({ ...g1, language_modes: { en: 'native', sk: 'native' } })).not.toBe(
      g1.selection.configSha,
    );
    expect(hash({ ...g1, gate: { ...g1.gate, profile: 'multi_person_beta' } })).not.toBe(
      g1.selection.configSha,
    );
  });
});
