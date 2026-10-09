import type { ArticleDetail, ArticleListItem } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  clearAccount,
  offlineUsage,
  readDetail,
  readMe,
  readView,
  saveDetail,
  saveMe,
  saveView,
  setOfflineEnabled,
} from '../../src/offline/cache.js';
import { isOfflineEnabled } from '../../src/offline/device.js';
import {
  countRecords,
  deleteRecord,
  listRecords,
  putRecord,
  setRecordsState,
} from '../../src/offline/queue.js';
import { makeMe } from '../session/fixtures.js';
import {
  A,
  B,
  DAY,
  MIB,
  T0,
  VIEW,
  allRows,
  bigDetail,
  cachedBytes,
  dumpDatabase,
  fullDetail,
  fullItem,
  itemList,
  makeRecord,
  rowCount,
  rowsOf,
  setClock,
  freshIndexedDb,
} from './support.js';

const idb = freshIndexedDb();

const ids = (items: readonly { id: string }[] | undefined) => (items ?? []).map((item) => item.id);

describe('the opt-in', () => {
  it('is off by default and stores nothing', async () => {
    expect(isOfflineEnabled(A)).toBe(false);

    expect(await saveView(A, 'view', [fullItem()], VIEW)).toBe(false);
    expect(await saveDetail(A, fullDetail())).toBe(false);
    expect(await saveMe(A, makeMe())).toBe(false);
    expect(await putRecord(makeRecord('m1'))).toBe(false);

    expect(allRows(await dumpDatabase(idb.factory))).toEqual([]);
    expect(await readView(A, 'view')).toBeNull();
    expect(await readDetail(A, '101')).toBeNull();
    expect(await listRecords(A)).toEqual([]);
  });

  it('stores once the account turned it on, and for that account only', async () => {
    expect(await setOfflineEnabled(A, true)).toBe(true);

    expect(isOfflineEnabled(A)).toBe(true);
    expect(isOfflineEnabled(B)).toBe(false);
    expect(await saveView(A, 'view', [fullItem()], VIEW)).toBe(true);
    expect(await saveView(B, 'view', [fullItem()], VIEW)).toBe(false);
    expect(await saveDetail(A, fullDetail())).toBe(true);
    expect(await putRecord(makeRecord('m1'))).toBe(true);
    expect(await putRecord(makeRecord('m2', { accountId: B }))).toBe(false);

    const dump = await dumpDatabase(idb.factory);
    expect(rowsOf(dump, A).length).toBeGreaterThan(0);
    expect(rowsOf(dump, B)).toEqual([]);
    expect(ids((await readView(A, 'view'))?.items)).toEqual(['101']);
  });

  it('removes the stored data of the account when it is turned off', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await saveView(A, 'view', [fullItem()], VIEW);
    await saveDetail(A, fullDetail());
    await putRecord(makeRecord('m1'));
    await saveView(B, 'view', [fullItem()], VIEW);

    expect(await setOfflineEnabled(A, false)).toBe(true);

    const dump = await dumpDatabase(idb.factory);
    expect(isOfflineEnabled(A)).toBe(false);
    expect(rowsOf(dump, A)).toEqual([]);
    expect(rowsOf(dump, B).length).toBeGreaterThan(0);
    expect(await saveView(A, 'view', [fullItem()], VIEW)).toBe(false);
  });

  it('does not open the database for an account that never turned it on', async () => {
    expect(await clearAccount(A)).toBe(true);
    expect(await offlineUsage(A)).toEqual({ articles: 0, bytes: 0, unsent: 0 });

    expect(await idb.factory.databases()).toEqual([]);
  });
});

