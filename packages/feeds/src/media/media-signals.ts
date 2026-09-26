import { isVideoHostUrl } from './hosts.js';
import { type HtmlMediaScan, scanHtml } from './scan-html.js';

/** A media object of a feed item: an enclosure, a JSON Feed attachment or a `media:content`. */
export interface MediaObject {
  /** MIME type (`video/mp4`, `audio/mpeg`, …) when declared. */
  type?: string | null;
  /** `media:content` `medium` (`video`, `image`, `audio`, …) when declared. */
  medium?: string | null;
}

export interface MediaSignalsInput {
  /** The article link (item link or page URL); a video-host link is video evidence. */
  link: string | null;
  /** The item's enclosures, attachments and `media:content` (including those in `media:group`). */
  media?: readonly MediaObject[];
  /** HTML examined for `<video>` and player embeds, read BEFORE sanitizing (excerpt/body/page). */
  html?: readonly (string | null)[];
  /**
   * The main body fragment whose distinct in-body images are counted, read BEFORE sanitizing: the
   * Readability result of a page or the feed item's publisher body. Absent or null → count null.
   * It is examined for video too, like `html`.
   */
  bodyHtml?: string | null;
  /** Base URL for resolving relative `src`/`data`/`srcset` values. */
  baseUrl: string;
}

export interface MediaSignals {
  videoEvidence: boolean;
  /** Distinct in-body images of `bodyHtml`; null when no body fragment was given. */
  bodyImageCount: number | null;
}

/**
 * Whether a media object is a video (spec 03 §6.4): its MIME type is `video/*` (parameters and case
 * ignored) or its `medium` is `video`. Audio, images and undeclared types are not.
 */
export function isVideoMediaObject(media: MediaObject): boolean {
  const type = (media.type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return type.startsWith('video/') || (media.medium ?? '').trim().toLowerCase() === 'video';
}

/**
 * Pure, local media detection (spec 03 §6.4): no network, no resource loading, no model call.
 *
 * - `videoEvidence`: a video media object (`isVideoMediaObject`), a `link` on a video host
 *   (`isVideoHostUrl`), or a `<video>` element or known player embed in any examined HTML
 *   (`html` and `bodyHtml`, see `scanHtml`).
 * - `bodyImageCount`: the distinct in-body images of `bodyHtml` (see `scanHtml`: tracking pixels,
 *   images without a usable http(s) URL and repeated URLs are excluded), or `null` without a body.
 *
 * Each distinct HTML string is parsed at most once, and not at all when neither signal needs it.
 */
export function mediaSignals(input: MediaSignalsInput): MediaSignals {
  const scans = new Map<string, HtmlMediaScan>();
  const scan = (html: string): HtmlMediaScan => {
    let result = scans.get(html);
    if (result === undefined) {
      result = scanHtml(html, input.baseUrl);
      scans.set(html, result);
    }
    return result;
  };
  const bodyHtml = input.bodyHtml ?? null;
  let videoEvidence =
    (input.media ?? []).some(isVideoMediaObject) ||
    (input.link !== null && isVideoHostUrl(input.link));
  for (const html of [...(input.html ?? []), bodyHtml]) {
    if (videoEvidence) break;
    if (html !== null && html !== '') videoEvidence = scan(html).video;
  }
  return {
    videoEvidence,
    bodyImageCount: bodyHtml === null ? null : scan(bodyHtml).imageUrls.size,
  };
}
