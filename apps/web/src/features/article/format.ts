export { formatRelativeTime } from '../../i18n/dates.js';

const numberFormats = new Map<string, Intl.NumberFormat>();

function cached<T>(cache: Map<string, T>, language: string, create: () => T): T {
  let format = cache.get(language);
  if (format === undefined) {
    format = create();
    cache.set(language, format);
  }
  return format;
}

/** A probability with two decimals, "0.91" or "0,91" by language. */
export function formatProbability(p: number, language: string): string {
  return cached(
    numberFormats,
    language,
    () => new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ).format(p);
}
