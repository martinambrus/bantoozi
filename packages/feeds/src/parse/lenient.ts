import { feedKindOfRoot, rootElement } from './sniff.js';
import { XML_FORBIDDEN_CHARS } from './text.js';

/** Leading junk (e.g. PHP warnings) is only removed within this many characters of the start. */
export const LENIENT_JUNK_WINDOW = 4096;

/**
 * Named entities the XML parser (sax, via rss-parser/xml2js) resolves: the five XML entities plus
 * the HTML 4 set. Any other `&name;` is not an existing valid entity.
 */
const KNOWN_ENTITIES = new Set(
  (
    'amp gt lt quot apos AElig Aacute Acirc Agrave Aring Atilde Auml Ccedil ETH Eacute Ecirc ' +
    'Egrave Euml Iacute Icirc Igrave Iuml Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml THORN ' +
    'Uacute Ucirc Ugrave Uuml Yacute aacute acirc aelig agrave aring atilde auml ccedil eacute ' +
    'ecirc egrave eth euml iacute icirc igrave iuml ntilde oacute ocirc ograve oslash otilde ouml ' +
    'szlig thorn uacute ucirc ugrave uuml yacute yuml copy reg nbsp iexcl cent pound curren yen ' +
    'brvbar sect uml ordf laquo not shy macr deg plusmn sup1 sup2 sup3 acute micro para middot ' +
    'cedil ordm raquo frac14 frac12 frac34 iquest times divide OElig oelig Scaron scaron Yuml fnof ' +
    'circ tilde Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron ' +
    'Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota ' +
    'kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega thetasym ' +
    'upsih piv ensp emsp thinsp zwnj zwj lrm rlm ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo ' +
    'dagger Dagger bull hellip permil prime Prime lsaquo rsaquo oline frasl euro image weierp real ' +
    'trade alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall part exist empty ' +
    'nabla isin notin ni prod sum minus lowast radic prop infin ang and or cap cup int there4 sim ' +
    'cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot lceil rceil lfloor ' +
    'rfloor lang rang loz spades clubs hearts diams'
  ).split(' '),
);

/**
 * CDATA sections, comments and processing instructions (left untouched), or an ampersand with the
 * reference that may follow it.
 */
const AMPERSAND_SCAN =
  /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|&(?:#x([0-9a-fA-F]{1,6});|#([0-9]{1,7});|([A-Za-z_:][\w.:-]{0,63});)?/g;

function isValidReference(hex?: string, decimal?: string, name?: string): boolean {
  if (hex !== undefined || decimal !== undefined) {
    const codePoint = hex === undefined ? Number(decimal) : parseInt(hex, 16);
    return codePoint >= 1 && codePoint <= 0x10ffff;
  }
  return name !== undefined && (KNOWN_ENTITIES.has(name) || KNOWN_ENTITIES.has(name.toLowerCase()));
}

/** Escapes every `&` that does not start a valid entity or character reference. */
function fixBareAmpersands(text: string): string {
  return text.replace(
    AMPERSAND_SCAN,
    (match, hex?: string, decimal?: string, name?: string): string => {
      if (!match.startsWith('&')) return match;
      if (match === '&' || !isValidReference(hex, decimal, name)) return `&amp;${match.slice(1)}`;
      return match;
    },
  );
}

/**
 * Removes a byte order mark and bounded leading junk before the XML (spec 03 §6): when the
 * document does not start with a feed root, cut to the first `<?xml` or feed root element found
 * within {@link LENIENT_JUNK_WINDOW} characters that is followed by a feed root.
 */
export function stripLeadingJunk(text: string): string {
  const value = text.replace(/^[\s\uFEFF]+/, '');
  if (feedKindOfRoot(rootElement(value, 0).name) !== null) return value;
  const window = value.slice(0, LENIENT_JUNK_WINDOW);
  const candidate = /<\?xml[\s?]|<(?:rss|feed|rdf:RDF)[\s>/]/g;
  for (const match of window.matchAll(candidate)) {
    const rest = value.slice(match.index).replace(/^\uFEFF+/, '');
    if (feedKindOfRoot(rootElement(rest, 0).name) !== null) return rest;
  }
  return value;
}

/**
 * The single lenient cleanup pass for malformed XML (spec 03 §6), applied before one retry:
 * 1. remove a byte order mark and bounded leading junk before the root ({@link stripLeadingJunk});
 * 2. strip XML-forbidden control characters and lone surrogates;
 * 3. escape bare `&` outside CDATA sections, comments and processing instructions — every `&`
 *    that does not start a valid character reference or an entity the parser knows.
 *
 * It never removes markup and never touches the XML declaration, so the chosen encoding is kept.
 */
export function lenientXmlCleanup(text: string): string {
  return fixBareAmpersands(stripLeadingJunk(text).replace(XML_FORBIDDEN_CHARS, ''));
}
