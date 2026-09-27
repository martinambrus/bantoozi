import { isAppError } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  defaultCardTitle,
  libraryCardDiff,
  parseCardBody,
  sameCardText,
  serializeCardBody,
  translationOf,
  withAddedExample,
  withRemovedExample,
  type ParsedCardBody,
} from '../../src/cards/body.js';
import {
  activeFeedIds,
  checkQuota,
  coveredFeeds,
  newlyCovered,
  requireScope,
  type Subscription,
} from '../../src/cards/store.js';
import {
  exampleFromArticleTitle,
  validateCardExample,
  validateCardInterest,
  validateCardLang,
  validateCardNotFor,
  validateCardStrength,
  validateCardTitle,
  validateCardTranslation,
  validateExampleSide,
  validateId,
  validateLabelColor,
} from '../../src/cards/validation.js';

/** Pure parts of the card repository: input validation, body edits, diffs, scope and quotas. */

function failure(fn: () => unknown): { code: string; details: unknown } {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('expected an AppError');
}

const invalid = (field: string, reason: string) => ({
  code: 'VALIDATION_FAILED',
  details: { field, reason },
});

describe('text validation (spec 05 §5.1)', () => {
  it('trims and bounds titles, interests, not_for and examples by code points', () => {
    expect(validateCardTitle('  Rust  ')).toBe('Rust');
    expect(validateCardTitle('é'.repeat(60))).toBe('é'.repeat(60));
    expect(validateCardTitle('🦀'.repeat(60))).toBe('🦀'.repeat(60));
    expect(failure(() => validateCardTitle('🦀'.repeat(61)))).toEqual(invalid('title', 'too_long'));
    expect(failure(() => validateCardTitle('   '))).toEqual(invalid('title', 'required'));
    expect(failure(() => validateCardTitle(42))).toEqual(invalid('title', 'type'));
    expect(validateCardTitle('Label', 'name')).toBe('Label');
    expect(failure(() => validateCardTitle('', 'name'))).toEqual(invalid('name', 'required'));

    expect(validateCardInterest(' abc ')).toBe('abc');
    expect(failure(() => validateCardInterest('ab'))).toEqual(invalid('interest', 'too_short'));
    expect(failure(() => validateCardInterest('x'.repeat(301)))).toEqual(
      invalid('interest', 'too_long'),
    );
    expect(failure(() => validateCardInterest('ab', 'definition'))).toEqual(
      invalid('definition', 'too_short'),
    );

    expect(validateCardNotFor(undefined)).toBeNull();
    expect(validateCardNotFor(null)).toBeNull();
    expect(validateCardNotFor(' \t ')).toBeNull();
    expect(validateCardNotFor(' Games ')).toBe('Games');
    expect(failure(() => validateCardNotFor('x'.repeat(301)))).toEqual(
      invalid('notFor', 'too_long'),
    );

    expect(validateCardExample('A headline')).toBe('A headline');
    expect(failure(() => validateCardExample('x'.repeat(201)))).toEqual(
      invalid('text', 'too_long'),
    );
  });

  it('rejects control characters and lone surrogates but keeps tabs and line breaks', () => {
    expect(validateCardInterest('line one\nline two\tend')).toBe('line one\nline two\tend');
    for (const bad of ['nul \u0000 here', 'bell \u0007 here', 'del \u007f here', 'lone \ud800 x']) {
      expect(
        failure(() => validateCardInterest(bad)),
        JSON.stringify(bad),
      ).toEqual(invalid('interest', 'characters'));
    }
  });

  it('validates enums, ids, languages and colours', () => {
    expect(validateCardStrength('never')).toBe('never');
    expect(failure(() => validateCardStrength('Love'))).toEqual(invalid('strength', 'enum'));
    expect(validateExampleSide('no')).toBe('no');
    expect(failure(() => validateExampleSide('maybe'))).toEqual(invalid('side', 'enum'));

    expect(validateId('9223372036854775807', 'cardId')).toBe('9223372036854775807');
    for (const bad of ['0', '-1', '01', '1e3', 'v1', '', ' 1', '9223372036854775808', 7]) {
      expect(
        failure(() => validateId(bad, 'cardId')),
        String(bad),
      ).toEqual(invalid('cardId', 'id'));
    }

    expect(validateCardLang(undefined)).toBe('und');
    expect(validateCardLang('sk')).toBe('sk');
    expect(validateCardLang('und')).toBe('und');
    for (const bad of ['SK', 'english', 'sk-SK', '', null]) {
      expect(
        failure(() => validateCardLang(bad)),
        String(bad),
      ).toEqual(invalid('lang', 'language'));
    }

    expect(validateLabelColor('#A0b1C2')).toBe('#a0b1c2');
    for (const bad of ['red', '#abc', '#12345g', 'a0b1c2', '#a0b1c2 ']) {
      expect(
        failure(() => validateLabelColor(bad)),
        bad,
      ).toEqual(invalid('color', 'color'));
    }
  });

  it('accepts a complete English pair only for a non-English card', () => {
    expect(validateCardTranslation(undefined, null, 'sk')).toBeNull();
    expect(validateCardTranslation(null, 'x', 'sk')).toBeNull();
    expect(
      validateCardTranslation({ interestEn: ' Politics ', notForEn: null }, null, 'sk'),
    ).toEqual({ interestEn: 'Politics', notForEn: null });
    // A blank notForEn for a card without not_for is the same as none.
    expect(validateCardTranslation({ interestEn: 'Politics', notForEn: ' ' }, null, 'sk')).toEqual({
      interestEn: 'Politics',
      notForEn: null,
    });
    expect(
      validateCardTranslation({ interestEn: 'Politics', notForEn: ' Sports ' }, 'Šport', 'sk'),
    ).toEqual({ interestEn: 'Politics', notForEn: 'Sports' });

    const pair = { interestEn: 'Politics', notForEn: null };
    expect(failure(() => validateCardTranslation(pair, null, 'en'))).toEqual(
      invalid('translation', 'language'),
    );
    expect(failure(() => validateCardTranslation(pair, null, 'und'))).toEqual(
      invalid('translation', 'language'),
    );
    expect(failure(() => validateCardTranslation(pair, 'Šport', 'sk'))).toEqual(
      invalid('translation.notForEn', 'type'),
    );
    expect(
      failure(() => validateCardTranslation({ interestEn: 'x', notForEn: 'Sports' }, null, 'sk')),
    ).toEqual(invalid('translation.notForEn', 'unexpected'));
    expect(
      failure(() =>
        validateCardTranslation({ interestEn: 'x'.repeat(601), notForEn: null }, null, 'sk'),
      ),
    ).toEqual(invalid('translation.interestEn', 'too_long'));
  });

  it('turns an article title into one clean example', () => {
    expect(exampleFromArticleTitle('  Breaking:\n  Rust   2.0 \t released ')).toBe(
      'Breaking: Rust 2.0 released',
    );
    expect(exampleFromArticleTitle('Bad\u0000 \u0007bytes')).toBe('Bad bytes');
    expect(exampleFromArticleTitle('🦀'.repeat(250))).toBe('🦀'.repeat(200));
    expect(exampleFromArticleTitle(`${'x'.repeat(199)} tail`)).toBe('x'.repeat(199));
    expect(exampleFromArticleTitle(' \n\u0001 ')).toBeNull();
  });
});

