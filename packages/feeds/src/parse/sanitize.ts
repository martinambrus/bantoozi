import sanitize from 'sanitize-html';

import { PARSE_LIMITS } from './limits.js';
import { charLength, stripControlChars, utf8Length } from './text.js';
import { resolveHttpUrl } from './urls.js';

/** The display allow-list of spec 03 §6.3 (`img` only when images are kept). */
const DISPLAY_TAGS = [
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h2',
  'h3',
  'h4',
  'img',
  'figure',
  'figcaption',
];

/**
 * Disallowed elements whose content is dropped too, not just the tag: active or embedded content
 * (scripts, frames, objects, forms), raw-text elements whose text would otherwise leak as escaped
 * markup, and non-content such as `<head>`, `<title>` and `<noscript>` fallbacks.
 */
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'select',
  'button',
  'form',
  'xmp',
  'plaintext',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'canvas',
  'map',
  'svg',
  'math',
  'template',
  'head',
  'title',
];

/**
 * Block containers outside the allow-list. Their tags are dropped, but each becomes a line break,
 * so the text of adjacent blocks does not run together.
 */
const BLOCK_CONTAINERS = [
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'address',
  'center',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'hr',
  'hgroup',
  'fieldset',
  'legend',
];

/** Headings outside the allow-list map to the nearest allowed level. */
const HEADINGS: Readonly<Record<string, string>> = { h1: 'h2', h5: 'h4', h6: 'h4' };

/** `rel` of every kept link (spec 03 §6.3). */
export const SANITIZED_LINK_REL = 'noopener noreferrer nofollow';

export interface SanitizeHtmlOptions {
  /**
   * Keep safe, non-pixel `<img>` elements (`src` resolved, `alt` kept). Default `false`: for the
   * beta, embedded images are removed from stored display HTML (spec 03 §6.3).
   */
  keepImages?: boolean | undefined;
}

/** Result of {@link sanitizeContent}. */
export interface SanitizedContent {
  /** Sanitized display HTML. */
  html: string;
  /** The first `<img src>` that resolves to http(s) and is not a tracking pixel, or `null`. */
  firstImageUrl: string | null;
}

const PIXEL_MAX = 2;
const NUMERIC_DIMENSION = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;

function parseDimension(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = NUMERIC_DIMENSION.exec(value.replace(/!important/i, ''));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Whether an `<img>` is a tracking pixel (spec 03 §6.3): judged from the source `width`/`height`
 * attributes and inline `style` before those are stripped. Either known dimension ≤ 2 px, or
 * `display:none`/`visibility:hidden`, marks a pixel.
 */
export function isTrackingPixel(attribs: Readonly<Record<string, string | undefined>>): boolean {
  const dimensions = [parseDimension(attribs['width']), parseDimension(attribs['height'])];
  for (const declaration of (attribs['style'] ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (/^(?:max-)?(?:width|height)$/.test(property)) dimensions.push(parseDimension(value));
    if (property === 'display' && value.startsWith('none')) return true;
    if (property === 'visibility' && value.startsWith('hidden')) return true;
  }
  return dimensions.some((d) => d !== null && d <= PIXEL_MAX);
}

/**
 * An allowed element with nothing but whitespace and line breaks inside (a link or figure that
 * only wrapped a removed image, an empty paragraph). The sanitized output is well-formed, so the
 * innermost such elements can be matched and removed repeatedly.
 */
const EMPTY_ELEMENT =
  /<(p|b|strong|i|em|u|a|ul|ol|li|blockquote|code|pre|h2|h3|h4|figure|figcaption)(?:\s[^>]*)?>(?:\s|<br \/>)*<\/\1>/g;

/**
 * Collapses whitespace runs that contain a line break to one line break, except inside `<pre>`:
 * elsewhere such runs render as one space, so this only removes the gaps left by dropped markup.
 */
function tidyLineBreaks(html: string): string {
  return html
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part) => (part.startsWith('<pre>') ? part : part.replace(/[^\S\n]*\n\s*/g, '\n')))
    .join('');
}

