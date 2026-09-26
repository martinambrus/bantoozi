/**
 * The XML feed parser that runs in a `node:worker_threads` Worker (spec 03 §6), so the caller can
 * enforce the parser CPU deadline by terminating the thread. It is self-contained — no local
 * imports — because it runs both from TypeScript sources (Node's type stripping, under Vitest) and
 * from the compiled `dist/`.
 *
 * `rss-parser` (xml2js/sax, strict mode) parses RSS 0.9x/1.0/2.0 and Atom. sax never loads DTDs or
 * external entities, performs no network access or XInclude and does not expand custom entities;
 * the caller additionally rejects DOCTYPE/ENTITY declarations and deep nesting before any parse.
 * Three defects of rss-parser 3.13 are worked around here:
 * - an Atom `published`/`updated` that is not a valid date throws and fails the whole feed, so those
 *   elements are taken out of rss-parser's hands and returned raw;
 * - an Atom `link` element without attributes crashes its link lookup, so such links are dropped;
 * - an empty `<item/>`/`<channel/>` is a string in xml2js, from which rss-parser copies
 *   `String.prototype` members (`''.link` is a function) that cannot be posted back, so such
 *   elements are treated as empty objects.
 *
 * xml2js groups child elements by name, which reorders mixed content (Atom `type="xhtml"`, RSS
 * descriptions with unescaped child markup). Only when an item's title/description/content has
 * element children, a second, bounded `fast-xml-parser` pass (entities not processed, same input
 * that already passed the safety checks) returns those elements' raw inner markup in order.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { XMLParser } from 'fast-xml-parser';
import Parser from 'rss-parser';

/** Marks the `workerData` of this worker, so importing the module elsewhere has no side effect. */
export const XML_WORKER_MARKER = 'bantoozi:feed-xml-worker:1';

export type XmlFeedKind = 'rss' | 'atom' | 'rdf';

/** Text-construct elements whose raw inner markup can be supplied by the fast-xml-parser pass. */
export type RawMarkupField = 'title' | 'description' | 'content:encoded' | 'content' | 'summary';

/** Raw inner markup (in document order, entities and CDATA sections untouched) per field. */
export type RawMarkup = Partial<Record<RawMarkupField, string>>;

export type XmlParseOutput =
  | {
      ok: true;
      kind: XmlFeedKind;
      /** rss-parser's feed-level output (without `items`), including the custom fields. */
      feed: Record<string, unknown>;
      /** rss-parser's items, including the custom fields. */
      items: Record<string, unknown>[];
      /** Attributes of the root element (`xml:base`, `xml:lang`, …). */
      rootAttrs: Record<string, unknown>;
      /** Per-item raw markup, aligned with `items`, or `null` when no item needed it. */
      rawMarkup: (RawMarkup | null)[] | null;
    }
  | { ok: false; code: 'XML_MALFORMED' | 'XML_NOT_A_FEED' | 'XML_TOO_MANY_ITEMS'; message: string };

export interface XmlWorkerData {
  marker: typeof XML_WORKER_MARKER;
  text: string;
  maxSourceItems: number;
}

export type XmlWorkerMessage = { type: 'started' } | { type: 'done'; output: XmlParseOutput };

const KEEP = { keepArray: true };

/** Item custom fields: the spec 03 §6 set, plus raw elements (with attributes) as `bz*`. */
const ITEM_FIELDS = [
  ['media:content', 'media:content', KEEP],
  ['media:thumbnail', 'media:thumbnail', KEEP],
  'dc:creator',
  'dc:date',
  'content:encoded',
  ['$', 'bzAttrs', KEEP],
  ['title', 'bzTitle', KEEP],
  ['link', 'bzLink', KEEP],
  ['guid', 'bzGuid', KEEP],
  ['id', 'bzId', KEEP],
  ['pubDate', 'bzPubDate', KEEP],
  ['description', 'bzDescription', KEEP],
  ['content:encoded', 'bzContentEncoded', KEEP],
  ['content', 'bzContent', KEEP],
  ['summary', 'bzSummary', KEEP],
  ['author', 'bzAuthor', KEEP],
  ['itunes:author', 'bzItunesAuthor', KEEP],
  ['category', 'bzCategory', KEEP],
  ['dc:subject', 'bzDcSubject', KEEP],
  ['enclosure', 'bzEnclosure', KEEP],
  ['media:group', 'bzMediaGroup', KEEP],
];