describe('card bodies', () => {
  const body = (over: Partial<ParsedCardBody> = {}): ParsedCardBody => ({
    interest: 'Rust programming',
    notFor: null,
    interestEn: null,
    notForEn: null,
    examplesYes: [],
    examplesNo: [],
    ...over,
  });

  it('parses stored bodies tolerantly and serializes the full shape', () => {
    expect(parseCardBody({ interest: 'x y z', not_for: ' ', examples_yes: ['a', 3] })).toEqual({
      interest: 'x y z',
      notFor: null,
      interestEn: null,
      notForEn: null,
      examplesYes: ['a'],
      examplesNo: [],
    });
    expect(parseCardBody(null)).toMatchObject({ interest: '', examplesNo: [] });
    expect(serializeCardBody(body({ notFor: 'Games', examplesNo: ['b'] }))).toEqual({
      interest: 'Rust programming',
      not_for: 'Games',
      interest_en: null,
      not_for_en: null,
      examples_yes: [],
      examples_no: ['b'],
    });
  });

  it('reports only a complete English pair', () => {
    expect(translationOf(body())).toBeNull();
    expect(translationOf(body({ interestEn: 'Rust' }))).toEqual({
      interestEn: 'Rust',
      notForEn: null,
    });
    expect(translationOf(body({ interestEn: 'Rust', notFor: 'Hry' }))).toBeNull();
    expect(translationOf(body({ interestEn: 'Rust', notFor: 'Hry', notForEn: 'Games' }))).toEqual({
      interestEn: 'Rust',
      notForEn: 'Games',
    });
  });

  it('compares text by norm', () => {
    expect(
      sameCardText(
        { interest: ' RUST  programming', notFor: null },
        { interest: 'rust programming', notFor: ' ' },
      ),
    ).toBe(true);
    expect(
      sameCardText({ interest: 'Rust', notFor: 'Games' }, { interest: 'Rust', notFor: null }),
    ).toBe(false);
  });

  it('keeps the newest five examples per side, moves across sides and ignores repeats', () => {
    let examples = { yes: [] as string[], no: [] as string[] };
    for (const title of ['a', 'b', 'c', 'd', 'e', 'f']) {
      examples = withAddedExample(examples, 'yes', title) ?? examples;
    }
    expect(examples).toEqual({ yes: ['b', 'c', 'd', 'e', 'f'], no: [] });
    expect(withAddedExample(examples, 'yes', ' C ')).toBeNull();
    expect(withAddedExample(examples, 'no', 'D')).toEqual({ yes: ['b', 'c', 'e', 'f'], no: ['D'] });

    expect(withRemovedExample(examples, 'yes', 'c')).toEqual({
      yes: ['b', 'd', 'e', 'f'],
      no: [],
    });
    expect(withRemovedExample(examples, 'yes', ' E ')).toEqual({
      yes: ['b', 'c', 'd', 'f'],
      no: [],
    });
    expect(withRemovedExample(examples, 'no', 'c')).toBeNull();
  });

  it('derives the default title from the first 60 characters', () => {
    expect(defaultCardTitle('  Short interest ')).toBe('Short interest');
    expect(defaultCardTitle(`${'x'.repeat(59)} tail`)).toBe('x'.repeat(59));
    expect(defaultCardTitle('🦀'.repeat(70))).toBe('🦀'.repeat(60));
  });

  it('diffs library versions semantically', () => {
    const from = { title: 'Rust', body: body({ notFor: 'Games', examplesYes: ['a', 'b'] }) };
    const to = {
      title: 'Rust programming',
      body: body({ interest: 'RUST  programming', notFor: 'games', examplesYes: ['b', 'c'] }),
    };
    expect(libraryCardDiff(from, to)).toEqual({
      title: { from: 'Rust', to: 'Rust programming' },
      interest: null,
      notFor: null,
      examplesYes: { added: ['c'], removed: ['a'] },
      examplesNo: { added: [], removed: [] },
    });
    expect(libraryCardDiff(from, { ...from, body: body({ interest: 'Go' }) })).toMatchObject({
      title: null,
      interest: { from: 'Rust programming', to: 'Go' },
      notFor: { from: 'Games', to: null },
    });
  });
});

