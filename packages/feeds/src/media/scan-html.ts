import sanitize from 'sanitize-html';

import { isTrackingPixel } from '../parse/sanitize.js';
import { resolveHttpUrl } from '../parse/urls.js';
import { isVideoEmbedUrl } from './hosts.js';
import { srcsetUrls } from './srcset.js';

/** Attributes that hold one image URL, in lookup order (spec 03 §6.4). */
const IMAGE_URL_ATTRIBUTES = ['src', 'data-src', 'data-lazy-src', 'data-original'] as const;

/** Attributes that hold `srcset` candidates, looked up after {@link IMAGE_URL_ATTRIBUTES}. */
const IMAGE_SRCSET_ATTRIBUTES = ['srcset', 'data-srcset'] as const;

/** What one HTML fragment contains (spec 03 §6.4). */
export interface HtmlMediaScan {
  /** A `<video>` element, or an `<iframe>`/`<embed>`/`<object>` of a known video player. */
  video: boolean;
  /** Resolved URLs of the counted `<img>` elements: distinct, without pixels or URL-less images. */
  imageUrls: Set<string>;
}

type Attributes = Readonly<Record<string, string | undefined>>;

/**
 * The URL of an `<img>` (spec 03 §6.4): the first value that resolves against `baseUrl` to an
 * http(s) URL, in this order: `src`, `data-src`, `data-lazy-src`, `data-original`, then the
 * candidates of `srcset` and of `data-srcset`. A `data:` placeholder or any other non-http(s) value
 * is skipped and the search goes on; `null` when no value is usable.
 */
export function imageUrlOf(attribs: Attributes, baseUrl: string): string | null {
  for (const name of IMAGE_URL_ATTRIBUTES) {
    const value = attribs[name];
    const url = value === undefined ? null : resolveHttpUrl(value, baseUrl);
    if (url !== null) return url;
  }
  for (const name of IMAGE_SRCSET_ATTRIBUTES) {
    const value = attribs[name];
    if (value === undefined) continue;
    for (const candidate of srcsetUrls(value)) {
      const url = resolveHttpUrl(candidate, baseUrl);
      if (url !== null) return url;
    }
  }
  return null;
}

/** Whether an `<iframe>`/`<embed>` (`src`) or `<object>` (`data`) is a known video player. */
function isPlayerEmbed(name: string, attribs: Attributes, baseUrl: string): boolean {
  const value = name === 'object' ? attribs['data'] : attribs['src'];
  const url = value === undefined ? null : resolveHttpUrl(value, baseUrl);
  return url !== null && isVideoEmbedUrl(url);
}

/**
 * Scans an HTML fragment for the media signals of spec 03 §6.4 with the tokenizer the sanitizer
 * uses (htmlparser2 through `sanitize-html`), so it reads exactly the element stream that
 * sanitizing would see, before any attribute is stripped. Nothing is fetched or loaded.
 *
 * - Video: any `<video>` element, or an `<iframe>`/`<embed>` whose resolved `src`, or an
 *   `<object>` whose resolved `data`, is on a video embed host (`isVideoEmbedUrl`).
 * - Images: every `<img>` (a `<picture>` counts through its `<img>`, never its `<source>`s),
 *   except tracking pixels (`isTrackingPixel`, the sanitizer's rule), images without a usable
 *   http(s) URL (`imageUrlOf`) and repeats of an already counted resolved URL.
 *
 * `<noscript>` content is markup, as for a parser with scripting disabled, so the fallback `<img>`
 * of a lazy-loaded image is seen and counted once with it. Raw-text elements (`<script>`,
 * `<style>`, `<textarea>`, `<iframe>`, `<noembed>`, `<noframes>`, …) contain no elements, and
 * inert `<template>` contents are ignored.
 */
export function scanHtml(html: string, baseUrl: string): HtmlMediaScan {
  const scan: HtmlMediaScan = { video: false, imageUrls: new Set() };
  let templateDepth = 0;
  // Only the tag hooks matter. With no allowed tag, completelyDiscard drops every text node without
  // escaping it, so the discarded output costs next to nothing.
  sanitize(html, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'completelyDiscard',
    parseStyleAttributes: false,
    onOpenTag: (name, attribs) => {
      if (name === 'template') templateDepth += 1;
      if (templateDepth > 0) return;
      switch (name) {
        case 'img': {
          if (isTrackingPixel(attribs)) return;
          const url = imageUrlOf(attribs, baseUrl);
          if (url !== null) scan.imageUrls.add(url);
          return;
        }
        case 'video':
          scan.video = true;
          return;
        case 'iframe':
        case 'embed':
        case 'object':
          if (!scan.video && isPlayerEmbed(name, attribs, baseUrl)) scan.video = true;
          return;
        default:
          return;
      }
    },
    onCloseTag: (name) => {
      if (name === 'template' && templateDepth > 0) templateDepth -= 1;
    },
  });
  return scan;
}
