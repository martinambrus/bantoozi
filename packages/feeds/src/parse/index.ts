/** Feed parsing, item normalization and sanitizing (spec 03 §6) — M1-T3. */
export { computeContentHash, type ContentHashInput } from './content-hash.js';
export { parseFeedDate } from './dates.js';
export { lenientXmlCleanup } from './lenient.js';
export { PARSE_LIMITS } from './limits.js';
export {
  normalizeItem,
  type NormalizeItemContext,
  type NormalizeItemResult,
  type RawFeedItem,
  type RawTitle,
  type RawUrl,
} from './normalize-item.js';
export { parseFeed } from './parse-feed.js';
export {
  htmlToText,
  isTrackingPixel,
  SANITIZED_LINK_REL,
  sanitizeHtml,
  sourceCoveredByText,
  truncateHtml,
  type HtmlLengthUnit,
  type SanitizeHtmlOptions,
} from './sanitize.js';
export { sniffFeed } from './sniff.js';
export {
  ITEM_ERROR_CODES,
  MAX_REPORTED_ITEM_ERRORS,
  type FeedKind,
  type FeedMeta,
  type ItemError,
  type ItemErrorCode,
  type NormalizedItem,
  type ParsedFeed,
  type ParseFeedErrorCode,
  type ParseFeedOptions,
  type ParseFeedResult,
} from './types.js';
export { inspectXml, type XmlSafetyResult } from './xml-safety.js';
