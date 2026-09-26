import { describe, expect, it } from 'vitest';

import {
  CARD_LIMITS,
  buildL2Question,
  cardInputSha256,
  cardKey,
  cardQuestion,
  defaultCardTitle,
  effectiveCardText,
  l2Key,
  l2Question,
  labelQuestion,
  parseCardKey,
  parseL2Key,
  selectL2Branches,
  validateCardBody,
  validateCardTitle,
  type CardBody,
} from '../src/index.js';

const QUESTION = 'Would a reader with this interest want to read `article`?';
const FOCUS = "Judge the article's main subject, not passing mentions.";
const TRUE_WHAT = "The article's main subject falls within `interest`";
const FALSE_WHAT = 'Only mentions it in passing, or falls under `not_for`';

const EV: CardBody = {
  interest:
    'New battery chemistry for electric vehicles (solid-state, sodium-ion, LFP improvements)',
  not_for: 'Stock-price moves, car launch PR without battery detail',
  interest_en: null,
  not_for_en: null,
  examples_yes: ["Toyota's solid-state pilot line hits 1,000 cycles"],
  examples_no: ['Tesla shares slide 4% after delivery miss'],
};

const SLOVAK: CardBody = {
  interest: 'Slovenská domáca politika a koaličné spory',
  not_for: 'Zahraničná politika',
  interest_en: 'Slovak domestic politics and coalition disputes',
  not_for_en: 'Foreign politics',
};

describe('cardQuestion (spec 05 §5.2)', () => {
  it('builds the full question with not_for and examples on both sides', () => {
    expect(cardQuestion(EV, 'as_written')).toEqual({
      type: 'noul',
      instructions: {
        question: QUESTION,
        interest: EV.interest,
        not_for: EV.not_for,
        focus: FOCUS,
      },
      criteria: {
        true: { what: TRUE_WHAT, examples: EV.examples_yes },
        false: { what: FALSE_WHAT, examples: EV.examples_no },
      },
    });
  });

  it('omits not_for and examples when the card has none', () => {
    const q = cardQuestion({ interest: 'Rust programming language' }, 'as_written');
    expect(q).toEqual({
      type: 'noul',
      instructions: { question: QUESTION, interest: 'Rust programming language', focus: FOCUS },
      criteria: { true: { what: TRUE_WHAT }, false: { what: FALSE_WHAT } },
    });
    // Key order of the instructions as sent: question, interest, not_for, focus.
    expect(Object.keys(cardQuestion(EV, 'as_written').instructions ?? {})).toEqual([
      'question',
      'interest',
      'not_for',
      'focus',
    ]);
  });

  it('treats empty example lists and an empty not_for as absent', () => {
    const q = cardQuestion(
      { interest: 'Rust', not_for: '', examples_yes: ['Rust 2.0 released'], examples_no: [] },
      'as_written',
    );
    expect(q.instructions).toEqual({ question: QUESTION, interest: 'Rust', focus: FOCUS });
    expect(q.criteria).toEqual({
      true: { what: TRUE_WHAT, examples: ['Rust 2.0 released'] },
      false: { what: FALSE_WHAT },
    });
    const onlyNo = cardQuestion(
      { interest: 'Rust', examples_yes: null, examples_no: ['Rust the game'] },
      'as_written',
    );
    expect(onlyNo.criteria).toEqual({
      true: { what: TRUE_WHAT },
      false: { what: FALSE_WHAT, examples: ['Rust the game'] },
    });
  });

  it('uses a complete translated pair in english mode, examples as written', () => {
    const withExamples = { ...SLOVAK, examples_yes: ['Koalícia sa rozpadla'] };
    expect(cardQuestion(withExamples, 'english')).toEqual({
      type: 'noul',
      instructions: {
        question: QUESTION,
        interest: 'Slovak domestic politics and coalition disputes',
        not_for: 'Foreign politics',
        focus: FOCUS,
      },
      criteria: {
        true: { what: TRUE_WHAT, examples: ['Koalícia sa rozpadla'] },
        false: { what: FALSE_WHAT },
      },
    });
  });

  it('never mixes a translated interest with an untranslated not_for', () => {
    const partial = { ...SLOVAK, not_for_en: null };
    expect(cardQuestion(partial, 'english').instructions).toEqual({
      question: QUESTION,
      interest: SLOVAK.interest,
      not_for: SLOVAK.not_for,
      focus: FOCUS,
    });
    expect(effectiveCardText(partial, 'english').translated).toBe(false);
  });

  it('translates a card without not_for from interest_en alone', () => {
    const card = { interest: 'Hokej', interest_en: 'Ice hockey' };
    expect(cardQuestion(card, 'english').instructions).toEqual({
      question: QUESTION,
      interest: 'Ice hockey',
      focus: FOCUS,
    });
    expect(effectiveCardText(card, 'english')).toEqual({
      interest: 'Ice hockey',
      notFor: null,
      translated: true,
    });
  });

  it('ignores translations in as_written mode and missing translations in english mode', () => {
    expect(cardQuestion(SLOVAK, 'as_written').instructions).toEqual({
      question: QUESTION,
      interest: SLOVAK.interest,
      not_for: SLOVAK.not_for,
      focus: FOCUS,
    });
    expect(cardQuestion(EV, 'english')).toEqual(cardQuestion(EV, 'as_written'));
  });

  it('hashes the actual built question (card_input_sha256)', () => {
    const asWritten = cardInputSha256(cardQuestion(SLOVAK, 'as_written'));
    const english = cardInputSha256(cardQuestion(SLOVAK, 'english'));
    expect(asWritten).toMatch(/^[0-9a-f]{64}$/);
    expect(english).not.toBe(asWritten);
    expect(cardInputSha256(cardQuestion({ ...SLOVAK }, 'english'))).toBe(english);
    // A changed translation changes the hash, so an answer to the old wording is not reused.
    const retranslated = { ...SLOVAK, interest_en: 'Slovak politics and coalition quarrels' };
    expect(cardInputSha256(cardQuestion(retranslated, 'english'))).not.toBe(english);
    expect(cardInputSha256(cardQuestion(retranslated, 'as_written'))).toBe(asWritten);
  });
});