/** Feed custom fields: the spec 03 §6 `sy:*` fields, plus raw channel/feed elements as `bz*`. */
const FEED_FIELDS = [
  'sy:updatePeriod',
  'sy:updateFrequency',
  ['$', 'bzAttrs', KEEP],
  ['title', 'bzTitle', KEEP],
  ['link', 'bzLink', KEEP],
  ['author', 'bzAuthor', KEEP],
  ['description', 'bzDescription', KEEP],
  ['subtitle', 'bzSubtitle', KEEP],
  ['language', 'bzLanguage', KEEP],
  ['dc:language', 'bzDcLanguage', KEEP],
  ['ttl', 'bzTtl', KEEP],
  ['image', 'bzImage', KEEP],
  ['icon', 'bzIcon', KEEP],
  ['logo', 'bzLogo', KEEP],
  ['itunes:image', 'bzItunesImage', KEEP],
];

/** Per kind: the item element path and the raw-markup fields with their rss-parser keys. */
const RAW_MARKUP: Record<
  XmlFeedKind,
  { itemPath: string; fields: readonly (readonly [RawMarkupField, string])[] }
> = {
  rss: {
    itemPath: 'rss.channel.item',
    fields: [
      ['title', 'bzTitle'],
      ['description', 'bzDescription'],
      ['content:encoded', 'bzContentEncoded'],
    ],
  },
  rdf: {
    itemPath: 'rdf:RDF.item',
    fields: [
      ['title', 'bzTitle'],
      ['description', 'bzDescription'],
      ['content:encoded', 'bzContentEncoded'],
    ],
  },
  atom: {
    itemPath: 'feed.entry',
    fields: [
      ['title', 'bzTitle'],
      ['summary', 'bzSummary'],
      ['content', 'bzContent'],
    ],
  },
};

