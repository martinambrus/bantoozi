import { canonicalJson } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';
import { describe, expect, it } from 'vitest';

import type { ContentHashInput } from '../../src/parse/index.js';
import { computeContentHash } from '../../src/parse/index.js';

const BASE: ContentHashInput = {
  title: 'Mestské zastupiteľstvo schválilo rozpočet',
  excerpt: 'Poslanci podporili návrh s úpravami.',
  author: 'Jana Nováková',
  categories: ['Politika', 'Bratislava'],
  link: 'https://www.dennik.example/spravy/rozpocet',
  feedBodyText: 'Poslanci podporili návrh s úpravami.\n\nRozpočet počíta s investíciami.',
};

describe('computeContentHash (spec 03 §6.2)', () => {
  it('is SHA-256 of the canonical JSON of the model inputs (pinned formula)', () => {
    const expected = sha256Hex(
      canonicalJson({
        author: BASE.author,
        body_sha256: sha256Hex(BASE.feedBodyText ?? ''),
        categories: ['Bratislava', 'Politika'],
        excerpt: BASE.excerpt,
        link: BASE.link,
        title: BASE.title,
      }),
    );
    expect(computeContentHash(BASE)).toBe(expected);
    expect(computeContentHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key or category order', () => {
    const reordered: ContentHashInput = {
      feedBodyText: BASE.feedBodyText,
      link: BASE.link,
      categories: ['Bratislava', 'Politika'],
      author: BASE.author,
      excerpt: BASE.excerpt,
      title: BASE.title,
    };
    expect(computeContentHash(reordered)).toBe(computeContentHash(BASE));
  });

  it('does not mutate the categories', () => {
    const categories = ['b', 'a'];
    computeContentHash({ ...BASE, categories });
    expect(categories).toEqual(['b', 'a']);
  });

  it.each<[string, Partial<ContentHashInput>]>([
    ['a diacritic change in the title', { title: 'Mestske zastupiteľstvo schválilo rozpočet' }],
    ['a case change in the title', { title: 'Mestské Zastupiteľstvo schválilo rozpočet' }],
    ['an excerpt edit', { excerpt: 'Poslanci podporili návrh bez úprav.' }],
    ['an author correction', { author: 'Jana Novák' }],
    ['a category change', { categories: ['Politika', 'Košice'] }],
    ['a category case change', { categories: ['politika', 'Bratislava'] }],
    ['a different link', { link: 'https://www.dennik.example/spravy/rozpocet-2' }],
    ['a feed body change', { feedBodyText: `${BASE.feedBodyText ?? ''} Doplnené.` }],
    ['a missing feed body', { feedBodyText: null }],
    ['a missing excerpt', { excerpt: null }],
    ['a missing author', { author: null }],
    ['a missing link', { link: null }],
  ])('changes on %s', (_label, change) => {
    expect(computeContentHash({ ...BASE, ...change })).not.toBe(computeContentHash(BASE));
  });

  it('changes on a correction beyond character 500 of the excerpt or body', () => {
    const long = 'Slovo '.repeat(150);
    const excerpt = `${long}pôvodne`;
    const body = `${long}${long}pôvodne`;
    const before = computeContentHash({ ...BASE, excerpt, feedBodyText: body });
    expect(excerpt.length).toBeGreaterThan(500);
    expect(
      computeContentHash({ ...BASE, excerpt: `${long}opravené`, feedBodyText: body }),
    ).not.toBe(before);
    expect(
      computeContentHash({ ...BASE, excerpt, feedBodyText: `${long}${long}opravené` }),
    ).not.toBe(before);
  });

  it('is stable for identical inputs', () => {
    expect(computeContentHash({ ...BASE })).toBe(computeContentHash({ ...BASE }));
  });
});
