import type { AssignmentCandidate } from '@bantoozi/db';
import { ENRICH_V1, TAXONOMY } from '@bantoozi/questions';
import { z } from 'zod';

import { languageQuotas, seededKey, seededShuffle } from './assignments.js';

/**
 * Facet labels (spec 10 §2.3): the human reference for Call A's enrichment accuracy. A labeller sets
 * six fields per article. Each field also offers `uncertain` and `not_applicable`, so nobody is
 * forced into a false class; the metrics exclude those two values (spec 10 §4).
 *
 * Stored in `eval.facet_labels` with `question_key` = the field name and `labeler` = the labeller's
 * participant key (one human labels once, whatever context they signed in with). Values:
 * - `content_type`: an `enrich-v1` content-type option (`news_report`, …, `other`)
 * - `topic_l1`: a level-1 taxonomy id (`technology`, …, `other`)
 * - `depth`: `0`…`4` (the `enrich-v1` depth scale)
 * - `clickbait`, `promotional`, `time_sensitive`: `yes` / `no`
 */

export const FACET_UNSURE_VALUES = ['uncertain', 'not_applicable'] as const;

export interface FacetField {
  key: 'content_type' | 'topic_l1' | 'depth' | 'clickbait' | 'promotional' | 'time_sensitive';
  label: string;
  /** Class values and their display text (the unsure values are added by the page). */
  options: ReadonlyArray<{ value: string; text: string }>;
}

const DEPTH_TEXT = ENRICH_V1.questions.depth.criteria;

export const FACET_FIELDS: readonly FacetField[] = [
  {
    key: 'content_type',
    label: 'Content type',
    options: Object.keys(ENRICH_V1.questions.content_type.criteria).map((value) => ({
      value,
      text: value.replace(/_/gu, ' '),
    })),
  },
  {
    key: 'topic_l1',
    label: 'Main topic',
    options: TAXONOMY.map((topic) => ({ value: topic.id, text: topic.nameEn })),
  },
  {
    key: 'depth',
    label: 'Depth',
    options: DEPTH_TEXT.map((text, level) => ({ value: String(level), text: `${level}: ${text}` })),
  },
  { key: 'clickbait', label: 'Clickbait', options: yesNo() },
  { key: 'promotional', label: 'Promotional', options: yesNo() },
  { key: 'time_sensitive', label: 'Time-sensitive', options: yesNo() },
];

function yesNo(): ReadonlyArray<{ value: string; text: string }> {
  return [
    { value: 'yes', text: 'yes' },
    { value: 'no', text: 'no' },
  ];
}

export const FACET_KEYS = FACET_FIELDS.map((f) => f.key);

/** The labelling form body: all six fields are required, each a known value. */
export const FacetFormSchema = z.object(
  Object.fromEntries(
    FACET_FIELDS.map((field) => [
      field.key,
      z.enum([...FACET_UNSURE_VALUES, ...field.options.map((o) => o.value)]),
    ]),
  ),
);

/** Articles per language for the primary labeller (spec 10 §2.3). */
export const FACETS_PER_LANGUAGE = 100;
/** The second labeller's overlap subset (spec 10 §2.3). */
export const FACET_OVERLAP_SIZE = 50;

/**
 * The primary labeller's set (pure): up to `perLang` articles per language of the sample, in a
 * seeded order. Articles already labelled (`keep`) come first, so a growing sample never takes away
 * work already done; the rest follow the seeded hash order, which a new article can only enter
 * where it ranks, never reshuffling the others. Returned in a seeded mixed-language order.
 */
export function selectFacetSet(input: {
  seed: string;
  candidates: readonly AssignmentCandidate[];
  perLang?: number;
  keep?: ReadonlySet<string>;
}): AssignmentCandidate[] {
  const perLang = input.perLang ?? FACETS_PER_LANGUAGE;
  const keep = input.keep ?? new Set<string>();
  const byLang = new Map<string, AssignmentCandidate[]>();
  for (const candidate of input.candidates) {
    const list = byLang.get(candidate.lang) ?? [];
    list.push(candidate);
    byLang.set(candidate.lang, list);
  }
  const chosen: AssignmentCandidate[] = [];
  for (const [, list] of [...byLang].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ranked = list
      .map((c) => ({
        c,
        kept: keep.has(c.articleId),
        key: seededKey(input.seed, 'facet', c.articleId),
      }))
      .sort((a, b) => Number(b.kept) - Number(a.kept) || (a.key < b.key ? -1 : 1));
    chosen.push(...ranked.slice(0, perLang).map((r) => r.c));
  }
  return orderForLabelling(chosen, input.seed);
}

/**
 * The second labeller's overlap subset (pure, deterministic): `size` articles of the primary set,
 * spread equally across its languages (a short language topped up from the others round-robin).
 * Articles the second labeller already labelled are kept first.
 */
export function selectOverlap(input: {
  seed: string;
  primary: readonly AssignmentCandidate[];
  size?: number;
  keep?: ReadonlySet<string>;
}): AssignmentCandidate[] {
  const size = input.size ?? FACET_OVERLAP_SIZE;
  const keep = input.keep ?? new Set<string>();
  const langs = [...new Set(input.primary.map((c) => c.lang))].sort();
  const quotas = languageQuotas(langs, size);
  const byLang = new Map<string, AssignmentCandidate[]>();
  for (const lang of langs) {
    const ranked = input.primary
      .filter((c) => c.lang === lang)
      .map((c) => ({
        c,
        kept: keep.has(c.articleId),
        key: seededKey(input.seed, 'overlap', c.articleId),
      }))
      .sort((a, b) => Number(b.kept) - Number(a.kept) || (a.key < b.key ? -1 : 1));
    byLang.set(
      lang,
      ranked.map((r) => r.c),
    );
  }
  const chosen: AssignmentCandidate[] = [];
  for (const lang of langs) {
    const list = byLang.get(lang) ?? [];
    chosen.push(...list.splice(0, quotas.get(lang) ?? 0));
  }
  let progressed = true;
  while (chosen.length < size && progressed) {
    progressed = false;
    for (const lang of langs) {
      if (chosen.length >= size) break;
      const next = byLang.get(lang)?.shift();
      if (next === undefined) continue;
      chosen.push(next);
      progressed = true;
    }
  }
  return orderForLabelling(chosen, input.seed);
}

function orderForLabelling(
  items: readonly AssignmentCandidate[],
  seed: string,
): AssignmentCandidate[] {
  const byId = new Map(items.map((c) => [c.articleId, c]));
  return seededShuffle(
    items.map((c) => c.articleId),
    seed,
    'facet-order',
  )
    .map((id) => byId.get(id))
    .filter((c): c is AssignmentCandidate => c !== undefined);
}

/** The facet seed of a dataset lineage (every version of a lineage shares its seed). */
export function facetSeed(datasetSeed: string): string {
  return `${datasetSeed}:facets`;
}