describe('what is read back', () => {
  it('is the saved view with its dataset, and the saved opened article', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', itemList(3), VIEW);
    await saveDetail(A, fullDetail());

    const view = await readView(A, 'view');
    const detail = await readDetail(A, '101');

    expect(ids(view?.items)).toEqual(['1', '2', '3']);
    expect(view).toMatchObject({ ...VIEW, savedAt: T0 });
    expect(detail?.bodyLead).toBe('The lead of the article.');
    expect(await readView(A, 'other-view')).toBeNull();
    expect(await readDetail(A, '999')).toBeNull();
  });

  it('is kept apart for each account', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await saveView(A, 'view', [fullItem({ id: '1' })], VIEW);
    await saveView(B, 'view', [fullItem({ id: '2' })], VIEW);

    expect(ids((await readView(A, 'view'))?.items)).toEqual(['1']);
    expect(ids((await readView(B, 'view'))?.items)).toEqual(['2']);
  });

  it('keeps the account for an offline start and drops it with the rest', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    const me = makeMe();

    expect(await saveMe(A, me)).toBe(true);

    expect(await readMe(A)).toEqual({ me, savedAt: T0 });
    expect(await readMe(B)).toBeNull();
    await clearAccount(A);
    expect(await readMe(A)).toBeNull();
  });
});

describe('expiry', () => {
  it('keeps a list and an opened article until 24 hours after they were saved', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [fullItem()], VIEW);
    await saveDetail(A, fullDetail());
    await saveMe(A, makeMe());

    setClock(T0 + DAY - 1);

    expect(ids((await readView(A, 'view'))?.items)).toEqual(['101']);
    expect(await readDetail(A, '101')).not.toBeNull();
    expect(await readMe(A)).not.toBeNull();
  });

  it('drops them for good once 24 hours have passed', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [fullItem()], VIEW);
    await saveDetail(A, fullDetail());
    await saveMe(A, makeMe());
    expect(await readView(A, 'view')).not.toBeNull();
    expect(await readDetail(A, '101')).not.toBeNull();
    expect(await readMe(A)).not.toBeNull();

    setClock(T0 + DAY + 1);

    expect(await readView(A, 'view')).toBeNull();
    expect(await readDetail(A, '101')).toBeNull();
    expect(await readMe(A)).toBeNull();
    const dump = await dumpDatabase(idb.factory);
    expect(rowCount(dump, 'views')).toBe(0);
    expect(rowCount(dump, 'details')).toBe(0);
    expect(rowCount(dump, 'meta')).toBe(0);
    expect(await offlineUsage(A)).toEqual({ articles: 0, bytes: 0, unsent: 0 });
  });

  it('counts from the last save of an entry', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail());
    setClock(T0 + DAY - 1000);
    await saveDetail(A, fullDetail());

    setClock(T0 + DAY + 1);

    expect(await readDetail(A, '101')).not.toBeNull();
  });

  it('removes expired entries of every kind when something is saved', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'old', itemList(3), VIEW);
    await saveDetail(A, fullDetail({ id: '50' }));

    setClock(T0 + DAY + 1);
    await saveDetail(A, fullDetail({ id: '51' }));

    const dump = await dumpDatabase(idb.factory);
    expect(rowCount(dump, 'items')).toBe(0);
    expect(rowCount(dump, 'views')).toBe(0);
    expect(rowCount(dump, 'details')).toBe(1);
  });

  it('does not count what expired in the usage', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', itemList(3), VIEW);
    expect((await offlineUsage(A)).articles).toBe(3);

    setClock(T0 + DAY + 1);

    expect((await offlineUsage(A)).articles).toBe(0);
  });
});

