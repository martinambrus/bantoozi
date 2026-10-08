import { useTranslation } from 'react-i18next';

export function AdminOverviewPage() {
  const { t } = useTranslation('admin');
  return (
    <div>
      <h1>{t('title')}</h1>
    </div>
  );
}
