import { PARSE_LIMITS } from './limits.js';

/** Result of {@link inspectXml}. */
export type XmlSafetyResult =
  | { ok: true; maxDepth: number }
  | { ok: false; code: 'XML_DECLARATION_FORBIDDEN' | 'XML_TOO_DEEP'; message: string };

/** Markup declarations that only occur in a DTD. */
const DECLARATIONS = new Set(['DOCTYPE', 'ENTITY', 'ELEMENT', 'ATTLIST', 'NOTATION']);

/**
 * The structural safety check that runs before any XML parser and before the lenient pass
 * (spec 03 §6, §11): rejects `DOCTYPE`/`ENTITY` (and other DTD) declarations outside CDATA sections
 * and comments, and element nesting deeper than `maxDepth` (default 64). A linear scan that never
 * resolves entities or loads anything; parser errors in malformed input are left to the parser.
 * Shared by the feed and OPML parsers.
 */
export function inspectXml(
  text: string,
  maxDepth: number = PARSE_LIMITS.maxXmlDepth,
): XmlSafetyResult {
  let depth = 0;
  let deepest = 0;
  let i = 0;
  for (;;) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    const next = text.charAt(open + 1);
    if (next === '!') {
      if (text.startsWith('<!--', open)) {
        const end = text.indexOf('-->', open + 4);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', open)) {
        const end = text.indexOf(']]>', open + 9);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      const keyword = /^<!([A-Za-z]+)/.exec(text.slice(open, open + 12))?.[1]?.toUpperCase();
      if (keyword !== undefined && DECLARATIONS.has(keyword)) {
        return {
          ok: false,
          code: 'XML_DECLARATION_FORBIDDEN',
          message: `XML ${keyword} declarations are not allowed`,
        };
      }
      i = open + 2;
      continue;
    }
    if (next === '?') {
      const end = text.indexOf('?>', open + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (next === '/') {
      depth = Math.max(0, depth - 1);
      i = open + 2;
      continue;
    }
    if (!/[\p{L}_:]/u.test(next)) {
      i = open + 1;
      continue;
    }
    // A start tag: find its end, skipping quoted attribute values (which may contain `>`).
    let j = open + 1;
    let quote = '';
    for (; j < text.length; j += 1) {
      const c = text.charAt(j);
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>' || c === '<') {
        break;
      }
    }
    if (j >= text.length) break;
    if (text.charAt(j) === '>' && text.charAt(j - 1) !== '/') {
      depth += 1;
      if (depth > maxDepth) {
        return {
          ok: false,
          code: 'XML_TOO_DEEP',
          message: `XML nesting exceeds ${maxDepth} levels`,
        };
      }
      deepest = Math.max(deepest, depth);
    }
    i = j + (text.charAt(j) === '>' ? 1 : 0);
  }
  return { ok: true, maxDepth: deepest };
}
