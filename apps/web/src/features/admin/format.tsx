import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface Format {
  dateTime: (iso: string) => string;
  usd: (value: number) => string;
  number: (value: number) => string;
}

export function useFormat(): Format {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
    const usd = new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    const number = new Intl.NumberFormat(language);
    return {
      dateTime: (iso) => dateTime.format(new Date(iso)),
      usd: (value) => usd.format(value),
      number: (value) => number.format(value),
    };
  }, [language]);
}

/** A moment in the reader's locale; the machine-readable value stays in `datetime`. */
export function Time({ value }: { value: string }) {
  const { dateTime } = useFormat();
  return <time dateTime={value}>{dateTime(value)}</time>;
}
