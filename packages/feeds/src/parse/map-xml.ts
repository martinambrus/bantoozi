import type { RawFeedMeta } from './feed-meta.js';
import { embeddedMarkupToHtml, xhtmlToHtml } from './markup.js';
import type { RawFeedItem, RawTitle, RawUrl } from './normalize-item.js';
import { textToHtml } from './sanitize.js';
import type { ItemErrorCode } from './types.js';
import { applyXmlBase } from './urls.js';
import type { RawMarkup, XmlParseOutput } from './xml-worker.js';
import {
  asArray,
  attributeOf,
  attributesOf,
  first,
  hasElementChildren,
  isRecord,
  textOf,
} from './xml-values.js';

/** A successful worker parse. */
export type XmlParsedFeed = Extract<XmlParseOutput, { ok: true }>;

/** A mapped source item, or the per-item error that prevented mapping it. */
export type MappedItem =
  { ok: true; raw: RawFeedItem } | { ok: false; sourceIndex: number; code: ItemErrorCode };

const IMAGE_PATH = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const ALTERNATE_REL_IRI = 'http://www.iana.org/assignments/relation/';
const HTML_LINK_TYPES = new Set(['', 'text/html', 'application/xhtml+xml']);

/** The trimmed text of an element, or `null` when the element is absent or empty. */
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = textOf(value).trim();
  return text === '' ? null : text;
}

function mediaType(value: unknown): string {
  return (attributeOf(value, 'type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function linkRel(value: unknown): string {
  const rel = (attributeOf(value, 'rel') ?? 'alternate').trim().toLowerCase();
  return rel.startsWith(ALTERNATE_REL_IRI) ? rel.slice(ALTERNATE_REL_IRI.length) : rel;
}

/** `xml:base` of the element applied to `base`. */
function elementBase(base: string, element: unknown): string {
  return applyXmlBase(base, attributeOf(element, 'xml:base'));
}

/** Attributes stored under a `bzAttrs` custom field (the element's `$` object itself). */
function ownXmlBase(base: string, attrs: unknown): string {
  return applyXmlBase(base, attributesOf({ $: attrs })['xml:base']);
}

function hasImagePath(href: string): boolean {
  try {
    return IMAGE_PATH.test(new URL(href, 'http://x.invalid/').pathname);
  } catch {
    return false;
  }
}

/**
 * `media:content` that is an image: `medium="image"`; without a medium an `image/*` type; with
 * neither, an image file extension (Media RSS makes both attributes optional).
 */
function isImageMediaContent(element: unknown): boolean {
  const medium = attributeOf(element, 'medium')?.trim().toLowerCase();
  if (medium !== undefined && medium !== '') return medium === 'image';
  const type = mediaType(element);
  if (type !== '') return type.startsWith('image/');
  return hasImagePath(attributeOf(element, 'url') ?? '');
}

/** Image candidates after enclosures: image `media:content`, then any `media:thumbnail`. */
function mediaImages(item: Record<string, unknown>, base: string): RawUrl[] {
  const groups = asArray(item['bzMediaGroup']).filter(isRecord);
  const contents = [
    ...asArray(item['media:content']),
    ...groups.flatMap((group) => asArray(group['media:content'])),
  ];
  const thumbnails = [
    ...asArray(item['media:thumbnail']),
    ...groups.flatMap((group) => asArray(group['media:thumbnail'])),
    ...contents.filter(isRecord).flatMap((content) => asArray(content['media:thumbnail'])),
  ];
  return [...contents.filter(isImageMediaContent), ...thumbnails].flatMap((element) => {
    const href = attributeOf(element, 'url');
    return href === undefined ? [] : [{ href, base: elementBase(base, element) }];
  });
}

/** Atom `link` elements that are article links: `rel=alternate` (or none), HTML or no type. */
function alternateLinks(links: readonly unknown[], base: string): RawUrl[] {
  return links.flatMap((link) => {
    const href = attributeOf(link, 'href');
    if (href === undefined || linkRel(link) !== 'alternate') return [];
    if (!HTML_LINK_TYPES.has(mediaType(link))) return [];
    return [{ href, base: elementBase(base, link) }];
  });
}

function flattenCategories(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    const text = textOf(value);
    return text.trim() === '' ? [] : [text];
  });
}

/** RSS text constructs are HTML; child markup (a publisher error) comes from the raw pass. */
function rssHtml(element: unknown, raw: string | undefined): string | null {
  if (element === undefined || element === null) return null;
  if (raw !== undefined && hasElementChildren(element)) return embeddedMarkupToHtml(raw);
  return textOf(element);
}

