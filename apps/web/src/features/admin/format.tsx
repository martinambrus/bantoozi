import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export { Time } from '../../components/time.js';

export interface Format {
  usd: (value: number) => string;
  number: (value: number) => string;
}

export function useFormat(): Format {
  const { i18n } = useTranslation();
  const language = i18n.language;
  return useMemo(() => {
    const usd = new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    const number = new Intl.NumberFormat(language);
    return {
      usd: (value) => usd.format(value),
      number: (value) => number.format(value),
    };
  }, [language]);
}
