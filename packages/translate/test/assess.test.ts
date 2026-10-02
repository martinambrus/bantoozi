import { describe, expect, it, vi } from 'vitest';

/** Lets a test force the next `detectLanguage` result to probe the exact thresholds. */
const detector = vi.hoisted(() => ({
  next: undefined as { lang: string; confidence: number } | undefined,
}));

vi.mock('@bantoozi/shared/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const detect = actual['detectLanguage'] as (text: string, options?: unknown) => unknown;
  return {
    ...actual,
    detectLanguage: (text: string, options?: unknown) => {
      const forced = detector.next;
      detector.next = undefined;
      return forced ?? detect(text, options);
    },
  };
});

import {
  ASSESSMENT_THRESHOLDS,
  assessTranslation,
  maxTrigramRepeats,
  trigramRepeatLimit,
  sharedTokenShare,
  type TranslationAssessment,
} from '../src/index.js';

/** A Slovak source of 48 characters and its English translation. */
const SK = 'Vláda schválila nový rozpočet na verejnú dopravu';
const EN = 'The government approved a new budget for public transport';
/** A Slovak source of 75 characters for the loop checks. */
const SK_LONG = 'Vláda schválila nový rozpočet na verejnú dopravu v Bratislave a v Košiciach';
/** A 20-character Slovak source: the shortest one the per-field checks apply to. */
const SK_20 = 'Nový most cez Dunaj.';

type Graded<F extends string> = Extract<TranslationAssessment<F>, { skipped: false }>;

function graded<F extends string>(assessment: TranslationAssessment<F>): Graded<F> {
  if (assessment.skipped) throw new Error('expected a graded assessment');
  return assessment;
}

/** Assesses one `title` field. */
function one(source: string, output: unknown): Graded<'title'> {
  return graded(assessTranslation({ title: source }, { title: output }, 'sk'));
}

