import { useTranslation } from 'react-i18next';

export function AdminUsersPage() {
  const { t } = useTranslation('admin');
  return (
    <main>
      <h1>{t('title')}</h1>
    </main>
  );
}
