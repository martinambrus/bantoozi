import { QueryClient, onlineManager } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, createAppServices, type AppServices } from '../../src/app.js';
import { createI18n } from '../../src/i18n/index.js';
import { readMe, saveMe, setOfflineEnabled } from '../../src/offline/cache.js';
import { writeLastAccount } from '../../src/offline/device.js';
import { resetOfflineDb } from '../../src/offline/db.js';
import { fakeFetch, json } from '../api/fake-fetch.js';
import { READER_READS } from '../auth/harness.js';
import { item, page, rowTitles } from '../reader/support.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { createFakeServer, type FakeServer } from '../support/app.js';
import { keepView, viewReaches } from './saved-support.js';
import { freshIndexedDb } from './support.js';

const ada = makeMe({ displayName: 'Ada Lovelace', email: 'ada@example.com' });
const idb = freshIndexedDb();
const booted: AppServices[] = [];

const LINE = /^Offline\. Showing articles saved on this device at .+\.$/;

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  for (const services of booted.splice(0)) services.session.dispose();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

/** The page starting, over what the device kept, with a network that may be down. */
async function startPage(network: { offline: boolean }, path = '/') {
  const server: FakeServer = {
    me: ada,
    routes: {
      ...READER_READS,
      'GET /articles': () => json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    },
  };
  const fake = createFakeServer(server);
  const recorded = fakeFetch((request) => {
    if (network.offline) throw new TypeError('Failed to fetch');
    return fake.handler(request);
  });
  const services = createAppServices({
    i18n: createI18n('en'),
    fetch: recorded.fetch,
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
  });
  booted.push(services);
  await services.router.load();
  const view = render(createElement(App, { services }));
  return { ...services, ...view, requests: recorded.requests, unhandled: fake.unhandled };
}

/** What an earlier visit by the account that chose offline reading left on the device. */
async function keepAccount() {
  await keepView([1, 2]);
  expect(await saveMe(USER_A_ID, ada)).toBe(true);
  writeLastAccount(USER_A_ID);
}

/** One visit with a connection by the account that chose offline reading, then the page is left. */
async function visitOnline() {
  await setOfflineEnabled(USER_A_ID, true);
  const visit = await startPage({ offline: false });
  await screen.findByRole('article', { name: 'Article 1' });
  await viewReaches(idb.factory, ['1', '2']);
  await vi.waitFor(async () => expect(await readMe(USER_A_ID)).not.toBeNull());
  visit.unmount();
  visit.session.dispose();
  await resetOfflineDb();
  expect(visit.unhandled).toEqual([]);
}

describe('starting the reader without a connection', () => {
  it.each<[string, boolean]>([
    ['the request fails', false],
    ['the browser reports no connection', true],
  ])('opens the first view with the rows saved for it when %s', async (_name, reported) => {
    await keepAccount();
    if (reported) vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const started = await startPage({ offline: true });

    expect(await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' })).toBeVisible();
    expect(started.router.state.location.pathname).toBe('/read/for_you');
    expect(await screen.findByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByRole('heading', { name: "You're offline" })).toBeNull();
    expect(started.requests.map((request) => request.pathname)).toContain('/api/v1/articles');
  });

  it('opens the first view with the rows an earlier visit saved', async () => {
    await visitOnline();

    const started = await startPage({ offline: true });

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(started.router.state.location.pathname).toBe('/read/for_you');
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
  });

  it('keeps the offline state of a view that has no saved rows', async () => {
    await keepAccount();

    const started = await startPage({ offline: true }, '/read/maybe');

    expect(await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' })).toBeVisible();
    expect(started.router.state.location.pathname).toBe('/read/maybe');
    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
  });
});
