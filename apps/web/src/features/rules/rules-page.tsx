import { useTranslation } from 'react-i18next';

export function RulesPage() {
  const { t } = useTranslation('rules');
  return (
    <div>
      <h1>{t('title')}</h1>
    </div>
  );
}
