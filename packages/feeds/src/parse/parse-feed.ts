import { type RawFeedMeta, normalizeFeedMeta } from './feed-meta.js';
import { parseJsonFeedDocument } from './json-feed.js';
import { lenientXmlCleanup, stripLeadingJunk } from './lenient.js';
import { PARSE_LIMITS } from './limits.js';
import { type MappedItem, mapXmlFeed } from './map-xml.js';
import {
  type NormalizeItemContext,
  type PreparedItem,
  finishItem,
  prepareItem,
} from './normalize-item.js';
import { parseXmlInWorker } from './run-xml-worker.js';
import { firstContentIndex, sniffFeed } from './sniff.js';
import {
  type FeedKind,
  type ItemError,
  type ItemErrorCode,
  MAX_REPORTED_ITEM_ERRORS,
  type NormalizedItem,
  type ParseFeedOptions,
  type ParseFeedResult,
  type ParsedFeed,
} from './types.js';
import { inspectXml } from './xml-safety.js';

/** Newest first by `published_at`; undated items after dated ones, in publisher order. */
function newestFirst(a: PreparedItem, b: PreparedItem): number {
  const aTime = a.publishedAt?.getTime();
  const bTime = b.publishedAt?.getTime();
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return bTime - aTime;
  if (aTime !== undefined && bTime === undefined) return -1;
  if (aTime === undefined && bTime !== undefined) return 1;
  return a.raw.sourceIndex - b.raw.sourceIndex;
}

/**
 * Normalizes the mapped items (spec 03 §6): every source item is prepared (identity, date,
 * emptiness), the valid ones are ordered newest first, and only the first `maxItems` are fully
 * normalized, so a 10,000-item document never sanitizes more than it keeps. Per-item failures are
 * counted and skipped.
 */
function buildParsedFeed(
  kind: FeedKind,
  meta: RawFeedMeta,
  mapped: readonly MappedItem[],
  context: NormalizeItemContext,
  maxItems: number,
  lenient: boolean,
): ParsedFeed {
  const itemErrors: ItemError[] = [];
  let itemErrorCount = 0;
  const skip = (index: number, code: ItemErrorCode): void => {
    itemErrorCount += 1;
    if (itemErrors.length < MAX_REPORTED_ITEM_ERRORS) itemErrors.push({ index, code });
  };

  const prepared: PreparedItem[] = [];
  for (const entry of mapped) {
    if (!entry.ok) {
      skip(entry.sourceIndex, entry.code);
      continue;
    }
    try {
      const result = prepareItem(entry.raw, context);
      if (result.ok) prepared.push(result.prepared);
      else skip(entry.raw.sourceIndex, result.code);
    } catch {
      skip(entry.raw.sourceIndex, 'ITEM_ERROR');
    }
  }
  prepared.sort(newestFirst);

  const items: NormalizedItem[] = [];
  let next = 0;
  for (; next < prepared.length && items.length < maxItems; next += 1) {
    const candidate = prepared[next];
    if (candidate === undefined) break;
    try {
      const result = finishItem(candidate);
      if (result.ok) items.push(result.item);
      else skip(candidate.raw.sourceIndex, result.code);
    } catch {
      skip(candidate.raw.sourceIndex, 'ITEM_ERROR');
    }
  }
  itemErrors.sort((a, b) => a.index - b.index);
  return {
    kind,
    feed: normalizeFeedMeta(meta),
    items,
    totalItems: mapped.length,
    itemsTruncated: next < prepared.length,
    itemErrors,
    itemErrorCount,
    lenient,
  };
}

function failure(
  code: 'FEED_PARSE_ERROR' | 'FEED_NOT_A_FEED',
  message: string,
): Extract<ParseFeedResult, { ok: false }> {
  return { ok: false, code, message };
}

function isXmlKind(kind: FeedKind | 'html' | null): kind is 'rss' | 'atom' | 'rdf' {
  return kind === 'rss' || kind === 'atom' || kind === 'rdf';
}

