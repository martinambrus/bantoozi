import type { Me } from '@bantoozi/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { themePreference } from '../../src/theme/theme.js';
import { json } from '../api/fake-fetch.js';
import { renderApp, type ApiRouteHandler, type FakeServer } from '../support/app.js';

export const EMAIL = 'ada@example.com';
export const CODE = '123456';

const AS_OF = '2026-05-31T10:00:00.000Z';

/** What the reader asks for when a test lands on it by the way: nothing to read, nothing to count. */
export const READER_READS: Record<string, ApiRouteHandler> = {
  'GET /subscriptions': () => json(200, []),
  'GET /labels': () => json(200, []),
  'GET /articles/counts': () =>
    json(200, {
      forYou: 0,
      maybe: 0,
      everything: 0,
      new: 0,
      bookmarks: 0,
      hidden: 0,
      scored: 0,
      total: 0,
      asOf: AS_OF,
      datasetVersion: 'empty',
      rankingPending: false,
    }),
  'GET /articles': () =>
    json(200, {
      items: [],
      nextCursor: null,
      asOf: AS_OF,
      datasetVersion: 'empty',
      rankingPending: false,
    }),
};

/**
 * A fake API for the sign-in flow: `request-code` always answers 202 like the real one, and a
 * correct `verify` signs `account` in (so the `/me` that follows knows it). Pass `routes` to
 * replace an operation.
 */
export function signInServer(options: {
  account: Me;
  routes?: Record<string, ApiRouteHandler>;
}): FakeServer {
  const server: FakeServer = {
    me: null,
    routes: {
      ...READER_READS,
      'POST /auth/request-code': () => json(202, { next: 'check_email' }),
      'POST /auth/verify': () => {
        server.me = options.account;
        return json(200, { user: options.account });
      },
      ...options.routes,
    },
  };
  return server;
}

/**
 * Boots the app through `renderApp` and, after each test, checks that the app asked the fake API
 * for nothing it does not handle. Call it once at the top of a test file.
 */
export function createHarness() {
  const opened: Awaited<ReturnType<typeof renderApp>>[] = [];

  // The router scrolls to the top on navigation, which jsdom reports as "not implemented".
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Unmount first: the theme the app left on <html> is reset below, with nothing listening.
    cleanup();
    const apps = opened.splice(0);
    for (const app of apps) app.session.dispose();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
    themePreference.set('system');
    vi.restoreAllMocks();
    for (const app of apps) expect(app.unhandled).toEqual([]);
  });

  return {
    async open(options: Parameters<typeof renderApp>[0]) {
      const app = await renderApp(options);
      opened.push(app);
      return app;
    },
  };
}
