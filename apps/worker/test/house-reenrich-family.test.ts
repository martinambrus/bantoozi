import type { ReprocessArticle } from '@bantoozi/db';
import { describe, expect, it } from 'vitest';

import type { ClassificationConfig } from '../src/classify/config.js';
import { decideReenrich } from '../src/handlers/house-reenrich.js';

const config = { languageModes: { en: 'native', sk: 'native' } } as unknown as ClassificationConfig;

const article = (model: string): ReprocessArticle => ({
  articleId: '1',
  revision: '1',
  pipelineState: 'enriched',
  lang: 'sk',
  key: '2026-10-01T00:00:00.000000Z',
  facets: { revision: '1', engine: 'typesafe', model, stateVariant: 'native' },
});

describe('decideReenrich across releases of one Jev major', () => {
  it('still enriches facets written by another release', () => {
    expect(decideReenrich(article('jev-1.13.0'), config, 'jev-1.14.0')).toBe('enrich');
  });

  it('skips facets of the pinned release', () => {
    expect(decideReenrich(article('jev-1.14.0'), config, 'jev-1.14.0')).toBe('none');
  });
});
