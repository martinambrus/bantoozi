/** A feed-provided icon, or the website's conventional favicon when no icon was advertised. */
export function feedIconUrl(iconUrl: string | null, siteUrl: string | null): string | null {
  if (iconUrl !== null) return iconUrl;
  if (siteUrl === null) return null;
  try {
    const site = new URL(siteUrl);
    if (site.protocol !== 'https:' && site.protocol !== 'http:') return null;
    return new URL('/favicon.ico', site.origin).href;
  } catch {
    return null;
  }
}
