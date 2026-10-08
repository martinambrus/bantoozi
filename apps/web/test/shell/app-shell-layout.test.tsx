import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShellLayout, type AppShellUser } from '../../src/features/shell/app-shell-layout.js';
import { createI18n, type Language } from '../../src/i18n/index.js';

const PATHS = [
  '/read',
  '/read/maybe',
  '/interests',
  '/labels',
  '/feeds',
  '/rules',
  '/settings',
  '/admin',
  '/admin/users',
] as const;

const ada = { displayName: 'Ada Lovelace', email: 'ada@example.com' };

async function renderShell({
  path = '/read/maybe',
  user = { ...ada, role: 'user' },
  offline,
  onLogout = vi.fn(),
  language = 'en',
}: {
  path?: (typeof PATHS)[number];
  user?: AppShellUser;
  offline?: boolean | undefined;
  onLogout?: () => void;
  language?: Language;
} = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShellLayout user={user} onLogout={onLogout} offline={offline}>
        <Outlet />
      </AppShellLayout>
    ),
  });
  const routeTree = rootRoute.addChildren(
    PATHS.map((routePath) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: routePath,
        component: () => <h1>{`page ${routePath}`}</h1>,
      }),
    ),
  );
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  return { onLogout, router };
}

const primaryNav = (name = 'Main navigation') => screen.getByRole('navigation', { name });

describe('AppShellLayout', () => {
  // The router scrolls to the top on navigation, which jsdom reports as "not implemented".
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has the landmarks: skip link, banner, labelled navigation and a focusable main', async () => {
    await renderShell();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(within(main).getByRole('heading', { name: 'page /read/maybe' })).toBeInTheDocument();

    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('link', { name: 'Bantoozi' })).toHaveAttribute('href', '/read');
    expect(primaryNav()).toBeInTheDocument();
  });

  it('links to every section, with no Admin link for a regular user', async () => {
    await renderShell();
    const links = within(primaryNav())
      .getAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href')]);
    expect(links).toEqual([
      ['Reader', '/read'],
      ['Interests', '/interests'],
      ['Labels', '/labels'],
      ['Feeds', '/feeds'],
      ['Rules', '/rules'],
      ['Settings', '/settings'],
    ]);
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the Admin link for admins only', async () => {
    await renderShell({ user: { ...ada, role: 'admin' } });
    expect(within(primaryNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('marks the active link with aria-current, Reader for every /read path', async () => {
    await renderShell({ path: '/read/maybe' });
    const nav = within(primaryNav());
    expect(nav.getByRole('link', { name: 'Reader' })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Interests', 'Labels', 'Feeds', 'Rules', 'Settings']) {
      expect(nav.getByRole('link', { name })).not.toHaveAttribute('aria-current');
    }
  });

  it('marks another section active at its own path', async () => {
    await renderShell({ path: '/labels' });
    const nav = within(primaryNav());
    expect(nav.getByRole('link', { name: 'Labels' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Reader' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Admin active below /admin', async () => {
    await renderShell({ path: '/admin/users', user: { ...ada, role: 'admin' } });
    expect(within(primaryNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('gives the active link a cue other than colour', async () => {
    await renderShell({ path: '/read/maybe' });
    const reader = within(primaryNav()).getByRole('link', { name: 'Reader' });
    expect(reader.className).toMatch(/aria-\[current=page\]:(underline|font-)/);
  });

  it('shows the account in a menu with Sign out', async () => {
    const user = userEvent.setup();
    const { onLogout } = await renderShell();
    const trigger = screen.getByRole('button', { name: 'Account menu: Ada Lovelace' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it.each([null, '', '  '])(
    'falls back to the email when the display name is %j',
    async (displayName) => {
      const user = userEvent.setup();
      await renderShell({ user: { displayName, email: 'solo@example.com', role: 'user' } });
      const trigger = screen.getByRole('button', { name: 'Account menu: solo@example.com' });

      await user.click(trigger);
      expect(screen.getAllByText('solo@example.com')).toHaveLength(2);
    },
  );

  it('opens the navigation in a sheet from the menu button and closes it on navigation', async () => {
    const user = userEvent.setup();
    const { router } = await renderShell({ path: '/read/maybe' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const menuButton = screen.getByRole('button', { name: 'Menu' });
    await user.click(menuButton);
    const sheet = screen.getByRole('dialog', { name: 'Menu' });
    const sheetNav = within(sheet).getByRole('navigation', { name: 'Main navigation' });
    expect(within(sheetNav).getAllByRole('link')).toHaveLength(6);
    expect(within(sheetNav).getByRole('link', { name: 'Reader' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(sheetNav).getByRole('link', { name: 'Interests' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/interests');
    expect(screen.getByRole('heading', { name: 'page /interests' })).toBeInTheDocument();
  });

  it('closes the sheet when the current page is chosen again', async () => {
    const user = userEvent.setup();
    await renderShell({ path: '/read/maybe' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = screen.getByRole('dialog');
    await user.click(within(sheet).getByRole('link', { name: 'Reader' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('lists Admin in the sheet for admins', async () => {
    const user = userEvent.setup();
    await renderShell({ user: { ...ada, role: 'admin' } });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('link', { name: 'Admin' }),
    ).toBeInTheDocument();
  });

  it('shows the offline banner only when offline', async () => {
    await renderShell({ offline: true });
    expect(screen.getByRole('status')).toHaveTextContent(createI18n('en').t('shell:offlineBanner'));
  });

  it.each([undefined, false])('has no offline banner when offline is %s', async (offline) => {
    await renderShell({ offline });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('is translated to Slovak', async () => {
    await renderShell({ language: 'sk', user: { ...ada, role: 'admin' }, offline: true });
    const { t } = createI18n('sk');
    expect(screen.getByRole('link', { name: t('common:skipToContent') })).toBeInTheDocument();
    const nav = within(primaryNav(t('shell:nav.label')));
    for (const key of ['reader', 'interests', 'labels', 'feeds', 'rules', 'settings', 'admin']) {
      expect(nav.getByRole('link', { name: t(`shell:nav.${key}`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('status')).toHaveTextContent(t('shell:offlineBanner'));
  });
});
