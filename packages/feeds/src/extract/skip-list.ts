/**
 * The extraction skip list (spec 03 §8.1 step 1): URLs whose page is not a readable HTML article are
 * never fetched and end with status `skipped`.
 */

/** Why an article URL is not extracted. */
export type ExtractionSkipReason = 'skip_host' | 'skip_extension' | 'skip_media';

/** Video, social and audio platforms; a host matches itself and its subdomains (label boundaries). */
export const EXTRACTION_SKIP_HOSTS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'open.spotify.com',
  'podcasts.apple.com',
  'soundcloud.com',
];

/** Media and document file extensions, matched case-insensitively at the end of the pathname. */
export const EXTRACTION_SKIP_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.mp3',
  '.m4a',
  '.mp4',
  '.mov',
  '.zip',
  '.jpg',
  '.png',
  '.gif',
  '.webp',
];

const MEDIA_ENCLOSURE_TYPE = /^\s*(?:audio|video)\//i;

/**
 * Returns why `url` is on the skip list, or `null` when it may be fetched (spec 03 §8.1 step 1):
 * - `skip_host`: the host is one of {@link EXTRACTION_SKIP_HOSTS} or a subdomain of one, compared on
 *   DNS label boundaries (`m.youtube.com` is skipped, `notyoutube.com` is not);
 * - `skip_extension`: the pathname (never the query string or fragment) ends in one of
 *   {@link EXTRACTION_SKIP_EXTENSIONS}, case-insensitively, also when percent-encoded;
 * - `skip_media`: the chosen article URL is itself an audio/video enclosure, i.e. the caller passes
 *   the enclosure's MIME type. A podcast entry whose link is a normal HTML page stays extractable.
 *
 * An unparsable URL returns `null`: it is not on the list, and the fetch reports it as invalid.
 */
export function extractionSkipReason(
  url: string,
  options: { enclosureType?: string | null } = {},
): ExtractionSkipReason | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (EXTRACTION_SKIP_HOSTS.some((skipped) => host === skipped || host.endsWith(`.${skipped}`))) {
    return 'skip_host';
  }

  const pathname = decodePathname(parsed.pathname).toLowerCase();
  if (EXTRACTION_SKIP_EXTENSIONS.some((extension) => pathname.endsWith(extension))) {
    return 'skip_extension';
  }

  const enclosureType = options.enclosureType;
  if (enclosureType !== undefined && enclosureType !== null) {
    if (MEDIA_ENCLOSURE_TYPE.test(enclosureType)) return 'skip_media';
  }
  return null;
}

/** Percent-decodes a pathname for suffix matching; a malformed escape keeps the raw pathname. */
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
