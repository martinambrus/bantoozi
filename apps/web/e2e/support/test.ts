import {
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

import { apiLogin, callJson, newApiContext } from './api.js';
import { Control } from './control.js';
import { URLS } from './env.js';

export { expect } from '@playwright/test';

export interface Api {
  /** A context without a session, for public routes and the sign-in flow itself. */
  anonymous(): Promise<APIRequestContext>;
  /** A context signed in as `email`; open signup creates the account on first use. */
  login(email: string): Promise<APIRequestContext>;
}

export interface BrowseOptions {
  /** False leaves the first-run wizard to do; by default it is marked done through the API. */
  onboarded?: boolean;
  /**
   * Extra options of the browser context, e.g. a phone viewport. Service workers are blocked, as in
   * the `page` fixture, unless this says `serviceWorkers: 'allow'`.
   */
  context?: BrowserContextOptions;
}

export interface Browse {
  /**
   * A page in a browser context of its own, signed in as `email` (open signup creates the account)
   * with the session the API sign-in made.
   */
  as(email: string, options?: BrowseOptions): Promise<Page>;
}

interface Fixtures {
  control: Control;
  api: Api;
  browse: Browse;
}

export const test = base.extend<Fixtures>({
  control: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture names from the pattern
    async ({}, use) => {
      const control = new Control();
      await control.reset();
      await use(control);
    },
    { auto: true },
  ],

  api: async ({ playwright }, use) => {
    const contexts: APIRequestContext[] = [];
    await use({
      async anonymous() {
        const context = await newApiContext(playwright);
        contexts.push(context);
        return context;
      },
      async login(email) {
        const context = await apiLogin(playwright, email);
        contexts.push(context);
        return context;
      },
    });
    await Promise.all(contexts.map((context) => context.dispose()));
  },

  browse: async ({ browser, api }, use) => {
    const contexts: BrowserContext[] = [];
    await use({
      async as(email, { onboarded = true, context: options = {} } = {}) {
        const request = await api.login(email);
        if (onboarded) {
          await callJson<unknown>(request, 'PATCH', '/api/v1/me', {
            data: { preferences: { onboardingCompletedAt: new Date().toISOString() } },
          });
        }
        const context = await browser.newContext({
          baseURL: URLS.app,
          serviceWorkers: 'block',
          ...options,
          storageState: await request.storageState(),
        });
        contexts.push(context);
        return context.newPage();
      },
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});
