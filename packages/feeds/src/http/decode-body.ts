import chardet from 'chardet';
import iconv from 'iconv-lite';

/** Decoded text and the encoding used, or `FEED_DECODE_ERROR` (spec 03 §4 "Charset decoding"). */
export type DecodeResult =
  | { ok: true; text: string; encoding: string }
  | { ok: false; code: 'FEED_DECODE_ERROR'; message: string };

/** XML and HTML charset declarations are searched in the first 2 KiB (spec 03 §4). */
export const DECLARATION_PROBE_BYTES = 2048;
/** An undeclared document with more U+FFFD than this share after UTF-8 decoding is sniffed. */
export const REPLACEMENT_RATIO_LIMIT = 0.005;
/** `chardet` looks at most at this many bytes. */
const CHARDET_SAMPLE_BYTES = 256 * 1024;

/** Labels iconv-lite knows but a document must never select (WHATWG: UTF-7 is not decodable). */
const UNSAFE_LABELS = new Set([
  'utf7',
  'utf7imap',
  'unicode11utf7',
  'csunicode11utf7',
  'base64',
  'hex',
]);

/** WHATWG Encoding Standard labels of windows-1252 that iconv-lite maps to strict ISO-8859-1/ASCII. */
const WINDOWS_1252_LABELS = new Set([
  'ansix341968',
  'ascii',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso88591',
  'isoir100',
  'l1',
  'latin1',
  'usascii',
]);

/** iconv-lite's own label canonicalization: lower case, trailing `:YYYY` and punctuation dropped. */
const canonicalLabel = (label: string): string =>
  label.toLowerCase().replace(/:\d{4}$|[^0-9a-z]/g, '');

const isWideUnicode = (label: string): boolean =>
  /^(?:utf16|utf32|ucs2|ucs4|unicode)/.test(canonicalLabel(label));

/**
 * The encoding to decode a charset `label` with, through iconv-lite's own alias table
 * (`windows-1250`, `cp1250`, `iso-8859-2`, `latin2`, `utf8`, …), or undefined when it is unknown
 * or unsafe (UTF-7 and binary-to-text pseudo-encodings). ISO-8859-1 and ASCII labels decode as
 * windows-1252, as the WHATWG Encoding Standard prescribes, so C1 bytes become the curly quotes
 * and dashes publishers meant.
 */
export function supportedEncoding(label: string | null | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const trimmed = label
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
    .toLowerCase();
  if (trimmed === '' || trimmed.length > 40) return undefined;
  const canonical = canonicalLabel(trimmed);
  if (canonical === '' || UNSAFE_LABELS.has(canonical)) return undefined;
  const chosen = WINDOWS_1252_LABELS.has(canonical) ? 'windows-1252' : trimmed;
  return iconv.encodingExists(chosen) ? chosen : undefined;
}

function parseMediaType(contentType: string | undefined): { type: string; charset?: string } {
  if (contentType === undefined) return { type: '' };
  const [type = '', ...parameters] = contentType.split(';');
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator === -1 || parameter.slice(0, separator).trim().toLowerCase() !== 'charset') {
      continue;
    }
    const value = parameter.slice(separator + 1).trim();
    const unquoted =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;
    return { type: type.trim().toLowerCase(), charset: unquoted.trim() };
  }
  return { type: type.trim().toLowerCase() };
}

/** JSON (and JSON Feed) is always UTF-8 (RFC 8259 §8.1). */
const isJsonType = (type: string): boolean =>
  type === 'application/json' || type === 'text/json' || type.endsWith('+json');

function detectBom(bytes: Buffer): 'utf-8' | 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return undefined;
}

/**
 * The byte signature of BOM-less UTF-16 markup (XML 1.0 Appendix F): two ASCII characters such as
 * `<?` (`3C 00 3F 00`) with zero high bytes.
 */
function detectUtf16Signature(bytes: Buffer): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes.length < 4) return undefined;
  const [b0, b1, b2, b3] = bytes;
  if (b0 !== 0 && b1 === 0 && b2 !== 0 && b3 === 0) return 'utf-16le';
  if (b0 === 0 && b1 !== 0 && b2 === 0 && b3 !== 0) return 'utf-16be';
  return undefined;
}

