import type { ArticleListItem } from '@bantoozi/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listItemOf } from '../../src/features/offline/saved-copy.js';
import { createReaderActions } from '../../src/features/reader/actions/store.js';
import { READER_FIELDS, type ReaderState } from '../../src/features/reader/actions/types.js';
import { readView, saveView, setOfflineEnabled } from '../../src/offline/cache.js';
import { writeOfflineEnabled } from '../../src/offline/device.js';
import { putRecord } from '../../src/offline/queue.js';
import { createActionQueue } from '../../src/offline/replay.js';
import type { ItemRow } from '../../src/offline/types.js';
import { FakeTransport, acked, makeItem } from '../reader/actions/fake-transport.js';
import {
  A,
  DAY,
  T0,
  VIEW,
  dumpDatabase,
  freshIndexedDb,
  makeRecord,
  rowsOf,
  setClock,
} from './support.js';

const idb = freshIndexedDb();

const READ = '2026-10-08T07:30:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

const article = (id: string, patch: Partial<ArticleListItem> = {}) =>
  makeItem({ id, title: `Article ${id}`, ...patch });

const readerOf = (item: ArticleListItem): ReaderState =>
  Object.fromEntries(READER_FIELDS.map((field) => [field, item[field]])) as ReaderState;

/** The store of one page of the account, over the real queue store and the fake IndexedDB. */
function page(net: { online: boolean } = { online: true }) {
  const queue = createActionQueue({ accountId: A, online: () => net.online });
  const transport = new FakeTransport();
  const store = createReaderActions({
    transport,
    queue,
    preferences: () => ({ markReadOnRate: true }),
    maxRetries: 0,
    backoffMs: () => 0,
  });
  return { store, queue, transport };
}

/** The account keeps these articles as one saved list. */
async function keep(...items: ArticleListItem[]): Promise<void> {
  await setOfflineEnabled(A, true);
  expect(await saveView(A, 'view', items, VIEW)).toBe(true);
}

/** The saved rows of the account, by article id, as raw IndexedDB has them. */
async function storedItems(): Promise<Record<string, ItemRow>> {
  return Object.fromEntries(
    rowsOf(await dumpDatabase(idb.factory), A)
      .filter(([store]) => store === 'items')
      .map(([, key, value]) => [key.slice(A.length + 1), value as ItemRow]),
  );
}

const stored = async (id: string) => (await storedItems())[id]?.item;

/** The store writes the saved rows a moment after it learns something: wait for what must come. */
const eventually = (check: () => Promise<void> | void) => vi.waitFor(check, { timeout: 4000 });

/** Lets what must not happen have its chance to. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));

/** The transactions that write saved rows, from now on. */
function watchRowWrites(): () => number {
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
  return () =>
    spy.mock.calls.filter(
      ([stores, mode]) => mode === 'readwrite' && Array.isArray(stores) && stores.includes('items'),
    ).length;
}

