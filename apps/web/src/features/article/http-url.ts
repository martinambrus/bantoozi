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

/** The address as a URL when it is an absolute https address; the only form an image may load from. */
export function httpsUrl(value: string | null | undefined): URL | null {
  const url = httpUrl(value);
  return url !== null && url.protocol === 'https:' ? url : null;
}
