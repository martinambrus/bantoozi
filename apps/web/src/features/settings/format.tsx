import { useCallback } from 'react';
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

/** Prints a moment in the reader's language and the time zone chosen for the account (spec 02). */
export function useMoment(): (iso: string) => string {
  const { i18n } = useTranslation();
  const { timezone } = useMe();
  const language = i18n.language;
  return useCallback(
    (iso) => formatterFor(language, timezone).format(new Date(iso)),
    [language, timezone],
  );
}

export function Time({ value }: { value: string }) {
  const moment = useMoment();
  return <time dateTime={value}>{moment(value)}</time>;
}

/** A size in bytes in the unit that reads best: 512 byte, 1.5 kB, 2.5 MB. */
export function formatBytes(bytes: number, language: string): string {
  const [value, unit] =
    bytes < 1_000
      ? ([bytes, 'byte'] as const)
      : bytes < 1_000_000
        ? ([bytes / 1_000, 'kilobyte'] as const)
        : ([bytes / 1_000_000, 'megabyte'] as const);
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(value);
}
