import { describe, expect, it } from 'vitest';

import { isVideoMediaObject, mediaSignals, type MediaSignalsInput } from '../../src/media/index.js';

const BASE = 'https://news.example.com/2026/09/26/harbour/';
const ARTICLE = 'https://news.example.com/2026/09/26/harbour/';

function signals(overrides: Partial<MediaSignalsInput> = {}) {
  return mediaSignals({ link: ARTICLE, baseUrl: BASE, ...overrides });
}

describe('spec 03 §6.4 video evidence (mediaSignals)', () => {
  it('is false without any video rule', () => {
    expect(signals()).toEqual({ videoEvidence: false, bodyImageCount: null });
    expect(signals({ link: null, media: [], html: [] })).toEqual({
      videoEvidence: false,
      bodyImageCount: null,
    });
  });

  it('a video enclosure or attachment (type video/*) is video evidence', () => {
    expect(signals({ media: [{ type: 'video/mp4' }] }).videoEvidence).toBe(true);
    expect(signals({ media: [{ type: ' Video/WebM; codecs="vp9" ' }] }).videoEvidence).toBe(true);
    expect(
      signals({ media: [{ type: 'image/jpeg' }, { type: 'video/quicktime' }] }).videoEvidence,
    ).toBe(true);
  });

  it('a media:content with medium="video" (also from a media:group) is video evidence', () => {
    expect(signals({ media: [{ medium: 'video' }] }).videoEvidence).toBe(true);
    expect(signals({ media: [{ type: null, medium: ' VIDEO ' }] }).videoEvidence).toBe(true);
  });

  it('audio (enclosure type or medium) and other media are not video evidence', () => {
    expect(signals({ media: [{ type: 'audio/mpeg' }] }).videoEvidence).toBe(false);
    expect(signals({ media: [{ type: 'audio/mp4', medium: 'audio' }] }).videoEvidence).toBe(false);
    expect(
      signals({
        media: [
          { type: 'image/jpeg', medium: 'image' },
          { type: 'application/x-shockwave-flash' },
          { type: 'application/vnd.apple.mpegurl' },
          { type: 'text/html' },
          { type: 'videogame/x' },
          { medium: 'document' },
          {},
        ],
      }).videoEvidence,
    ).toBe(false);
  });

  it('a link on a video host is video evidence', () => {
    expect(signals({ link: 'https://www.youtube.com/watch?v=tr4mR3st0r3' }).videoEvidence).toBe(
      true,
    );
    expect(signals({ link: 'https://vimeo.com/123456789' }).videoEvidence).toBe(true);
    expect(signals({ link: 'https://notvimeo.com/123456789' }).videoEvidence).toBe(false);
  });

  it('a <video> or a player <iframe> in the examined HTML is video evidence', () => {
    expect(signals({ html: ['<video src="/clip.mp4"></video>'] }).videoEvidence).toBe(true);
    expect(
      signals({ html: ['<iframe src="https://www.youtube.com/embed/tr4mR3st0r3"></iframe>'] })
        .videoEvidence,
    ).toBe(true);
    expect(
      signals({ html: [null, '<p>Text</p>', '<iframe src="//player.vimeo.com/video/1"></iframe>'] })
        .videoEvidence,
    ).toBe(true);
    expect(signals({ html: [null, '', '<p>Text</p>'] }).videoEvidence).toBe(false);
  });

  it('an <embed> or <object> player is video evidence; Facebook only under /plugins/video', () => {
    expect(
      signals({ html: ['<embed src="https://www.youtube-nocookie.com/v/tr4mR3st0r3">'] })
        .videoEvidence,
    ).toBe(true);
    expect(
      signals({ html: ['<object data="https://vimeo.com/moogaloop.swf"></object>'] }).videoEvidence,
    ).toBe(true);
    expect(
      signals({
        html: ['<iframe src="https://www.facebook.com/plugins/video.php?href=x"></iframe>'],
      }).videoEvidence,
    ).toBe(true);
    expect(
      signals({
        html: ['<iframe src="https://www.facebook.com/plugins/post.php?href=x"></iframe>'],
      }).videoEvidence,
    ).toBe(false);
  });

  it('examines the body fragment for video too', () => {
    expect(signals({ bodyHtml: '<p>Intro</p><video controls></video>' })).toEqual({
      videoEvidence: true,
      bodyImageCount: 0,
    });
  });
});

