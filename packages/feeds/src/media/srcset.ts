/** ASCII whitespace of the HTML standard: TAB, LF, FF, CR and SPACE. */
const ASCII_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' ']);

/**
 * The candidate URLs of a `srcset` value in order, split as the HTML standard's "parse a srcset
 * attribute" algorithm does: candidates are separated by commas, a URL runs to the next ASCII
 * whitespace (so commas inside a URL, as in `…/w_400,h_300/a.jpg 400w`, are kept, and trailing
 * commas are dropped), and a comma inside parentheses does not end a descriptor list. Descriptors
 * are skipped without validation; only the URLs matter here (spec 03 §6.4).
 */
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  const length = value.length;
  let position = 0;
  for (;;) {
    while (
      position < length &&
      (ASCII_WHITESPACE.has(value[position] ?? '') || value[position] === ',')
    ) {
      position += 1;
    }
    if (position >= length) return urls;
    const start = position;
    while (position < length && !ASCII_WHITESPACE.has(value[position] ?? '')) position += 1;
    let url = value.slice(start, position);
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      position = skipDescriptors(value, position);
    }
    if (url !== '') urls.push(url);
  }
}

/** The position after the descriptors of one candidate and the comma that ends them. */
function skipDescriptors(value: string, from: number): number {
  let inParens = false;
  for (let position = from; position < value.length; position += 1) {
    const char = value[position];
    if (inParens) {
      if (char === ')') inParens = false;
    } else if (char === '(') {
      inParens = true;
    } else if (char === ',') {
      return position + 1;
    }
  }
  return value.length;
}