describe('the size limits', () => {
  it('keeps at most 200 items per account, the top of the list first', async () => {
    await setOfflineEnabled(A, true);

    await saveView(A, 'all', itemList(201), VIEW);

    const dump = await dumpDatabase(idb.factory);
    const view = await readView(A, 'all');
    expect(rowCount(dump, 'items')).toBe(200);
    expect(view?.items).toHaveLength(200);
    expect(ids(view?.items)[0]).toBe('1');
    expect(ids(view?.items).at(-1)).toBe('200');
    expect((await offlineUsage(A)).articles).toBe(200);
  });

  it('drops the items saved longest ago first, the bottom of a list before its top', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'first', itemList(150, 1), VIEW);
    setClock(T0 + 1000);

    await saveView(A, 'second', itemList(60, 1000), VIEW);

    const first = ids((await readView(A, 'first'))?.items);
    const second = ids((await readView(A, 'second'))?.items);
    expect(first).toHaveLength(140);
    expect(first[0]).toBe('1');
    expect(first.at(-1)).toBe('140');
    expect(second).toHaveLength(60);
    expect(rowCount(await dumpDatabase(idb.factory), 'items')).toBe(200);
  });

  it('breaks a tie by the order of saving', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'first', itemList(150, 1), VIEW);

    await saveView(A, 'second', itemList(60, 1000), VIEW);

    const first = ids((await readView(A, 'first'))?.items);
    expect(first).toHaveLength(140);
    expect(first.at(-1)).toBe('140');
    expect(ids((await readView(A, 'second'))?.items)).toHaveLength(60);
  });

  it('keeps a refreshed item longer than the ones that were not saved again', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'first', itemList(150, 1), VIEW);
    setClock(T0 + 1000);
    await saveView(A, 'again', [fullItem({ id: '150' })], VIEW);
    setClock(T0 + 2000);

    await saveView(A, 'second', itemList(60, 1000), VIEW);

    const first = ids((await readView(A, 'first'))?.items);
    expect(first).toContain('150');
    expect(first).not.toContain('149');
    expect(first).toContain('139');
  });

  it('stays within 10 MiB, dropping the oldest articles first', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);

    for (let index = 1; index <= 12; index += 1) {
      setClock(T0 + index * 1000);
      expect(await saveDetail(A, bigDetail(String(index), MIB))).toBe(true);
    }

    const dump = await dumpDatabase(idb.factory);
    const kept = rowCount(dump, 'details');
    expect(cachedBytes(dump, A)).toBeLessThanOrEqual(10 * MIB);
    expect((await offlineUsage(A)).bytes).toBeLessThanOrEqual(10 * MIB);
    expect(kept).toBeGreaterThanOrEqual(8);
    expect(kept).toBeLessThan(12);
    expect(await readDetail(A, '1')).toBeNull();
    expect(await readDetail(A, '2')).toBeNull();
    expect(await readDetail(A, '12')).not.toBeNull();
    expect(await readDetail(A, String(12 - kept + 1))).not.toBeNull();
    expect(await readDetail(A, String(12 - kept))).toBeNull();
  });

  it('does not store a single article that is bigger than the limit', async () => {
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail({ id: '7' }));

    expect(await saveDetail(A, bigDetail('8', 11 * MIB))).toBe(false);

    expect(await readDetail(A, '7')).not.toBeNull();
    expect(await readDetail(A, '8')).toBeNull();
  });

  it('counts the limits for each account on its own', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await saveView(B, 'view', itemList(150, 5000), VIEW);

    await saveView(A, 'all', itemList(200), VIEW);

    expect(ids((await readView(B, 'view'))?.items)).toHaveLength(150);
    expect(ids((await readView(A, 'all'))?.items)).toHaveLength(200);
  });

  it('reports what is stored', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', itemList(3), VIEW);
    await saveDetail(A, fullDetail({ id: '2' }));
    await saveDetail(A, fullDetail({ id: '50' }));
    await putRecord(makeRecord('m1'));
    await putRecord(makeRecord('m2'));

    const usage = await offlineUsage(A);

    const stored = cachedBytes(await dumpDatabase(idb.factory), A);
    expect(usage.articles).toBe(4);
    expect(usage.unsent).toBe(2);
    expect(usage.bytes).toBeGreaterThanOrEqual(stored);
    expect(usage.bytes).toBeLessThan(stored + 64);
  });
});