function dropEmptyElements(html: string): string {
  let previous: string;
  let output = html;
  do {
    previous = output;
    output = output.replace(EMPTY_ELEMENT, '');
  } while (output !== previous);
  return output;
}

/**
 * Sanitizes untrusted HTML for display (spec 03 §6.3) and reports the first usable image:
 * - allow-list tags `p, br, b, strong, i, em, u, a, ul, ol, li, blockquote, code, pre, h2, h3, h4,
 *   img, figure, figcaption`; attributes `a[href]`, `img[src|alt]`
 * - `href`/`src` are resolved against `baseUrl` and must be http(s); `a` gets
 *   `rel="noopener noreferrer nofollow" target="_blank"`, and a link without a usable `href`
 *   (e.g. `javascript:`) is unwrapped to its text
 * - `srcset`, inline styles, classes and event handlers never survive; scripts, styles, frames,
 *   objects, forms and SVG are removed with their content
 * - tracking pixels are detected before attributes are stripped; by default every embedded image is
 *   removed and only `firstImageUrl` is kept as metadata
 * - `h1`→`h2`, `h5`/`h6`→`h4`; other block containers become line breaks; elements left without
 *   content are dropped; nesting is limited to 64 levels
 */
export function sanitizeContent(
  html: string,
  baseUrl: string,
  options: SanitizeHtmlOptions = {},
): SanitizedContent {
  const keepImages = options.keepImages === true;
  let firstImageUrl: string | null = null;

  // Transforms only ever produce allowed tags: sanitize-html leaks the transform of a tag it then
  // discards into the closing tag of the next sibling. Unusable links and images keep their allowed
  // name without attributes and are unwrapped or dropped by the exclusive filter below. Empty
  // elements are removed afterwards, because an unwrapped link's text never reaches its ancestors'
  // `frame.text`.
  const transformTags: Record<string, string | sanitize.Transformer> = {
    ...HEADINGS,
    ...Object.fromEntries(BLOCK_CONTAINERS.map((tag) => [tag, 'br'])),
    a: (tagName, attribs) => {
      const href = attribs['href'] === undefined ? null : resolveHttpUrl(attribs['href'], baseUrl);
      return {
        tagName,
        attribs: href === null ? {} : { href, rel: SANITIZED_LINK_REL, target: '_blank' },
      };
    },
  };
  if (keepImages) {
    transformTags['img'] = (tagName, attribs) => {
      const src = attribs['src'] === undefined ? null : resolveHttpUrl(attribs['src'], baseUrl);
      if (src === null || isTrackingPixel(attribs)) return { tagName, attribs: {} };
      const alt = attribs['alt'];
      return { tagName, attribs: alt === undefined ? { src } : { src, alt } };
    };
  }

  let output = sanitize(html, {
    allowedTags: keepImages ? DISPLAY_TAGS : DISPLAY_TAGS.filter((tag) => tag !== 'img'),
    allowedAttributes: { a: ['href', 'rel', 'target'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: NON_TEXT_TAGS,
    parseStyleAttributes: false,
    nestingLimit: PARSE_LIMITS.maxXmlDepth,
    transformTags,
    onOpenTag: (name, attribs) => {
      if (name !== 'img' || firstImageUrl !== null || attribs['src'] === undefined) return;
      const src = resolveHttpUrl(attribs['src'], baseUrl);
      if (src !== null && !isTrackingPixel(attribs)) firstImageUrl = src;
    },
    exclusiveFilter: (frame) => {
      // A link without a usable href is unwrapped to its text.
      if (frame.tag === 'a' && frame.attribs['href'] === undefined) return 'excludeTag';
      return frame.tag === 'img' && frame.attribs['src'] === undefined;
    },
  });

  output = tidyLineBreaks(dropEmptyElements(stripControlChars(output)))
    .replace(/(?:<br \/>\s*){3,}/g, '<br /><br />')
    .replace(/^(?:\s*<br \/>)+/, '')
    .replace(/(?:<br \/>\s*)+$/, '')
    .trim();
  return { html: output, firstImageUrl };
}

/**
 * The spec 03 §6.3 allow-list sanitizer. Also used for extracted article bodies (M1-T5). See
 * {@link sanitizeContent} for the rules; images are removed unless `options.keepImages` is set.
 */
export function sanitizeHtml(html: string, baseUrl: string, options?: SanitizeHtmlOptions): string {
  return sanitizeContent(html, baseUrl, options).html;
}

/** Elements that end a paragraph in plain text. */
const TEXT_PARAGRAPH_TAGS = [
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'address',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'dl',
  'table',
  'caption',
  'hr',
  'details',
  'summary',
  'fieldset',
  'center',
  'hgroup',
];
const TEXT_LINE_TAGS = ['br', 'li', 'dt', 'dd', 'tr'];
const TEXT_CELL_TAGS = ['td', 'th'];

const TEXT_BREAKS: ReadonlyMap<string, string> = new Map([
  ...TEXT_PARAGRAPH_TAGS.map((tag) => [tag, '\n\n'] as const),
  ...TEXT_LINE_TAGS.map((tag) => [tag, '\n'] as const),
  ...TEXT_CELL_TAGS.map((tag) => [tag, ' '] as const),
]);

const SKELETON_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  amp: '&',
};

/** A tag of the text skeleton: paragraph tags break on both sides, line and cell tags on open. */
function skeletonBreak(closing: string, name: string): string {
  const separator = TEXT_BREAKS.get(name) ?? '';
  return closing === '' || separator === '\n\n' ? separator : '';
}

/**
 * Text of markup whose every `<` starts a tag and whose only character references are
 * `&amp; &lt; &gt; &quot;` (sanitize-html output): tags become breaks, source whitespace collapses
 * as in a browser except inside `<pre>`, and runs of blank lines are limited to one.
 */
function markupToText(markup: string): string {
  const text = stripControlChars(markup)
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part) => {
      const preformatted = part.startsWith('<pre>');
      const value = (preformatted ? part.replace(/\r\n?/g, '\n') : part.replace(/\s+/g, ' '))
        .replace(/<(\/?)([a-z0-9]+)[^>]*>/g, (_tag, closing: string, name: string) =>
          skeletonBreak(closing, name),
        )
        .replace(/&(lt|gt|quot|amp);/g, (_entity, name: string) => SKELETON_ENTITIES[name] ?? '');
      // `<pre>` parts start and end with a paragraph break, so their neighbours can be trimmed.
      return preformatted
        ? value
        : value
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            .trim();
    })
    .join('');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Plain text of an HTML fragment: tags removed, every HTML entity decoded, scripts/styles and other
 * non-text elements dropped, source whitespace collapsed as a browser would (except inside `<pre>`),
 * block boundaries kept as blank lines (`\n\n`) and line breaks (`\n`), control characters
 * removed. Titles and excerpts collapse the result further to one line.
 */
