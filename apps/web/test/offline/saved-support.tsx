import { onlineManager } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

import { viewKey } from '../../src/features/reader/view.js';
import { saveView, setOfflineEnabled } from '../../src/offline/cache.js';
import { resetOfflineDb } from '../../src/offline/db.js';
import type { DetailRow, ItemRow, ViewRow } from '../../src/offline/types.js';
import { createHarness } from '../auth/harness.js';
import { AS_OF, item, readerServer, setDesktop, type ReaderOptions } from '../reader/support.js';
import { A, dumpDatabase, rowsOf } from './support.js';

/** The view key of the For you lane, which is where the reader opens. */
export const FOR_YOU = viewKey({ kind: 'lane', lane: 'for_you' });

/** What the device's connection does, as the browser's `navigator.onLine` and the requests see it. */
export interface Connection {
  /** Whether requests reach the server. */
  reaches(): boolean;
  /** The device has no connection: the browser says so and every request fails. */
  lose(): void;
  /** The browser still says it is online, but no request reaches the server. */
  blackhole(): void;
  /** Requests reach the server again; nothing tells the browser. */
  heal(): void;
  /** The connection is back: requests succeed and the browser says so with an `online` event. */
  restore(): void;
}

export function connection(): Connection {
  const state = { browser: true, server: true };
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => state.browser);
  return {
    reaches: () => state.server,
    lose() {
      state.browser = false;
      state.server = false;
    },
    blackhole() {
      state.server = false;
    },
    heal() {
      state.server = true;
    },
    restore() {
      state.browser = true;
      state.server = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
    },
  };
}

/** The reader over a fake API whose requests fail, as they do offline, while the connection is lost. */
export function createSavedHarness() {
  const harness = createHarness();
  afterEach(() => {
    onlineManager.setOnline(true);
  });
  return {
    async open(net: Connection, options: ReaderOptions) {
      const { server, state } = readerServer(options);
      for (const [key, handler] of Object.entries(server.routes)) {
        server.routes[key] = (request, params) =>
          net.reaches()
            ? handler(request, params)
            : Promise.reject(new TypeError('Failed to fetch'));
      }
      setDesktop(options.desktop ?? true);
      const app = await harness.open({ path: options.path, server });
      return { app, state, server };
    },
  };
}

/** The list an earlier visit of an account that chose offline reading left on the device. */
export async function keepView(ids: number[], which = FOR_YOU, accountId = A) {
  await setOfflineEnabled(accountId, true);
  const kept = await saveView(
    accountId,
    which,
    ids.map((id) => item(id)),
    { asOf: AS_OF, datasetVersion: 'd-list' },
  );
  expect(kept).toBe(true);
}

/** Closes the page as leaving it does, so that the next one starts from what the device kept. */
export async function leave(app: { unmount(): void; session: { dispose(): void } }) {
  app.unmount();
  app.session.dispose();
  await resetOfflineDb();
}

async function stored<T>(factory: IDBFactory, store: string, name: string): Promise<T | undefined> {
  const found = rowsOf(await dumpDatabase(factory), A).find(
    ([where, key]) => where === store && key === `${A}:${name}`,
  );
  return found?.[2] as T | undefined;
}

/** The list the offline store holds for a view, as raw IndexedDB has it. */
export const storedView = (factory: IDBFactory, which: string) =>
  stored<ViewRow>(factory, 'views', which);

export const storedItem = (factory: IDBFactory, id: string) =>
  stored<ItemRow>(factory, 'items', id);

export const storedDetail = (factory: IDBFactory, id: string) =>
  stored<DetailRow>(factory, 'details', id);

/** Waits until the offline store holds exactly these articles, in this order, for the view. */
export async function viewReaches(factory: IDBFactory, ids: string[], which = FOR_YOU) {
  await vi.waitFor(
    async () => {
      expect((await storedView(factory, which))?.itemIds).toEqual(ids);
    },
    { timeout: 5000 },
  );
}
