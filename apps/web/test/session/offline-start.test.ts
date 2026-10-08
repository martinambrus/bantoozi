import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { App, createAppServices, type AppServices } from '../../src/app.js';
import { createI18n } from '../../src/i18n/index.js';
import { readMe, setOfflineEnabled } from '../../src/offline/cache.js';
import { failure, fakeFetch } from '../api/fake-fetch.js';
import { READER_READS } from '../auth/harness.js';
import { DAY, T0, setClock, freshIndexedDb } from '../offline/support.js';
import { createFakeServer, type FakeServer } from '../support/app.js';
import { USER_A_ID, makeMe } from './fixtures.js';

const ada = makeMe({ displayName: 'Ada Lovelace', email: 'ada@example.com' });
freshIndexedDb();

const booted: AppServices[] = [];

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  for (const services of booted.splice(0)) services.session.dispose();
  vi.restoreAllMocks();
});

/** The page starting: a new session and router over what the device kept, and a network that may be down. */
async function startPage(network: { offline: boolean }, path = '/read/for_you') {
  const server: FakeServer = { me: ada, routes: { ...READER_READS } };
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

const operations = (requests: { method: string; pathname: string }[]) =>
  requests.map((request) => `${request.method} ${request.pathname.replace('/api/v1', '')}`);

/** One visit with a connection, as the person who chose offline reading makes it. */
async function visitOnline(options: { optedIn: boolean }) {
  if (options.optedIn) await setOfflineEnabled(USER_A_ID, true);
  const page = await startPage({ offline: false });
  await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' });
  if (options.optedIn) await vi.waitFor(async () => expect(await readMe(USER_A_ID)).not.toBeNull());
  page.unmount();
  page.session.dispose();
  expect(page.unhandled).toEqual([]);
}

describe('starting without a connection', () => {
  it('opens the signed-in shell for the last account that chose offline reading', async () => {
    setClock(T0);
    await visitOnline({ optedIn: true });

    const page = await startPage({ offline: true });

    expect(await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    expect(page.router.state.location.pathname).toBe('/read/for_you');
    expect(page.queryClient.getQueryData(meKey())).toEqual(ada);
    expect(operations(page.requests)).toContain('GET /me');
    expect(screen.queryByRole('heading', { name: "You're offline" })).not.toBeInTheDocument();
  });

  it('does not extend the 24 hours of the saved account by opening it', async () => {
    setClock(T0);
    await visitOnline({ optedIn: true });
    setClock(T0 + 20 * 3_600_000);
    const first = await startPage({ offline: true });
    await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' });
    first.unmount();
    first.session.dispose();

    setClock(T0 + DAY + 1);
    await startPage({ offline: true });

    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeVisible();
  });

  it.each([
    ['the saved account is 24 hours old', DAY],
    ['the saved account is older than 24 hours', DAY + 3_600_000],
  ])('shows the offline screen when %s', async (_name, age) => {
    setClock(T0);
    await visitOnline({ optedIn: true });
    setClock(T0 + age);

    const page = await startPage({ offline: true });

    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Account menu/ })).not.toBeInTheDocument();
    expect(page.queryClient.getQueryData(meKey())).toBeUndefined();
  });

  it('shows the offline screen when the account did not choose offline reading', async () => {
    setClock(T0);
    await visitOnline({ optedIn: false });
    setClock(T0 + 1000);

    const page = await startPage({ offline: true });

    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Account menu/ })).not.toBeInTheDocument();
    expect(page.queryClient.getQueryData(meKey())).toBeUndefined();
    expect(await readMe(USER_A_ID)).toBeNull();
  });

  it('shows the offline screen on a device that never had an account', async () => {
    await startPage({ offline: true });

    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeVisible();
    expect(screen.getByText(/connect to the internet/i)).toBeVisible();
  });

  it('opens the signed-in app once Try again finds a connection', async () => {
    setClock(T0);
    await visitOnline({ optedIn: false });
    const network = { offline: true };
    const page = await startPage(network);
    await screen.findByRole('heading', { name: "You're offline" });
    const before = operations(page.requests).filter((entry) => entry === 'GET /me').length;
    network.offline = false;

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Account menu: Ada Lovelace' })).toBeVisible();
    await waitFor(() => expect(page.router.state.location.pathname).toBe('/read/for_you'));
    expect(operations(page.requests).filter((entry) => entry === 'GET /me').length).toBe(
      before + 1,
    );
    expect(screen.queryByRole('heading', { name: "You're offline" })).not.toBeInTheDocument();
    expect(page.queryClient.getQueryData(meKey())).toEqual(ada);
  });

  it('shows every other failure of /me as it always did', async () => {
    const recorded = fakeFetch(() => failure(500, 'INTERNAL'));
    const services = createAppServices({
      i18n: createI18n('en'),
      fetch: recorded.fetch,
      history: createMemoryHistory({ initialEntries: ['/read/for_you'] }),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    booted.push(services);
    await services.router.load();

    render(createElement(App, { services }));

    expect(await screen.findByText(/something went wrong/i)).toBeVisible();
    expect(screen.queryByRole('heading', { name: "You're offline" })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
