/** Longest label (feed title, folder name) kept from discovery or OPML input, in code points. */
export const MAX_LABEL_CHARS = 500;

/**
 * Invisible characters removed from labels: C0/C1 controls other than whitespace, U+FFFE/U+FFFF
 * and lone surrogates (XML forbids them and PostgreSQL `text` cannot store all of them).
 */
const INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the purpose
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A display label from untrusted text (a `<link title>`, a feed title, an OPML `text`/`title`):
 * invisible characters removed, whitespace collapsed and trimmed, at most {@link MAX_LABEL_CHARS}
 * code points (a surrogate pair is never split). Empty → `null`.
 */
export function cleanLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  if (cleaned.length <= MAX_LABEL_CHARS) return cleaned;
  const codePoints = Array.from(cleaned);
  return codePoints.length <= MAX_LABEL_CHARS
    ? cleaned
    : codePoints.slice(0, MAX_LABEL_CHARS).join('').trimEnd();
}

/** The lower-cased media type of a `Content-Type` or `type` attribute value, without parameters. */
export function mediaTypeOf(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