describe('assessTranslation: shape first (spec 07 §4)', () => {
  it('skips an entirely empty input instead of reporting ok', () => {
    const empty: Array<Readonly<Record<string, string | null | undefined>>> = [
      { title: null, excerpt: null, body_lead: null },
      { title: '', excerpt: '   ', body_lead: undefined },
      {},
    ];
    for (const source of empty) {
      expect(assessTranslation(source, { title: 'Anything' }, 'sk')).toEqual({
        skipped: true,
        reason: 'empty_input',
        sourceLang: 'sk',
      });
    }
  });

  it('fails output that is not an object, conclusively', () => {
    for (const output of [null, undefined, 'The government approved it', [EN], 42, true]) {
      const assessment = graded(assessTranslation({ title: SK, excerpt: null }, output, 'sk'));
      expect(assessment).toMatchObject({
        quality: 'fail',
        conclusive: true,
        shape: 'not_an_object',
      });
      expect(assessment.fields.title).toEqual({
        result: 'fail',
        reasons: ['missing_output'],
        sourceChars: 48,
      });
      expect(assessment.fields.excerpt.result).toBe('absent');
    }
  });

  it('fails output with keys beyond the source fields, even when every field is fine', () => {
    const assessment = graded(
      assessTranslation({ title: SK, excerpt: null }, { title: EN, summary: 'Extra' }, 'sk'),
    );
    expect(assessment).toMatchObject({ quality: 'fail', conclusive: true, shape: 'extra_keys' });
    expect(assessment.fields.title.result).toBe('ok');
  });

  it('treats hostile JSON keys such as __proto__ as data: an extra key, never a field', () => {
    const polluted: unknown = JSON.parse(`{"title":"${EN}","__proto__":{"excerpt":"Injected"}}`);
    expect(graded(assessTranslation({ title: SK, excerpt: SK }, polluted, 'sk'))).toMatchObject({
      quality: 'fail',
      shape: 'extra_keys',
      fields: { excerpt: { result: 'fail', reasons: ['missing_output'] } },
    });
    const inherited: unknown = JSON.parse('{"__proto__":{"title":"Injected title text here"}}');
    expect(graded(assessTranslation({ title: SK }, inherited, 'sk'))).toMatchObject({
      quality: 'fail',
      fields: { title: { result: 'fail', reasons: ['missing_output'] } },
    });
    // An inherited property is not an own field either.
    const child = Object.create({ title: EN }) as object;
    expect(graded(assessTranslation({ title: SK }, child, 'sk')).quality).toBe('fail');
  });

  it('fails a nonblank source field whose output is empty, missing or not a string, even when short', () => {
    const cases: Array<[unknown, string]> = [
      [{ title: '' }, 'empty_output'],
      [{ title: ' \n\t ' }, 'empty_output'],
      [{}, 'missing_output'],
      [{ title: null }, 'missing_output'],
      [{ title: undefined }, 'missing_output'],
      [{ title: 42 }, 'not_a_string'],
      [{ title: ['Bridge'] }, 'not_a_string'],
      [{ title: { text: 'Bridge' } }, 'not_a_string'],
    ];
    for (const source of ['Most', SK]) {
      for (const [output, reason] of cases) {
        const assessment = graded(assessTranslation({ title: source }, output, 'sk'));
        expect(assessment.quality, `${source} → ${JSON.stringify(output)}`).toBe('fail');
        expect(assessment.shape).toBe('ok');
        expect(assessment.fields.title.reasons).toEqual([reason]);
      }
    }
  });

  it('excludes absent source fields from scoring, whatever the output says for them', () => {
    const source = { title: SK, excerpt: null, body_lead: '   ' };
    for (const output of [
      { title: EN, excerpt: '', body_lead: '' },
      { title: EN },
      { title: EN, excerpt: 'Model chatter', body_lead: 42 },
    ]) {
      const assessment = graded(assessTranslation(source, output, 'sk'));
      expect(assessment).toMatchObject({ quality: 'ok', conclusive: true, shape: 'ok' });
      expect(assessment.fields.excerpt).toEqual({ result: 'absent', reasons: [], sourceChars: 0 });
      expect(assessment.fields.body_lead).toEqual({
        result: 'absent',
        reasons: [],
        sourceChars: 0,
      });
    }
  });

  it('grades short-only input ok but not conclusive: short text proves nothing', () => {
    const assessment = graded(
      assessTranslation({ title: 'Nový most', excerpt: null }, { title: 'X', excerpt: '' }, 'sk'),
    );
    expect(assessment).toMatchObject({ quality: 'ok', conclusive: false, shape: 'ok' });
    expect(assessment.fields.title).toEqual({
      result: 'inconclusive',
      reasons: ['short_source'],
      sourceChars: 9,
      outputChars: 1,
    });
  });

  it('rejects a source value that is not a string (a programming error)', () => {
    expect(() =>
      assessTranslation({ title: 42 as unknown as string }, { title: 'x' }, 'sk'),
    ).toThrow(TypeError);
  });
});

