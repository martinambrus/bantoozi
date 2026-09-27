import { describe, expect, it } from 'vitest';

import {
  TRANSLATION_POLICY_VERSION,
  assessTranslation,
  currentTier2Row,
  decideTier2,
  mayRunTier2,
  sameTranslationText,
  selectBestTranslation,
  skippedReasonOf,
  skippedTier2QualityDetail,
  translationQualityDetail,
  type TranslationRowSummary,
} from '../src/index.js';

interface Row extends TranslationRowSummary {
  id: string;
}

const row = (
  id: string,
  engine: Row['engine'],
  quality: Row['quality'],
  articleRevision: string | bigint = '3',
  extra: Partial<Row> = {},
): Row => ({ id, engine, quality, articleRevision, ...extra });

const skipped = (reason: 'no_key' | 'cap' | 'budget', revision = '3'): Row =>
  row(`skip-${reason}`, 'ollama', 'fail', revision, {
    qualityDetail: skippedTier2QualityDetail(reason, '7'),
  });

describe('selectBestTranslation (spec 07 §3 step 4)', () => {
  it('picks the highest quality among the current-revision rows: ok > weak > fail', () => {
    expect(
      selectBestTranslation([row('a', 'libretranslate', 'weak'), row('b', 'ollama', 'ok')], '3')
        ?.id,
    ).toBe('b');
    expect(
      selectBestTranslation([row('a', 'libretranslate', 'ok'), row('b', 'ollama', 'weak')], '3')
        ?.id,
    ).toBe('a');
    expect(
      selectBestTranslation([row('a', 'ollama', 'fail'), row('b', 'libretranslate', 'weak')], '3')
        ?.id,
    ).toBe('b');
  });

  it('prefers ollama on a tie, whatever the order', () => {
    const tier1 = row('lt', 'libretranslate', 'ok');
    const tier2 = row('ol', 'ollama', 'ok');
    expect(selectBestTranslation([tier1, tier2], '3')?.id).toBe('ol');
    expect(selectBestTranslation([tier2, tier1], '3')?.id).toBe('ol');
    expect(
      selectBestTranslation([row('lt', 'libretranslate', 'weak'), row('ol', 'ollama', 'weak')], '3')
        ?.id,
    ).toBe('ol');
  });

  it('returns null (native text) when only fail rows exist, skipped tier-2 rows included, or none', () => {
    expect(
      selectBestTranslation([row('a', 'libretranslate', 'fail'), row('b', 'ollama', 'fail')], '3'),
    ).toBeNull();
    expect(
      selectBestTranslation([row('a', 'libretranslate', 'fail'), skipped('budget')], '3'),
    ).toBeNull();
    expect(selectBestTranslation([], '3')).toBeNull();
  });

  it('ignores rows of an earlier revision and of another target language', () => {
    const rows = [
      row('old', 'ollama', 'ok', '2'),
      row('fr', 'ollama', 'ok', '3', { targetLang: 'fr' }),
      row('cur', 'libretranslate', 'weak', '3', { targetLang: 'en' }),
    ];
    expect(selectBestTranslation(rows, '3')?.id).toBe('cur');
    expect(selectBestTranslation(rows, '4')).toBeNull();
    expect(selectBestTranslation(rows, '2')?.id).toBe('old');
  });

  it('compares revisions as bigints, strings and bigints alike', () => {
    const big = '9007199254740993';
    expect(selectBestTranslation([row('a', 'ollama', 'ok', BigInt(big))], big)?.id).toBe('a');
    expect(selectBestTranslation([row('a', 'ollama', 'ok', big)], 9007199254740993n)?.id).toBe('a');
    expect(selectBestTranslation([row('a', 'ollama', 'ok', '9007199254740992')], big)).toBeNull();
  });

  it('rejects a revision that is not a decimal bigint string', () => {
    for (const bad of ['03', '-1', '1.5', '', 'x']) {
      expect(() => selectBestTranslation([row('a', 'ollama', 'ok', bad)], '3')).toThrow(TypeError);
      expect(() => selectBestTranslation([], bad)).toThrow(TypeError);
    }
  });
});

describe('tier-2 runs once per content revision (spec 07 §3)', () => {
  it('finds the current ollama row, a skipped one included', () => {
    expect(currentTier2Row([row('lt', 'libretranslate', 'fail'), skipped('cap')], '3')?.id).toBe(
      'skip-cap',
    );
    expect(currentTier2Row([row('ol', 'ollama', 'ok', '2')], '3')).toBeUndefined();
  });

  it('allows tier 2 only when the current revision has no ollama row', () => {
    expect(mayRunTier2([], '3')).toBe(true);
    expect(mayRunTier2([row('lt', 'libretranslate', 'fail')], '3')).toBe(true);
    expect(mayRunTier2([row('ol', 'ollama', 'ok', '2')], '3')).toBe(true);
    expect(mayRunTier2([row('ol', 'ollama', 'fail')], '3')).toBe(false);
    // A skipped row is on record: redelivery and budget reset never retry it.
    expect(mayRunTier2([skipped('budget')], '3')).toBe(false);
  });

  it('lets only the administrative reprocess replace a skipped row, for the listed reasons', () => {
    expect(mayRunTier2([skipped('budget')], '3', { replaceSkipped: true })).toBe(true);
    expect(
      mayRunTier2([skipped('budget')], '3', { replaceSkipped: true, reasons: ['budget'] }),
    ).toBe(true);
    expect(mayRunTier2([skipped('no_key')], '3', { replaceSkipped: true, reasons: ['cap'] })).toBe(
      false,
    );
    // Never a real attempt, whatever its quality.
    expect(
      mayRunTier2(
        [
          row('ol', 'ollama', 'fail', '3', {
            qualityDetail: translationQualityDetail({ failure: 'invalid_response' }),
          }),
        ],
        '3',
        { replaceSkipped: true },
      ),
    ).toBe(false);
    expect(mayRunTier2([row('ol', 'ollama', 'weak')], '3', { replaceSkipped: true })).toBe(false);
  });
});

