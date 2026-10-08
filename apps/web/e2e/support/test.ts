import { test as base, type APIRequestContext } from '@playwright/test';

import { apiLogin, newApiContext } from './api.js';
import { Control } from './control.js';

export { expect } from '@playwright/test';

export interface Api {
  /** A context without a session, for public routes and the sign-in flow itself. */
  anonymous(): Promise<APIRequestContext>;
  /** A context signed in as `email`; open signup creates the account on first use. */
  login(email: string): Promise<APIRequestContext>;
}

interface Fixtures {
  control: Control;
  api: Api;
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
});