/** rss-parser methods that are not part of its type declarations. */
interface ParserInternals {
  parseItemAtom(entry: unknown): Record<string, unknown>;
  parseItemRss(item: unknown, itemFields: unknown): Record<string, unknown>;
  buildRSS(channel: unknown, items: unknown): Record<string, unknown>;
  buildAtomFeed(xmlObj: Record<string, unknown>): Record<string, unknown>;
  buildRSS0_9(xmlObj: Record<string, unknown>): Record<string, unknown>;
  buildRSS1(xmlObj: Record<string, unknown>): Record<string, unknown>;
  buildRSS2(xmlObj: Record<string, unknown>): Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAttributes(value: unknown): boolean {
  return isRecord(value) && isRecord(value['$']);
}

function attributesOf(value: unknown): Record<string, unknown> {
  return isRecord(value) && isRecord(value['$']) ? value['$'] : {};
}

/** An xml2js element with child elements (not just text and attributes). */
function hasElementChildren(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => key !== '$' && key !== '_');
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

type Fields = Record<string, unknown>;

function createParser(onRoot: (kind: XmlFeedKind, root: unknown) => void): Parser<Fields, Fields> {
  // rss-parser's types allow only plain names as feed custom fields; it accepts [from, to, options].
  const options = { defaultRSS: 2, customFields: { item: ITEM_FIELDS, feed: FEED_FIELDS } };
  const parser = new Parser<Fields, Fields>(
    options as unknown as Parser.ParserOptions<Fields, Fields>,
  );
  const internals = parser as unknown as ParserInternals;
  const base = {
    parseItemAtom: internals.parseItemAtom.bind(parser),
    parseItemRss: internals.parseItemRss.bind(parser),
    buildRSS: internals.buildRSS.bind(parser),
    buildAtomFeed: internals.buildAtomFeed.bind(parser),
    buildRSS0_9: internals.buildRSS0_9.bind(parser),
    buildRSS1: internals.buildRSS1.bind(parser),
    buildRSS2: internals.buildRSS2.bind(parser),
  };
  internals.parseItemAtom = (entry) => {
    const source = isRecord(entry) ? entry : {};
    const { published, updated, link, ...rest } = source;
    if (Array.isArray(link)) rest['link'] = link.filter(hasAttributes);
    const item = base.parseItemAtom(rest);
    item['bzPublished'] = published;
    item['bzUpdated'] = updated;
    return item;
  };
  // An element without children or attributes is a string in xml2js; rss-parser would then read
  // `String.prototype` members such as `link` as fields. Such elements are empty.
  internals.parseItemRss = (item, itemFields) =>
    base.parseItemRss(isRecord(item) ? item : {}, itemFields);
  internals.buildRSS = (channel, items) => base.buildRSS(isRecord(channel) ? channel : {}, items);
  internals.buildAtomFeed = (xmlObj) => {
    const feed = isRecord(xmlObj['feed']) ? xmlObj['feed'] : {};
    if (Array.isArray(feed['link'])) feed['link'] = feed['link'].filter(hasAttributes);
    onRoot('atom', feed);
    return base.buildAtomFeed({ ...xmlObj, feed });
  };
  internals.buildRSS0_9 = (xmlObj) => {
    onRoot('rss', xmlObj['rss']);
    return base.buildRSS0_9(xmlObj);
  };
  internals.buildRSS1 = (xmlObj) => {
    onRoot('rdf', xmlObj['rdf:RDF']);
    return base.buildRSS1(xmlObj);
  };
  internals.buildRSS2 = (xmlObj) => {
    onRoot('rss', xmlObj['rss']);
    return base.buildRSS2(xmlObj);
  };
  return parser;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/**
 * Raw inner markup of the text constructs of every item, from a fast-xml-parser pass that stops at
 * those elements. `null` when the pass fails or does not see the same items as rss-parser.
 */
function extractRawMarkup(
  text: string,
  kind: XmlFeedKind,
  count: number,
): (RawMarkup | null)[] | null {
  const { itemPath, fields } = RAW_MARKUP[kind];
  const stopNodes = fields.map(([name]) => `${itemPath}.${name}`);
  try {
    const document: unknown = new XMLParser({
      ignoreAttributes: true,
      processEntities: false,
      htmlEntities: false,
      parseTagValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      stopNodes,
      isArray: (_name: string, jpath: unknown) =>
        jpath === itemPath || stopNodes.includes(String(jpath)),
    }).parse(text);
    let node: unknown = document;
    for (const segment of itemPath.split('.')) {
      node = isRecord(node) ? node[segment] : undefined;
      if (segment !== 'item' && segment !== 'entry') node = firstOf(node);
    }
    if (!Array.isArray(node) || node.length !== count) return null;
    return (node as unknown[]).map((item) => {
      if (!isRecord(item)) return null;
      const markup: RawMarkup = {};
      for (const [name] of fields) {
        const value = firstOf(item[name]);
        if (typeof value === 'string') markup[name] = value;
      }
      return markup;
    });
  } catch {
    return null;
  }
}

/**
 * Parses an RSS/RDF/Atom document with rss-parser (strict) and, when needed, supplies raw markup of
 * text constructs with child elements. Documents with more than `maxSourceItems` items are rejected
 * (spec 03 §6 input complexity limit). Never throws.
 */
export async function parseFeedXml(text: string, maxSourceItems: number): Promise<XmlParseOutput> {
  let kind: XmlFeedKind | null = null;
  let rootAttrs: Record<string, unknown> = {};
  const parser = createParser((rootKind, root) => {
    kind = rootKind;
    rootAttrs = attributesOf(root);
  });
  let output: Record<string, unknown>;
  try {
    output = (await parser.parseString(text)) as unknown as Record<string, unknown>;
  } catch (error) {
    const message = boundedMessage(error);
    return message.startsWith('Feed not recognized')
      ? { ok: false, code: 'XML_NOT_A_FEED', message }
      : { ok: false, code: 'XML_MALFORMED', message };
  }
  const detected = kind as XmlFeedKind | null;
  if (detected === null) return { ok: false, code: 'XML_NOT_A_FEED', message: 'Not a feed' };
  const { items: rawItems, ...feed } = output;
  const items = (Array.isArray(rawItems) ? (rawItems as unknown[]) : []).map((item) =>
    isRecord(item) ? item : {},
  );
  if (items.length > maxSourceItems) {
    return {
      ok: false,
      code: 'XML_TOO_MANY_ITEMS',
      message: `The feed has more than ${maxSourceItems} items`,
    };
  }
  const { fields } = RAW_MARKUP[detected];
  const needsRawMarkup = items.some((item) =>
    fields.some(([, key]) => hasElementChildren(firstOf(item[key]))),
  );
  return {
    ok: true,
    kind: detected,
    feed,
    items,
    rootAttrs,
    rawMarkup: needsRawMarkup ? extractRawMarkup(text, detected, items.length) : null,
  };
}

function isWorkerData(value: unknown): value is XmlWorkerData {
  return (
    isRecord(value) &&
    value['marker'] === XML_WORKER_MARKER &&
    typeof value['text'] === 'string' &&
    typeof value['maxSourceItems'] === 'number'
  );
}

/** A structured-clone-safe copy: functions, symbols and bigints are dropped. */
export function toCloneable(value: unknown, depth = 0): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > 256) return null;
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => toCloneable(item, depth + 1) ?? null);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const cloneable = toCloneable(item, depth + 1);
    if (cloneable !== undefined) copy[key] = cloneable;
  }
  return copy;
}

const port = parentPort;
const input: unknown = workerData;
if (port !== null && isWorkerData(input)) {
  port.postMessage({ type: 'started' } satisfies XmlWorkerMessage);
  void parseFeedXml(input.text, input.maxSourceItems).then((output) => {
    try {
      port.postMessage({ type: 'done', output } satisfies XmlWorkerMessage);
    } catch {
      port.postMessage({ type: 'done', output: toCloneable(output) } as XmlWorkerMessage);
    }
  });
}
