import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { redactFeedUrl, validateFeedUrl, type FeedUrlRejection } from '../discover/feed-url.js';
import { cleanLabel } from '../discover/text.js';
import { inspectXml } from '../parse/index.js';

/** Largest accepted OPML document, in UTF-8 bytes (spec 03 §11: upload ≤ 1 MiB). */
export const OPML_MAX_BYTES = 1024 * 1024;
/** Deepest accepted element nesting; the root `<opml>` is depth 1 (spec 03 §6 XML safety). */
export const OPML_MAX_DEPTH = 64;
/** Most `<outline>` elements accepted in one document (spec 03 §6 XML safety). */
export const OPML_MAX_OUTLINES = 10_000;

/** A feed subscription found in an OPML document. */
export interface OpmlEntry {
  /** Position of the outline among all `<outline>` elements in document order, from 0. */
  index: number;
  /** Validated fetch URL (`feeds.fetch_url`): the `xmlUrl` with tracking parameters kept. */
  url: string;
  /** Canonical identity (`feeds.url`, spec 03 §5). */
  canonicalUrl: string;
  /** The outline's `text`, else its `title` (cleaned), else `null`. */
  title: string | null;
  /** The outline's `htmlUrl` when it is an http(s) URL without credentials, else `null`. */
  htmlUrl: string | null;
  /** The nearest ancestor outline's `text`, else its `title`; `null` at the top level. */
  folder: string | null;
}

/** Why an outline with an `xmlUrl` was not imported: a `validateFeedUrl` rejection, or empty. */
export type OpmlInvalidReason = FeedUrlRejection | 'missing_url';

export interface OpmlInvalidEntry {
  index: number;
  /** The `xmlUrl` as written, with credentials redacted (`redactFeedUrl`), ≤ 512 chars. */
  url: string;
  reason: OpmlInvalidReason;
}

export interface OpmlDuplicateEntry {
  index: number;
  /** The validated fetch URL of the repeated feed. */
  url: string;
}

export type OpmlImport =
  | {
      ok: true;
      /** Valid feeds in document order, deduplicated by `canonicalUrl` (the first one wins). */
      entries: OpmlEntry[];
      /** Later outlines whose feed was already listed. */
      duplicates: OpmlDuplicateEntry[];
      invalid: OpmlInvalidEntry[];
    }
  | { ok: false; code: 'OPML_INVALID' | 'OPML_TOO_LARGE'; message: string };

export interface ParseOpmlOptions {
  /** `FETCH_ALLOW_PRIVATE` (spec 03 §4.9), passed to `validateFeedUrl`. */
  allowPrivate?: boolean;
}

type OpmlFailure = Extract<OpmlImport, { ok: false }>;

const ATTRIBUTE_PREFIX = '@_';
/** Where fast-xml-parser's `preserveOrder` output keeps an element's attributes. */
const ATTRIBUTES_KEY = ':@';
const TEXT_KEY = '#text';

/**
 * fast-xml-parser under the XML safety rules of spec 03 §6 (DTD declarations are rejected by
 * `inspectXml` before it runs): entity processing off, so nothing is ever expanded even if a
 * declaration slipped through (the five predefined entities and character references are decoded
 * here), no DTD loading, network access or XInclude (the parser has none), values kept as strings
 * and nesting bounded. `preserveOrder` keeps document order and returns the parser's tree without
 * the recursive object conversion.
 */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  allowBooleanAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
  cdataPropName: false,
  maxNestedTags: OPML_MAX_DEPTH,
});

/**
 * OPML import (spec 03 §11, `POST /subscriptions/import-opml`). Pure: no network, no database, and
 * an unsafe or malformed document fails as a whole before the caller mutates anything.
 *
 * - At most {@link OPML_MAX_BYTES} UTF-8 bytes (`OPML_TOO_LARGE`). The caller decodes the upload
 *   (e.g. with `decodeBody`); a leading BOM and whitespace are ignored.
 * - XML safety (spec 03 §6), shared with the feed parser: `inspectXml` rejects `DOCTYPE`,
 *   `ENTITY` and other DTD declarations outside comments and CDATA before any parser runs; the
 *   document must be well-formed XML with one `<opml>` root and a `<body>`; any element nested
 *   deeper than {@link OPML_MAX_DEPTH} levels is rejected (`OPML_INVALID`); more than
 *   {@link OPML_MAX_OUTLINES} outlines is `OPML_TOO_LARGE`. The parser's 2 s CPU deadline needs no
 *   worker thread here: the input is capped at 1 MiB, the scans are linear and nothing expands.
 *   Element and attribute names match case-insensitively.
 * - Every `<outline>` with an `xmlUrl` attribute under `<body>` (recursively, through outlines) is
 *   a feed; outlines without one are folders or notes and are not reported. An empty `xmlUrl` is
 *   invalid (`missing_url`); other URLs are checked by `validateFeedUrl` without network access
 *   (scheme, credentials, credential parameters, port, IP literal, length) and a rejection is
 *   reported as `{index, url, reason}` with the URL redacted. The DNS check happens at first fetch.
 * - Valid feeds are deduplicated by canonical URL (the first wins; later ones are `duplicates`).
 *   Every valid entry is returned: capping at the remaining plan quota is the caller's job.
 */
