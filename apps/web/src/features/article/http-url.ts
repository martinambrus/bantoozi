/** The address as a URL when it is an absolute http(s) address; no other link is followed. */
export function httpUrl(value: string | null | undefined): URL | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * The address as a URL when an image may load from it: https, or http only for a loopback host while the page
 * itself runs on a loopback origin (the E2E fixture server). Production pages are never loopback, so they stay
 * https only (spec 11 §7).
 */
export function httpsUrl(value: string | null | undefined): URL | null {
  const url = httpUrl(value);
  if (url === null) return null;
  if (url.protocol === 'https:') return url;
  const page = typeof window === 'undefined' ? '' : window.location.hostname;
  return isLoopbackHost(url.hostname) && isLoopbackHost(page) ? url : null;
}
