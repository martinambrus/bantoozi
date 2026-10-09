import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { createI18n } from '../../src/i18n/index.js';
import type * as CacheModule from '../../src/offline/cache.js';
import { readMe } from '../../src/offline/cache.js';
import { writeLastAccount, writeOfflineEnabled } from '../../src/offline/device.js';
import { SESSION_CHANNEL, createSession, type Session } from '../../src/session/session.js';
import { fakeFetch } from '../api/fake-fetch.js';
import { USER_A_ID, makeMe } from './fixtures.js';

// The saved account is read when the test says so.
vi.mock('../../src/offline/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheModule>()),
  readMe: vi.fn(),
}));

const sessions: Session[] = [];
const channels: BroadcastChannel[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const channel of channels.splice(0)) channel.close();
  localStorage.clear();
  vi.mocked(readMe).mockReset();
});

describe('an offline start', () => {
  it('leaves nobody signed in when another tab signs out while the saved account is read', async () => {
    const ada = makeMe({ id: USER_A_ID });
    writeLastAccount(USER_A_ID);
    writeOfflineEnabled(USER_A_ID, true);
    let found!: (saved: { me: Me; savedAt: number }) => void;
    vi.mocked(readMe).mockImplementation(
      () =>
        new Promise((resolve) => {
          found = resolve;
        }),
    );
    const fake = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
    sessions.push(session);
    const tab = new BroadcastChannel(SESSION_CHANNEL);
    channels.push(tab);

    const loading = session.loadMe();
    await vi.waitFor(() => expect(readMe).toHaveBeenCalledWith(USER_A_ID));
    tab.postMessage({ type: 'reset' });
    await vi.waitFor(() => expect(queryClient.getQueryData(meKey())).toBeNull());
    found({ me: ada, savedAt: Date.now() });

    await expect(loading).resolves.toBeNull();
    expect(queryClient.getQueryData(meKey())).toBeNull();
  });
});
