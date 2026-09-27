import { canonicalSha256 } from '@bantoozi/shared/server';

import {
  TRANSLATION_FIELDS,
  type SourceField,
  type TranslationField,
  type TranslationTexts,
} from './types.js';

/**
 * Translation input bounds in code points: spec 07 §3 step 1 translates the title, the first 600
 * characters of the excerpt and at most 1,500 of the body lead; titles are at most 500 as parsed
 * (spec 03 §6).
 */
export const ARTICLE_SOURCE_LIMITS: Readonly<Record<TranslationField, number>> = Object.freeze({
  title: 500,
  excerpt: 600,
  body_lead: 1500,
});

/** Whether a text has nothing to translate: absent, empty or whitespace only. */
export function isBlankText(text: string | null | undefined): boolean {
  return text === null || text === undefined || text.trim() === '';
}

/** The first `max` code points of `text` (never splits a surrogate pair). */
export function cutToCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  let count = 0;
  for (const ch of text) {
    if (count === max) break;
    out += ch;
    count += 1;
  }
  return out;
}

/**
 * An article's translation source: each field trimmed and cut to {@link ARTICLE_SOURCE_LIMITS};
 * a blank field is `null` (absent).
 */
export function articleTranslationSource(input: Partial<TranslationTexts>): TranslationTexts {
  const field = (name: TranslationField): string | null => {
    const value = input[name];
    if (isBlankText(value)) return null;
    return cutToCodePoints((value as string).trim(), ARTICLE_SOURCE_LIMITS[name]);
  };
  return { title: field('title'), excerpt: field('excerpt'), body_lead: field('body_lead') };
}

/**
 * The nonblank fields of `texts` in `order`, each tagged with its field: the explicit ordered
 * mapping every request keeps (spec 07 §3). Absent fields are left out without shifting the rest.
 */
export function sourceFields<F extends string>(
  texts: Readonly<Partial<Record<F, string | null>>>,
  order: readonly F[],
): SourceField<F>[] {
  const fields: SourceField<F>[] = [];
  for (const field of order) {
    const text = texts[field];
    if (typeof text === 'string' && !isBlankText(text)) fields.push({ field, text });
  }
  return fields;
}

/** {@link sourceFields} of an article in the fixed order title, excerpt, body lead. */
export function articleSourceFields(texts: Readonly<Partial<TranslationTexts>>): SourceField[] {
  return sourceFields(texts, TRANSLATION_FIELDS);
}

/**
 * `article_translations.source_sha256` ("the exact source text sent to translation", spec 02):
 * SHA-256 of the canonical JSON of the source language and the three source fields (absent =
 * `null`). Both tiers translating one revision's source share it.
 */
export function translationSourceSha256(sourceLang: string, texts: TranslationTexts): string {
  return canonicalSha256({
    source_lang: sourceLang,
    title: texts.title,
    excerpt: texts.excerpt,
    body_lead: texts.body_lead,
  });
}