export function parseOpml(xml: string, options: ParseOpmlOptions = {}): OpmlImport {
  if (xml.length > OPML_MAX_BYTES || Buffer.byteLength(xml, 'utf8') > OPML_MAX_BYTES) {
    return failure('OPML_TOO_LARGE', `The OPML file is larger than ${OPML_MAX_BYTES} bytes`);
  }
  const text = (xml.startsWith(BOM) ? xml.slice(1) : xml).trimStart();
  const safety = inspectXml(text, OPML_MAX_DEPTH);
  if (!safety.ok) {
    return safety.code === 'XML_TOO_DEEP'
      ? tooDeep()
      : failure('OPML_INVALID', 'DOCTYPE and ENTITY declarations are not allowed in OPML');
  }
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    const { line, col } = validation.err;
    return failure(
      'OPML_INVALID',
      `The OPML file is not well-formed XML (line ${line}, column ${col})`,
    );
  }

  let tree: unknown;
  try {
    tree = parser.parse(text);
  } catch (error) {
    return error instanceof Error && error.message.includes('nested')
      ? tooDeep()
      : failure('OPML_INVALID', 'The OPML file cannot be parsed');
  }

  const roots = elementsOf(Array.isArray(tree) ? tree : []);
  const [root] = roots;
  if (roots.length !== 1 || root === undefined || lower(root.name) !== 'opml') {
    return failure('OPML_INVALID', 'The file is not an OPML document');
  }
  const walk = new OutlineWalk(options.allowPrivate === true);
  const result = walk.visitRoot(root);
  if (result !== undefined) return result;
  return { ok: true, entries: walk.entries, duplicates: walk.duplicates, invalid: walk.invalid };
}

const BOM = String.fromCharCode(0xfeff);

interface XmlElement {
  name: string;
  /** Attribute values as written (entities not decoded), keyed by lower-cased name. */
  attributes: ReadonlyMap<string, string>;
  children: readonly unknown[];
}

/** Collects feed outlines in document order while enforcing the depth and count limits. */
class OutlineWalk {
  readonly entries: OpmlEntry[] = [];
  readonly duplicates: OpmlDuplicateEntry[] = [];
  readonly invalid: OpmlInvalidEntry[] = [];
  private readonly seen = new Set<string>();
  private outlines = 0;

  constructor(private readonly allowPrivate: boolean) {}

  /** Depth 1 is `<opml>`; only its first `<body>` holds subscriptions. */
  visitRoot(root: XmlElement): OpmlFailure | undefined {
    let body: XmlElement | undefined;
    for (const child of elementsOf(root.children)) {
      if (body === undefined && lower(child.name) === 'body') {
        body = child;
        const failed = this.visitChildren(child.children, 3, true, null);
        if (failed !== undefined) return failed;
      } else {
        const failed = this.visitElement(child, 2, false, null);
        if (failed !== undefined) return failed;
      }
    }
    return body === undefined
      ? failure('OPML_INVALID', 'The OPML document has no body')
      : undefined;
  }

  private visitChildren(
    children: readonly unknown[],
    depth: number,
    collect: boolean,
    folder: string | null,
  ): OpmlFailure | undefined {
    for (const child of elementsOf(children)) {
      const failed = this.visitElement(child, depth, collect, folder);
      if (failed !== undefined) return failed;
    }
    return undefined;
  }

