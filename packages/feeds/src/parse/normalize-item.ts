import { normalizeText } from '@bantoozi/shared';

import { type MediaObject, mediaSignals } from '../media/index.js';
import { computeContentHash } from './content-hash.js';
import { parseFeedDate } from './dates.js';
import { PARSE_LIMITS } from './limits.js';
import { htmlToText, sanitizeContent, sanitizedHtmlToText, truncateHtml } from './sanitize.js';
import { charLength, cleanText, stripControlChars, truncateChars, utf8Length } from './text.js';
import type { ItemErrorCode, NormalizedItem } from './types.js';
import { resolveHttpUrl } from './urls.js';

/** A title candidate: `html` titles are stripped of markup and entity-decoded, `text` is literal. */
export interface RawTitle {
  value: string;
  type: 'html' | 'text';
}

/** A URL candidate. Without `base` it must already be absolute (an RSS guid used as a link). */
export interface RawUrl {
  href: string;
  base?: string | undefined;
}

/** One source item mapped from RSS/RDF/Atom/JSON Feed, before the spec 03 §6 rules apply. */
export interface RawFeedItem {
  sourceIndex: number;
  title: RawTitle | null;
  /** Article link candidates in priority order (never enclosures or attachments). */
  links: RawUrl[];
  /** Raw identifier (RSS guid, Atom id, JSON Feed id, RSS 1.0 `rdf:about`). */
  guid: string | null;
  /** Raw date candidates in priority order. */
  dates: string[];
  /** Raw author candidates in priority order. */
  authors: string[];
  /** Flattened raw category strings. */
  categories: string[];
  /** The selected content as HTML, with the base URL for its relative links. */
  content: { html: string; base: string } | null;
  /** Image candidates (enclosure, `media:content`, `media:thumbnail`) in priority order. */
  images: RawUrl[];
  /**
   * Every media object of the item, for video evidence (spec 03 §6.4): RSS enclosures, Atom
   * `link rel="enclosure"`, JSON Feed attachments and `media:content` (also inside `media:group`).
   */
  media: MediaObject[];
}

export interface NormalizeItemContext {
  /** Clock for the future-date rule. */
  now: Date;
}

export type NormalizeItemResult =
  { ok: true; item: NormalizedItem } | { ok: false; code: ItemErrorCode };

/** Result of the cheap first phase: identity and date, known before any content is sanitized. */
export interface PreparedItem {
  raw: RawFeedItem;
  guid: string | null;
  publishedAt: Date | null;
}

/**
 * Markup in an RSS/Atom-html title: a known inline tag, or any element with its closing tag. Other
 * `<` sequences (`the <details> element`) stay literal text, because RSS titles are often escaped
 * only once.
 */
const TITLE_MARKUP =
  /<\/?(?:a|abbr|b|big|br|cite|code|del|em|font|i|img|ins|kbd|mark|q|s|small|span|strike|strong|sub|sup|tt|u|var)\b[^>]*>|<([a-z][a-z0-9]*)\b[^>]*>[^<]*<\/\1\s*>/i;

/** Text with HTML entities decoded (e.g. WordPress's `News &amp; Politics`), tags kept literal. */
function decodeEntities(value: string): string {
  return value.includes('&') ? htmlToText(value.replace(/</g, '&lt;')) : value;
}

/** Plain text of a title (spec 03 §6 `title`): markup stripped and entities decoded for `html`. */
export function cleanRawTitle(title: RawTitle | null): string {
  if (title === null) return '';
  const value = title.value.slice(0, 64 * 1024);
  if (title.type === 'text') return cleanText(value);
  return cleanText(TITLE_MARKUP.test(value) ? htmlToText(value) : decodeEntities(value));
}

/** GUIDs are opaque: control characters and surrounding XML whitespace go, nothing else. */
function cleanGuid(guid: string | null): string | null {
  if (guid === null) return null;
  const value = stripControlChars(guid).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  return value === '' ? null : value;
}