function mapRssItem(
  item: Record<string, unknown>,
  sourceIndex: number,
  raw: RawMarkup | null,
  channelBase: string,
): RawFeedItem {
  const base = ownXmlBase(channelBase, item['bzAttrs']);
  const titleElement = first(item['bzTitle']);
  const titleHtml = rssHtml(titleElement, raw?.title) ?? optionalText(item['title']);
  const title: RawTitle | null = titleHtml === null ? null : { value: titleHtml, type: 'html' };

  const links: RawUrl[] = [];
  const linkElement = first(item['bzLink']);
  const linkHref = optionalText(linkElement) ?? attributeOf(linkElement, 'href');
  if (linkHref !== undefined) links.push({ href: linkHref, base: elementBase(base, linkElement) });
  const guidElement = first(item['bzGuid']);
  const guidText = guidElement === undefined ? null : textOf(guidElement);
  // A guid is the article link only when isPermaLink is not false and it is already absolute.
  if (
    guidText !== null &&
    attributeOf(guidElement, 'isPermaLink')?.trim().toLowerCase() !== 'false'
  ) {
    links.push({ href: guidText });
  }
  const about = typeof item['rdf:about'] === 'string' ? item['rdf:about'] : null;
  if (about !== null) links.push({ href: about });

  const encodedElement = first(item['bzContentEncoded']);
  const descriptionElement = first(item['bzDescription']);
  const encoded = rssHtml(encodedElement, raw?.['content:encoded']);
  const description = rssHtml(descriptionElement, raw?.description);
  let content: RawFeedItem['content'] = null;
  if (encoded !== null && encoded.trim() !== '') {
    content = { html: encoded, base: elementBase(base, encodedElement) };
  } else if (description !== null && description.trim() !== '') {
    content = { html: description, base: elementBase(base, descriptionElement) };
  }

  const enclosures = asArray(item['bzEnclosure']).filter((enclosure) =>
    mediaType(enclosure).startsWith('image/'),
  );
  return {
    sourceIndex,
    title,
    links,
    guid: guidText ?? about,
    dates: [textOf(first(item['bzPubDate'])), textOf(item['dc:date'])],
    // rss-parser's `creator` is dc:creator, else author (spec: creator ?? author ?? dc:creator ??
    // itunes:author).
    authors: [
      textOf(item['creator']),
      textOf(item['author']),
      textOf(item['dc:creator']),
      textOf(first(item['bzItunesAuthor'])),
    ],
    categories: flattenCategories([
      ...asArray(item['bzCategory']),
      ...asArray(item['bzDcSubject']),
    ]),
    content,
    images: [
      ...enclosures.flatMap((enclosure) => {
        const href = attributeOf(enclosure, 'url');
        return href === undefined ? [] : [{ href, base: elementBase(base, enclosure) }];
      }),
      ...mediaImages(item, base),
    ],
  };
}

/** An Atom text construct (RFC 4287 §3.1) as a title candidate, respecting `type`. */
function atomTitle(element: unknown, raw: string | undefined): RawTitle | null {
  if (element === undefined || element === null) return null;
  const type = mediaType(element) || 'text';
  if (type === 'xhtml') {
    return raw === undefined
      ? { value: textOf(element), type: 'text' }
      : { value: xhtmlToHtml(raw), type: 'html' };
  }
  if (type === 'html' || type === 'text/html') {
    return { value: rssHtml(element, raw) ?? '', type: 'html' };
  }
  return { value: textOf(element), type: 'text' };
}

/**
 * Atom `content`/`summary` as HTML (spec 03 §6 `excerpt_html`): `type` text (default) and `text/*`
 * are escaped text, `html` is HTML, `xhtml` is the inline XHTML. Out-of-line content (`src`) is
 * never fetched and other media types are not displayable, so both give `null`.
 */
function atomContent(
  element: unknown,
  raw: string | undefined,
  builtXhtml: unknown,
  base: string,
): RawFeedItem['content'] {
  if (element === undefined || element === null) return null;
  if (attributeOf(element, 'src') !== undefined) return null;
  const type = mediaType(element) || 'text';
  let html: string;
  if (type === 'xhtml') {
    if (raw !== undefined) html = xhtmlToHtml(raw);
    else html = typeof builtXhtml === 'string' ? builtXhtml : textToHtml(textOf(element));
  } else if (type === 'html' || type === 'text/html') {
    html = rssHtml(element, raw) ?? '';
  } else if (type === 'text' || type.startsWith('text/')) {
    html = textToHtml(textOf(element));
  } else {
    return null;
  }
  return html.trim() === '' ? null : { html, base: elementBase(base, element) };
}

/** Names of Atom `author` elements. */
function atomAuthorNames(authors: unknown): string[] {
  return asArray(authors).map((author) => (isRecord(author) ? textOf(first(author['name'])) : ''));
}