  /** `collect`: the element is a child of `<body>` or of a collected outline. */
  private visitElement(
    element: XmlElement,
    depth: number,
    collect: boolean,
    folder: string | null,
  ): OpmlFailure | undefined {
    if (depth > OPML_MAX_DEPTH) return tooDeep();
    if (lower(element.name) !== 'outline') {
      return this.visitChildren(element.children, depth + 1, false, null);
    }
    const index = this.outlines;
    this.outlines += 1;
    if (this.outlines > OPML_MAX_OUTLINES) {
      return failure('OPML_TOO_LARGE', `The OPML file has more than ${OPML_MAX_OUTLINES} outlines`);
    }
    if (!collect) return this.visitChildren(element.children, depth + 1, false, null);
    this.collect(element, index, folder);
    return this.visitChildren(element.children, depth + 1, true, labelOf(element));
  }

  private collect(element: XmlElement, index: number, folder: string | null): void {
    const rawUrl = element.attributes.get('xmlurl');
    if (rawUrl === undefined) return;
    const url = decodeXmlText(rawUrl).trim();
    if (url === '') {
      this.invalid.push({ index, url: '', reason: 'missing_url' });
      return;
    }
    const check = validateFeedUrl(url, { allowPrivate: this.allowPrivate });
    if (!check.ok) {
      this.invalid.push({ index, url: redactFeedUrl(url), reason: check.reason });
      return;
    }
    if (this.seen.has(check.canonicalUrl)) {
      this.duplicates.push({ index, url: check.fetchUrl });
      return;
    }
    this.seen.add(check.canonicalUrl);
    this.entries.push({
      index,
      url: check.fetchUrl,
      canonicalUrl: check.canonicalUrl,
      title: labelOf(element),
      htmlUrl: htmlUrlOf(element),
      folder,
    });
  }
}

/** The elements among `preserveOrder` nodes (`{name: children, ':@': attributes}`). */
function elementsOf(nodes: readonly unknown[]): XmlElement[] {
  const elements: XmlElement[] = [];
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const record = node as Record<string, unknown>;
    const name = Object.keys(record).find((key) => key !== ATTRIBUTES_KEY && key !== TEXT_KEY);
    if (name === undefined) continue;
    const children = record[name];
    elements.push({
      name,
      attributes: attributesOf(record[ATTRIBUTES_KEY]),
      children: Array.isArray(children) ? children : [],
    });
  }
  return elements;
}

function attributesOf(raw: unknown): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  if (typeof raw !== 'object' || raw === null) return attributes;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith(ATTRIBUTE_PREFIX) || typeof value !== 'string') continue;
    const name = lower(key.slice(ATTRIBUTE_PREFIX.length));
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/** An outline's label: `text`, else `title` (spec 03 §11 folder rule), cleaned. */
function labelOf(element: XmlElement): string | null {
  return (
    cleanLabel(decodeOptional(element.attributes.get('text'))) ??
    cleanLabel(decodeOptional(element.attributes.get('title')))
  );
}

const MAX_HTML_URL_BYTES = 2048;

function htmlUrlOf(element: XmlElement): string | null {
  const raw = element.attributes.get('htmlurl');
  if (raw === undefined) return null;
  const url = URL.parse(decodeXmlText(raw).trim());
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.username !== '' || url.password !== '') return null;
  return Buffer.byteLength(url.href, 'utf8') <= MAX_HTML_URL_BYTES ? url.href : null;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const XML_REFERENCE = /&(?:#(\d+)|#x([\da-fA-F]+)|(amp|lt|gt|quot|apos));/g;

/**
 * Decodes the XML predefined entities and character references of an attribute value. A reference
 * to a character XML forbids is dropped; any other `&…;` (an undeclared entity) stays as written.
 */
function decodeXmlText(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(
    XML_REFERENCE,
    (match, decimal?: string, hex?: string, name?: string): string => {
      if (name !== undefined) return PREDEFINED_ENTITIES[name] ?? match;
      const codePoint =
        decimal === undefined ? Number.parseInt(hex ?? '', 16) : Number.parseInt(decimal, 10);
      return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : '';
    },
  );
}

function decodeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : decodeXmlText(value);
}

/** XML 1.0 `Char` production. */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function lower(value: string): string {
  return value.toLowerCase();
}

function tooDeep(): OpmlFailure {
  return failure('OPML_INVALID', `The OPML file is nested deeper than ${OPML_MAX_DEPTH} levels`);
}

function failure(code: OpmlFailure['code'], message: string): OpmlFailure {
  return { ok: false, code, message };
}