describe('assessTranslation: the per-field checks (spec 07 §4 table)', () => {
  it('grades a real translation ok with its per-field details', () => {
    const assessment = one(SK, EN);
    expect(assessment).toEqual({
      skipped: false,
      quality: 'ok',
      conclusive: true,
      shape: 'ok',
      sourceLang: 'sk',
      fields: {
        title: {
          result: 'ok',
          reasons: [],
          sourceChars: 48,
          outputChars: 57,
          lengthRatio: 1.188,
          maxTrigramRepeats: 1,
          sourceMaxTrigramRepeats: 1,
          sharedTokenShare: 0,
          detected: { lang: 'en', confidence: expect.any(Number) as number },
        },
      },
    });
    // The details are plain JSON for quality_detail.
    expect(JSON.parse(JSON.stringify(assessment))).toEqual(assessment);
  });

  it('applies the checks from a 20-character source, and counts characters as code points', () => {
    expect(one('Nový most cez Dunaj', 'Bridge!').fields.title.result).toBe('inconclusive');
    expect(one(SK_20, 'Bridge!').fields.title).toMatchObject({
      result: 'fail',
      reasons: ['length_ratio'],
      lengthRatio: 0.35,
    });
    // 19 emoji are 38 UTF-16 units but 19 characters: still short.
    expect(one('😀'.repeat(19), 'X').fields.title.result).toBe('inconclusive');
  });

  it('fails an empty output', () => {
    expect(one(SK, '').fields.title).toMatchObject({ result: 'fail', reasons: ['empty_output'] });
  });

  it('fails a length ratio outside [0.4, 2.5], boundaries included in the valid range', () => {
    // 8 / 20 = 0.4 is inside; 7 / 20 = 0.35 is below.
    expect(one(SK_20, 'New span').fields.title).toMatchObject({ result: 'ok', lengthRatio: 0.4 });
    expect(one(SK_20, 'New spa').fields.title).toMatchObject({
      result: 'fail',
      reasons: ['length_ratio'],
    });
    // 50 / 20 = 2.5 is inside; 51 / 20 = 2.55 is above (a model that added text).
    const long = 'The new bridge over the Danube opened this morning';
    expect(one(SK_20, long).fields.title).toMatchObject({ result: 'ok', lengthRatio: 2.5 });
    expect(one(SK_20, `${long}.`).fields.title).toMatchObject({
      result: 'fail',
      reasons: ['length_ratio'],
      lengthRatio: 2.55,
    });
  });

  it('fails the same word 3-gram repeated more than 4 times (a model loop)', () => {
    const loop = (times: number): string => Array(times).fill('the bridge opens').join(' ');
    expect(one(SK_LONG, loop(4)).fields.title).toMatchObject({
      result: 'ok',
      maxTrigramRepeats: 4,
    });
    expect(one(SK_LONG, loop(5)).fields.title).toMatchObject({
      result: 'fail',
      reasons: ['repeated_trigram'],
      maxTrigramRepeats: 5,
    });
  });

  it('allows the repetition a source already has, plus English function-word 3-grams (D-144)', () => {
    expect([0, 1, 2, 5].map(trigramRepeatLimit)).toEqual([4, 4, 6, 12]);
    // A listing that repeats "cena za dopravu" five times translates to "price for transport" ×5.
    const listing = Array(5).fill('Disketa 3,5 palca, cena za dopravu 4 eur.').join(' ');
    const listingEn = Array(5).fill('Floppy disk 3.5 inch, price for transport 4 euros.').join(' ');
    expect(one(listing, listingEn).fields.title).toMatchObject({
      result: 'ok',
      maxTrigramRepeats: 5,
      sourceMaxTrigramRepeats: 5,
    });
    // Slovak has no articles: "the su 37" recurs five times where the source's most repeated
    // 3-gram ("na leteckych prehliadkach") occurs twice, within the limit of 6.
    const jet =
      'Su-37 na leteckých prehliadkach ohromilo. Na leteckých prehliadkach sa Su-37 otočilo. ' +
      'Su-37 pristálo. Su-37 odletelo. Su-37 je späť.';
    const jetEn =
      'The Su-37 amazed at air shows. At air shows the Su-37 turned. The Su-37 landed. ' +
      'The Su-37 flew away. The Su-37 is back.';
    expect(one(jet, jetEn).fields.title).toMatchObject({
      result: 'ok',
      maxTrigramRepeats: 5,
      sourceMaxTrigramRepeats: 2,
    });
    // A real loop still fails far beyond the source's own repetition.
    expect(
      one(listing, `${listingEn} ${Array(9).fill('price for transport').join(' ')}`).fields.title,
    ).toMatchObject({ result: 'fail', reasons: ['repeated_trigram'] });
  });

  it('grades weak when more than half of the output tokens also appear in the source', () => {
    // Exactly half (tesla, model of tesla, model, reaches, berlin) is still fine.
    expect(
      one('Tesla Model Y v Berlíne', 'Tesla Model Y reaches Berlin').fields.title,
    ).toMatchObject({ result: 'ok', sharedTokenShare: 0.5 });
    expect(
      one(
        'Tesla Model Y a Volkswagen ID.4 v teste spotreby',
        'Tesla Model Y and Volkswagen ID.4 in a consumption test',
      ).fields.title,
    ).toMatchObject({ result: 'weak', reasons: ['untranslated_share'], sharedTokenShare: 0.6 });
    // An echo of the source (the fake server's weak mode) is untranslated.
    expect(one(SK, SK).fields.title).toMatchObject({
      result: 'weak',
      reasons: ['untranslated_share'],
      sharedTokenShare: 1,
    });
  });

  it('grades weak when the detector names a known non-English language', () => {
    expect(
      one(SK, 'Die Regierung hat einen neuen Haushalt für den Nahverkehr beschlossen').fields.title,
    ).toMatchObject({
      result: 'weak',
      reasons: ['non_english'],
      sharedTokenShare: 0,
      detected: { lang: 'de' },
    });
  });

  it('uses the confidence threshold of 0.1 inclusively and ignores English and und', () => {
    const detectedAs = (lang: string, confidence: number): Graded<'title'> => {
      detector.next = { lang, confidence };
      return one(SK, EN);
    };
    expect(detectedAs('de', ASSESSMENT_THRESHOLDS.minNonEnglishConfidence).quality).toBe('weak');
    expect(detectedAs('de', 0.0999).quality).toBe('ok');
    expect(detectedAs('cs', 0.8).fields.title.reasons).toEqual(['non_english']);
    expect(detectedAs('en', 0.9).quality).toBe('ok');
    expect(detectedAs('und', 0).fields.title).toMatchObject({
      result: 'ok',
      detected: { lang: 'und', confidence: 0 },
    });
  });

  it('lets names and brands survive translation (the 0.5 share is lenient)', () => {
    const assessment = one(
      'Elon Musk v utorok navštívil továreň Tesla v Berlíne a stretol sa s kancelárom.',
      'On Tuesday, Elon Musk visited the Tesla factory in Berlin and met the chancellor.',
    );
    expect(assessment.quality).toBe('ok');
    expect(assessment.fields.title.sharedTokenShare).toBe(0.375);
  });

  it('treats a detector und (unknown language) as inconclusive, not as a failure', () => {
    const assessment = one('Nový most cez Dunaj otvorili', 'New Danube bridge opened');
    expect(assessment.quality).toBe('ok');
    expect(assessment.fields.title).toMatchObject({
      result: 'ok',
      reasons: [],
      detected: { lang: 'und', confidence: 0 },
    });
  });

  it('lets the worst field win, and records every field', () => {
    const german = 'Die Regierung hat einen neuen Haushalt für den Nahverkehr beschlossen';
    const loop = Array(5).fill('the bridge opens').join(' ');
    const source = { title: SK, excerpt: SK, body_lead: SK_LONG };
    const weak = graded(
      assessTranslation(source, { title: EN, excerpt: german, body_lead: EN }, 'sk'),
    );
    expect(weak.quality).toBe('weak');
    expect(weak.fields.title.result).toBe('ok');
    expect(weak.fields.excerpt.result).toBe('weak');
    const failed = graded(
      assessTranslation(source, { title: EN, excerpt: german, body_lead: loop }, 'sk'),
    );
    expect(failed.quality).toBe('fail');
    expect(failed.fields.body_lead.reasons).toEqual(['repeated_trigram']);
    // A short field never lowers the grade; a short empty one fails.
    const mixed = { title: 'Most', excerpt: SK, body_lead: null };
    expect(graded(assessTranslation(mixed, { title: 'B', excerpt: EN }, 'sk')).quality).toBe('ok');
    expect(graded(assessTranslation(mixed, { title: '', excerpt: EN }, 'sk')).quality).toBe('fail');
  });

  it('assesses any field names, such as the card pair', () => {
    const assessment = graded(
      assessTranslation({ interest: SK, not_for: null }, { interest: EN, not_for: null }, 'sk'),
    );
    expect(assessment.quality).toBe('ok');
    expect(Object.keys(assessment.fields)).toEqual(['interest', 'not_for']);
  });
});

describe('assessment helpers', () => {
  it('counts the most frequent normalized word 3-gram', () => {
    expect(maxTrigramRepeats('')).toBe(0);
    expect(maxTrigramRepeats('two words')).toBe(0);
    expect(maxTrigramRepeats('a b c a b c')).toBe(2);
    expect(maxTrigramRepeats('Most, most! MOST most most')).toBe(3);
  });

  it('measures the shared share over normalized output tokens of at least 4 characters', () => {
    expect(sharedTokenShare('Tesla Model', 'Tesla bridge')).toBe(0.5);
    expect(sharedTokenShare('Nový MOST', 'nový most and the')).toBe(1);
    expect(sharedTokenShare('Nový most', 'Novy most')).toBe(1);
    expect(sharedTokenShare('source text', 'a an of')).toBeUndefined();
  });
});
