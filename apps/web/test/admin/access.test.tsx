import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { failure } from '../api/fake-fetch.js';
import { renderApp } from '../support/app.js';
import { adminMe, adminRoutes, unhandledGuard, userMe } from './support.js';

const SCREENS = [
  { path: '/admin', name: 'Overview' },
  { path: '/admin/usage', name: 'Usage' },
  { path: '/admin/settings', name: 'Settings' },
  { path: '/admin/providers', name: 'Provider accounts' },
  { path: '/admin/feeds', name: 'Feeds' },
  { path: '/admin/library', name: 'Library' },
  { path: '/admin/users', name: 'Users' },
  { path: '/admin/invites', name: 'Invites' },
  { path: '/admin/waitlist', name: 'Waitlist' },
] as const;

const NAV = 'Administration sections';

const guard = unhandledGuard();

async function render(options: Parameters<typeof renderApp>[0]) {
  return guard(await renderApp(options));
}

beforeEach(() => {
  // jsdom has no scrolling; the router's scroll restoration would log "not implemented".
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

describe('admin access (spec 09 §2, §8)', () => {
  it.each(['/admin', '/admin/settings', '/admin/library'])(
    'answers %s with not found for a non-admin, who triggers no admin request',
    async (path) => {
      const app = await render({ path, server: { me: userMe(), routes: adminRoutes() } });

      expect(await screen.findByText('Not Found')).toBeInTheDocument();
      expect(app.requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
        'GET /api/v1/me',
      ]);
      expect(app.unhandled).toEqual([]);
      expect(screen.queryByRole('navigation', { name: NAV })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Administration' })).toBeNull();
    },
  );

  it.each(SCREENS)('lets an admin open $path', async ({ path, name }) => {
    const app = await render({ path, server: { me: adminMe(), routes: adminRoutes() } });

    expect(await screen.findByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
    expect(await screen.findByRole('heading', { level: 2, name })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument(),
    );

    const links = within(screen.getByRole('navigation', { name: NAV })).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin',
      '/admin/usage',
      '/admin/settings',
      '/admin/providers',
      '/admin/feeds',
      '/admin/library',
      '/admin/users',
      '/admin/invites',
      '/admin/waitlist',
    ]);
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual([name]);
    expect(app.unhandled).toEqual([]);
    expect(screen.queryByText('Not Found')).not.toBeInTheDocument();
  });

  it('moves between the screens with the sub-navigation', async () => {
    const app = await render({
      path: '/admin',
      server: { me: adminMe(), routes: adminRoutes() },
    });
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    const nav = screen.getByRole('navigation', { name: NAV });

    await app.user.click(within(nav).getByRole('link', { name: 'Usage' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Usage' })).toBeVisible();
    expect(app.router.state.location.pathname).toBe('/admin/usage');
    expect(within(nav).getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('shows the permission error when the API refuses an admin read', async () => {
    const app = await render({
      path: '/admin/feeds',
      server: {
        me: adminMe(),
        routes: adminRoutes({ 'GET /admin/feeds': () => failure(403, 'FORBIDDEN') }),
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You don't have permission to do that.",
    );
    expect(app.unhandled).toEqual([]);
  });
});
