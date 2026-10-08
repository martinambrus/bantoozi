import { useTranslation } from 'react-i18next';

export function LabelsPage() {
  const { t } = useTranslation('labels');
  return (
    <div>
      <h1>{t('title')}</h1>
    </div>
  );
}