describe('the queue of unsent actions', () => {
  it('is never evicted, never expires and does not count against the size limits', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    const records = [
      makeRecord('m1'),
      makeRecord('m2', { state: 'frozen', createdAt: T0 - 5 * DAY, articleId: '202' }),
      makeRecord('m3', { action: { type: 'read' }, createdAt: T0 + 5 }),
    ];
    for (const record of records) expect(await putRecord(record)).toBe(true);

    await saveView(A, 'all', itemList(250), VIEW);
    for (let index = 1; index <= 12; index += 1) {
      setClock(T0 + index * 1000);
      await saveDetail(A, bigDetail(String(index), MIB));
    }
    setClock(T0 + 3 * DAY);
    await saveDetail(A, fullDetail({ id: '900' }));

    expect(await listRecords(A)).toEqual([records[1], records[0], records[2]]);
    expect(await countRecords(A)).toBe(3);
    expect(rowCount(await dumpDatabase(idb.factory), 'queue')).toBe(3);
  });

  it('lists the records of one account by the time they were created', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await putRecord(makeRecord('late', { createdAt: T0 + 20 }));
    await putRecord(makeRecord('early', { createdAt: T0 + 10 }));
    await putRecord(makeRecord('other', { accountId: B, createdAt: T0 }));

    expect((await listRecords(A)).map((record) => record.id)).toEqual(['early', 'late']);
    expect(await countRecords(A)).toBe(2);
    expect(await countRecords(B)).toBe(1);
  });

  it('replaces a record that is saved again and deletes one by its id', async () => {
    await setOfflineEnabled(A, true);
    await putRecord(makeRecord('m1'));
    await putRecord(makeRecord('m2'));

    await putRecord(makeRecord('m1', { attempts: 2, state: 'sending' }));
    await deleteRecord(A, 'm2');

    expect(await listRecords(A)).toEqual([makeRecord('m1', { attempts: 2, state: 'sending' })]);
  });

  it('is frozen and thawed for the whole account at once', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await putRecord(makeRecord('m1'));
    await putRecord(makeRecord('m2', { state: 'sending' }));
    await putRecord(makeRecord('m3', { accountId: B }));

    expect(await setRecordsState(A, 'frozen')).toBe(2);

    expect((await listRecords(A)).map((record) => record.state)).toEqual(['frozen', 'frozen']);
    expect((await listRecords(B)).map((record) => record.state)).toEqual(['pending']);
    expect(await setRecordsState(A, 'pending')).toBe(2);
    expect((await listRecords(A)).map((record) => record.state)).toEqual(['pending', 'pending']);
  });
});

describe('clearing an account', () => {
  it('removes its rows from every store and leaves the other account alone', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    for (const id of [A, B]) {
      await saveView(id, 'view', itemList(3), VIEW);
      await saveDetail(id, fullDetail());
      await saveMe(id, makeMe({ id }));
      await putRecord(makeRecord('m1', { accountId: id }));
    }
    const before = await dumpDatabase(idb.factory);
    expect(rowsOf(before, A).length).toBeGreaterThanOrEqual(6);

    expect(await clearAccount(A)).toBe(true);

    const after = await dumpDatabase(idb.factory);
    expect(rowsOf(after, A)).toEqual([]);
    expect(rowsOf(after, B)).toEqual(rowsOf(before, B));
    expect(rowsOf(after, B).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the choice of the account, which is not data', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', itemList(2), VIEW);

    await clearAccount(A);

    expect(isOfflineEnabled(A)).toBe(true);
    expect(await saveView(A, 'view', itemList(2), VIEW)).toBe(true);
  });

  it('is not undone by a save or a queued action that began before it', async () => {
    await setOfflineEnabled(A, true);
    expect(await saveView(A, 'view', itemList(1), VIEW)).toBe(true);
    expect(await putRecord(makeRecord('m0'))).toBe(true);

    const lateSave = saveView(A, 'late', itemList(2), VIEW);
    const lateRecord = putRecord(makeRecord('m1'));
    await clearAccount(A);

    expect(await lateSave).toBe(false);
    expect(await lateRecord).toBe(false);
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
  });

  it('keeps the database and the other account usable', async () => {
    await setOfflineEnabled(A, true);
    await setOfflineEnabled(B, true);
    await saveView(A, 'view', itemList(2), VIEW);

    await clearAccount(A);
    await saveView(B, 'view', itemList(2), VIEW);

    expect(await idb.factory.databases()).toHaveLength(1);
    expect(ids((await readView(B, 'view'))?.items)).toEqual(['1', '2']);
  });
});

