import type { ReprocessArticle } from '@bantoozi/db';
import { describe, expect, it } from 'vitest';

import type { ClassificationConfig } from '../src/classify/config.js';
import { decideReenrich } from '../src/handlers/house-reenrich.js';

const PRIMARY = 'jev-1';

const config = (sk: 'native' | 'translate'): ClassificationConfig =>
  ({ languageModes: { en: 'native', sk, cs: 'native' } }) as unknown as ClassificationConfig;

function article(
  over: Partial<ReprocessArticle> & { variant?: 'native' | 'translated'; model?: string } = {},
): ReprocessArticle {
  const { variant, model, ...rest } = over;
  return {
    articleId: '1',
    revision: '1',
    pipelineState: 'enriched',
    lang: 'sk',
    key: '2026-10-01T00:00:00.000000Z',
    facets: {
      revision: '1',
      engine: 'typesafe',
      model: model ?? PRIMARY,
      stateVariant: variant ?? 'native',
    },
    ...rest,
  };
}

describe('decideReenrich (spec 05 §2, spec 11 §6)', () => {
  it('skips an article already current under the primary model and the variant its mode needs', () => {
    expect(decideReenrich(article(), config('native'), PRIMARY)).toBe('none');
    expect(decideReenrich(article({ variant: 'translated' }), config('translate'), PRIMARY)).toBe(
      'none',
    );
  });

  it('re-enriches in place when the model or the revision of the facets is not current', () => {
    expect(decideReenrich(article({ model: 'old' }), config('native'), PRIMARY)).toBe('enrich');
    expect(decideReenrich(article({ facets: null }), config('native'), PRIMARY)).toBe('enrich');
  });

  it('sends a native article of a translate language through the mode-change translation', () => {
    expect(decideReenrich(article(), config('translate'), PRIMARY)).toBe('translate');
    expect(
      decideReenrich(
        article({ pipelineState: 'extracted', facets: null }),
        config('translate'),
        PRIMARY,
      ),
    ).toBe('translate');
    expect(
      decideReenrich(
        article({ variant: 'translated', model: 'old' }),
        config('translate'),
        PRIMARY,
      ),
    ).toBe('enrich');
  });

  it('resets a translated article of a native language, and never translates English', () => {
    expect(decideReenrich(article({ variant: 'translated' }), config('native'), PRIMARY)).toBe(
      'reset-native',
    );
    expect(decideReenrich(article({ lang: 'en' }), config('translate'), PRIMARY)).toBe('none');
  });
});
