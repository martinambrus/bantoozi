import { useTranslation } from 'react-i18next';

export function SettingsPage() {
  const { t } = useTranslation('settings');
  return (
    <main>
      <h1>{t('title')}</h1>
    </main>
  );
}