function mapAtomEntry(
  item: Record<string, unknown>,
  sourceIndex: number,
  raw: RawMarkup | null,
  feedBase: string,
  feedAuthors: readonly string[],
): RawFeedItem {
  const base = ownXmlBase(feedBase, item['bzAttrs']);
  const links = asArray(item['bzLink']);
  const enclosures = links.filter(
    (link) => linkRel(link) === 'enclosure' && mediaType(link).startsWith('image/'),
  );
  return {
    sourceIndex,
    title: atomTitle(first(item['bzTitle']), raw?.title),
    links: alternateLinks(links, base),
    guid: optionalText(first(item['bzId'])),
    dates: [textOf(first(item['bzPublished'])), textOf(first(item['bzUpdated']))],
    // RFC 4287 §4.2.1: without its own author, an entry has the feed's authors.
    authors: [
      ...atomAuthorNames(item['bzAuthor']),
      textOf(item['dc:creator']),
      textOf(first(item['bzItunesAuthor'])),
      ...feedAuthors,
    ],
    categories: flattenCategories(
      asArray(item['bzCategory']).map(
        (category) =>
          attributeOf(category, 'term') ?? attributeOf(category, 'label') ?? textOf(category),
      ),
    ),
    content:
      atomContent(first(item['bzContent']), raw?.content, item['content'], base) ??
      atomContent(first(item['bzSummary']), raw?.summary, item['summary'], base),
    images: [
      ...enclosures.flatMap((link) => {
        const href = attributeOf(link, 'href');
        return href === undefined ? [] : [{ href, base: elementBase(base, link) }];
      }),
      ...mediaImages(item, base),
    ],
  };
}

function rssFeedMeta(parsed: XmlParsedFeed, channelBase: string): RawFeedMeta {
  const { feed } = parsed;
  const channelAttributes = attributesOf({ $: feed['bzAttrs'] });
  const rootAttributes = attributesOf({ $: parsed.rootAttrs });
  const titleHtml = optionalText(first(feed['bzTitle']));
  const linkElement = first(feed['bzLink']);
  const siteHref = optionalText(linkElement) ?? attributeOf(linkElement, 'href');
  const descriptionHtml = optionalText(first(feed['bzDescription']));
  const image = first(feed['bzImage']);
  const imageHref =
    (isRecord(image) ? optionalText(first(image['url'])) : null) ??
    attributeOf(image, 'rdf:resource');
  const itunesImage = attributeOf(first(feed['bzItunesImage']), 'href');
  return {
    title: titleHtml === null ? null : { value: titleHtml, type: 'html' },
    siteUrl: siteHref === undefined ? null : { href: siteHref, base: channelBase },
    description: descriptionHtml === null ? null : { value: descriptionHtml, type: 'html' },
    language:
      optionalText(first(feed['bzLanguage'])) ??
      optionalText(first(feed['bzDcLanguage'])) ??
      channelAttributes['xml:lang'] ??
      rootAttributes['xml:lang'] ??
      null,
    icons: [imageHref, itunesImage].flatMap((href) =>
      href === undefined || href === null ? [] : [{ href, base: channelBase }],
    ),
    ttl: optionalText(first(feed['bzTtl'])),
    syUpdatePeriod: optionalText(feed['sy:updatePeriod']),
    syUpdateFrequency: optionalText(feed['sy:updateFrequency']),
  };
}

function atomFeedMeta(parsed: XmlParsedFeed, feedBase: string): RawFeedMeta {
  const { feed } = parsed;
  const siteLink = alternateLinks(asArray(feed['bzLink']), feedBase)[0];
  const icons = [first(feed['bzIcon']), first(feed['bzLogo'])].flatMap((element) => {
    const href = optionalText(element);
    return href === null ? [] : [{ href, base: elementBase(feedBase, element) }];
  });
  return {
    title: atomTitle(first(feed['bzTitle']), undefined),
    siteUrl:
      siteLink === undefined ? null : { href: siteLink.href, base: siteLink.base ?? feedBase },
    description: atomTitle(first(feed['bzSubtitle']), undefined),
    language: attributesOf({ $: parsed.rootAttrs })['xml:lang'] ?? null,
    icons,
    ttl: null,
    syUpdatePeriod: optionalText(feed['sy:updatePeriod']),
    syUpdateFrequency: optionalText(feed['sy:updateFrequency']),
  };
}

/**
 * Maps rss-parser output to feed metadata and raw items (spec 03 §6). `xml:base` chains start at
 * the final feed URL: root element → RSS channel/Atom feed → item/entry → the element itself
 * (`link`, `content`, `enclosure`, …). An item that cannot be mapped becomes an `ITEM_ERROR`.
 */
export function mapXmlFeed(
  parsed: XmlParsedFeed,
  feedUrl: string,
): { meta: RawFeedMeta; items: MappedItem[] } {
  const rootBase = ownXmlBase(feedUrl, parsed.rootAttrs);
  const isAtom = parsed.kind === 'atom';
  const base = isAtom ? rootBase : ownXmlBase(rootBase, parsed.feed['bzAttrs']);
  const feedAuthors = isAtom ? atomAuthorNames(parsed.feed['bzAuthor']) : [];
  const items = parsed.items.map((item, index): MappedItem => {
    try {
      const raw = parsed.rawMarkup?.[index] ?? null;
      return {
        ok: true,
        raw: isAtom
          ? mapAtomEntry(item, index, raw, base, feedAuthors)
          : mapRssItem(item, index, raw, base),
      };
    } catch {
      return { ok: false, sourceIndex: index, code: 'ITEM_ERROR' };
    }
  });
  return { meta: isAtom ? atomFeedMeta(parsed, base) : rssFeedMeta(parsed, base), items };
}
