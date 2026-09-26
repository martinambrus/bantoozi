/**
 * Video host lists and host matching for the media signals (spec 03 §6.4). Both lists are code, not
 * configuration: adding a host is a code change with a fixture.
 */

/** Article link hosts that are video evidence (label-boundary suffix match, spec 03 §6.4). */
export const VIDEO_HOSTS: readonly string[] = Object.freeze([
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'twitch.tv',
  'tiktok.com',
  'rumble.com',
]);

/**
 * Player embed hosts (`<iframe>`, `<embed>`, `<object>` src/data): `VIDEO_HOSTS` plus
 * `youtube-nocookie.com`, `player.vimeo.com` and `facebook.com` with the path prefix
 * `/plugins/video` only (spec 03 §6.4).
 */
export const VIDEO_EMBED_HOSTS: readonly string[] = Object.freeze([
  ...VIDEO_HOSTS,
  'youtube-nocookie.com',
  'player.vimeo.com',
  'facebook.com',
]);

/**
 * Entries of {@link VIDEO_EMBED_HOSTS} that are player embeds only under a path prefix (compared
 * case-insensitively with the start of the URL path): Facebook's video plugin, not its other
 * plugins or pages.
 */
export const VIDEO_EMBED_PATH_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  'facebook.com': '/plugins/video',
});

/**
 * The lower-case host (without a trailing dot) and the path of an absolute http(s) URL, or `null`
 * for other schemes and unparsable values.
 */
function httpHost(url: string): { host: string; pathname: string } | null {
  const parsed = URL.parse(url.trim());
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  return { host: parsed.hostname.toLowerCase().replace(/\.$/, ''), pathname: parsed.pathname };
}

/** Whether `host` is `entry` or one of its subdomains, compared on DNS label boundaries. */
function onHost(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/**
 * Whether the absolute http(s) `url`'s host is on {@link VIDEO_HOSTS}: the host itself or a
 * subdomain on a label boundary (`m.youtube.com` matches, `notyoutube.com` does not), compared
 * case-insensitively, with a trailing dot tolerated. Other schemes and unparsable URLs are `false`.
 */
export function isVideoHostUrl(url: string): boolean {
  const parsed = httpHost(url);
  return parsed !== null && VIDEO_HOSTS.some((entry) => onHost(parsed.host, entry));
}

/**
 * Whether the absolute http(s) `url` is a known player embed (spec 03 §6.4): its host is on
 * {@link VIDEO_EMBED_HOSTS} by the same label-boundary rule as {@link isVideoHostUrl}, and for
 * `facebook.com` its path starts with `/plugins/video`.
 */
export function isVideoEmbedUrl(url: string): boolean {
  const parsed = httpHost(url);
  if (parsed === null) return false;
  const pathname = parsed.pathname.toLowerCase();
  return VIDEO_EMBED_HOSTS.some((entry) => {
    if (!onHost(parsed.host, entry)) return false;
    const prefix = VIDEO_EMBED_PATH_PREFIXES[entry];
    return prefix === undefined || pathname.startsWith(prefix);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scheme (optional: protocol-relative URLs), userinfo and the subdomain labels of a URL value. */
const URL_START = String.raw`^\s*(?:https?:)?\/\/(?:[^\s/?#@\\]*@)?(?:[^\s./?#@:\\]+\.)*`;
/** An optional trailing dot and port after the host. */
const HOST_END = String.raw`\.?(?::\d*)?`;

/**
 * Readability's `allowedVideoRegex` (spec 03 §8.1 step 5), built from {@link VIDEO_EMBED_HOSTS}:
 * Readability tests it against every attribute value of an `<iframe>`, `<embed>` or `<object>` and
 * keeps the element when one matches, so these embeds survive into the result fragment. It matches
 * an http(s) or protocol-relative URL (surrounding whitespace allowed) whose host is on the list on
 * a label boundary, with `/plugins/video` required after `facebook.com`, case-insensitively, like
 * {@link isVideoEmbedUrl}. A new, stateless (non-global) RegExp on each call.
 */
export function videoEmbedRegex(): RegExp {
  const anyPath = VIDEO_EMBED_HOSTS.filter((host) => VIDEO_EMBED_PATH_PREFIXES[host] === undefined);
  const alternatives = [
    `(?:${anyPath.map(escapeRegExp).join('|')})${HOST_END}(?=[\\s/?#\\\\]|$)`,
    ...Object.entries(VIDEO_EMBED_PATH_PREFIXES).map(
      ([host, prefix]) => `${escapeRegExp(host)}${HOST_END}${escapeRegExp(prefix)}`,
    ),
  ];
  return new RegExp(`${URL_START}(?:${alternatives.join('|')})`, 'i');
}
