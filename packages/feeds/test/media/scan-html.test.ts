import { describe, expect, it } from 'vitest';

import { imageUrlOf, scanHtml } from '../../src/media/scan-html.js';
import { srcsetUrls } from '../../src/media/srcset.js';

const BASE = 'https://blog.example.com/2026/09/seed-library/';
const PLACEHOLDER =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20800%20533'%3E%3C/svg%3E";
const GIF_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const images = (html: string): string[] => [...scanHtml(html, BASE).imageUrls];
const count = (html: string): number => scanHtml(html, BASE).imageUrls.size;
const hasVideo = (html: string): boolean => scanHtml(html, BASE).video;

describe('spec 03 §6.4 in-body image count (scanHtml)', () => {
  it('counts distinct <img> elements with resolved http(s) URLs', () => {
    expect(
      images(
        '<p><img src="/a.jpg"> <img src="b.jpg" alt="B"></p><figure><img src="https://cdn.example.net/c.png"></figure>',
      ),
    ).toEqual([
      'https://blog.example.com/a.jpg',
      'https://blog.example.com/2026/09/seed-library/b.jpg',
      'https://cdn.example.net/c.png',
    ]);
    expect(count('<p>No images at all.</p>')).toBe(0);
    expect(count('')).toBe(0);
  });

  it('excludes tracking pixels by the sanitizer rule (either known dimension ≤ 2)', () => {
    expect(
      images(
        [
          '<img src="https://stats.example.net/p.gif" width="1" height="1">',
          '<img src="/w.gif" width="2">',
          '<img src="/h.gif" height="1px">',
          '<img src="/s.gif" style="width: 1px; height: 1px">',
          '<img src="/hidden.gif" style="display:none">',
          '<img src="/real.jpg" width="3" height="3">',
          '<img src="/sized.jpg" width="100%">',
        ].join(''),
      ),
    ).toEqual(['https://blog.example.com/real.jpg', 'https://blog.example.com/sized.jpg']);
  });

  it('counts a lazy image once with its <noscript> fallback (relative and absolute URLs)', () => {
    const lazy = `<figure><img src="${PLACEHOLDER}" data-src="/uploads/volunteers.jpg" class="lazyload" width="800" height="533"><noscript><img src="https://blog.example.com/uploads/volunteers.jpg" width="800" height="533"></noscript></figure>`;
    expect(images(lazy)).toEqual(['https://blog.example.com/uploads/volunteers.jpg']);
    // Twice the same lazy image with its fallback is still one image.
    expect(count(lazy + lazy)).toBe(1);
  });

  it('parses <noscript> content as markup, so a fallback-only image counts', () => {
    expect(images('<noscript><img src="/only-fallback.jpg"></noscript>')).toEqual([
      'https://blog.example.com/only-fallback.jpg',
    ]);
    expect(
      count(
        '<div data-bg="/bg.jpg" class="lazy"></div><noscript><p><img src="/bg.jpg"></p></noscript>',
      ),
    ).toBe(1);
  });

  it('counts a <picture> once through its <img>, never its <source>s', () => {
    expect(
      images(
        '<picture><source srcset="/map.avif" type="image/avif"><source srcset="/map.webp 1x, /map@2x.webp 2x" type="image/webp"><img src="/map.png" alt="Map"></picture>',
      ),
    ).toEqual(['https://blog.example.com/map.png']);
    expect(count('<picture><source srcset="/only-source.avif"></picture>')).toBe(0);
  });

  it('skips a data: placeholder in src and takes the real URL from the lazy attributes', () => {
    expect(
      images(`<img src="${GIF_PLACEHOLDER}" data-src="https://cdn.example.net/real.jpg">`),
    ).toEqual(['https://cdn.example.net/real.jpg']);
    expect(images(`<img src="${PLACEHOLDER}" data-lazy-src="/lazy.jpg">`)).toEqual([
      'https://blog.example.com/lazy.jpg',
    ]);
    expect(images(`<img data-original="/original.jpg">`)).toEqual([
      'https://blog.example.com/original.jpg',
    ]);
    // The order: src, data-src, data-lazy-src, data-original.
    expect(
      images('<img data-original="/4.jpg" data-lazy-src="/3.jpg" data-src="/2.jpg" src="/1.jpg">'),
    ).toEqual(['https://blog.example.com/1.jpg']);
    expect(images('<img data-original="/4.jpg" data-lazy-src="/3.jpg" src="">')).toEqual([
      'https://blog.example.com/3.jpg',
    ]);
  });

  it('falls back to the srcset, then the data-srcset candidates', () => {
    expect(images('<img srcset="/s-400.jpg 400w, /s-800.jpg 800w">')).toEqual([
      'https://blog.example.com/s-400.jpg',
    ]);
    expect(
      images(
        `<img src="${PLACEHOLDER}" srcset="${PLACEHOLDER} 1x" data-srcset="/d-1x.jpg 1x, /d-2x.jpg 2x">`,
      ),
    ).toEqual(['https://blog.example.com/d-1x.jpg']);
    // A data: candidate is skipped and the search goes on within the srcset.
    expect(
      images(`<img srcset="${GIF_PLACEHOLDER} 1w, https://cdn.example.net/x.jpg 800w">`),
    ).toEqual(['https://cdn.example.net/x.jpg']);
    // A URL containing commas stays whole.
    expect(
      images(
        '<img srcset="https://res.example.net/upload/w_400,h_300/a.jpg 400w, https://res.example.net/upload/w_800,h_600/a.jpg 800w">',
      ),
    ).toEqual(['https://res.example.net/upload/w_400,h_300/a.jpg']);
  });

  it('excludes images without a usable http(s) URL', () => {
    expect(
      count(
        [
          '<img>',
          '<img src="">',
          `<img src="${GIF_PLACEHOLDER}">`,
          '<img src="javascript:alert(1)">',
          '<img src="blob:https://blog.example.com/1f2e">',
          '<img src="about:blank" data-src="ftp://files.example.com/a.jpg">',
          `<img srcset="${PLACEHOLDER} 1x" alt="placeholder only">`,
          '<img src="http://[broken/x.jpg">',
        ].join(''),
      ),
    ).toBe(0);
  });

  it('resolves relative URLs against the base and counts a repeated resolved URL once', () => {
    expect(
      images(
        '<img src="photo.jpg"><img src="./photo.jpg"><img src="/2026/09/seed-library/photo.jpg"><img src="//blog.example.com/2026/09/seed-library/photo.jpg">',
      ),
    ).toEqual(['https://blog.example.com/2026/09/seed-library/photo.jpg']);
    expect(
      images('<img src="photo.jpg?w=300&amp;h=200"><img src="photo.jpg?w=300&h=200">'),
    ).toEqual(['https://blog.example.com/2026/09/seed-library/photo.jpg?w=300&h=200']);
  });

  it('does not let a pixel claim a URL that a real image uses later', () => {
    expect(
      count('<img src="/same.jpg" width="1" height="1"><img src="/same.jpg" width="640">'),
    ).toBe(1);
  });

  it('reads attribute names case-insensitively, as HTML does', () => {
    expect(images('<IMG SRC="/upper.jpg" WIDTH="640">')).toEqual([
      'https://blog.example.com/upper.jpg',
    ]);
    expect(count('<IMG SRC="/pixel.gif" WIDTH="1" HEIGHT="1">')).toBe(0);
  });

  it('never counts markup that is text or inert', () => {
    expect(
      count(
        [
          '<script>document.write(\'<img src="/script.jpg">\')</script>',
          '<style>/* <img src="/style.jpg"> */</style>',
          '<textarea><img src="/textarea.jpg"></textarea>',
          '<!-- <img src="/comment.jpg"> -->',
          '<iframe src="/frame.html"><img src="/iframe-fallback.jpg"></iframe>',
          '<noembed><img src="/noembed.jpg"></noembed>',
          '<template><img src="/template.jpg"><template></template><img src="/nested.jpg"></template>',
          '&lt;img src="/escaped.jpg"&gt;',
        ].join(''),
      ),
    ).toBe(0);
    expect(images('<template><img src="/t.jpg"></template><img src="/after.jpg">')).toEqual([
      'https://blog.example.com/after.jpg',
    ]);
  });

  it('never loads anything: an image URL is only resolved', () => {
    expect(imageUrlOf({ src: 'https://tracker.example.net/a.jpg' }, BASE)).toBe(
      'https://tracker.example.net/a.jpg',
    );
    expect(imageUrlOf({}, BASE)).toBeNull();
  });
});

