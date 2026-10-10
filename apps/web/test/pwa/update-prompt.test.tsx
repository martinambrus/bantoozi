import type { Me } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Language } from '../../src/i18n/index.js';
import { offlineDb } from '../../src/offline/db.js';
import { OFFLINE_DB } from '../../src/offline/names.js';
import { noContent } from '../api/fake-fetch.js';
import { READER_READS, createHarness } from '../auth/harness.js';
import { freshIndexedDb } from '../offline/support.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler } from '../support/app.js';
import { libraries } from './fake-register.js';

vi.mock('virtual:pwa-register/react', () => import('./fake-register.js'));

const { open } = createHarness();
const idb = freshIndexedDb();

const COPY = {
  en: {
    ready: 'A new version of Bantoozi is ready.',
    otherTab: 'Bantoozi was updated in another tab. Reload to keep using it offline.',
    reload: 'Reload',
  },
  sk: {
    ready: 'Je pripravená nová verzia Bantoozi.',
    otherTab:
      'Bantoozi bol aktualizovaný v inej karte. Načítajte ho znova, aby ste ho mohli ďalej používať offline.',
    reload: 'Znova načítať',
  },
} as const;

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-08T08:00:00.000Z');

beforeEach(() => {
  libraries.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

/** Boots the app and checks that it asked for its service worker, once. */
async function boot(
  options: {
    path?: string;
    me?: Me | null;
    language?: Language;
    routes?: Record<string, ApiRouteHandler>;
  } = {},
) {
  const { path = '/login', me = null, language, routes } = options;
  const app = await open({
    path,
    server: { me, routes: { ...READER_READS, ...routes } },
    ...(language === undefined ? {} : { language }),
  });
  expect(libraries).toHaveLength(1);
  const [library] = libraries;
  if (library === undefined) throw new Error('the app did not register its service worker');
  return { app, library };
}

/** jsdom cannot reload a page, so the page's own `reload` is replaced. */
function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
}

function updateBar(): HTMLElement {
  return screen.getByTestId('update-bar');
}

const barCount = () => screen.queryAllByTestId('update-bar').length;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Moves `Date` only: the app, the router and the fake IndexedDB keep their real timers. */
function startClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
}

function returnAfter(ms: number) {
  vi.setSystemTime(T0 + ms);
  setVisibility('visible');
}

