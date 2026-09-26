import { z } from 'zod';

import type { RawFeedMeta } from './feed-meta.js';
import type { MappedItem } from './map-xml.js';
import type { RawFeedItem, RawUrl } from './normalize-item.js';
import { textToHtml } from './sanitize.js';
import { JSON_FEED_VERSION_URL } from './sniff.js';
import { isRecord } from './xml-values.js';

/** An optional string member; a value of another type counts as absent. */
const optionalString = z.string().optional().catch(undefined);

const authorSchema = z.object({ name: optionalString });

const attachmentSchema = z.object({ url: optionalString, mime_type: optionalString });

/** One JSON Feed 1.0/1.1 item; members of the wrong type are dropped, not fatal. */
const itemSchema = z.object({
  id: z
    .union([z.string(), z.number()])
    .transform((id) => String(id))
    .optional()
    .catch(undefined),
  url: optionalString,
  external_url: optionalString,
  title: optionalString,
  content_html: optionalString,
  content_text: optionalString,
  summary: optionalString,
  image: optionalString,
  banner_image: optionalString,
  date_published: optionalString,
  date_modified: optionalString,
  author: authorSchema.optional().catch(undefined),
  authors: z.array(authorSchema.catch({})).optional().catch(undefined),
  tags: z.array(z.unknown()).optional().catch(undefined),
  attachments: z.array(attachmentSchema.catch({})).optional().catch(undefined),
});

/** The JSON Feed document: the `version` URL identifies it; `items` must be an array. */
const feedSchema = z.object({
  version: z.string().trim().regex(JSON_FEED_VERSION_URL),
  title: optionalString,
  home_page_url: optionalString,
  description: optionalString,
  icon: optionalString,
  favicon: optionalString,
  language: optionalString,
  author: authorSchema.optional().catch(undefined),
  authors: z.array(authorSchema.catch({})).optional().catch(undefined),
  items: z.array(z.unknown()),
});

export type JsonFeedDocument =
  | { ok: true; meta: RawFeedMeta; items: MappedItem[] }
  | { ok: false; code: 'FEED_PARSE_ERROR' | 'FEED_NOT_A_FEED'; message: string };

const MENTIONS_JSON_FEED = /jsonfeed\.org\\?\/version/;

/** Author names of a JSON Feed object: 1.1 `authors`, then the 1.0 `author`. */
function authorNames(value: {
  author?: { name?: string | undefined } | undefined;
  authors?: { name?: string | undefined }[] | undefined;
}): string[] {
  return [...(value.authors ?? []).map((author) => author.name), value.author?.name].flatMap(
    (name) => (name === undefined ? [] : [name]),
  );
}

function mapItem(
  value: unknown,
  sourceIndex: number,
  feedUrl: string,
  feedAuthors: readonly string[],
): MappedItem {
  if (!isRecord(value)) return { ok: false, sourceIndex, code: 'ITEM_INVALID' };
  const parsed = itemSchema.safeParse(value);
  if (!parsed.success) return { ok: false, sourceIndex, code: 'ITEM_INVALID' };
  const item = parsed.data;
  const urls = (values: (string | undefined)[]): RawUrl[] =>
    values.flatMap((href) => (href === undefined ? [] : [{ href, base: feedUrl }]));
  let html: string | null = null;
  if (item.content_html !== undefined && item.content_html.trim() !== '') html = item.content_html;
  else if (item.content_text !== undefined && item.content_text.trim() !== '') {
    html = textToHtml(item.content_text);
  } else if (item.summary !== undefined && item.summary.trim() !== '') {
    html = textToHtml(item.summary);
  }
  const imageAttachments = (item.attachments ?? []).filter(
    (attachment) => attachment.mime_type?.trim().toLowerCase().startsWith('image/') === true,
  );
  const raw: RawFeedItem = {
    sourceIndex,
    title: item.title === undefined ? null : { value: item.title, type: 'text' },
    // Attachments are never article links.
    links: urls([item.url, item.external_url]),
    guid: item.id ?? null,
    dates: [item.date_published, item.date_modified].flatMap((date) =>
      date === undefined ? [] : [date],
    ),
    // JSON Feed 1.1: an item without authors has the feed's authors.
    authors: [...authorNames(item), ...feedAuthors],
    categories: (item.tags ?? []).flatMap((tag) => (typeof tag === 'string' ? [tag] : [])),
    content: html === null ? null : { html, base: feedUrl },
    images: urls([
      ...imageAttachments.map((attachment) => attachment.url),
      item.image,
      item.banner_image,
    ]),
  };
  return { ok: true, raw };
}

/**
 * Parses a JSON Feed 1.0/1.1 document (spec 03 §6) in the calling thread: JSON (UTF-8; a leading
 * BOM is ignored), then zod validation. A document is a JSON Feed when its `version` is a
 * `https://jsonfeed.org/version/1…` URL; other JSON is `FEED_NOT_A_FEED`, broken JSON that names a
 * JSON Feed version (or a JSON Feed without an `items` array) is `FEED_PARSE_ERROR`. Items are
 * validated one by one: an item that is not an object is a per-item error (`ITEM_INVALID`).
 * `maxSourceItems` bounds the input like the XML item limit.
 */
export function parseJsonFeedDocument(
  text: string,
  feedUrl: string,
  maxSourceItems: number,
): JsonFeedDocument {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return MENTIONS_JSON_FEED.test(text)
      ? { ok: false, code: 'FEED_PARSE_ERROR', message: 'Malformed JSON Feed' }
      : { ok: false, code: 'FEED_NOT_A_FEED', message: 'Not a feed' };
  }
  const version = isRecord(data) ? data['version'] : undefined;
  if (typeof version !== 'string' || !JSON_FEED_VERSION_URL.test(version.trim())) {
    return { ok: false, code: 'FEED_NOT_A_FEED', message: 'JSON document is not a JSON Feed' };
  }
  const parsed = feedSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: 'Invalid JSON Feed: items is not a list',
    };
  }
  const feed = parsed.data;
  if (feed.items.length > maxSourceItems) {
    return {
      ok: false,
      code: 'FEED_PARSE_ERROR',
      message: `The feed has more than ${maxSourceItems} items`,
    };
  }
  const meta: RawFeedMeta = {
    title: feed.title === undefined ? null : { value: feed.title, type: 'text' },
    siteUrl: feed.home_page_url === undefined ? null : { href: feed.home_page_url, base: feedUrl },
    description: feed.description === undefined ? null : { value: feed.description, type: 'text' },
    language: feed.language ?? null,
    icons: [feed.icon, feed.favicon].flatMap((href) =>
      href === undefined ? [] : [{ href, base: feedUrl }],
    ),
    ttl: null,
    syUpdatePeriod: null,
    syUpdateFrequency: null,
  };
  return {
    ok: true,
    meta,
    items: feed.items.map((item, index) => mapItem(item, index, feedUrl, authorNames(feed))),
  };
}
