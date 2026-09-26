import { Readability } from '@mozilla/readability';

import { mediaSignals, videoEmbedRegex } from '../media/index.js';
import { htmlToText, sanitizeHtml, sourceCoveredByText } from '../parse/index.js';
import { detectCanonicalUrl } from './canonical-link.js';
import { hasPaywallMarkers, looksLikeTeaser } from './completeness.js';
import { type DomDocument, parseDocument } from './dom.js';
import { capOutput, EXTRACT_MAX_OUTPUT_BYTES } from './output-cap.js';
import { bodyLead, countWords } from './text-metrics.js';
import type { HtmlExtractResult } from './types.js';

/** Readability's `charThreshold` and the minimum readable text (spec 03 §8.1 step 5). */
export const MIN_ARTICLE_CHARS = 200;

/** Readability keeps `<iframe>`/`<embed>`/`<object>` players of these hosts (spec 03 §6.4). */
const ALLOWED_VIDEO_REGEX = videoEmbedRegex();

/**
 * The pure HTML part of extraction (spec 03 §8.1 steps 5–6), shared by `article.extract` and
 * bookmark capture (§8.5 step 3). Never throws.
 *
 * 1. Parse inertly with `linkedom` (no scripts, no resource loads). The document base (`<base
 *    href>` resolved against `pageUrl`, else `pageUrl`) is pinned so Readability and the sanitizer
 *    resolve relative links alike.
 * 2. Before Readability rewrites the DOM, detect the `rel=canonical` (`detectCanonicalUrl`) and
 *    known paywall markers (`hasPaywallMarkers`).
 * 3. `new Readability(document, { charThreshold: 200, allowedVideoRegex }).parse()`, where
 *    `allowedVideoRegex` (`videoEmbedRegex`) keeps the player embeds of `VIDEO_EMBED_HOSTS`. No
 *    result, or readable text shorter than 200 characters → `failed` with error `no_content`
 *    (reason `paywall` when the page is marked as paywalled, else `no_content`) and no canonical: a
 *    page without an article is not identity evidence for one.
 * 4. `bodyText`: the full readable text with paragraph boundaries (`htmlToText` of the Readability
 *    fragment: blank lines between blocks); `bodyHtml`: the full fragment through `sanitizeHtml`
 *    (spec 03 §6.3); both together capped at `maxOutputBytes` (10 MiB) with well-formed truncation
 *    (`capOutput`).
 * 5. Media signals (spec 03 §6.4) of the Readability fragment, read before sanitizing removes the
 *    media: `videoEvidence` whenever Readability returned a fragment, `bodyImageCount` only when
 *    the body is stored (status `ok`), of the part of the fragment the stored text covers (all of
 *    it unless the cap cut the text, `sourceCoveredByText`). Nothing outside the fragment is
 *    examined or counted.
 * 6. Completeness: `partial` with reason `truncated` (the cap cut the output), else `paywall`
 *    (known markers), else `teaser` (short text or a "read more"/ellipsis ending); otherwise
 *    `complete`, meaning no known omission, never a claim about content behind a paywall.
 * 7. `bodyLead` and `wordCount` of the stored text.
 */
export function extractFromHtml(
  html: string,
  pageUrl: string,
  options: { maxOutputBytes?: number } = {},
): HtmlExtractResult {
  try {
    const document = parseDocument(html);
    const baseUrl = pinDocumentBase(document, pageUrl);
    const canonicalUrl = detectCanonicalUrl(document, pageUrl, baseUrl);
    const paywalled = hasPaywallMarkers(document);

    const article = new Readability(document, {
      charThreshold: MIN_ARTICLE_CHARS,
      allowedVideoRegex: ALLOWED_VIDEO_REGEX,
    }).parse();
    const contentHtml = article?.content ?? '';
    const text = contentHtml === '' ? '' : htmlToText(contentHtml);
    // Media signals read the fragment before sanitizing, which removes images, iframes and
    // <video>; the page link is not examined.
    if (!hasAtLeastChars(text, MIN_ARTICLE_CHARS)) {
      const media = mediaSignals({ link: null, html: [contentHtml], bodyHtml: null, baseUrl });
      return {
        ...emptyBody(paywalled ? 'paywall' : 'no_content', 'no_content'),
        canonicalUrl: null,
        status: 'failed',
        videoEvidence: media.videoEvidence,
      };
    }

    const capped = capOutput(
      text,
      sanitizeHtml(contentHtml, baseUrl),
      options.maxOutputBytes ?? EXTRACT_MAX_OUTPUT_BYTES,
    );
    const media = mediaSignals({
      link: null,
      html: [contentHtml],
      bodyHtml: sourceCoveredByText(contentHtml, text, capped.text),
      baseUrl,
    });
    const reason = capped.truncated
      ? 'truncated'
      : paywalled
        ? 'paywall'
        : looksLikeTeaser(text)
          ? 'teaser'
          : null;
    return {
      status: 'ok',
      bodyText: capped.text,
      bodyHtml: capped.html === '' ? null : capped.html,
      bodyLead: bodyLead(capped.text),
      wordCount: countWords(capped.text),
      completeness: reason === null ? 'complete' : 'partial',
      completenessReason: reason,
      canonicalUrl,
      error: null,
      videoEvidence: media.videoEvidence,
      bodyImageCount: media.bodyImageCount,
    };
  } catch {
    return {
      ...emptyBody('extraction_failed', 'extraction_failed'),
      canonicalUrl: null,
      status: 'failed',
    };
  }
}

function emptyBody(
  reason: string,
  error: string,
): Omit<HtmlExtractResult, 'status' | 'canonicalUrl'> {
  return {
    bodyText: null,
    bodyHtml: null,
    bodyLead: null,
    wordCount: null,
    completeness: 'partial',
    completenessReason: reason,
    error,
    videoEvidence: false,
    bodyImageCount: null,
  };
}

/**
 * Resolves the document base URL (the first `<base href>` with an http(s) target, resolved against
 * `pageUrl`, else `pageUrl`) and leaves exactly one absolute `<base>` in the document, which
 * `linkedom` reports as `baseURI` to Readability's link fixing.
 */
function pinDocumentBase(document: DomDocument, pageUrl: string): string {
  const page = URL.parse(pageUrl);
  let baseUrl = page?.href ?? pageUrl;
  const bases = Array.from(document.querySelectorAll('base'));
  const declared = bases.find((base) => base.getAttribute('href') !== null);
  const resolved = URL.parse(declared?.getAttribute('href')?.trim() ?? '', page?.href);
  if (declared !== undefined && resolved !== null && /^https?:$/.test(resolved.protocol)) {
    baseUrl = resolved.href;
  }
  for (const base of bases) base.remove();
  if (page !== null && document.head !== null) {
    const pinned = document.createElement('base');
    pinned.setAttribute('href', baseUrl);
    document.head.appendChild(pinned);
  }
  return baseUrl;
}

function hasAtLeastChars(text: string, min: number): boolean {
  if (text.length >= min * 2) return true;
  return Array.from(text).length >= min;
}
