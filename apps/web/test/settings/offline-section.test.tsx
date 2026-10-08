import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { readMe, saveDetail, saveView, setOfflineEnabled } from '../../src/offline/cache.js';
import { resetOfflineDb } from '../../src/offline/db.js';
import { isOfflineEnabled } from '../../src/offline/device.js';
import { listRecords, putRecord } from '../../src/offline/queue.js';
import {
  A,
  B,
  VIEW,
  allRows,
  dumpDatabase,
  fullDetail,
  itemList,
  makeRecord,
  rowCount,
  rowsOf,
  freshIndexedDb,
} from '../offline/support.js';
import { makeMe } from '../session/fixtures.js';
import { EMAIL, openSettings, section } from './support.js';

const idb = freshIndexedDb();

const offline = (name = 'Offline reading') => section(name);
const toggle = (name = 'Keep articles on this device') =>
  within(offline()).getByRole('switch', { name });
const clearButton = () =>
  within(offline()).getByRole('button', { name: 'Clear downloaded articles' });

/** Unsent actions stay unsent only while the browser is offline: online, the app sends them at once. */
async function unsent(...ids: string[]) {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => {
    online.mockRestore();
  });
  for (const id of ids) await putRecord(makeRecord(id));
}

/** An account that chose offline reading, with 3 list items, 1 opened article and `records` unsent actions. */
async function storedArticles(records = 0) {
  await setOfflineEnabled(A, true);
  await saveView(A, 'view', itemList(3), VIEW);
  await saveDetail(A, fullDetail({ id: '50' }));
  if (records > 0)
    await unsent(...Array.from({ length: records }, (_unused, index) => `m${index + 1}`));
}

const discardDialog = () => screen.findByRole('dialog', { name: 'Discard unsent changes?' });
const storedRows = async () => {
  const dump = await dumpDatabase(idb.factory);
  return {
    items: rowCount(dump, 'items'),
    views: rowCount(dump, 'views'),
    details: rowCount(dump, 'details'),
    queue: rowCount(dump, 'queue'),
  };
};

