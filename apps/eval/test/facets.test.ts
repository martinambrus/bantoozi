import { describe, expect, it } from 'vitest';

import {
  FACET_FIELDS,
  FACET_KEYS,
  FacetFormSchema,
  selectFacetSet,
  selectOverlap,
} from '../src/rating-server/facets.js';

/** M3a-T4 (spec 10 §2.3): facet fields and the deterministic labelling sets. */

const candidates = (lang: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ articleId: String(from + i), lang }));

const sample = [
  ...candidates('en', 1, 500),
  ...candidates('sk', 1000, 500),
  ...candidates('cs', 2000, 80),
];

const countBy = (items: ReadonlyArray<{ lang: string }>) => {
  const out: Record<string, number> = {};
  for (const item of items) out[item.lang] = (out[item.lang] ?? 0) + 1;
  return out;
};

describe('facet fields', () => {
  it('are the six fields of spec 10 §2.3', () => {
    expect(FACET_KEYS).toEqual([
      'content_type',
      'topic_l1',
      'depth',
      'clickbait',
      'promotional',
      'time_sensitive',
    ]);
    expect(FACET_FIELDS.find((f) => f.key === 'depth')?.options.map((o) => o.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(FACET_FIELDS.find((f) => f.key === 'content_type')?.options.length).toBe(12);
    expect(FACET_FIELDS.find((f) => f.key === 'topic_l1')?.options.length).toBe(20);
  });

  it('requires every field and accepts uncertain / not applicable', () => {
    const full = {
      content_type: 'news_report',
      topic_l1: 'technology',
      depth: '2',
      clickbait: 'no',
      promotional: 'uncertain',
      time_sensitive: 'not_applicable',
    };
    expect(FacetFormSchema.safeParse(full).success).toBe(true);
    expect(FacetFormSchema.safeParse({ ...full, depth: '5' }).success).toBe(false);
    expect(FacetFormSchema.safeParse({ ...full, clickbait: 'maybe' }).success).toBe(false);
    const { topic_l1: _omitted, ...missing } = full;
    expect(FacetFormSchema.safeParse(missing).success).toBe(false);
  });
});

describe('selectFacetSet', () => {
  it('takes 100 articles per language (all of a short language), deterministically', () => {
    const set = selectFacetSet({ seed: 'golden:facets', candidates: sample });
    expect(countBy(set)).toEqual({ en: 100, sk: 100, cs: 80 });
    const again = selectFacetSet({ seed: 'golden:facets', candidates: [...sample].reverse() });
    expect(again).toEqual(set);
    const other = selectFacetSet({ seed: 'other', candidates: sample });
    expect(other.map((c) => c.articleId)).not.toEqual(set.map((c) => c.articleId));
  });

  it('keeps labelled articles and is stable when the sample grows', () => {
    const set = selectFacetSet({ seed: 's', candidates: sample });
    const labelled = new Set(set.slice(0, 30).map((c) => c.articleId));
    const grown = selectFacetSet({
      seed: 's',
      candidates: [...sample, ...candidates('en', 9000, 400)],
      keep: labelled,
    });
    for (const id of labelled) expect(grown.some((c) => c.articleId === id)).toBe(true);
    expect(countBy(grown)).toEqual({ en: 100, sk: 100, cs: 80 });
  });
});

describe('selectOverlap (second labeller)', () => {
  it('chooses 50 of the primary set spread across languages, deterministically', () => {
    const primary = selectFacetSet({ seed: 's', candidates: sample });
    const overlap = selectOverlap({ seed: 's', primary });
    expect(overlap).toHaveLength(50);
    expect(countBy(overlap)).toEqual({ cs: 17, en: 17, sk: 16 });
    const ids = new Set(primary.map((c) => c.articleId));
    for (const item of overlap) expect(ids.has(item.articleId)).toBe(true);
    expect(selectOverlap({ seed: 's', primary: [...primary].reverse() })).toEqual(overlap);
  });

  it('tops a short language up from the others', () => {
    const primary = [...candidates('en', 1, 100), ...candidates('sk', 1000, 5)];
    const overlap = selectOverlap({ seed: 's', primary });
    expect(countBy(overlap)).toEqual({ en: 45, sk: 5 });
  });
});
