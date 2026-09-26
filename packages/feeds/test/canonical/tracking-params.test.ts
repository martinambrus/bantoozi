import { describe, expect, it } from 'vitest';

import {
  TRACKING_PARAM_PREFIXES,
  TRACKING_PARAMS,
  canonicalizeUrl,
  isTrackingParam,
} from '../../src/canonical/index.js';

/** The exact names of spec 03 §5 step 4, in spec order. Changing the list must change this pin. */
const SPEC_TRACKING_PARAMS = [
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'igshid',
  'ref_src',
  'ref_url',
  'cmpid',
  's_cid',
  'spm',
  'ncid',
  'sr_share',
  'at_medium',
  'at_campaign',
  'xtor',
  '__twitter_impression',
  '_ga',
  '_gl',
  'oly_enc_id',
  'oly_anon_id',
  'vero_id',
  'wickedid',
];

const UTM_NAMES = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_',
  'UTM_SOURCE',
  'Utm_Medium',
  'uTm_CaMpAiGn',
];

const KEPT_NAMES = [
  'id',
  'page',
  'ref',
  'source',
  'p',
  'oc',
  'amp',
  'FBCLID',
  'Gclid',
  'utm',
  'utmsource',
  'utm-source',
  'xutm_source',
  ' utm_source',
  'ｕｔｍ_source',
  'fbclid_',
  ' fbclid',
  'ref_srcs',
  '',
];

describe('tracking-parameter list (spec 03 §5 step 4)', () => {
  it('pins the exact names of the spec', () => {
    expect(TRACKING_PARAMS).toEqual(SPEC_TRACKING_PARAMS);
    expect(new Set(TRACKING_PARAMS).size).toBe(30);
  });

  it('has only the lower-case utm_ prefix', () => {
    expect(TRACKING_PARAM_PREFIXES).toEqual(['utm_']);
  });

  it('cannot be mutated at run time', () => {
    expect(Object.isFrozen(TRACKING_PARAMS)).toBe(true);
    expect(Object.isFrozen(TRACKING_PARAM_PREFIXES)).toBe(true);
  });
});

describe('isTrackingParam', () => {
  it.each(SPEC_TRACKING_PARAMS)('matches the exact name %s', (name) => {
    expect(isTrackingParam(name)).toBe(true);
  });

  it.each(UTM_NAMES)('matches %s by its case-insensitive utm_ prefix', (name) => {
    expect(isTrackingParam(name)).toBe(true);
  });

  it.each(KEPT_NAMES)('keeps %j', (name) => {
    expect(isTrackingParam(name)).toBe(false);
  });
});

describe('canonicalizeUrl removes every tracking parameter', () => {
  it.each([...SPEC_TRACKING_PARAMS, ...UTM_NAMES])('%s', (name) => {
    const base = 'https://example.com/clanok';
    expect(canonicalizeUrl(`${base}?${name}=v`)).toEqual({ ok: true, url: base });
    expect(canonicalizeUrl(`${base}?${name}=v&id=1`)).toEqual({ ok: true, url: `${base}?id=1` });
    expect(canonicalizeUrl(`${base}?id=1&${name}=v&page=2`)).toEqual({
      ok: true,
      url: `${base}?id=1&page=2`,
    });
    expect(canonicalizeUrl(`${base}?page=2&${name}`)).toEqual({ ok: true, url: `${base}?page=2` });
  });
});