/** What another tab running a newer version of the app does to the offline database. */
async function anotherTabOpensTheOfflineDatabaseAt(version: number) {
  await offlineDb();
  await act(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.factory.open(OFFLINE_DB, version);
      request.onupgradeneeded = () => request.result.createObjectStore(`added-in-${version}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('the offline connection stayed open'));
    });
    database.close();
  });
}

async function anotherTabDeletesTheOfflineDatabase() {
  await offlineDb();
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = idb.factory.deleteDatabase(OFFLINE_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('the offline connection stayed open'));
    });
  });
}

describe('registering the service worker', () => {
  it('registers once for the page, whichever route it opens on and moves to', async () => {
    const { app } = await boot();
    expect(app.router.state.location.pathname).toBe('/login');

    await act(async () => {
      await app.router.navigate({ to: '/join' });
    });

    expect(app.router.state.location.pathname).toBe('/join');
    expect(libraries).toHaveLength(1);
  });

  it('registers on a signed-in screen too', async () => {
    const { app } = await boot({ path: '/read/for_you', me: makeMe() });

    expect(app.router.state.location.pathname).toBe('/read/for_you');
  });
});

describe('a new version of the app', () => {
  it.each(['en', 'sk'] as const)(
    'asks before reloading, in %s, and reloads when asked',
    async (language) => {
      const copy = COPY[language];
      const reload = stubReload();
      const { app, library } = await boot({ language });
      expect(barCount()).toBe(0);

      act(() => library.waiting());

      const bar = updateBar();
      expect(bar).toHaveTextContent(copy.ready);
      expect(bar).not.toHaveTextContent(copy.otherTab);
      expect(library.updateServiceWorker).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      await app.user.click(within(bar).getByRole('button', { name: copy.reload }));

      expect(library.updateServiceWorker).toHaveBeenCalledExactlyOnceWith(true);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it('stays on screen until it is dismissed', async () => {
    const { library } = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    act(() => library.waiting());
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(updateBar()).toHaveTextContent(COPY.en.ready);
  });

  it('keeps the running version when it is dismissed', async () => {
    const reload = stubReload();
    const { app, library } = await boot();
    act(() => library.waiting());

    await app.user.click(within(updateBar()).getByRole('button', { name: 'Dismiss' }));

    expect(barCount()).toBe(0);
    expect(library.updateServiceWorker).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('stays dismissed when the language changes', async () => {
    const { app, library } = await boot();
    act(() => library.waiting());
    await app.user.click(within(updateBar()).getByRole('button', { name: 'Dismiss' }));

    await act(async () => {
      await app.i18n.changeLanguage('sk');
    });

    expect(barCount()).toBe(0);
  });

  it('shows again when another tab then takes over', async () => {
    const { app, library } = await boot();
    act(() => library.waiting());
    await app.user.click(within(updateBar()).getByRole('button', { name: 'Dismiss' }));
    expect(barCount()).toBe(0);

    act(() => library.tookControl());

    expect(updateBar()).toHaveTextContent(COPY.en.otherTab);
  });

  it('keeps the height of the bar in a variable for the sticky parts below it', async () => {
    const { app, library } = await boot();
    const height = () => document.documentElement.style.getPropertyValue('--update-bar-height');
    expect(height()).toBe('');

    act(() => library.waiting());
    expect(height()).toBe('0px');

    await app.user.click(within(updateBar()).getByRole('button', { name: 'Dismiss' }));
    expect(height()).toBe('');
  });

  it('stays when the account signs out', async () => {
    const { app, library } = await boot({
      path: '/read/for_you',
      me: makeMe({ displayName: 'Ada Lovelace' }),
      routes: { 'POST /auth/logout': () => noContent() },
    });
    act(() => library.waiting());

    await app.user.click(screen.getByRole('button', { name: 'Account menu: Ada Lovelace' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'));
    expect(updateBar()).toHaveTextContent(COPY.en.ready);
  });

  it('is one bar however often a worker waits', async () => {
    const { library } = await boot();

    act(() => library.waiting());
    act(() => library.waiting());

    expect(screen.queryAllByTestId('update-bar')).toHaveLength(1);
  });

  it('does not reload a tab that another tab updated until it is asked to', async () => {
    const reload = stubReload();
    const { app, library } = await boot();
    act(() => library.waiting());

    act(() => library.tookControl());

    expect(reload).not.toHaveBeenCalled();
    expect(barCount()).toBe(1);
    const bar = updateBar();
    expect(bar).toHaveTextContent(COPY.en.otherTab);
    expect(bar).not.toHaveTextContent(COPY.en.ready);

    await app.user.click(within(bar).getByRole('button', { name: COPY.en.reload }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(library.updateServiceWorker).not.toHaveBeenCalled();
  });
});

describe('another tab moved the offline database to a newer version', () => {
  it.each(['en', 'sk'] as const)(
    'asks to reload, in %s, and reloads when asked',
    async (language) => {
      const copy = COPY[language];
      const reload = stubReload();
      const { app, library } = await boot({ language });
      expect(barCount()).toBe(0);

      await anotherTabOpensTheOfflineDatabaseAt(2);

      const bar = updateBar();
      expect(bar).toHaveTextContent(copy.otherTab);
      expect(reload).not.toHaveBeenCalled();

      await app.user.click(within(bar).getByRole('button', { name: copy.reload }));

      expect(reload).toHaveBeenCalledTimes(1);
      expect(library.updateServiceWorker).not.toHaveBeenCalled();
    },
  );

  it('takes the place of the update bar', async () => {
    const { library } = await boot();
    act(() => library.waiting());

    await anotherTabOpensTheOfflineDatabaseAt(2);

    expect(screen.queryAllByTestId('update-bar')).toHaveLength(1);
    expect(updateBar()).toHaveTextContent(COPY.en.otherTab);
    expect(updateBar()).not.toHaveTextContent(COPY.en.ready);
  });

  it('is not shown for a database that was deleted', async () => {
    await boot();

    await anotherTabDeletesTheOfflineDatabase();

    expect(barCount()).toBe(0);
  });
});

describe('a registration that does not work', () => {
  it('is silent when it fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { library } = await boot();

    act(() =>
      library.failed(new TypeError("Failed to execute 'register' on 'ServiceWorkerContainer'")),
    );

    expect(barCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('is silent when the browser gives no registration', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startClock();
    const { library } = await boot();

    act(() => library.registered(undefined));
    returnAfter(2 * HOUR);

    expect(barCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a tab left open', () => {
  async function registered(update: () => Promise<unknown> = vi.fn(() => Promise.resolve())) {
    startClock();
    const booted = await boot();
    act(() => booted.library.registered({ update } as unknown as ServiceWorkerRegistration));
    return { ...booted, update };
  }

  it('asks the registration for an update when the page returns after an hour', async () => {
    const { update } = await registered();
    setVisibility('hidden');
    expect(update).not.toHaveBeenCalled();

    returnAfter(HOUR);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the page returns within the hour', async () => {
    const { update } = await registered();
    setVisibility('hidden');

    returnAfter(HOUR - 1);

    expect(update).not.toHaveBeenCalled();
  });

  it('asks at most once an hour', async () => {
    const { update } = await registered();

    returnAfter(HOUR);
    returnAfter(HOUR + 1);
    returnAfter(2 * HOUR - 1);
    expect(update).toHaveBeenCalledTimes(1);

    returnAfter(2 * HOUR);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not ask while the page is hidden', async () => {
    const { update } = await registered();
    vi.setSystemTime(T0 + 2 * HOUR);

    setVisibility('hidden');

    expect(update).not.toHaveBeenCalled();
  });

  it('waits for the connection and asks when the page returns online', async () => {
    const { update } = await registered();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    returnAfter(2 * HOUR);
    expect(update).not.toHaveBeenCalled();

    online.mockReturnValue(true);
    returnAfter(2 * HOUR + 1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the check fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let asked = 0;
    await registered(() => {
      asked += 1;
      return Promise.reject(new TypeError('Failed to update a ServiceWorker'));
    });

    returnAfter(HOUR);
    await act(async () => {
      await Promise.resolve();
    });

    expect(asked).toBe(1);
    expect(barCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});
