import { describe, expect, it } from 'vitest';

import { platformFeeds } from '../../src/discover/index.js';

const urls = (input: string): string[] => platformFeeds(input).map((link) => link.url);

describe('platformFeeds', () => {
  const CHANNEL = 'UCabcdefghijklmnopqrstuv';

  it('maps YouTube channel and playlist URLs and ignores handles it cannot resolve offline', () => {
    expect(urls(`https://www.youtube.com/channel/${CHANNEL}`)).toEqual([
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
    ]);
    expect(urls('https://youtube.com/playlist?list=PLabc123def456')).toEqual([
      'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc123def456',
    ]);
    expect(urls('https://www.youtube.com/@someone')).toEqual([]);
    expect(urls('https://www.youtube.com/channel/not-a-channel-id')).toEqual([]);
  });

  it('maps Reddit subreddits and users', () => {
    expect(urls('https://www.reddit.com/r/programming/')).toEqual([
      'https://www.reddit.com/r/programming/.rss',
    ]);
    expect(urls('https://old.reddit.com/user/spez')).toEqual([
      'https://www.reddit.com/user/spez/.rss',
    ]);
    expect(urls('https://www.reddit.com/r/a%2Fb')).toEqual([]);
  });

  it('maps Medium, Substack, Bluesky, GitHub and Mastodon-style profiles', () => {
    expect(urls('https://medium.com/@writer')).toEqual(['https://medium.com/feed/@writer']);
    expect(urls('https://medium.com/feed/@writer')).toEqual([]);
    expect(urls('https://newsletter.substack.com/p/some-post')).toEqual([
      'https://newsletter.substack.com/feed',
    ]);
    expect(urls('https://substack.com/')).toEqual([]);
    expect(urls('https://bsky.app/profile/alice.bsky.social')).toEqual([
      'https://bsky.app/profile/alice.bsky.social/rss',
    ]);
    expect(urls('https://github.com/owner/repo')).toEqual([
      'https://github.com/owner/repo/releases.atom',
      'https://github.com/owner/repo/tags.atom',
    ]);
    expect(urls('https://github.com/owner/repo/issues')).toEqual([]);
    expect(urls('https://mastodon.example/@alice')).toEqual([
      'https://mastodon.example/@alice.rss',
    ]);
    expect(urls('https://mastodon.example/@alice/12345')).toEqual([]);
  });

  it('gives nothing for other hosts and unusable input', () => {
    expect(urls('https://blog.example/post')).toEqual([]);
    expect(urls('not a url')).toEqual([]);
    expect(urls('ftp://github.com/owner/repo')).toEqual([]);
  });
});