function selectDate(candidates: readonly string[], now: Date): Date | null {
  for (const candidate of candidates) {
    const date = parseFeedDate(candidate);
    if (date === null) continue;
    // A date more than a day ahead is unknown, so it is never advanced again on each poll.
    return date.getTime() > now.getTime() + PARSE_LIMITS.futureToleranceMs ? null : date;
  }
  return null;
}

function selectUrl(candidates: readonly RawUrl[]): string | null {
  for (const candidate of candidates) {
    const url = resolveHttpUrl(candidate.href, candidate.base);
    if (url !== null) return url;
  }
  return null;
}

function selectAuthor(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const author = truncateChars(
      cleanText(decodeEntities(candidate.slice(0, 4096))),
      PARSE_LIMITS.authorChars,
    ).trim();
    if (author !== '') return author;
  }
  return null;
}

function selectCategories(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const candidate of candidates) {
    if (categories.length >= PARSE_LIMITS.maxCategories) break;
    const category = truncateChars(
      cleanText(decodeEntities(candidate.slice(0, 1024))),
      PARSE_LIMITS.categoryChars,
    ).trim();
    const key = category.normalize('NFC').toLowerCase();
    if (category === '' || seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
  }
  return categories;
}

interface ItemContent {
  /** The bounded source HTML that was sanitized, with its base URL (examined for media, §6.4). */
  source: { html: string; base: string } | null;
  bodyHtml: string | null;
  bodyText: string | null;
  bodyTruncated: boolean;
  excerptHtml: string | null;
  excerpt: string | null;
  imageUrl: string | null;
}

/**
 * Sanitizes the full content once (input bounded to 5 MiB first), keeps it as the feed body within
 * the 10 MiB text + HTML limit, and derives the ≤ 10,000-char excerpt HTML and ≤ 2,000-char plain
 * excerpt from it (spec 03 §6 `excerpt_html`, `excerpt`, `feed_body_*`).
 */
function processContent(content: RawFeedItem['content']): ItemContent {
  const empty: ItemContent = {
    source: null,
    bodyHtml: null,
    bodyText: null,
    bodyTruncated: false,
    excerptHtml: null,
    excerpt: null,
    imageUrl: null,
  };
  if (content === null) return empty;
  let source = content.html;
  let truncated = false;
  if (source.length > PARSE_LIMITS.contentInputChars) {
    source = source.slice(0, PARSE_LIMITS.contentInputChars);
    truncated = true;
  }
  const sanitized = sanitizeContent(source, content.base);
  const bounded = { html: source, base: content.base };
  let html = sanitized.html;
  let text = sanitizedHtmlToText(html);
  if (text === '') return { ...empty, source: bounded, imageUrl: sanitized.firstImageUrl };
  if (utf8Length(html) + utf8Length(text) > PARSE_LIMITS.bodyBytes) {
    // Plain text is never longer than its HTML, so half the budget each keeps the sum in bounds.
    html = truncateHtml(html, PARSE_LIMITS.bodyBytes / 2, 'utf8').html;
    text = sanitizedHtmlToText(html);
    truncated = true;
  }
  const excerptHtml = truncateHtml(html, PARSE_LIMITS.excerptHtmlChars).html;
  const excerpt = truncateChars(
    cleanText(sanitizedHtmlToText(excerptHtml)),
    PARSE_LIMITS.excerptChars,
  ).trim();
  return {
    source: bounded,
    bodyHtml: html,
    bodyText: text,
    bodyTruncated: truncated,
    excerptHtml: excerptHtml === '' ? null : excerptHtml,
    excerpt: excerpt === '' ? null : excerpt,
    imageUrl: sanitized.firstImageUrl,
  };
}

/**
 * The spec 03 §6.4 media signals of an item: its media objects, its selected link, and the source
 * HTML of its content read before sanitizing. That one content is the source of both the excerpt
 * and the body, so it is the examined HTML; its images are counted only when it became the feed
 * body (`feedBodyImageCount` is `null` exactly when `feedBodyHtml` is).
 */
