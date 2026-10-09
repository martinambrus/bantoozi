import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { IconButton } from '../../components/icon-button.js';
import { ChevronDownIcon, MenuIcon, OfflineIcon } from '../../components/icons.js';
import { Menu, MenuItem } from '../../components/menu.js';
import { Sheet } from '../../components/sheet.js';
import { useToast } from '../../components/toast/toast-provider.js';

export interface AppShellUser {
  displayName: string | null;
  email: string;
  role: 'user' | 'admin';
}

export interface AppShellLayoutProps {
  user: AppShellUser;
  onLogout: () => void;
  /** Shows the offline banner. */
  offline?: boolean | undefined;
  children: ReactNode;
}

const SECTIONS = [
  { to: '/read', name: 'reader' },
  { to: '/interests', name: 'interests' },
  { to: '/labels', name: 'labels' },
  { to: '/feeds', name: 'feeds' },
  { to: '/rules', name: 'rules' },
  { to: '/settings', name: 'settings' },
] as const;
const ADMIN_SECTION = { to: '/admin', name: 'admin' } as const;

// The current page is underlined and bold as well as coloured, so it never rides on colour alone.
const NAV_LINK = cx(
  'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
  'aria-[current=page]:font-semibold aria-[current=page]:text-indigo-700 aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-4 dark:aria-[current=page]:text-indigo-300',
  FOCUS_RING,
);

function NavLinks({
  admin,
  vertical = false,
  onNavigate,
}: {
  admin: boolean;
  vertical?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation('shell');
  const sections = admin ? [...SECTIONS, ADMIN_SECTION] : SECTIONS;
  return (
    <ul role="list" className={cx('flex gap-1', vertical && 'flex-col')}>
      {sections.map((section) => (
        <li key={section.to}>
          <Link to={section.to} onClick={onNavigate} className={cx(NAV_LINK, vertical && 'w-full')}>
            {t(`nav.${section.name}`)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function UserMenu({ user, onLogout }: Pick<AppShellLayoutProps, 'user' | 'onLogout'>) {
  const { t } = useTranslation('shell');
  const displayName = user.displayName?.trim();
  const name = displayName === undefined || displayName === '' ? user.email : displayName;
  return (
    <Menu
      align="end"
      header={
        <>
          <p className="break-all font-semibold">{name}</p>
          {name === user.email ? null : (
            <p className="break-all text-slate-600 dark:text-slate-300">{user.email}</p>
          )}
        </>
      }
      trigger={(props) => (
        <Button
          {...props}
          variant="ghost"
          aria-label={t('userMenu.label', { name })}
          className="px-2"
        >
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-full bg-indigo-700 text-sm font-semibold text-white dark:bg-indigo-300 dark:text-slate-950"
          >
            {Array.from(name)[0]?.toUpperCase()}
          </span>
          <span className="max-w-40 truncate max-sm:hidden">{name}</span>
          <ChevronDownIcon className="size-4" />
        </Button>
      )}
    >
      <MenuItem onSelect={onLogout}>{t('common:actions.signOut')}</MenuItem>
    </Menu>
  );
}

/** The signed-in frame (spec 09 §1): landmarks, a skip link, the section navigation and the account menu. */
export function AppShellLayout({ user, onLogout, offline, children }: AppShellLayoutProps) {
  const { t } = useTranslation('shell');
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const admin = user.role === 'admin';

  // The banner is in the page, which an open modal makes inert: only a toast reaches a person there.
  const wasOffline = useRef(offline === true);
  useEffect(() => {
    const isOffline = offline === true;
    if (isOffline === wasOffline.current) return;
    wasOffline.current = isOffline;
    toast.show({
      id: 'connectivity',
      message: t(isOffline ? 'connectivity.offline' : 'connectivity.online'),
      tone: isOffline ? 'info' : 'success',
    });
  }, [offline, toast, t]);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className={cx(
          'sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-indigo-700 focus:px-4 focus:py-3 focus:text-sm focus:font-medium focus:text-white',
          FOCUS_RING,
        )}
      >
        {t('common:skipToContent')}
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1">
          <IconButton
            label={t('common:actions.menu')}
            aria-haspopup="dialog"
            onClick={() => setNavOpen(true)}
            className="-ml-2 lg:hidden"
          >
            <MenuIcon />
          </IconButton>
          <Link
            to="/read"
            className={cx(
              'inline-flex min-h-11 items-center rounded-lg px-2 text-lg font-bold',
              FOCUS_RING,
            )}
          >
            {t('common:appName')}
          </Link>
          <nav aria-label={t('nav.label')} className="ml-4 max-lg:hidden">
            <NavLinks admin={admin} />
          </nav>
          <div className="ml-auto">
            <UserMenu user={user} onLogout={onLogout} />
          </div>
        </div>
      </header>
      {offline === true ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <OfflineIcon className="size-4" />
          {t('offlineBanner')}
        </div>
      ) : null}
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <Sheet
        open={navOpen}
        onClose={() => setNavOpen(false)}
        title={t('common:actions.menu')}
        side="bottom"
      >
        <nav aria-label={t('nav.label')}>
          <NavLinks admin={admin} vertical onNavigate={() => setNavOpen(false)} />
        </nav>
      </Sheet>
    </div>
  );
}
