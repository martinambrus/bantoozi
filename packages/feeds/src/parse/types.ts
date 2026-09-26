/** Feed formats handled by {@link parseFeed} (spec 03 §6). */
export type FeedKind = 'rss' | 'atom' | 'rdf' | 'json';

/** Feed-level metadata (spec 03 §6 "Feed-level fields"). */
export interface FeedMeta {
  /** Plain-text title, or `null`. */
  title: string | null;
  /** Resolved http(s) site link: RSS `<link>`, Atom `link[rel=alternate]`, JSON Feed `home_page_url`. */
  siteUrl: string | null;
  /** Plain-text description (RSS `description`, Atom `subtitle`, JSON Feed `description`). */
  description: string | null;
  /** Raw language: RSS `<language>`/`dc:language`, Atom `xml:lang`, JSON Feed `language`. */
  language: string | null;
  /** `language` normalized to ISO 639-1 by `normalizeLanguageHint`, or `null` (→ `feeds.lang_hint`). */
  langHint: string | null;
  /** Resolved http(s) image/icon/favicon. */
  iconUrl: string | null;
  /** RSS `<ttl>` in minutes. */
  ttlMinutes: number | null;
  /** `sy:updatePeriod`, lower-cased: `hourly`, `daily`, `weekly`, `monthly` or `yearly`. */
  syUpdatePeriod: string | null;
  /** `sy:updateFrequency`, a positive integer. */
  syUpdateFrequency: number | null;
}

/** One normalized feed item (spec 03 §6 "Per item → NormalizedItem"). */
export interface NormalizedItem {
  /** Position of the item in the source document (for bounded error logs). */
  sourceIndex: number;
  /** Cleaned, case-preserving title (≤ 500 chars); excerpt prefix or `(untitled)` as fallbacks. */
  title: string;
  /** `normalizeText(title)` (spec 03 §6.1). */
  titleNorm: string;
  /** Resolved absolute http(s) article link, not canonicalized (the caller canonicalizes). */
  link: string | null;
  /** Complete opaque identifier (RSS guid, Atom id, JSON Feed id, RSS 1.0 `rdf:about`). */
  guid: string | null;
  /** Publication instant in UTC, or `null` when unknown, malformed or more than 1 day ahead. */
  publishedAt: Date | null;
  /** Author as text (≤ 200 chars). */
  author: string | null;
  /** Trimmed, case-insensitively deduplicated categories (≤ 16 of ≤ 64 chars). */
  categories: string[];
  /** Sanitized excerpt HTML (spec 03 §6.3), ≤ 10,000 chars, never cut through markup. */
  excerptHtml: string | null;
  /** Plain text of `excerptHtml`, whitespace-collapsed, ≤ 2,000 chars. */
  excerpt: string | null;
  /** Full readable publisher text before excerpt truncation (paragraph breaks kept). */
  feedBodyText: string | null;
  /** Full sanitized publisher HTML before excerpt truncation. */
  feedBodyHtml: string | null;
  /**
   * The feed body hit an input or output safety limit (5 MiB of source HTML, 10 MiB of text + HTML)
   * and was cut with well-formed truncation, so it is not a complete capture (spec 03 §8.1 step 6).
   */
  feedBodyTruncated: boolean;
  /** Selected http(s) image URL (metadata only; embedded images are never kept in the HTML). */
  imageUrl: string | null;
  /** `content_hash` (spec 03 §6.2). */
  contentHash: string;
}

/** A per-item problem: bounded index and code only, never item content (spec 03 §6). */
export interface ItemError {
  /** The item's `sourceIndex`. */
  index: number;
  /** One of {@link ITEM_ERROR_CODES}. */
  code: ItemErrorCode;
}

/** Per-item error codes. */
export const ITEM_ERROR_CODES = [
  /** A JSON Feed item that is not an object. */
  'ITEM_INVALID',
  /** The GUID/id is longer than 4,096 chars; identity is never truncated. */
  'ITEM_GUID_TOO_LONG',
  /** No title, link, identifier or content: nothing identifies or describes the item. */
  'ITEM_EMPTY',
  /** An unexpected failure while normalizing this item. */
  'ITEM_ERROR',
] as const;

export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];

/** A successfully parsed feed (spec 03 §6). */
export interface ParsedFeed {
  kind: FeedKind;
  feed: FeedMeta;
  /** At most `maxItems` valid items, newest first; undated items keep publisher order, last. */
  items: NormalizedItem[];
  /** Source items seen in the document. */
  totalItems: number;
  /** The feed has more than `maxItems` valid items (`items_truncated`). */
  itemsTruncated: boolean;
  /** Skipped items, at most {@link MAX_REPORTED_ITEM_ERRORS} entries (see `itemErrorCount`). */
  itemErrors: ItemError[];
  /** Number of skipped items, including those beyond the reported `itemErrors`. */
  itemErrorCount: number;
  /** The lenient XML cleanup pass was needed to parse the document. */
  lenient: boolean;
}

/** Whole-document failure codes of {@link parseFeed}. */
export type ParseFeedErrorCode = 'FEED_PARSE_ERROR' | 'FEED_NOT_A_FEED';

export type ParseFeedResult =
  ({ ok: true } & ParsedFeed) | { ok: false; code: ParseFeedErrorCode; message: string };

export interface ParseFeedOptions {
  /** Final feed URL (after redirects): the base for relative links. Must be an absolute URL. */
  url: string;
  /** Response `Content-Type`, used only to sniff ambiguous bodies. */
  contentType?: string | undefined;
  /** Clock for the future-date rule (default `new Date()`). */
  now?: Date | undefined;
  /** Stored-item cap (default 200). */
  maxItems?: number | undefined;
  /** XML parser CPU deadline per attempt in ms (default 2,000). */
  deadlineMs?: number | undefined;
}

/** At most this many item errors are reported individually (spec 03 §6: bounded logs). */
export const MAX_REPORTED_ITEM_ERRORS = 100;
