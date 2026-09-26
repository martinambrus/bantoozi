import * as shared from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import * as ranker from '../src/index.js';

describe('@bantoozi/ranker public entry', () => {
  it('names the package', () => {
    expect(ranker.PACKAGE_NAME).toBe('@bantoozi/ranker');
  });

  it('re-exports the shared RankerConfig schema, defaults and window without copies', () => {
    expect(ranker.DEFAULT_RANKER_CONFIG).toBe(shared.DEFAULT_RANKER_CONFIG);
    expect(ranker.RankerConfigSchema).toBe(shared.RankerConfigSchema);
    expect(ranker.RankerThresholdsSchema).toBe(shared.RankerThresholdsSchema);
    expect(ranker.mergeRankerConfig).toBe(shared.mergeRankerConfig);
    expect(ranker.RANK_WINDOW_DAYS).toBe(14);
    expect(ranker.RankerConfigSchema.parse(ranker.DEFAULT_RANKER_CONFIG)).toEqual(
      ranker.DEFAULT_RANKER_CONFIG,
    );
  });

  it('accepts a merged override config wherever it accepts the defaults', () => {
    const config: ranker.RankerConfig = ranker.mergeRankerConfig({ lanes: { forYou: 0.7 } });
    expect(ranker.laneFromP(0.68, config)).toBe('maybe');
    expect(ranker.laneFromP(0.68, ranker.DEFAULT_RANKER_CONFIG)).toBe('for_you');
  });

  it('exposes the stable rule codes of spec 06 §3.2', () => {
    const codes = [
      ...Object.values(ranker.RULE_CODES),
      ranker.muteKeywordCode('crypto'),
      ranker.neverCode('4'),
      ranker.neverSoftCode('4'),
      ranker.mustCode('5'),
    ];
    expect(new Set(codes)).toEqual(
      new Set([
        'mute_keyword:crypto',
        'mute_story',
        'block_feed',
        'block_domain',
        'block_author',
        'boost_feed',
        'boost_domain',
        'never:4',
        'never_soft:4',
        'must:5',
        'demote:clickbait',
        'demote:promotional',
        'demote:shallow',
        'demote:stale',
        'degraded',
        'llm_answer',
        'seen_story',
        'pending_cards',
        'inference_not_requested',
      ]),
    );
  });
});