describe('the Offline reading section', () => {
  it('is off by default, says what turning it on means and has stored nothing', async () => {
    await openSettings();

    const region = offline();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    for (const part of [
      '24 hours',
      'Anyone who uses this browser can read them',
      'only for the last account that signed in here',
      'bookmarked on the server are separate',
    ]) {
      expect(toggle()).toHaveAccessibleDescription(expect.stringContaining(part));
    }
    expect(within(region).getByText(/Offline reading is off/)).toBeVisible();
    expect(clearButton()).toBeDisabled();
    expect(isOfflineEnabled(A)).toBe(false);
    expect(allRows(await dumpDatabase(idb.factory))).toEqual([]);
  });

  it('turns on for this account only, and keeps the account for an offline start', async () => {
    const { user } = await openSettings();

    await user.click(toggle());

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'));
    expect(isOfflineEnabled(A)).toBe(true);
    expect(isOfflineEnabled(B)).toBe(false);
    expect(await within(offline()).findByText('0 articles stored on this device')).toBeVisible();
    expect(within(offline()).queryByText(/Offline reading is off/)).not.toBeInTheDocument();
    await vi.waitFor(async () => expect((await readMe(A))?.me.email).toBe(EMAIL));
  });

  it('shows how much is stored and how many changes were not sent', async () => {
    await storedArticles(2);

    await openSettings();

    const region = offline();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(await within(region).findByText('4 articles stored on this device')).toBeVisible();
    expect(within(region).getByText('2 changes have not been sent yet')).toBeVisible();
    expect(within(region).getByText(/of 10\.5 MB used/)).toBeVisible();
    expect(clearButton()).toBeEnabled();
  });

  it('uses the singular for one article and one change', async () => {
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail({ id: '50' }));
    await unsent('m1');

    await openSettings();

    expect(await within(offline()).findByText('1 article stored on this device')).toBeVisible();
    expect(within(offline()).getByText('1 change has not been sent yet')).toBeVisible();
  });

  describe('Clear downloaded articles', () => {
    it('clears at once when nothing is waiting to be sent', async () => {
      await storedArticles();
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');

      await user.click(clearButton());

      expect(await within(offline()).findByText('0 articles stored on this device')).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await storedRows()).toEqual({ items: 0, views: 0, details: 0, queue: 0 });
      expect(within(offline()).getByText('Downloaded articles cleared.')).toBeVisible();
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
      expect(isOfflineEnabled(A)).toBe(true);
    });

    it('asks first when changes were not sent, and keeps everything on Cancel', async () => {
      await storedArticles(2);
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');

      await user.click(clearButton());

      const dialog = await discardDialog();
      expect(
        within(dialog).getByText('2 changes have not been sent yet and will be discarded.'),
      ).toBeVisible();
      expect(await storedRows()).toEqual({ items: 3, views: 1, details: 1, queue: 2 });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await storedRows()).toEqual({ items: 3, views: 1, details: 1, queue: 2 });
      expect(await listRecords(A)).toHaveLength(2);
    });

    it('discards the articles and the unsent changes once confirmed', async () => {
      await storedArticles(2);
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');
      await user.click(clearButton());

      await user.click(
        within(await discardDialog()).getByRole('button', { name: 'Clear and discard' }),
      );

      expect(await within(offline()).findByText('0 articles stored on this device')).toBeVisible();
      expect(within(offline()).queryByText(/have not been sent yet/)).not.toBeInTheDocument();
      expect(await storedRows()).toEqual({ items: 0, views: 0, details: 0, queue: 0 });
      expect(await listRecords(A)).toEqual([]);
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('turning it off', () => {
    it('removes what was stored at once when nothing is waiting to be sent', async () => {
      await storedArticles();
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');

      await user.click(toggle());

      await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(isOfflineEnabled(A)).toBe(false);
      expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
      expect(await within(offline()).findByText(/Offline reading is off/)).toBeVisible();
    });

    it('asks first when changes were not sent, and stays on after Cancel', async () => {
      await storedArticles(2);
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');

      await user.click(toggle());

      const dialog = await discardDialog();
      expect(
        within(dialog).getByText('2 changes have not been sent yet and will be discarded.'),
      ).toBeVisible();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(toggle()).toHaveAttribute('aria-checked', 'true');
      expect(isOfflineEnabled(A)).toBe(true);
      expect(await listRecords(A)).toHaveLength(2);
    });

    it('discards the unsent changes and everything stored once confirmed', async () => {
      await storedArticles(2);
      const { user } = await openSettings();
      await within(offline()).findByText('4 articles stored on this device');
      await user.click(toggle());

      await user.click(
        within(await discardDialog()).getByRole('button', { name: 'Turn off and discard' }),
      );

      await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
      expect(isOfflineEnabled(A)).toBe(false);
      expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
    });
  });

  describe('a browser that cannot store articles', () => {
    it('says it is not available and turns nothing on', async () => {
      vi.stubGlobal('indexedDB', undefined);
      await resetOfflineDb();

      await openSettings();

      const region = offline();
      expect(within(region).getByText('Not available in this browser')).toBeVisible();
      expect(toggle()).toBeDisabled();
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
      expect(clearButton()).toBeDisabled();
      expect(isOfflineEnabled(A)).toBe(false);
    });

    it('says so when turning it on finds that the store cannot be opened', async () => {
      const { user } = await openSettings();
      expect(
        within(offline()).queryByText('Not available in this browser'),
      ).not.toBeInTheDocument();
      vi.stubGlobal('indexedDB', {
        open: () => {
          throw new DOMException('Access is denied.', 'SecurityError');
        },
      });
      await resetOfflineDb();

      await user.click(toggle());

      expect(await within(offline()).findByText('Not available in this browser')).toBeVisible();
      expect(toggle()).toHaveAttribute('aria-checked', 'false');
      expect(isOfflineEnabled(A)).toBe(false);
      expect(within(offline()).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('does not create the store for an account that has not turned it on', async () => {
      await openSettings();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(await idb.factory.databases()).toEqual([]);
    });
  });

  describe('in Slovak', () => {
    const slovak = () => makeMe({ email: EMAIL, locale: 'sk' });

    it('has a section named and explained in the language of the account', async () => {
      await openSettings({ me: slovak() });

      const region = await screen.findByRole('region', { name: 'Čítanie offline' });
      expect(
        within(region).getByRole('switch', { name: 'Uchovávať články v tomto zariadení' }),
      ).toHaveAttribute('aria-checked', 'false');
      expect(
        within(region).getByRole('button', { name: 'Vymazať stiahnuté články' }),
      ).toBeVisible();
    });

    it.each([
      [1, '1 zmena ešte nebola odoslaná'],
      [2, '2 zmeny ešte neboli odoslané'],
      [5, '5 zmien ešte nebolo odoslaných'],
    ])('counts %i unsent changes with the right plural', async (count, text) => {
      await storedArticles(count);

      await openSettings({ me: slovak() });

      const region = await screen.findByRole('region', { name: 'Čítanie offline' });
      expect(await within(region).findByText('4 články uložené v tomto zariadení')).toBeVisible();
      expect(within(region).getByText(text)).toBeVisible();
    });
  });
});

describe('the delete account dialog', () => {
  const open = async (records: number) => {
    await storedArticles(records);
    const app = await openSettings();
    await app.user.click(screen.getByRole('button', { name: 'Delete my account…' }));
    return within(await screen.findByRole('dialog', { name: 'Delete your account?' }));
  };

  it('names the changes that were not sent, which are lost with the account', async () => {
    const dialog = await open(2);

    expect(
      await dialog.findByText('2 changes have not been sent yet and will be lost.'),
    ).toBeVisible();
  });

  it('uses the singular for one change', async () => {
    const dialog = await open(1);

    expect(
      await dialog.findByText('1 change has not been sent yet and will be lost.'),
    ).toBeVisible();
  });

  it('says nothing of it when every change was sent', async () => {
    const dialog = await open(0);

    await dialog.findByText(/Sign in again within 7 days/);
    expect(dialog.queryByText(/have not been sent yet/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/has not been sent yet/)).not.toBeInTheDocument();
  });
});
