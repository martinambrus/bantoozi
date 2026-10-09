import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page } from '@playwright/test';

import { newAccount } from '../reader-support/accounts.js';
import { callJson } from '../support/api.js';
import type { Control } from '../support/control.js';
import { URLS } from '../support/env.js';
import { test as base } from '../support/test.js';

import { openReader, type Reader, type StartOptions } from './reader.js';

/**
 * A browser that can install the app: a persistent profile in the full Chromium, with service
 * workers on (spec 09 §9). The default headless shell and incognito contexts report `in-incognito`
 * installability errors, and the smoke contexts block service workers.
 */
export interface InstalledApp {
  context: BrowserContext;
  page: Page;
}

export interface InstalledApps {
  /** A browser signed in as `email` by the cookies of an API sign-in, which makes the account. */
  open(email: string): Promise<InstalledApp>;
}

interface Profile {
  dir: string;
  context: BrowserContext | undefined;
}

export const test = base.extend<{ installed: InstalledApps }>({
  installed: async ({ api }, use) => {
    const profiles: Profile[] = [];
    await use({
      async open(email) {
        const request = await api.login(email);
        await callJson<unknown>(request, 'PATCH', '/api/v1/me', {
          data: { preferences: { onboardingCompletedAt: new Date().toISOString() } },
        });
        const profile: Profile = {
          dir: await mkdtemp(join(tmpdir(), 'bantoozi-pwa-profile-')),
          context: undefined,
        };
        profiles.push(profile);
        const context = await chromium.launchPersistentContext(profile.dir, {
          channel: 'chromium',
          serviceWorkers: 'allow',
          baseURL: URLS.app,
        });
        profile.context = context;
        await context.addCookies((await request.storageState()).cookies);
        return { context, page: context.pages()[0] ?? (await context.newPage()) };
      },
    });
    for (const { context, dir } of profiles) {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
});

/** A new account in an installable browser, following the fixture feeds, with the reader open. */
export async function startInstalledReader(
  { installed, control }: { installed: InstalledApps; control: Control },
  label: string,
  options: StartOptions = {},
): Promise<Reader> {
  const email = newAccount(label);
  const { page } = await installed.open(email);
  return openReader({ page, email, control }, options);
}

/** What Chrome says stands in the way of installing the page, through the DevTools Protocol. */
export async function installabilityErrorsOf({ context, page }: InstalledApp): Promise<unknown[]> {
  const session = await context.newCDPSession(page);
  try {
    return (await session.send('Page.getInstallabilityErrors')).installabilityErrors;
  } finally {
    await session.detach();
  }
}
