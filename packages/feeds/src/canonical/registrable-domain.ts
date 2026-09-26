import { getDomain } from 'tldts';

/**
 * The registrable domain of a URL (`feed.site` of the model state, spec 05 §3.1), computed by
 * `tldts` with the private suffix list, as for canonical links (spec 03 §8.1): `news.example.co.uk`
 * → `example.co.uk`, `someone.github.io` → `someone.github.io`. Null for a missing or unparsable
 * URL, an IP address or a bare public suffix.
 */
export function registrableDomain(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return getDomain(hostname, { allowPrivateDomains: true }) ?? null;
}
