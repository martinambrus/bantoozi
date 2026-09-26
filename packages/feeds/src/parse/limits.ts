/**
 * Parsing and normalization limits (spec 03 §6). "Chars" are Unicode code points, as counted by
 * PostgreSQL's `char_length`.
 */
export const PARSE_LIMITS = {
  /** Valid items kept per fetch (`items_truncated` beyond this). */
  maxItems: 200,
  /** Source items/entries a document may contain at all (input complexity limit). */
  maxSourceItems: 10_000,
  /** Maximum XML element nesting depth. */
  maxXmlDepth: 64,
  /** XML parser CPU deadline per attempt, enforced by terminating the parser worker thread. */
  deadlineMs: 2_000,
  /** Maximum cleaned title length. */
  titleChars: 500,
  /** Length of the excerpt prefix used as a fallback title. */
  titleFallbackChars: 80,
  /** Maximum author length. */
  authorChars: 200,
  /** Maximum length of one category. */
  categoryChars: 64,
  /** Maximum number of categories. */
  maxCategories: 16,
  /** Maximum sanitized excerpt HTML length. */
  excerptHtmlChars: 10_000,
  /** Maximum plain-text excerpt length. */
  excerptChars: 2_000,
  /** A longer GUID makes the item invalid (identity is never truncated). */
  guidChars: 4_096,
  /** Source HTML of one item's body is bounded to this many UTF-16 code units before sanitizing. */
  contentInputChars: 5 * 1024 * 1024,
  /** Combined UTF-8 bytes of `feedBodyText` + `feedBodyHtml` (the extraction-output safety limit). */
  bodyBytes: 10 * 1024 * 1024,
  /** Dates further ahead than this are treated as unknown. */
  futureToleranceMs: 24 * 60 * 60 * 1000,
  /** Longer URLs are not usable links (the safe client rejects them, spec 03 §4). */
  urlChars: 8_192,
} as const;
