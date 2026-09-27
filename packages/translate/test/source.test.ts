import { describe, expect, it } from 'vitest';

import {
  ARTICLE_SOURCE_LIMITS,
  articleSourceFields,
  articleTranslationSource,
  cutToCodePoints,
  sourceFields,
  translationSourceSha256,
} from '../src/index.js';

describe('articleTranslationSource', () => {
  it('trims each field, cuts it to its limit in code points, and makes blank fields absent', () => {
    const source = articleTranslationSource({
      title: '  Titulok  ',
      excerpt: `${'á'.repeat(599)}😀tail`,
      body_lead: '   ',
    });
    expect(source.title).toBe('Titulok');
    expect([...(source.excerpt ?? '')]).toHaveLength(ARTICLE_SOURCE_LIMITS.excerpt);
    expect(source.excerpt?.endsWith('😀')).toBe(true);
    expect(source.body_lead).toBeNull();
    expect(articleTranslationSource({})).toEqual({ title: null, excerpt: null, body_lead: null });
    expect(articleTranslationSource({ body_lead: 'b'.repeat(2000) }).body_lead).toHaveLength(1500);
  });

  it('never splits a surrogate pair when cutting', () => {
    expect(cutToCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(cutToCodePoints('abc', 5)).toBe('abc');
  });
});

describe('source fields keep their explicit mapping', () => {
  it('leaves absent fields out without shifting the others', () => {
    expect(articleSourceFields({ title: 'T', excerpt: null, body_lead: 'B' })).toEqual([
      { field: 'title', text: 'T' },
      { field: 'body_lead', text: 'B' },
    ]);
    expect(articleSourceFields({ title: null, excerpt: 'E', body_lead: ' ' })).toEqual([
      { field: 'excerpt', text: 'E' },
    ]);
  });

  it('follows the given order for any field names', () => {
    expect(sourceFields({ not_for: 'N', interest: 'I' }, ['interest', 'not_for'])).toEqual([
      { field: 'interest', text: 'I' },
      { field: 'not_for', text: 'N' },
    ]);
  });
});

describe('translationSourceSha256', () => {
  const texts = { title: 'T', excerpt: null, body_lead: 'B' };

  it('is a stable hex digest of the language and the exact fields', () => {
    const digest = translationSourceSha256('sk', texts);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(translationSourceSha256('sk', { body_lead: 'B', excerpt: null, title: 'T' })).toBe(
      digest,
    );
    expect(translationSourceSha256('cs', texts)).not.toBe(digest);
    expect(translationSourceSha256('sk', { ...texts, excerpt: '' })).not.toBe(digest);
  });
});
