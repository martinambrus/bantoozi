import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../i18n/dates.js';
import { useMe } from '../session/context.js';

/** Prints a moment in the reader's language and the time zone chosen for the account (spec 02). */
export function useMoment(): (iso: string) => string {
  const { i18n } = useTranslation();
  const { timezone } = useMe();
  const language = i18n.language;
  return useCallback((iso) => formatDateTime(iso, language, timezone), [language, timezone]);
}

/** A moment in the account's time zone; the exact value stays in `datetime`. */
export function Time({ value }: { value: string }) {
  const moment = useMoment();
  return <time dateTime={value}>{moment(value)}</time>;
}