function itemMediaSignals(
  raw: RawFeedItem,
  link: string | null,
  content: ItemContent,
): { videoEvidence: boolean; feedBodyImageCount: number | null } {
  const { source } = content;
  const signals = mediaSignals({
    link,
    media: raw.media,
    html: source === null ? [] : [source.html],
    bodyHtml: source === null || content.bodyHtml === null ? null : source.html,
    // Without source HTML nothing is resolved; the link is absolute already.
    baseUrl: source?.base ?? link ?? '',
  });
  return { videoEvidence: signals.videoEvidence, feedBodyImageCount: signals.bodyImageCount };
}

/**
 * Phase 1 of {@link normalizeItem}: the identifier (complete; empty → `null`; more than 4,096
 * chars → `ITEM_GUID_TOO_LONG`, never truncated), `published_at`, and an emptiness check. Cheap,
 * so it runs for every source item before the newest items are selected.
 */
export function prepareItem(
  raw: RawFeedItem,
  context: NormalizeItemContext,
): { ok: true; prepared: PreparedItem } | { ok: false; code: ItemErrorCode } {
  const guid = cleanGuid(raw.guid);
  if (guid !== null && charLength(guid) > PARSE_LIMITS.guidChars) {
    return { ok: false, code: 'ITEM_GUID_TOO_LONG' };
  }
  const hasTitle = raw.title !== null && raw.title.value.trim() !== '';
  const hasLink = raw.links.some((link) => link.href.trim() !== '');
  const hasContent = raw.content !== null && raw.content.html.trim() !== '';
  if (!hasTitle && !hasLink && !hasContent && guid === null) {
    return { ok: false, code: 'ITEM_EMPTY' };
  }
  return { ok: true, prepared: { raw, guid, publishedAt: selectDate(raw.dates, context.now) } };
}

/**
 * Phase 2 of {@link normalizeItem}: content, title, link, author, categories, image, media signals
 * and hash.
 */
export function finishItem(prepared: PreparedItem): NormalizeItemResult {
  const { raw, guid, publishedAt } = prepared;
  const content = processContent(raw.content);
  const sourceTitle = truncateChars(cleanRawTitle(raw.title), PARSE_LIMITS.titleChars).trim();
  const link = selectUrl(raw.links);
  if (sourceTitle === '' && link === null && guid === null && content.excerpt === null) {
    return { ok: false, code: 'ITEM_EMPTY' };
  }
  const fallbackTitle =
    content.excerpt === null
      ? ''
      : truncateChars(content.excerpt, PARSE_LIMITS.titleFallbackChars).trim();
  const title =
    sourceTitle !== '' ? sourceTitle : fallbackTitle !== '' ? fallbackTitle : '(untitled)';
  const author = selectAuthor(raw.authors);
  const categories = selectCategories(raw.categories);
  const media = itemMediaSignals(raw, link, content);
  const item: NormalizedItem = {
    sourceIndex: raw.sourceIndex,
    title,
    titleNorm: normalizeText(title),
    link,
    guid,
    publishedAt,
    author,
    categories,
    excerptHtml: content.excerptHtml,
    excerpt: content.excerpt,
    feedBodyText: content.bodyText,
    feedBodyHtml: content.bodyHtml,
    feedBodyTruncated: content.bodyTruncated,
    imageUrl: selectUrl(raw.images) ?? content.imageUrl,
    videoEvidence: media.videoEvidence,
    feedBodyImageCount: media.feedBodyImageCount,
    // Media signals are not model text inputs: they never enter the hash (spec 03 §6.2).
    contentHash: computeContentHash({
      title,
      excerpt: content.excerpt,
      author,
      categories,
      link,
      feedBodyText: content.bodyText,
    }),
  };
  return { ok: true, item };
}

/**
 * Applies the spec 03 §6 per-item rules to one mapped source item (title, link, guid,
 * published_at, author, categories, excerpt/excerpt HTML, feed body, image, `title_norm` §6.1,
 * `content_hash` §6.2 and the media signals `video_evidence`/`feed_body_image_count` §6.4). A
 * failure is a per-item error code, never an exception.
 */
export function normalizeItem(
  raw: RawFeedItem,
  context: NormalizeItemContext,
): NormalizeItemResult {
  const prepared = prepareItem(raw, context);
  return prepared.ok ? finishItem(prepared.prepared) : prepared;
}
