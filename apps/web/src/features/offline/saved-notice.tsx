import { useTranslation } from 'react-i18next';

import { OfflineIcon } from '../../components/icons.js';
import { useMe } from '../../session/context.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(
  language: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${language}|${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
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

/** The time of the day when the copy is from today, else the day too, in the account's time zone. */
function whenSaved(savedAt: number, now: number, language: string, timeZone: string): string {
  const day = formatterFor(language, timeZone, { dateStyle: 'short' });
  const today = day.format(savedAt) === day.format(now);
  return formatterFor(
    language,
    timeZone,
    today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(savedAt);
}

/** The line above rows that come from the device: that they do, and from when (spec 09 §1). */
export function SavedNotice({ savedAt }: { savedAt: number }) {
  const { t, i18n } = useTranslation('offline');
  const { timezone } = useMe();
  const time = whenSaved(savedAt, Date.now(), i18n.language, timezone);
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
      <OfflineIcon className="mt-0.5 size-4 shrink-0" />
      {t('saved.line', { time })}
    </p>
  );
}