describe('labelQuestion (spec 05 §5.2)', () => {
  it('uses the shared card title as the label and the interest as the definition', () => {
    expect(labelQuestion({ title: 'Battery tech', body: EV }, 'as_written')).toEqual({
      type: 'noul',
      instructions: {
        question: 'Does `article` fit this label?',
        label: 'Battery tech',
        definition: EV.interest,
        not_for: EV.not_for,
        focus: FOCUS,
      },
      criteria: {
        true: {
          what: "The article's main subject falls within `definition`",
          examples: EV.examples_yes,
        },
        false: { what: FALSE_WHAT, examples: EV.examples_no },
      },
    });
  });

  it('omits the optional fields and keeps the label title as written in english mode', () => {
    expect(
      labelQuestion({ title: 'Na neskôr', body: { interest: 'Na prečítanie' } }, 'english'),
    ).toEqual({
      type: 'noul',
      instructions: {
        question: 'Does `article` fit this label?',
        label: 'Na neskôr',
        definition: 'Na prečítanie',
        focus: FOCUS,
      },
      criteria: {
        true: { what: "The article's main subject falls within `definition`" },
        false: { what: FALSE_WHAT },
      },
    });
    const translated = labelQuestion({ title: 'Politika', body: SLOVAK }, 'english');
    expect(translated.instructions).toEqual({
      question: 'Does `article` fit this label?',
      label: 'Politika',
      definition: 'Slovak domestic politics and coalition disputes',
      not_for: 'Foreign politics',
      focus: FOCUS,
    });
  });

  it('gives differently titled labels different inputs', () => {
    const a = cardInputSha256(labelQuestion({ title: 'Read later', body: EV }, 'as_written'));
    const b = cardInputSha256(labelQuestion({ title: 'Batteries', body: EV }, 'as_written'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(cardInputSha256(cardQuestion(EV, 'as_written')));
  });
});

describe('question keys', () => {
  it('maps card ids to c<cardId> and back', () => {
    expect(cardKey('123')).toBe('c123');
    expect(cardKey('9223372036854775807')).toBe('c9223372036854775807');
    for (const bad of ['0', '01', 'abc', '', '-1', '12345678901234567890']) {
      expect(() => cardKey(bad), bad).toThrow(RangeError);
    }
    expect(parseCardKey('c123')).toBe('123');
    expect(parseCardKey('c0')).toBeNull();
    expect(parseCardKey('c')).toBeNull();
    expect(parseCardKey('t2_technology')).toBeNull();
    expect(parseCardKey('x123')).toBeNull();
  });

  it('maps level-1 ids to t2_<l1> and back', () => {
    expect(l2Key('technology')).toBe('t2_technology');
    expect(() => l2Key('other')).toThrow(RangeError);
    expect(() => l2Key('technology.ai_ml')).toThrow(RangeError);
    expect(parseL2Key('t2_technology')).toBe('technology');
    expect(parseL2Key('t2_other')).toBeNull();
    expect(parseL2Key('t2_nope')).toBeNull();
    expect(parseL2Key('c12')).toBeNull();
  });
});

describe('level-2 topics (spec 05 §4)', () => {
  it('asks one Choice per branch with its children and none_of_these', () => {
    expect(l2Question('transport')).toEqual({
      type: 'choice',
      instructions: { question: 'Which Cars and transport subtopic is `article` primarily about?' },
      criteria: {
        cars: { what: 'Cars' },
        ev: { what: 'Electric vehicles' },
        public_transport_rail: { what: 'Public transport and rail' },
        aviation: { what: 'Aviation' },
        cycling_micromobility: { what: 'Cycling and micromobility' },
        none_of_these: null,
      },
    });
    expect(() => l2Question('other')).toThrow(RangeError);
    expect(() => l2Question('nope')).toThrow(RangeError);
    expect(() => buildL2Question({ nameEn: 'X', children: [{ id: 'x', nameEn: 'X' }] })).toThrow(
      /invalid L2 id/,
    );
  });

  it('selects the top two branches (excluding other) with p ≥ 0.15, by p then id', () => {
    expect(selectL2Branches({ technology: 0.6, science: 0.3, other: 0.9 })).toEqual([
      'technology',
      'science',
    ]);
    expect(selectL2Branches({ technology: 0.5, science: 0.1 })).toEqual(['technology']);
    expect(selectL2Branches({ technology: 0.9, science: 0.05, health: 0.04 })).toEqual([
      'technology',
    ]);
    expect(selectL2Branches({ science: 0.4, business: 0.4, technology: 0.2 })).toEqual([
      'business',
      'science',
    ]);
    expect(selectL2Branches({ sports: 0.3, health: 0.3, diy: 0.3 })).toEqual(['diy', 'health']);
    expect(selectL2Branches({ sports: 0.15, health: 0.14 })).toEqual(['sports']);
    expect(selectL2Branches({ other: 1 })).toEqual([]);
    expect(selectL2Branches({})).toEqual([]);
    expect(selectL2Branches({ nope: 0.9, sports: Number.NaN, health: 0.2 })).toEqual(['health']);
  });
});

describe('card body validation (spec 05 §5.1)', () => {
  it('accepts a full valid body', () => {
    const result = validateCardBody(EV);
    expect(result).toEqual({ ok: true, body: EV });
    expect(validateCardBody(SLOVAK).ok).toBe(true);
    expect(validateCardBody({ interest: 'abc' }).ok).toBe(true);
  });

  it('enforces the length limits in characters', () => {
    const problems = (body: unknown) => {
      const result = validateCardBody(body);
      return result.ok ? [] : result.problems.map((p) => `${p.path}: ${p.message}`);
    };
    expect(problems({ interest: 'ab' })).toEqual(['interest: must have at least 3 characters']);
    expect(problems({ interest: '  ab  ' })).toEqual(['interest: must have at least 3 characters']);
    expect(problems({ interest: 'x'.repeat(300) })).toEqual([]);
    expect(problems({ interest: '😀'.repeat(300) })).toEqual([]);
    expect(problems({ interest: 'x'.repeat(301) })).toEqual([
      'interest: must have at most 300 characters',
    ]);
    expect(problems({ interest: 'abc', not_for: 'x'.repeat(301) })).toEqual([
      'not_for: must have at most 300 characters',
    ]);
    const six = Array.from({ length: 6 }, (_, i) => `example ${i}`);
    expect(problems({ interest: 'abc', examples_yes: six })).toEqual([
      'examples_yes: at most 5 examples',
    ]);
    expect(problems({ interest: 'abc', examples_no: ['x'.repeat(201), ' '] })).toEqual([
      'examples_no[0]: must have at most 200 characters',
      'examples_no[1]: must have at least 1 characters',
    ]);
    expect(problems({ interest: 'abc', examples_no: 'nope' })).toEqual([
      'examples_no: must be an array of strings',
    ]);
    expect(problems({ interest: 5 })).toEqual(['interest: must be a string']);
    expect(problems({ interest: 'abc', title: 'x' })).toEqual(['title: is not a card body field']);
    expect(problems(null)).toEqual(['body: must be an object']);
    expect(problems(['abc'])).toEqual(['body: must be an object']);
    expect(
      problems({ interest: 'abc', interest_en: 'x'.repeat(CARD_LIMITS.translatedMax + 1) }),
    ).toEqual(['interest_en: must have at most 600 characters']);
  });

  it('requires the English pair to be absent or complete', () => {
    const pair = (body: Record<string, unknown>) =>
      validateCardBody({ interest: 'abc', ...body }).ok;
    expect(pair({})).toBe(true);
    expect(pair({ interest_en: null, not_for_en: null })).toBe(true);
    expect(pair({ interest_en: 'ABC' })).toBe(true);
    expect(pair({ not_for: 'x', interest_en: 'ABC', not_for_en: 'X' })).toBe(true);
    expect(pair({ not_for: 'x', interest_en: 'ABC' })).toBe(false);
    expect(pair({ interest_en: 'ABC', not_for_en: 'X' })).toBe(false);
    expect(pair({ not_for: 'x', not_for_en: 'X' })).toBe(false);
    expect(pair({ interest_en: '' })).toBe(false);
    expect(pair({ not_for: ' ', interest_en: 'ABC' })).toBe(true);
  });

  it('validates titles and derives the default title', () => {
    expect(validateCardTitle('Rust')).toEqual([]);
    expect(validateCardTitle('x'.repeat(60))).toEqual([]);
    expect(validateCardTitle('x'.repeat(61))).toEqual([
      { path: 'title', message: 'must have at most 60 characters' },
    ]);
    expect(validateCardTitle(' ')).toEqual([
      { path: 'title', message: 'must have at least 1 characters' },
    ]);
    expect(validateCardTitle(undefined)).toEqual([{ path: 'title', message: 'must be a string' }]);
    const interest =
      'The Rust programming language: releases, libraries, tooling and real-world use';
    expect(defaultCardTitle(interest)).toBe(
      'The Rust programming language: releases, libraries, tooling',
    );
    expect(defaultCardTitle('  Short  ')).toBe('Short');
    expect(Array.from(defaultCardTitle('ž'.repeat(80)))).toHaveLength(60);
  });
});
