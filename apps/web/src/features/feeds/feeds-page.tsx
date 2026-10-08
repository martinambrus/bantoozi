import { useTranslation } from 'react-i18next';

export function FeedsPage() {
  const { t } = useTranslation('feeds');
  return (
    <main>
      <h1>{t('title')}</h1>
    </main>
  );
}