describe('spec 03 §6.4 in-body image count (mediaSignals)', () => {
  it('is null without a body fragment, even when other HTML has images', () => {
    expect(signals({ html: ['<p><img src="/excerpt.jpg"></p>'] }).bodyImageCount).toBeNull();
    expect(signals({ bodyHtml: null }).bodyImageCount).toBeNull();
    expect(signals({ bodyHtml: '' }).bodyImageCount).toBe(0);
  });

  it('counts the body only: the excerpt HTML and other examined HTML are never counted', () => {
    expect(
      signals({
        html: ['<p><img src="/teaser.jpg"><img src="/teaser-2.jpg"></p>'],
        bodyHtml: '<p><img src="/body.jpg"></p>',
      }).bodyImageCount,
    ).toBe(1);
  });

  it('applies every exclusion: pixel, <noscript> repeat, <picture>, data: placeholder, srcset', () => {
    const body = [
      '<p>Intro.</p>',
      '<figure><img src="/hero.jpg" width="1200" height="800"></figure>',
      '<img src="https://stats.example.net/pixel.gif?id=1" width="1" height="1" alt="">',
      '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="/lazy.jpg" class="lazyload">',
      '<noscript><img src="https://news.example.com/lazy.jpg"></noscript>',
      '<picture><source srcset="/chart.avif" type="image/avif"><img src="/chart.png"></picture>',
      '<img srcset="/gallery-1-400.jpg 400w, /gallery-1-800.jpg 800w">',
      '<img src="/hero.jpg" alt="The hero image again">',
    ].join('');
    expect(signals({ bodyHtml: body })).toEqual({ videoEvidence: false, bodyImageCount: 4 });
  });

  it('resolves relative image URLs against the base URL', () => {
    const body =
      '<img src="photo.jpg"><img src="https://news.example.com/2026/09/26/harbour/photo.jpg">';
    expect(signals({ bodyHtml: body }).bodyImageCount).toBe(1);
    expect(signals({ bodyHtml: body, baseUrl: 'https://cdn.example.net/' }).bodyImageCount).toBe(2);
  });

  it('computes both signals from one body fragment', () => {
    const fragment =
      '<p>Text</p><iframe src="https://www.youtube.com/embed/x"></iframe><img src="/a.jpg">';
    expect(signals({ link: null, html: [fragment], bodyHtml: fragment })).toEqual({
      videoEvidence: true,
      bodyImageCount: 1,
    });
    expect(
      signals({ media: [{ type: 'video/mp4' }], html: [fragment], bodyHtml: '<img src="/a.jpg">' }),
    ).toEqual({ videoEvidence: true, bodyImageCount: 1 });
  });
});

describe('isVideoMediaObject', () => {
  it.each([
    [{ type: 'video/mp4' }, true],
    [{ type: 'VIDEO/MP4' }, true],
    [{ type: 'video/mp4; codecs="avc1.42E01E"' }, true],
    [{ medium: 'video' }, true],
    [{ type: 'image/png', medium: 'video' }, true],
    [{ type: 'audio/mpeg' }, false],
    [{ type: 'audio/x-m4a', medium: 'audio' }, false],
    [{ medium: 'image' }, false],
    [{ type: '' }, false],
    [{ type: null, medium: null }, false],
    [{}, false],
  ])('%j → %s', (media, expected) => {
    expect(isVideoMediaObject(media)).toBe(expected);
  });
});
