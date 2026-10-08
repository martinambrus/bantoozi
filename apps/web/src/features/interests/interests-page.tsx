import { useTranslation } from 'react-i18next';

export function InterestsPage() {
  const { t } = useTranslation('interests');
  return (
    <div>
      <h1>{t('title')}</h1>
    </div>
  );
}
