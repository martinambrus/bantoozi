import { describe, expect, it, vi } from 'vitest';

import type * as CacheModule from '../../src/offline/cache.js';
import { readMe, setOfflineEnabled } from '../../src/offline/cache.js';
import { A, dumpDatabase, freshIndexedDb, rowsOf } from '../offline/support.js';
import { makeMe } from './fixtures.js';
import { trackSessions } from './support.js';

// The removal of what earlier sign-outs left on the device, held until the test lets it finish.
const purges = vi.hoisted(() => ({ held: Promise.resolve() }));

vi.mock('../../src/offline/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CacheModule>();
  return {
    ...actual,
    finishPendingPurges: async () => {
      await purges.held;
      await actual.finishPendingPurges();
    },
  };
});

const userA = makeMe();
const idb = freshIndexedDb();
const sessions = trackSessions();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('keeping the account for an offline start', () => {
  it('keeps nothing of an account that signed out while earlier removals still ran', async () => {
    await setOfflineEnabled(A, true);
    let release!: () => void;
    purges.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = sessions.start({ me: userA });
    await session.loadMe();

    await session.logout();
    release();
    await settle();

    expect(await readMe(A)).toBeNull();
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
  });

  it('keeps the account that stays signed in once the earlier removals are done', async () => {
    await setOfflineEnabled(A, true);
    let release!: () => void;
    purges.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = sessions.start({ me: userA });
    await session.loadMe();

    release();

    await vi.waitFor(async () => expect(await readMe(A)).toMatchObject({ me: userA }));
  });
});