describe('decideTier2: whether tier 2 is wanted (spec 07 §3 step 3)', () => {
  it('follows the truth table of tier-1 fail, forceTier2 and translate_strong', () => {
    expect(decideTier2({})).toEqual({ wanted: false });
    expect(decideTier2({ tier1Quality: 'ok' })).toEqual({ wanted: false });
    expect(
      decideTier2({ tier1Quality: 'weak', forceTier2: false, translateStrong: false }),
    ).toEqual({ wanted: false });
    expect(decideTier2({ tier1Quality: null })).toEqual({ wanted: false });
    expect(decideTier2({ tier1Quality: 'fail' })).toEqual({
      wanted: true,
      reasons: ['tier1_fail'],
      modelTier: 'fast',
    });
    expect(decideTier2({ tier1Quality: 'weak', forceTier2: true })).toEqual({
      wanted: true,
      reasons: ['forced'],
      modelTier: 'fast',
    });
    expect(decideTier2({ forceTier2: true })).toEqual({
      wanted: true,
      reasons: ['forced'],
      modelTier: 'fast',
    });
    expect(decideTier2({ tier1Quality: 'ok', translateStrong: true })).toEqual({
      wanted: true,
      reasons: ['translate_strong'],
      modelTier: 'strong',
    });
    expect(decideTier2({ tier1Quality: 'fail', forceTier2: true, translateStrong: true })).toEqual({
      wanted: true,
      reasons: ['tier1_fail', 'forced', 'translate_strong'],
      modelTier: 'strong',
    });
  });
});

describe('sameTranslationText (re-translation no-op check)', () => {
  const a = { title: 'T', excerpt: null, body_lead: 'B' };

  it('compares the effective texts, native (null) included', () => {
    expect(sameTranslationText(a, { ...a })).toBe(true);
    expect(sameTranslationText(a, { ...a, excerpt: '' })).toBe(false);
    expect(sameTranslationText(a, { ...a, body_lead: 'B.' })).toBe(false);
    expect(sameTranslationText(null, null)).toBe(true);
    expect(sameTranslationText(a, null)).toBe(false);
    expect(sameTranslationText(null, a)).toBe(false);
  });
});

describe('quality_detail', () => {
  it('represents a skipped tier-2 row with its reason and credential version', () => {
    expect(skippedTier2QualityDetail('no_key')).toEqual({
      policyVersion: TRANSLATION_POLICY_VERSION,
      skipped: 'no_key',
    });
    const detail = skippedTier2QualityDetail('cap', '12');
    expect(detail).toEqual({
      policyVersion: TRANSLATION_POLICY_VERSION,
      skipped: 'cap',
      credentialVersion: '12',
    });
    // Round-trips through jsonb.
    expect(skippedReasonOf(JSON.parse(JSON.stringify(detail)))).toBe('cap');
  });

  it('rejects an unknown skip reason or a malformed credential version', () => {
    expect(() => skippedTier2QualityDetail('quota' as 'cap')).toThrow(TypeError);
    expect(() => skippedTier2QualityDetail('cap', 'v1')).toThrow(TypeError);
    expect(() => translationQualityDetail({ credentialVersion: '0' })).toThrow(TypeError);
    expect(() => translationQualityDetail({ failure: 'Bad Gateway: <html>' })).toThrow(TypeError);
  });

  it('carries the policy version, a failure code and the assessment of a real attempt', () => {
    const assessment = assessTranslation(
      { title: 'Most', excerpt: null, body_lead: null },
      { title: 'Bridge' },
      'sk',
    );
    expect(translationQualityDetail({ assessment, credentialVersion: '3' })).toEqual({
      policyVersion: TRANSLATION_POLICY_VERSION,
      credentialVersion: '3',
      assessment,
    });
    expect(translationQualityDetail({ failure: 'invalid_response:extra_keys' })).toEqual({
      policyVersion: TRANSLATION_POLICY_VERSION,
      failure: 'invalid_response:extra_keys',
    });
  });

  it('reads the skip reason of any stored JSON, and nothing else', () => {
    expect(skippedReasonOf({ skipped: 'budget' })).toBe('budget');
    for (const detail of [
      null,
      undefined,
      'budget',
      ['budget'],
      {},
      { skipped: 'other' },
      { skipped: 1 },
    ]) {
      expect(skippedReasonOf(detail)).toBeUndefined();
    }
    expect(skippedReasonOf(JSON.parse('{"__proto__":{"skipped":"cap"}}'))).toBeUndefined();
  });
});