describe('the saved rows of the articles the store learns more about', () => {
  it('take the newer state of an article the store knew', async () => {
    const { store } = page();
    const one = article('1');
    await keep(one);
    store.observe([one]);

    store.observe([acked(one, { readAt: READ })]);

    await eventually(async () => {
      expect(await stored('1')).toMatchObject({ stateVersion: '5', readAt: READ });
    });
  });

  it('take the answer to a change the person made, and the next page fences its changes by it', async () => {
    const first = page();
    const one = article('1');
    await keep(one);
    first.store.observe([one]);
    const read = first.store.dispatch(one, { type: 'read', trigger: 'expand' });
    await vi.waitFor(() => expect(first.transport.sends).toHaveLength(1));
    first.transport.sends[0]!.resolve({ item: acked(one, { readAt: READ }), mutationId: 'm1' });
    await read.result;
    await eventually(async () => {
      expect(await stored('1')).toMatchObject({ stateVersion: '5', readAt: READ });
      expect(await first.queue.list()).toEqual([]);
    });

    const offline = page({ online: false });
    const saved = (await readView(A, 'view'))?.items.map(listItemOf) ?? [];
    offline.store.observe(saved);
    offline.store.dispatch(saved[0]!, { type: 'rate', rating: 1 });
    await vi.waitFor(() => expect(offline.store.offline.waiting()).toHaveLength(1));

    const records = await offline.queue.list();
    expect(records.map((record) => record.fence)).toEqual([
      { stateVersion: '5', contentRevision: '2' },
    ]);
  });

  it('take the states of a whole list in one transaction', async () => {
    const { store } = page();
    const items = Array.from({ length: 50 }, (_unused, index) => article(String(index + 1)));
    await keep(...items);
    store.observe(items);
    const writes = watchRowWrites();

    store.observe(items.map((item) => acked(item, { readAt: READ })));

    await eventually(async () => {
      const rows = Object.values(await storedItems());
      expect(rows.filter((row) => row.item.readAt === READ)).toHaveLength(50);
    });
    expect(writes()).toBe(1);
  });

  it('take what marking a list read did, in one transaction', async () => {
    const { store, transport } = page();
    const items = Array.from({ length: 50 }, (_unused, index) => article(String(index + 1)));
    await keep(...items);
    store.observe(items);
    const writes = watchRowWrites();

    const marked = store.bulk({ kind: 'markRead', items });
    await vi.waitFor(() => expect(transport.markReads).toHaveLength(1));
    transport.markReads[0]!.resolve({ count: 50, mutationId: 'm1' });
    expect(await marked).toMatchObject({ status: 'done', count: 50 });

    await eventually(async () => {
      const rows = Object.values(await storedItems());
      expect(
        rows.filter((row) => row.item.stateVersion === '5' && row.item.readAt !== null),
      ).toHaveLength(50);
    });
    expect(writes()).toBe(1);
  });

  it('keep a state that is as new or newer than the one the store learns', async () => {
    const { store } = page();
    const newer = article('1', { stateVersion: '6', readAt: READ });
    const same = article('2', { stateVersion: '5', readAt: READ });
    const older = article('3');
    await keep(newer, same, older);
    store.observe([article('1'), article('2'), article('3')]);

    store.observe([
      acked(article('1'), { rating: 1 }),
      acked(article('2'), { rating: 1 }),
      acked(article('3'), { rating: 1 }),
    ]);

    await eventually(async () => {
      expect(await stored('3')).toMatchObject({ stateVersion: '5', rating: 1 });
    });
    expect(await stored('1')).toMatchObject({ stateVersion: '6', readAt: READ, rating: null });
    expect(await stored('2')).toMatchObject({ stateVersion: '5', readAt: READ, rating: null });
  });

  it('write the reader fields only', async () => {
    const { store } = page();
    const one = article('1');
    await keep(one);
    const before = (await stored('1'))!;
    store.observe([one]);

    store.observe([acked(one, { readAt: READ, title: 'Retitled', pLike: 0.99, lane: 'maybe' })]);

    await eventually(async () => {
      expect(await stored('1')).toMatchObject({ readAt: READ });
    });
    const row = (await stored('1'))!;
    expect(row.title).toBe('Article 1');
    expect(row).not.toHaveProperty('pLike');
    expect(Object.keys(row).sort()).toEqual(Object.keys(before).sort());
  });

  it('are not added for an article the device does not hold', async () => {
    const { store } = page();
    const held = article('1');
    const unheld = article('9');
    await keep(held);
    store.observe([held, unheld]);

    store.observe([acked(held, { readAt: READ }), acked(unheld, { readAt: READ })]);

    await eventually(async () => {
      expect(await stored('1')).toMatchObject({ readAt: READ });
    });
    expect(Object.keys(await storedItems())).toEqual(['1']);
  });

  it('do not come back once they expired', async () => {
    setClock(T0);
    const { store } = page();
    const [old, fresh] = [article('1'), article('2')] as const;
    await keep(old);
    setClock(T0 + DAY - 10);
    await saveView(A, 'other', [fresh], VIEW);
    setClock(T0 + DAY + 5);
    store.observe([old, fresh]);

    store.observe([acked(old, { readAt: READ }), acked(fresh, { readAt: READ })]);

    await eventually(async () => {
      expect(await stored('2')).toMatchObject({ readAt: READ });
    });
    expect(Object.keys(await storedItems())).toEqual(['2']);
  });

  it('are left as they are while the account has not chosen offline reading, and taken once it has', async () => {
    const { store } = page();
    const [one, two] = [article('1'), article('2')] as const;
    await keep(one, two);
    store.observe([one, two]);
    writeOfflineEnabled(A, false);
    const writes = watchRowWrites();

    store.observe([acked(one, { readAt: READ })]);
    await settle();
    expect(writes()).toBe(0);
    expect(await stored('1')).toMatchObject({ stateVersion: '4', readAt: null });

    writeOfflineEnabled(A, true);
    store.observe([acked(two, { readAt: READ })]);

    await eventually(async () => {
      expect(await stored('2')).toMatchObject({ stateVersion: '5', readAt: READ });
    });
    expect(await stored('1')).toMatchObject({ stateVersion: '4', readAt: null });
  });

  it('never show a change that waits for a connection, and take the state of the server under it', async () => {
    const net = { online: true };
    const { store } = page(net);
    const one = article('1');
    await keep(one);
    store.observe([one]);
    net.online = false;

    store.dispatch(one, { type: 'rate', rating: 1 });
    await vi.waitFor(() => expect(store.offline.waiting()).toHaveLength(1));
    await settle();

    expect(store.view(one).rating).toBe(1);
    expect(await stored('1')).toMatchObject({ stateVersion: '4', rating: null });

    const theirs = acked(one, { rating: -1, reason: 'clickbait' });
    store.observe([theirs]);

    await eventually(async () => {
      expect(await stored('1')).toMatchObject({ stateVersion: '5', rating: -1 });
    });
    expect(store.view(theirs).rating).toBe(1);
    expect(store.offline.waiting()).toHaveLength(1);
  });

  it('do not take the state that the changes of an earlier page were made on', async () => {
    const net = { online: false };
    const { store, queue } = page(net);
    const [one, two] = [article('1'), article('2')] as const;
    await keep(one, two);
    await putRecord(
      makeRecord('earlier', {
        articleId: '1',
        before: { ...readerOf(one), stateVersion: '9', rating: 1 },
      }),
    );
    store.observe([one, two]);

    store.offline.adopt(await queue.list());
    store.observe([acked(two, { readAt: READ })]);

    await eventually(async () => {
      expect(await stored('2')).toMatchObject({ readAt: READ });
    });
    expect(store.offline.waiting()).toHaveLength(1);
    expect(await stored('1')).toMatchObject({ stateVersion: '4', rating: null });
  });
});