function positiveOption(
  name: string,
  value: number | undefined,
  fallback: number,
  integer: boolean,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || (integer && !Number.isInteger(result))) {
    throw new TypeError(`parseFeed: ${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return result;
}

/**
 * Parses a decoded feed body into normalized items (spec 03 §6). Charset decoding happens before
 * (`decodeBody`, §4); JSON Feed is UTF-8.
 *
 * - The body is sniffed (§6): JSON Feed is parsed in this thread with zod; RSS 0.9x/1.0/2.0 and
 *   Atom are parsed by rss-parser in a worker thread that is terminated after `deadlineMs`
 *   (default 2 s). An HTML page or unknown content is `FEED_NOT_A_FEED`.
 * - XML safety: DOCTYPE/ENTITY declarations and nesting deeper than 64 are rejected before any
 *   parse or lenient pass; more than 10,000 source items is `FEED_PARSE_ERROR`.
 * - Malformed XML is retried once after {@link lenientXmlCleanup} (`lenient: true`); a valid feed
 *   without items is a success.
 * - Items follow the §6 rules; at most `maxItems` (200) valid items are returned, newest first.
 *
 * Resolves with a result union; rejects only on invalid options or when the parser worker cannot
 * start at all (a deployment error).
 */
export async function parseFeed(text: string, options: ParseFeedOptions): Promise<ParseFeedResult> {
  let feedUrl: string;
  try {
    feedUrl = new URL(options.url).href;
  } catch {
    throw new TypeError('parseFeed: url must be an absolute URL');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('parseFeed: now must be a valid Date');
  const maxItems = positiveOption('maxItems', options.maxItems, PARSE_LIMITS.maxItems, true);
  const deadlineMs = positiveOption(
    'deadlineMs',
    options.deadlineMs,
    PARSE_LIMITS.deadlineMs,
    false,
  );
  const context: NormalizeItemContext = { now };

  const start = firstContentIndex(text);
  if (start >= 0 && text.charAt(start) === '{') {
    const document = parseJsonFeedDocument(text, feedUrl, PARSE_LIMITS.maxSourceItems);
    if (!document.ok) return failure(document.code, document.message);
    return {
      ok: true,
      ...buildParsedFeed('json', document.meta, document.items, context, maxItems, false),
    };
  }

  const kind = sniffFeed(text, options.contentType);
  // Leading junk (e.g. PHP warnings) hides the root: only the lenient pass can parse such a body.
  let lenient = false;
  if (!isXmlKind(kind)) {
    if (!isXmlKind(sniffFeed(stripLeadingJunk(text)))) {
      return failure(
        'FEED_NOT_A_FEED',
        kind === 'html' ? 'The document is an HTML page, not a feed' : 'Not a recognized feed',
      );
    }
    lenient = true;
  }

  // Before any parse or lenient pass (spec 03 §6).
  const safety = inspectXml(text);
  if (!safety.ok) return failure('FEED_PARSE_ERROR', safety.message);

  const workerOptions = { deadlineMs, maxSourceItems: PARSE_LIMITS.maxSourceItems };
  const strictText = text.slice(Math.max(start, 0));
  let outcome = await parseXmlInWorker(
    lenient ? lenientXmlCleanup(text) : strictText,
    workerOptions,
  );
  if (!lenient && !outcome.ok && outcome.code === 'XML_MALFORMED') {
    // One retry after the lenient cleanup, unless it has nothing to repair.
    const cleaned = lenientXmlCleanup(text);
    if (cleaned !== strictText) {
      outcome = await parseXmlInWorker(cleaned, workerOptions);
      lenient = true;
    }
  }
  if (!outcome.ok) {
    return outcome.code === 'XML_NOT_A_FEED'
      ? failure('FEED_NOT_A_FEED', outcome.message)
      : failure(
          'FEED_PARSE_ERROR',
          outcome.code === 'XML_MALFORMED' ? `Malformed XML: ${outcome.message}` : outcome.message,
        );
  }
  const mapped = mapXmlFeed(outcome, feedUrl);
  return {
    ok: true,
    ...buildParsedFeed(outcome.kind, mapped.meta, mapped.items, context, maxItems, lenient),
  };
}
