/**
 * Remembered per-reader/feed image policy (spec 02 §3.5, spec 08 §4.2; PLAN §2 decision 12).
 * An explicit feed `allow` overrides a global block and an explicit `block` overrides a global
 * allow; `inherit` (or no row, or no source feed) follows `preferences.loadRemoteImages`.
 */
export const IMAGE_POLICIES = ['inherit', 'allow', 'block'] as const;
export type ImagePolicy = (typeof IMAGE_POLICIES)[number];

export function effectiveImagesAllowed(
  feedPolicy: ImagePolicy | null | undefined,
  loadRemoteImages: boolean,
): boolean {
  if (feedPolicy === 'allow') return true;
  if (feedPolicy === 'block') return false;
  return loadRemoteImages;
}

/**
 * Policy kept when a feed identity merge remaps two preferences of one reader: conflicting explicit
 * settings preserve `block` until the user chooses otherwise; an explicit choice beats `inherit`.
 */
export function mergeImagePolicies(a: ImagePolicy, b: ImagePolicy): ImagePolicy {
  if (a === 'block' || b === 'block') return 'block';
  if (a === 'allow' || b === 'allow') return 'allow';
  return 'inherit';
}

/** Explicit rows keep their feed from the idle-feed purge; `inherit` rows do not (spec 11 §5). */
export function isExplicitImagePolicy(policy: ImagePolicy): boolean {
  return policy !== 'inherit';
}
