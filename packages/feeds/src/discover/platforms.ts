import { cleanLabel } from './text.js';

/** A feed address derived from a well-known platform URL. Not proof: it is fetched and parsed. */
export interface PlatformFeedLink {
  url: string;
  title: string | null;
}

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);
const REDDIT_HOSTS: ReadonlySet<string> = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
]);
/** `UC` + 22 URL-safe base64 characters. */
const YOUTUBE_CHANNEL_ID = /^UC[\w-]{22}$/;
const YOUTUBE_PLAYLIST_ID = /^[\w-]{10,64}$/;
/** A path segment safe to copy into another path: no separators, dots-only or encodings. */
const SEGMENT = /^[\w.-]{1,100}$/;
/** A Bluesky actor in a profile URL: a handle, or a `did:plc:` / `did:web:` identifier. */
const BLUESKY_ACTOR = /^(?:[\w.-]{1,253}|did:(?:plc|web):[\w.:-]{1,200})$/;

function link(url: string, title: string | null = null): PlatformFeedLink {
  return { url, title: cleanLabel(title) };
}

/**
 * Feed addresses that well-known platforms serve for a page URL, for pages that do not declare
 * them (or cannot be fetched by a bot): YouTube channels and playlists, Reddit subreddits and
 * users, Medium profiles and publications, Substack publications, Mastodon-style `/@user`
 * profiles, Bluesky profiles and GitHub repositories (D-231). Pure, no network. Anything that does
 * not match gives `[]`; the caller still fetches and parses every address.
 */
export function platformFeeds(input: string): PlatformFeedLink[] {
  const url = URL.parse(input);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return [];
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter((part) => part !== '');
  const [first, second, third] = parts;

  if (YOUTUBE_HOSTS.has(host)) {
    if (first === 'channel' && second !== undefined && YOUTUBE_CHANNEL_ID.test(second)) {
      return [link(`https://www.youtube.com/feeds/videos.xml?channel_id=${second}`)];
    }
    const list = url.searchParams.get('list');
    if (list !== null && YOUTUBE_PLAYLIST_ID.test(list)) {
      return [link(`https://www.youtube.com/feeds/videos.xml?playlist_id=${list}`)];
    }
    return [];
  }

  if (REDDIT_HOSTS.has(host)) {
    if ((first === 'r' || first === 'user' || first === 'u') && second !== undefined) {
      if (!SEGMENT.test(second)) return [];
      const kind = first === 'r' ? 'r' : 'user';
      return [link(`https://www.reddit.com/${kind}/${second}/.rss`)];
    }
    return [];
  }

  if (host === 'medium.com' || host === 'www.medium.com') {
    if (
      first !== undefined &&
      SEGMENT.test(first.startsWith('@') ? first.slice(1) : first) &&
      first !== 'feed'
    ) {
      return [link(`https://medium.com/feed/${first}`)];
    }
    return [];
  }

  if (host.endsWith('.substack.com') && host !== 'www.substack.com' && host !== 'substack.com') {
    return [link(`https://${host}/feed`)];
  }

  if (
    host === 'bsky.app' &&
    first === 'profile' &&
    second !== undefined &&
    BLUESKY_ACTOR.test(second)
  ) {
    return [link(`https://bsky.app/profile/${second}/rss`)];
  }

  if (host === 'github.com' || host === 'www.github.com') {
    if (
      first !== undefined &&
      second !== undefined &&
      SEGMENT.test(first) &&
      SEGMENT.test(second)
    ) {
      const repo = `https://github.com/${first}/${second.replace(/\.git$/, '')}`;
      if (third === undefined || third === 'releases' || third === 'tags') {
        return [link(`${repo}/releases.atom`), link(`${repo}/tags.atom`)];
      }
    }
    return [];
  }

  // Mastodon, Pleroma, GoToSocial and others serve `/@user.rss` for any `/@user` profile.
  if (first !== undefined && first.startsWith('@') && parts.length === 1) {
    const user = first.slice(1);
    if (SEGMENT.test(user) && !user.endsWith('.rss')) {
      return [link(`${url.origin}/${first}.rss`)];
    }
  }
  return [];
}
