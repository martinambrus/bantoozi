import { useTranslation } from 'react-i18next';

export function JoinPage() {
  const { t } = useTranslation('auth');
  return (
    <main>
      <h1>{t('title')}</h1>
    </main>
  );
}
