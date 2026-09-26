import { Readability } from '@mozilla/readability';
import { describe, expect, it } from 'vitest';

import { parseDocument } from '../../src/extract/dom.js';
import {
  isVideoEmbedUrl,
  isVideoHostUrl,
  VIDEO_EMBED_HOSTS,
  VIDEO_HOSTS,
  videoEmbedRegex,
} from '../../src/media/index.js';

describe('spec 03 §6.4 video host lists', () => {
  it('are the spec lists; embeds add youtube-nocookie, player.vimeo and facebook', () => {
    expect(VIDEO_HOSTS).toEqual([
      'youtube.com',
      'youtu.be',
      'vimeo.com',
      'dailymotion.com',
      'dai.ly',
      'twitch.tv',
      'tiktok.com',
      'rumble.com',
    ]);
    expect(VIDEO_EMBED_HOSTS).toEqual([
      ...VIDEO_HOSTS,
      'youtube-nocookie.com',
      'player.vimeo.com',
      'facebook.com',
    ]);
    expect(Object.isFrozen(VIDEO_HOSTS)).toBe(true);
    expect(Object.isFrozen(VIDEO_EMBED_HOSTS)).toBe(true);
  });
});

describe('isVideoHostUrl (label-boundary suffix match)', () => {
  it.each([
    'https://www.youtube.com/watch?v=tr4mR3st0r3',
    'https://m.youtube.com/watch?v=tr4mR3st0r3',
    'https://youtube.com/shorts/tr4mR3st0r3',
    'http://youtu.be/tr4mR3st0r3',
    'https://vimeo.com/123456789',
    'https://player.vimeo.com/video/123456789',
    'https://www.dailymotion.com/video/x8abcd',
    'https://dai.ly/x8abcd',
    'https://www.twitch.tv/videos/2233',
    'https://www.tiktok.com/@workshop/video/7412',
    'https://rumble.com/v5abc-restoring-a-tram.html',
    'HTTPS://WWW.YOUTUBE.COM/watch?v=x',
    'https://www.youtube.com./watch?v=x',
    'https://www.youtube.com:443/watch?v=x',
    '  https://youtu.be/x  ',
  ])('%s is on a video host', (url) => {
    expect(isVideoHostUrl(url)).toBe(true);
  });

  it.each([
    'https://notyoutube.com/watch?v=x',
    'https://youtube.com.evil.example/watch?v=x',
    'https://www.youtube-nocookie.com/embed/x',
    'https://www.facebook.com/watch/?v=1',
    'https://example.com/?next=https://www.youtube.com/watch?v=x',
    'https://example.com/youtube.com',
    'ftp://youtube.com/video',
    'youtube.com/watch?v=x',
    '/watch?v=x',
    '',
  ])('%s is not on a video host', (url) => {
    expect(isVideoHostUrl(url)).toBe(false);
  });
});

describe('isVideoEmbedUrl', () => {
  it.each([
    'https://www.youtube.com/embed/tr4mR3st0r3',
    'https://www.youtube-nocookie.com/embed/tr4mR3st0r3',
    'https://player.vimeo.com/video/123456789?h=abc',
    'https://www.dailymotion.com/embed/video/x8abcd',
    'https://geo.dailymotion.com/player.html?video=x8abcd',
    'https://player.twitch.tv/?video=2233&parent=example.com',
    'https://www.tiktok.com/embed/v2/7412',
    'https://rumble.com/embed/v5abc/',
    'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fx%2Fvideos%2F1',
    'https://web.facebook.com/plugins/video.php?href=x',
    'https://facebook.com/Plugins/Video.php?href=x',
  ])('%s is a player embed', (url) => {
    expect(isVideoEmbedUrl(url)).toBe(true);
  });

  it.each([
    'https://www.facebook.com/plugins/post.php?href=x',
    'https://www.facebook.com/plugins/page.php?href=x',
    'https://www.facebook.com/watch/?v=1',
    'https://www.facebook.com/',
    'https://video.example/embed/123',
    'https://maps.example.com/embed?youtube.com',
    'https://nocookie-youtube.com/embed/x',
    'about:blank',
    'javascript:alert(1)',
  ])('%s is not a player embed', (url) => {
    expect(isVideoEmbedUrl(url)).toBe(false);
  });
});

describe('videoEmbedRegex (Readability allowedVideoRegex, spec 03 §8.1 step 5)', () => {
  const regex = videoEmbedRegex();

  it('returns a fresh case-insensitive, non-global RegExp', () => {
    expect(regex.flags).toBe('i');
    expect(videoEmbedRegex()).not.toBe(regex);
  });

  it.each([
    'https://www.youtube.com/embed/tr4mR3st0r3?feature=oembed',
    '//www.youtube-nocookie.com/embed/tr4mR3st0r3',
    ' https://player.vimeo.com/video/123456789 ',
    'https://vimeo.com/123456789',
    'https://www.dailymotion.com/embed/video/x8abcd',
    'https://player.twitch.tv/?video=2233&parent=example.com',
    'https://www.tiktok.com/embed/v2/7412',
    'https://rumble.com/embed/v5abc/',
    'https://youtu.be/x',
    'https://dai.ly/x8abcd',
    'HTTP://WWW.YOUTUBE.COM/EMBED/X',
    'https://www.youtube.com./embed/x',
    'https://www.youtube.com:443/embed/x',
    'https://www.youtube.com',
    'https://www.youtube.com?x=1',
    'https://www.youtube.com#t=1',
    'https://www.facebook.com/plugins/video.php?href=x',
  ])('matches %s', (value) => {
    expect(regex.test(value)).toBe(true);
    expect(isVideoEmbedUrl(new URL(value.trim(), 'https://page.example/').href)).toBe(true);
  });

  it.each([
    'https://www.facebook.com/plugins/post.php?href=x',
    'https://notyoutube.com/embed/x',
    'https://youtube.com.evil.example/embed/x',
    'https://www.youtube.community/embed/x',
    'https://video.example/embed/123',
    'https://example.com/frame?u=https://www.youtube.com/embed/x',
    '/embed/tr4mR3st0r3',
    'youtube.com/embed/x',
    'A YouTube video: https://www.youtube.com/embed/x',
    'video-embed',
  ])('does not match %s', (value) => {
    expect(regex.test(value)).toBe(false);
  });

  it('keeps embeds that Readability’s default list would remove', () => {
    const paragraphs = Array.from(
      { length: 4 },
      (_, i) =>
        `<p>Paragraph ${i} of a short report about the new tram line, its stops, the timetable and the works that are still to come in the old town this autumn.</p>`,
    ).join('');
    const html = `<html><body><article>${paragraphs}<div><iframe src="https://rumble.com/embed/v5abc/" width="640" height="360"></iframe></div>${paragraphs}</article></body></html>`;
    const withDefault = new Readability(parseDocument(html)).parse();
    expect(withDefault?.content).not.toContain('<iframe');
    const withList = new Readability(parseDocument(html), {
      allowedVideoRegex: videoEmbedRegex(),
    }).parse();
    expect(withList?.content).toContain('<iframe src="https://rumble.com/embed/v5abc/"');
  });
});