describe('rows that hold a newer state', () => {
  const READ = '2026-10-08T07:30:00.000Z';
  const row = (version: string, patch: Partial<ArticleListItem> = {}) =>
    fullItem({ id: '1', stateVersion: version, ...patch });
  const first = async (view: string) => (await readView(A, view))?.items[0];

  it('are not taken back by a list that was read before that state', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'later', [row('5', { rating: 1, reason: null, readAt: READ })], VIEW);

    await saveView(A, 'earlier', [row('4', { rating: null, reason: null, readAt: null })], VIEW);

    expect(await first('later')).toMatchObject({ stateVersion: '5', rating: 1, readAt: READ });
    expect(await first('earlier')).toMatchObject({ stateVersion: '5', rating: 1, readAt: READ });
  });

  it('are replaced by a list that holds the same state or a newer one', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [row('5', { title: 'Stored' })], VIEW);

    await saveView(A, 'view', [row('5', { title: 'Same state' })], VIEW);
    expect((await first('view'))?.title).toBe('Same state');

    await saveView(A, 'view', [row('6', { title: 'Newer state' })], VIEW);
    expect(await first('view')).toMatchObject({ title: 'Newer state', stateVersion: '6' });
  });

  it('are compared by content revision when the state versions are equal', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [row('5', { contentRevision: '3', title: 'Revision 3' })], VIEW);

    await saveView(A, 'view', [row('5', { contentRevision: '2', title: 'Revision 2' })], VIEW);
    expect(await first('view')).toMatchObject({ contentRevision: '3', title: 'Revision 3' });

    await saveView(A, 'view', [row('5', { contentRevision: '4', title: 'Revision 4' })], VIEW);
    expect(await first('view')).toMatchObject({ contentRevision: '4', title: 'Revision 4' });
  });

  it('are compared as numbers, not as text', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [row('10', { title: 'Tenth' })], VIEW);

    await saveView(A, 'view', [row('9', { title: 'Ninth' })], VIEW);

    expect(await first('view')).toMatchObject({ stateVersion: '10', title: 'Tenth' });
  });

  it('are kept one by one, and the others of the list are written as before', async () => {
    await setOfflineEnabled(A, true);
    const at = (id: string, version: string) => fullItem({ id, stateVersion: version });
    await saveView(A, 'view', [at('1', '5'), at('2', '5')], VIEW);

    await saveView(A, 'other', [at('1', '4'), at('2', '6'), at('3', '1')], VIEW);

    const items = (await readView(A, 'other'))?.items ?? [];
    expect(items.map((item) => [item.id, item.stateVersion])).toEqual([
      ['1', '5'],
      ['2', '6'],
      ['3', '1'],
    ]);
  });

  it('do not hold a list back once they have expired', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [row('5', { title: 'Stored' })], VIEW);
    setClock(T0 + DAY + 1);

    await saveView(A, 'view', [row('4', { title: 'Fresh' })], VIEW);

    expect(await first('view')).toMatchObject({ stateVersion: '4', title: 'Fresh' });
  });

  it('are as old as the last list that holds them, which keeps them from expiring early', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveView(A, 'view', [row('5')], VIEW);
    setClock(T0 + DAY - 1000);
    await saveView(A, 'view', [row('4')], VIEW);

    setClock(T0 + DAY + 1);

    expect(await first('view')).toMatchObject({ stateVersion: '5' });
  });
});

