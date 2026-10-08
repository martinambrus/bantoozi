import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { createI18n } from '../../src/i18n/index.js';
import { failure, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler } from '../support/app.js';

const LOGOUT = 'POST /auth/logout';

const ada = makeMe({ displayName: 'Ada Lovelace', email: 'ada@example.com' });

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

function signedIn(me = ada, logout: ApiRouteHandler = () => noContent()) {
  return { me, routes: { [LOGOUT]: logout } };
}

async function openAccountMenu(app: App, name = 'Ada Lovelace') {
  await app.user.click(screen.getByRole('button', { name: `Account menu: ${name}` }));
}

async function signOut(app: App) {
  await openAccountMenu(app);
  await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
}

function systemPrefersDark(dark: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: dark,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) satisfies MediaQueryList,
  );
}

const primaryNav = () => screen.getByRole('navigation', { name: 'Main navigation' });
const pathname = (app: App) => app.router.state.location.pathname;
const isDark = () => document.documentElement.classList.contains('dark');

describe('the signed-in app shell', () => {
  it('frames the screen with the navigation, the account menu and one main landmark', async () => {
    await open({ path: '/read/for_you', server: signedIn() });

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(within(primaryNav()).getAllByRole('link')).toHaveLength(6);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it("shows the user's email in the account menu", async () => {
    const app = await open({ path: '/read/for_you', server: signedIn() });

    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument();
    await openAccountMenu(app);

    expect(screen.getByText('ada@example.com')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  it('falls back to the email as the name of an account without a display name', async () => {
    const app = await open({
      path: '/read/for_you',
      server: signedIn(makeMe({ displayName: null, email: 'solo@example.com' })),
    });

    await openAccountMenu(app, 'solo@example.com');

    expect(screen.getAllByText('solo@example.com').length).toBeGreaterThan(0);
  });

  it('has no Admin link for a regular user', async () => {
    await open({ path: '/read/for_you', server: signedIn() });

    expect(within(primaryNav()).queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('links to the Admin section for an admin', async () => {
    await open({ path: '/read/for_you', server: signedIn(makeMe({ role: 'admin' })) });

    expect(within(primaryNav()).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('takes the visitor to the section they pick', async () => {
    const app = await open({ path: '/read/for_you', server: signedIn() });

    await app.user.click(within(primaryNav()).getByRole('link', { name: 'Settings' }));

    await waitFor(() => expect(pathname(app)).toBe('/settings'));
    expect(within(primaryNav()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  describe('signing out', () => {
    it('posts /auth/logout, forgets the account and lands on /login', async () => {
      const app = await open({ path: '/read/for_you', server: signedIn() });

      await signOut(app);

      await waitFor(() => expect(pathname(app)).toBe('/login'));
      expect(app.calls(LOGOUT)).toHaveLength(1);
      expect(app.queryClient.getQueryData(meKey())).toBeNull();
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Account menu/ })).not.toBeInTheDocument();
    });

    it('goes to a plain /login, without the page that was open', async () => {
      const app = await open({ path: '/read/maybe', server: signedIn() });

      await signOut(app);

      await waitFor(() => expect(app.router.state.location.href).toBe('/login'));
    });

    it.each([
      [
        'a server error',
        () => failure(500, 'INTERNAL'),
        'Something went wrong on our side. Try again.',
      ],
      [
        'a network failure',
        () => Promise.reject(new TypeError('Failed to fetch')),
        "You seem to be offline, or the server can't be reached.",
      ],
    ] as const)(
      'stays signed in and shows an error toast after %s',
      async (_name, logout, message) => {
        const app = await open({ path: '/read/for_you', server: signedIn(ada, logout) });

        await signOut(app);

        expect(await screen.findByText(message)).toBeVisible();
        expect(pathname(app)).toBe('/read/for_you');
        expect(screen.getByRole('button', { name: 'Account menu: Ada Lovelace' })).toBeVisible();
        expect(primaryNav()).toBeVisible();
        expect(app.queryClient.getQueryData(meKey())).toEqual(ada);
        expect(app.calls(LOGOUT)).toHaveLength(1);
      },
    );

    it('signs out on a second try after a failure', async () => {
      const answers: Array<() => Response> = [() => failure(500, 'INTERNAL'), () => noContent()];
      const app = await open({
        path: '/read/for_you',
        server: signedIn(ada, () => answers.shift()!()),
      });
      await signOut(app);
      await screen.findByText('Something went wrong on our side. Try again.');

      await signOut(app);

      await waitFor(() => expect(pathname(app)).toBe('/login'));
      expect(app.calls(LOGOUT)).toHaveLength(2);
    });

    it('signs out even when the session had already ended', async () => {
      const app = await open({
        path: '/read/for_you',
        server: signedIn(ada, () => failure(401, 'UNAUTHENTICATED')),
      });

      await signOut(app);

      await waitFor(() => expect(pathname(app)).toBe('/login'));
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });
  });

  describe("the account's theme", () => {
    it('is applied while signed in and removed on sign-out', async () => {
      const app = await open({
        path: '/read/for_you',
        server: signedIn(makeMe({ displayName: 'Ada Lovelace', preferences: { theme: 'dark' } })),
      });
      await waitFor(() => expect(isDark()).toBe(true));
      expect(document.documentElement.style.colorScheme).toBe('dark');

      await signOut(app);

      await waitFor(() => expect(pathname(app)).toBe('/login'));
      expect(isDark()).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe('light');
    });

    it('overrides a dark system when it is light', async () => {
      systemPrefersDark(true);
      await open({
        path: '/read/for_you',
        server: signedIn(makeMe({ preferences: { theme: 'light' } })),
      });

      await waitFor(() => expect(document.documentElement.style.colorScheme).toBe('light'));
      expect(isDark()).toBe(false);
    });

    it('follows the system when it is "system", also after signing out', async () => {
      systemPrefersDark(true);
      const app = await open({
        path: '/read/for_you',
        server: signedIn(makeMe({ displayName: 'Ada Lovelace', preferences: { theme: 'system' } })),
      });
      await waitFor(() => expect(isDark()).toBe(true));

      await signOut(app);

      await waitFor(() => expect(pathname(app)).toBe('/login'));
      expect(isDark()).toBe(true);
    });

    it('follows a change of the preference', async () => {
      const app = await open({
        path: '/read/for_you',
        server: signedIn(makeMe({ preferences: { theme: 'dark' } })),
      });
      await waitFor(() => expect(isDark()).toBe(true));

      act(() => {
        app.queryClient.setQueryData(meKey(), makeMe({ preferences: { theme: 'light' } }));
      });
      await waitFor(() => expect(isDark()).toBe(false));
      expect(document.documentElement.style.colorScheme).toBe('light');

      act(() => {
        app.queryClient.setQueryData(meKey(), makeMe({ preferences: { theme: 'dark' } }));
      });
      await waitFor(() => expect(isDark()).toBe(true));
    });

    it('is applied on the onboarding screen too', async () => {
      await open({
        path: '/onboarding',
        server: signedIn(makeMe({ preferences: { theme: 'dark', onboardingCompletedAt: null } })),
      });

      await waitFor(() => expect(isDark()).toBe(true));
    });
  });

  describe('offline', () => {
    it('shows the banner while the browser is offline and hides it when it is back', async () => {
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      await open({ path: '/read/for_you', server: signedIn() });
      const banner = createI18n('en').t('shell:offlineBanner');
      expect(screen.getByText(banner)).toBeVisible();

      online.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      await waitFor(() => expect(screen.queryByText(banner)).not.toBeInTheDocument());
    });

    it('has no banner while online', async () => {
      await open({ path: '/read/for_you', server: signedIn() });

      expect(screen.queryByText(createI18n('en').t('shell:offlineBanner'))).not.toBeInTheDocument();
    });
  });

  describe('a signed-in account on the sign-in screens', () => {
    it.each([
      ['/login', ada, '/read/for_you'],
      ['/login?redirect=%2Fread%2Fmaybe', ada, '/read/maybe'],
      ['/login?redirect=%2Fread%2Ffeed%2F42%3Fx%3D1', ada, '/read/feed/42?x=1'],
      ['/login?redirect=%2F%2Fevil.example', ada, '/read/for_you'],
      ['/login?redirect=https%3A%2F%2Fevil.example', ada, '/read/for_you'],
      ['/login?redirect=%2Flogin', ada, '/read/for_you'],
      ['/join?code=ABC123', ada, '/read/for_you'],
      ['/join', ada, '/read/for_you'],
      ['/login', makeMe({ preferences: { onboardingCompletedAt: null } }), '/onboarding'],
    ] as const)('is sent on from %s', async (path, me, expected) => {
      const app = await open({ path, server: signedIn(me) });

      expect(app.router.state.location.href).toBe(expected);
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(app.calls('POST /auth/request-code')).toHaveLength(0);
    });

    it('can still open the waitlist', async () => {
      const app = await open({ path: '/waitlist', server: signedIn() });

      expect(pathname(app)).toBe('/waitlist');
      expect(await screen.findByLabelText('Email')).toBeVisible();
    });
  });
});