describe('scope and quotas', () => {
  const subscriptions: Subscription[] = [
    { feedId: '10', mode: 'active' },
    { feedId: '9', mode: 'active' },
    { feedId: '11', mode: 'training' },
    { feedId: '12', mode: 'off' },
  ];

  it('covers every subscription or only the scoped one; refreshes active feeds in numeric order', () => {
    expect(coveredFeeds(subscriptions, null)).toEqual(subscriptions);
    expect(coveredFeeds(subscriptions, '11')).toEqual([{ feedId: '11', mode: 'training' }]);
    expect(activeFeedIds(subscriptions)).toEqual(['9', '10']);
    expect(
      activeFeedIds(coveredFeeds(subscriptions, '9'), coveredFeeds(subscriptions, null)),
    ).toEqual(['9', '10']);
    expect(
      newlyCovered(coveredFeeds(subscriptions, '9'), subscriptions).map((s) => s.feedId),
    ).toEqual(['10', '11', '12']);
    expect(newlyCovered(subscriptions, coveredFeeds(subscriptions, '9'))).toEqual([]);
    expect(() => requireScope(subscriptions, '12')).not.toThrow();
    expect(failure(() => requireScope(subscriptions, '13'))).toEqual(
      invalid('scopeFeedId', 'not_subscribed'),
    );
  });

  it('refuses only growth beyond the plan maximum', () => {
    expect(() => checkQuota('maxCards', 49, 50, 50)).not.toThrow();
    expect(failure(() => checkQuota('maxCards', 50, 51, 50))).toEqual({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxCards', used: 50, max: 50 },
    });
    // Over quota after a plan change: keeping or shrinking the count stays allowed.
    expect(() => checkQuota('maxForks', 25, 25, 20)).not.toThrow();
    expect(() => checkQuota('maxForks', 25, 24, 20)).not.toThrow();
  });
});