describe('an article that two views show', () => {
  // The same article through two feeds: one blocks images and has not analysed it, one shows them.
  const blocking = fullItem({
    id: '1',
    feed: { id: '7', title: 'Blocking Weekly', iconUrl: null },
    firstSeenAt: '2026-05-31T08:05:00.000Z',
    mediaPolicyFeedId: '7',
    effectiveImagesAllowed: false,
    analysis: { mode: 'off', status: 'not_requested', requestId: null },
    stateVersion: '5',
    rating: 1,
  });
  const allowing = fullItem({
    id: '1',
    feed: { id: '5', title: 'Pictures Daily', iconUrl: 'https://example.test/5.png' },
    firstSeenAt: '2026-05-31T09:00:00.000Z',
    mediaPolicyFeedId: '5',
    effectiveImagesAllowed: true,
    analysis: { mode: 'training', status: 'complete', requestId: null },
    stateVersion: '4',
    rating: null,
  });
  const shownBy = (item: ArticleListItem) => ({
    feed: item.feed,
    firstSeenAt: item.firstSeenAt,
    mediaPolicyFeedId: item.mediaPolicyFeedId,
    effectiveImagesAllowed: item.effectiveImagesAllowed,
    analysis: item.analysis,
  });
  const first = async (view: string) => (await readView(A, view))?.items[0];

  it('keeps what a view showed when another view saves the article later', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'feed:7', [{ ...blocking, stateVersion: '4', rating: null }], VIEW);
    await saveView(A, 'feed:5', [allowing], VIEW);

    expect(await first('feed:7')).toMatchObject(shownBy(blocking));
    expect(await first('feed:5')).toMatchObject(shownBy(allowing));
  });

  it('is read back in each view as that view showed it, with the newest reader state', async () => {
    await setOfflineEnabled(A, true);
    await saveView(A, 'feed:7', [blocking], VIEW);
    await saveView(A, 'feed:5', [allowing], VIEW);

    expect(await first('feed:7')).toMatchObject({
      ...shownBy(blocking),
      stateVersion: '5',
      rating: 1,
    });
    expect(await first('feed:5')).toMatchObject({
      ...shownBy(allowing),
      stateVersion: '5',
      rating: 1,
    });
  });
});

describe('the saved copy of a bookmark', () => {
  const SNAPSHOT = fullDetail().bookmarkSnapshot;
  /** The article as a view other than Bookmarks reads it: bookmarked, without the saved copy. */
  const fromLane = (overrides: Partial<ArticleDetail> = {}) =>
    fullDetail({ bookmarkSnapshot: null, ...overrides });

  it('stays when the article is saved again as another view reads it', async () => {
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail());
    await saveDetail(A, fromLane({ bodyLead: 'The newer lead.' }));

    const detail = await readDetail(A, '101');
    expect(detail?.bodyLead).toBe('The newer lead.');
    expect(detail?.bookmarkSnapshot).toEqual(SNAPSHOT);
  });

  it('is replaced by the copy the Bookmarks view reads next', async () => {
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail());
    const next = { ...SNAPSHOT!, id: '10', text: 'The text saved again.' };
    await saveDetail(A, fullDetail({ bookmarkSnapshot: next }));

    expect((await readDetail(A, '101'))?.bookmarkSnapshot).toEqual(next);
  });

  it('goes with the bookmark, and does not pass to a later bookmark', async () => {
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail());
    await saveDetail(A, fromLane({ bookmarkedAt: null }));
    expect((await readDetail(A, '101'))?.bookmarkSnapshot).toBeNull();

    await saveDetail(A, fullDetail());
    await saveDetail(A, fromLane({ bookmarkedAt: '2026-06-01T10:00:00.000Z' }));
    expect((await readDetail(A, '101'))?.bookmarkSnapshot).toBeNull();
  });

  it('is not taken from a copy that has expired', async () => {
    setClock(T0);
    await setOfflineEnabled(A, true);
    await saveDetail(A, fullDetail());
    setClock(T0 + DAY);

    await saveDetail(A, fromLane());

    expect((await readDetail(A, '101'))?.bookmarkSnapshot).toBeNull();
  });
});
