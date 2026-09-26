import { describe, expect, it } from 'vitest';

import { extractionSkipReason } from '../../src/extract/index.js';

describe('spec 03 §8.1 step 1 extractionSkipReason', () => {
  it.each([
    'https://youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc',
    'https://m.youtube.com/watch?v=abc',
    'https://WWW.YOUTUBE.COM./watch?v=abc',
    'https://youtu.be/abc',
    'https://vimeo.com/123456',
    'https://player.vimeo.com/video/123456',
    'https://x.com/someone/status/1',
    'https://mobile.twitter.com/someone/status/1',
    'https://www.instagram.com/p/abc/',
    'https://www.facebook.com/story.php?story_fbid=1',
    'https://www.tiktok.com/@someone/video/1',
    'https://open.spotify.com/episode/abc',
    'https://podcasts.apple.com/sk/podcast/abc/id1',
    'https://soundcloud.com/artist/track',
    'https://on.soundcloud.com/abc',
  ])('skips the video/social/audio host of %s', (url) => {
    expect(extractionSkipReason(url)).toBe('skip_host');
  });

  it.each([
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.example.net/watch',
    'https://xbox.com/games',
    'https://fox.com/news/story',
    'https://spotify.com/about',
    'https://www.apple.com/podcasts/',
    'https://news.example.com/2026/09/youtube.com-outage',
    'https://news.example.com/redirect?to=https://youtube.com/watch',
  ])('matches hosts on label boundaries only: %s is extractable', (url) => {
    expect(extractionSkipReason(url)).toBeNull();
  });

  it.each([
    'https://example.com/report.pdf',
    'https://example.com/REPORT.PDF',
    'https://example.com/files/episode.mp3',
    'https://example.com/files/episode.M4A',
    'https://example.com/video/clip.mp4',
    'https://example.com/video/clip.MoV',
    'https://example.com/archive.zip',
    'https://example.com/photo.jpg',
    'https://example.com/photo.PNG',
    'https://example.com/anim.gif',
    'https://example.com/image.webp',
    'https://example.com/report.pdf?download=1',
    'https://example.com/report.pdf#page=2',
    'https://example.com/report%2Epdf',
    'https://example.com/malformed%E0%A4%A.pdf',
  ])('skips the media/document pathname %s', (url) => {
    expect(extractionSkipReason(url)).toBe('skip_extension');
  });

  it.each([
    'https://example.com/article?file=report.pdf',
    'https://example.com/article?img=photo.JPG&x=1',
    'https://example.com/article#figure.png',
    'https://example.com/report.pdf/',
    'https://example.com/pdf',
    'https://example.com/report.pdfx',
    'https://example.com/2026/09/zip-code-reform',
  ])('never matches extensions outside the pathname end: %s', (url) => {
    expect(extractionSkipReason(url)).toBeNull();
  });

  it('skips a chosen URL that is itself an audio/video enclosure', () => {
    const url = 'https://cdn.example.com/episodes/12';
    expect(extractionSkipReason(url, { enclosureType: 'audio/mpeg' })).toBe('skip_media');
    expect(extractionSkipReason(url, { enclosureType: 'Video/MP4' })).toBe('skip_media');
    expect(extractionSkipReason(url, { enclosureType: 'text/html' })).toBeNull();
    expect(extractionSkipReason(url, { enclosureType: null })).toBeNull();
    expect(extractionSkipReason(url)).toBeNull();
  });

  it('prefers the host and extension reasons and leaves unparsable URLs to the fetch', () => {
    expect(extractionSkipReason('https://youtube.com/a.mp4', { enclosureType: 'video/mp4' })).toBe(
      'skip_host',
    );
    expect(extractionSkipReason('https://example.com/a.mp3', { enclosureType: 'audio/mpeg' })).toBe(
      'skip_extension',
    );
    expect(extractionSkipReason('not a url')).toBeNull();
  });
});
