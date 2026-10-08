import { Link, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { FOCUS_RING, cx } from '../../components/cx.js';

const SCREENS = [
  { to: '/admin', name: 'overview' },
  { to: '/admin/usage', name: 'usage' },
  { to: '/admin/settings', name: 'settings' },
  { to: '/admin/providers', name: 'providers' },
  { to: '/admin/feeds', name: 'feeds' },
  { to: '/admin/library', name: 'library' },
  { to: '/admin/users', name: 'users' },
  { to: '/admin/invites', name: 'invites' },
  { to: '/admin/waitlist', name: 'waitlist' },
] as const;

// The current screen is bold and underlined as well as coloured, so it never rides on colour alone.
const NAV_LINK = cx(
  'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
  'aria-[current=page]:font-semibold aria-[current=page]:text-indigo-700 aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-4 dark:aria-[current=page]:text-indigo-300',
  FOCUS_RING,
);

export function AdminLayout() {
  const { t } = useTranslation('admin');
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <nav aria-label={t('nav.label')}>
        <ul role="list" className="flex flex-wrap gap-1">
          {SCREENS.map((screen) => (
            <li key={screen.to}>
              <Link to={screen.to} activeOptions={{ exact: true }} className={NAV_LINK}>
                {t(`nav.${screen.name}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
