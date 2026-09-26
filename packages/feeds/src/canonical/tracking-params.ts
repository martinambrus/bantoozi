/**
 * Query-parameter name prefixes that mark tracking parameters (spec 03 §5 step 4), stored in
 * lower case and matched case-insensitively: `utm_source`, `UTM_Medium`, …
 */
export const TRACKING_PARAM_PREFIXES: readonly string[] = Object.freeze(['utm_']);

/**
 * Exact tracking-parameter names (spec 03 §5 step 4), matched case-sensitively. Anything not listed
 * here or in {@link TRACKING_PARAM_PREFIXES} is kept, including `id`, `page`, `ref` and `source`
 * (spec 03 §5 step 7).
 */
export const TRACKING_PARAMS: readonly string[] = Object.freeze([
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
]);

const EXACT_TRACKING_PARAMS: ReadonlySet<string> = new Set(TRACKING_PARAMS);

/**
 * Whether a query parameter is a tracking parameter (spec 03 §5 step 4). `name` is the
 * percent-decoded name (the part before the first `=` of a query pair): an exact entry of
 * {@link TRACKING_PARAMS}, or a name starting with a {@link TRACKING_PARAM_PREFIXES} entry in any
 * case.
 */
export function isTrackingParam(name: string): boolean {
  if (EXACT_TRACKING_PARAMS.has(name)) return true;
  const lower = name.toLowerCase();
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