describe('spec 03 §6.4 video evidence in HTML (scanHtml)', () => {
  it('any <video> element is video evidence', () => {
    expect(hasVideo('<video controls src="/clip.mp4"></video>')).toBe(true);
    expect(
      hasVideo('<figure><video><source src="/clip.webm" type="video/webm"></video></figure>'),
    ).toBe(true);
    expect(hasVideo('<VIDEO></VIDEO>')).toBe(true);
    expect(hasVideo('<noscript><video src="/fallback.mp4"></video></noscript>')).toBe(true);
  });

  it('an <iframe> on a video embed host is video evidence', () => {
    expect(hasVideo('<iframe src="https://www.youtube.com/embed/tr4mR3st0r3"></iframe>')).toBe(
      true,
    );
    expect(hasVideo('<iframe src="//www.youtube-nocookie.com/embed/tr4mR3st0r3"></iframe>')).toBe(
      true,
    );
    expect(hasVideo('<iframe src="https://player.vimeo.com/video/123456789?h=abc"></iframe>')).toBe(
      true,
    );
    expect(
      hasVideo(
        '<iframe src="https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fx%2Fvideos%2F1"></iframe>',
      ),
    ).toBe(true);
  });

  it('an <embed> src or an <object> data on a video embed host is video evidence', () => {
    expect(
      hasVideo(
        '<embed src="https://www.youtube.com/v/tr4mR3st0r3" type="application/x-shockwave-flash">',
      ),
    ).toBe(true);
    expect(hasVideo('<object data="https://www.dailymotion.com/swf/x8abcd"></object>')).toBe(true);
    // An <object> is judged by data, not src.
    expect(hasVideo('<object src="https://www.youtube.com/v/x" data="/movie.swf"></object>')).toBe(
      false,
    );
    expect(hasVideo('<object data="movie.swf"><embed src="movie.swf"></object>')).toBe(false);
  });

  it('other embeds and Facebook plugins other than video are not video evidence', () => {
    expect(hasVideo('<iframe src="https://video.example/embed/123"></iframe>')).toBe(false);
    expect(
      hasVideo('<iframe src="https://www.facebook.com/plugins/post.php?href=x"></iframe>'),
    ).toBe(false);
    expect(hasVideo('<iframe src="https://maps.example.com/embed"></iframe>')).toBe(false);
    expect(
      hasVideo('<iframe data-src="https://www.youtube.com/embed/x" src="about:blank"></iframe>'),
    ).toBe(false);
    expect(hasVideo('<audio controls src="/episode.mp3"></audio>')).toBe(false);
    expect(
      hasVideo('<p>Watch it on <a href="https://www.youtube.com/watch?v=x">YouTube</a>.</p>'),
    ).toBe(false);
  });

  it('resolves a relative embed src against the base', () => {
    expect(
      scanHtml('<iframe src="/embed/x"></iframe>', 'https://www.youtube.com/watch?v=x').video,
    ).toBe(true);
    expect(hasVideo('<iframe src="/embed/x"></iframe>')).toBe(false);
  });

  it('ignores video markup in raw-text and inert elements', () => {
    expect(hasVideo('<script>var v = "<video></video>";</script>')).toBe(false);
    expect(hasVideo('<template><video></video></template>')).toBe(false);
    expect(hasVideo('<iframe src="/frame"><video></video></iframe>')).toBe(false);
    expect(hasVideo('<!-- <iframe src="https://www.youtube.com/embed/x"></iframe> -->')).toBe(
      false,
    );
  });
});

