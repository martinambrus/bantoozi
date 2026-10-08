import { useTranslation } from 'react-i18next';

import { useMe } from '../../session/context.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(language: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${language}|${timeZone}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
    try {
      formatter = new Intl.DateTimeFormat(language, { ...options, timeZone });
    } catch {
      // A time zone this browser does not know: the device's own is better than a broken page.
      formatter = new Intl.DateTimeFormat(language, options);
    }
    formatters.set(key, formatter);
  }
  return formatter;
}

/** A moment in the reader's language and the time zone chosen for the account (spec 02). */
export function Time({ value }: { value: string }) {
  const { i18n } = useTranslation();
  const { timezone } = useMe();
  return (
    <time dateTime={value}>{formatterFor(i18n.language, timezone).format(new Date(value))}</time>
  );
}
