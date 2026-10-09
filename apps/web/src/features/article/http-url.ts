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