describe('srcsetUrls (HTML srcset candidate URLs)', () => {
  it.each([
    ['/a.jpg', ['/a.jpg']],
    ['/a.jpg 1x, /b.jpg 2x', ['/a.jpg', '/b.jpg']],
    ['  /a.jpg   400w ,\n/b.jpg\t800w  ', ['/a.jpg', '/b.jpg']],
    ['/a.jpg,/b.jpg 2x', ['/a.jpg,/b.jpg']],
    ['/a.jpg, /b.jpg', ['/a.jpg', '/b.jpg']],
    ['/a.jpg,, /b.jpg', ['/a.jpg', '/b.jpg']],
    [', , /a.jpg 1x,', ['/a.jpg']],
    [
      '/w_400,h_300/a.jpg 400w, /w_800,h_600/a.jpg 800w',
      ['/w_400,h_300/a.jpg', '/w_800,h_600/a.jpg'],
    ],
    ['/a.jpg 100w (min-width: 10px, max-width: 20px), /b.jpg', ['/a.jpg', '/b.jpg']],
    ['/a.jpg (unclosed, /b.jpg', ['/a.jpg']],
    ['', []],
    [' ,, ', []],
  ])('%j → %j', (value, expected) => {
    expect(srcsetUrls(value)).toEqual(expected);
  });
});