const XML_DECLARATION = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*(["'])\s*([^"'\s]+)\s*\1/i;
const META_CHARSET = /<meta\s[^>]*?\bcharset\s*=\s*["']?\s*([^"'\s;/>]+)/i;

/** The charset of an XML declaration, else of an HTML `<meta charset>` / `http-equiv` tag. */
function findDeclaredCharset(probe: string): string | undefined {
  return XML_DECLARATION.exec(probe)?.[2] ?? META_CHARSET.exec(probe)?.[1];
}

function decodeAs(bytes: Buffer, encoding: string): DecodeResult {
  if (!iconv.encodingExists(encoding)) {
    return { ok: false, code: 'FEED_DECODE_ERROR', message: 'unsupported character encoding' };
  }
  // iconv-lite strips a leading BOM only (BOM-aware codecs); a U+FEFF inside the text stays.
  return { ok: true, text: iconv.decode(bytes, encoding), encoding };
}

function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let replacements = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) replacements += 1;
  }
  return replacements / text.length;
}

/** Spec 03 §4 step 3: UTF-8 unless it is clearly wrong; then `chardet`, which must be supported. */
function decodeUndeclared(bytes: Buffer): DecodeResult {
  const utf8 = iconv.decode(bytes, 'utf-8');
  if (replacementRatio(utf8) <= REPLACEMENT_RATIO_LIMIT) {
    return { ok: true, text: utf8, encoding: 'utf-8' };
  }
  const detected = chardet.detect(bytes.subarray(0, CHARDET_SAMPLE_BYTES));
  const encoding = supportedEncoding(detected);
  if (encoding === undefined) {
    const shown = detected !== null && /^[\w.:-]{1,40}$/.test(detected) ? ` ${detected}` : '';
    return {
      ok: false,
      code: 'FEED_DECODE_ERROR',
      message:
        detected === null
          ? 'the character encoding cannot be detected'
          : `unsupported character encoding${shown}`,
    };
  }
  return decodeAs(bytes, encoding);
}

/**
 * Decodes a fetched body to text (spec 03 §4 "Charset decoding"). JSON content types are UTF-8.
 * Otherwise, in this order: a supported charset from `contentType`; a UTF-8/UTF-16 BOM; a BOM-less
 * UTF-16 byte signature (so UTF-16 XML is never mistaken for an empty document; a declaration
 * inside it can only name UTF-16 itself); the XML declaration or HTML `<meta charset>` /
 * `http-equiv` Content-Type within the first 2 KiB (a UTF-16/32 label there is impossible in an
 * ASCII-compatible document and means UTF-8, as in the HTML prescan); then UTF-8. Unknown or
 * unsupported labels are ignored at every step. Only such undeclared documents are sniffed: when
 * UTF-8 yields more than 0.5 % U+FFFD, `chardet` picks the encoding, and an unsupported result is
 * `FEED_DECODE_ERROR`. Decoding uses iconv-lite and strips only a leading BOM.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): DecodeResult {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const media = parseMediaType(contentType);
    if (isJsonType(media.type)) return decodeAs(buffer, 'utf-8');
    const fromHttp = supportedEncoding(media.charset);
    if (fromHttp !== undefined) return decodeAs(buffer, fromHttp);
    const bom = detectBom(buffer);
    if (bom !== undefined) return decodeAs(buffer, bom);
    const signature = detectUtf16Signature(buffer);
    if (signature !== undefined) return decodeAs(buffer, signature);
    const probe = buffer.subarray(0, DECLARATION_PROBE_BYTES).toString('latin1');
    const declared = supportedEncoding(findDeclaredCharset(probe));
    if (declared !== undefined)
      return decodeAs(buffer, isWideUnicode(declared) ? 'utf-8' : declared);
    return decodeUndeclared(buffer);
  } catch {
    return { ok: false, code: 'FEED_DECODE_ERROR', message: 'the body cannot be decoded' };
  }
}