export function htmlToText(html: string): string {
  // Reduce the document to bare, attribute-free break tags and escaped text first.
  return markupToText(
    sanitize(html, {
      allowedTags: [...TEXT_BREAKS.keys()],
      allowedAttributes: {},
      disallowedTagsMode: 'discard',
      nonTextTags: NON_TEXT_TAGS,
      parseStyleAttributes: false,
    }),
  );
}

/**
 * {@link htmlToText} of HTML that {@link sanitizeContent} produced, without parsing it again:
 * linear even for entity-dense bodies of several MiB.
 */
export function sanitizedHtmlToText(html: string): string {
  return markupToText(html);
}

/** Converts plain text to HTML paragraphs (`<p>`, single line breaks as `<br>`), escaped. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[^\S\n]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeForHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function escapeForHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** How {@link truncateHtml} measures length: Unicode code points or UTF-8 bytes. */
export type HtmlLengthUnit = 'chars' | 'utf8';

function measure(value: string, unit: HtmlLengthUnit): number {
  return unit === 'chars' ? charLength(value) : utf8Length(value);
}

/** Length (UTF-16 units) of the longest prefix of `text` within `room` units. */
function prefixEnd(text: string, room: number, unit: HtmlLengthUnit): number {
  if (unit === 'utf8') {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= room) return text.length;
    let prefix = bytes.subarray(0, Math.max(0, room)).toString('utf8');
    // A cut inside a multi-byte sequence decodes to a trailing U+FFFD: drop that partial char.
    if (!text.startsWith(prefix)) prefix = prefix.slice(0, -1);
    return prefix.length;
  }
  let end = 0;
  for (let used = 0; end < text.length && used < room; used += 1) {
    const codePoint = text.codePointAt(end) ?? 0;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

/** Longest prefix of `text` within `room`, never inside an entity, preferring a word boundary. */
function cutText(text: string, room: number, unit: HtmlLengthUnit): string {
  let end = prefixEnd(text, room, unit);
  const amp = text.lastIndexOf('&', end - 1);
  if (amp >= 0) {
    const semicolon = text.indexOf(';', amp);
    if (semicolon >= end) end = amp;
  }
  // Back off to a word boundary unless the cut already falls on one.
  if (end < text.length && !/\s/.test(text.charAt(end))) {
    const lastSpace = text.slice(0, end).search(/\s\S*$/);
    if (lastSpace > 0 && end - lastSpace <= 80) end = lastSpace;
  }
  return text.slice(0, end).trimEnd();
}

const HTML_TOKEN = /<[^>]*>|[^<]+/g;
const TAG_NAME = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;
const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr']);
const TRAILING_EMPTY_ELEMENT = /<([a-z0-9]+)(?:\s[^>]*)?>\s*<\/\1>\s*$/;

/**
 * Truncates sanitized HTML to at most `max` units without cutting through markup: whole tags only,
 * text cut outside entities (at a word boundary when one is near), open elements closed, and empty
 * trailing elements removed (spec 03 §6 `excerpt_html`, §8.1 "well-formed truncation").
 */
export function truncateHtml(
  html: string,
  max: number,
  unit: HtmlLengthUnit = 'chars',
): { html: string; truncated: boolean } {
  if (measure(html, unit) <= max) return { html, truncated: false };
  const stack: string[] = [];
  let output = '';
  // Invariant: used + closingCost <= max, where closingCost is the cost of closing every open tag.
  let used = 0;
  let closingCost = 0;
  for (const match of html.matchAll(HTML_TOKEN)) {
    const token = match[0];
    const tag = TAG_NAME.exec(token);
    if (tag === null) {
      const cost = measure(token, unit);
      if (used + cost + closingCost <= max) {
        output += token;
        used += cost;
        continue;
      }
      output += cutText(token, max - used - closingCost, unit);
      break;
    }
    const name = (tag[2] ?? '').toLowerCase();
    if (tag[1] === '/') {
      const at = stack.lastIndexOf(name);
      while (at >= 0 && stack.length > at) {
        const close = `</${stack.pop() ?? ''}>`;
        const cost = measure(close, unit);
        output += close;
        used += cost;
        closingCost -= cost;
      }
      continue;
    }
    const isVoid = VOID_TAGS.has(name) || token.endsWith('/>');
    const cost = measure(token, unit);
    const closeCost = isVoid ? 0 : measure(`</${name}>`, unit);
    if (used + cost + closeCost + closingCost > max) break;
    output += token;
    used += cost;
    if (!isVoid) {
      stack.push(name);
      closingCost += closeCost;
    }
  }
  output = output.trimEnd();
  while (stack.length > 0) output += `</${stack.pop() ?? ''}>`;
  let previous: string;
  do {
    previous = output;
    output = output.replace(TRAILING_EMPTY_ELEMENT, '');
  } while (output !== previous);
  return { html: output.trimEnd(), truncated: true };
}
