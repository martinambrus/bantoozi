import { Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export function AdminLayout() {
  const { t } = useTranslation('admin');
  return (
    <div>
      <h1>{t('title')}</h1>
      <Outlet />
    </div>
  );
}
