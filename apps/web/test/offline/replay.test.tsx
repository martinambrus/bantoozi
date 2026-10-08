import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReaderActions } from '../../src/features/reader/actions/store.js';
import { UNDO_WINDOW_MS, type ReaderAction } from '../../src/features/reader/actions/types.js';
import { writeOfflineEnabled } from '../../src/offline/device.js';
import { putRecord } from '../../src/offline/queue.js';
import { UUID_V4, json } from '../api/fake-fetch.js';
import { findToast } from '../article/harness.js';
import { FakeTransport, acked, makeItem } from '../reader/actions/fake-transport.js';
import { makeMe } from '../session/fixtures.js';
import { page, resetPage } from './replay-page.js';
import {
  FakeLocks,
  bookmarkOf,
  connection,
  createArticleServer,
  dislikeOf,
  flushIo,
  installLocks,
  isPressed,
  likeOf,
  openTab,
  recordsReach,
  removeLocks,
  requestReplayEvent,
  restoreVisibility,
  storedRecords,
  toastTexts,
  until,
} from './replay-support.js';
import {
  A,
  B,
  DAY,
  T0,
  dumpDatabase,
  freshIndexedDb,
  makeRecord,
  rowCount,
  rowsOf,
  setClock,
} from './support.js';

// The reader page belongs to another task; the tab page renders article rows in its place.
vi.mock('../../src/features/reader/reader-page.js', async () => {
  const { TabPage } = await import('./replay-page.js');
  return { ReaderPage: TabPage };
});

const idb = freshIndexedDb();

const ITEM = makeItem();
const SECOND_TITLE = 'A second article';
const SECOND = makeItem({
  id: '102',
  title: SECOND_TITLE,
  url: 'https://example.test/articles/102',
});
const THIRD_TITLE = 'A third article';
const THIRD = makeItem({
  id: '103',
  title: THIRD_TITLE,
  url: 'https://example.test/articles/103',
});
const FENCE = { stateVersion: '4', contentRevision: '2' };

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  resetPage([ITEM]);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreVisibility();
  removeLocks();
});

const errorToasts = () => Array.from(document.querySelectorAll('[data-tone="error"]'));
const failedToasts = () => screen.queryAllByText("Couldn't save — retry");
const buttonNames = (toast: HTMLElement) =>
  within(toast)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);

/** Moves the fake clock (timers and Date) and lets IndexedDB and promises catch up. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flushIo();
}

function fakeTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

describe('1. a rating made offline, with offline reading on', () => {
  it('stays on the device, is shown, and is sent once with its key and fence when the connection returns', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const tab = await openTab(server);

    net.drop();
    await tab.user.click(likeOf(tab));

    expect(isPressed(likeOf(tab))).toBe(true);
    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    const [record] = await recordsReach(idb.factory, 1);
    expect(record).toMatchObject({
      schema: 1,
      key: record!.id,
      accountId: A,
      articleId: '101',
      action: { type: 'rate', rating: 1 },
      fence: FENCE,
      after: null,
      before: { ...FENCE, rating: null, readAt: null, bookmarkedAt: null },
      markRead: true,
      state: 'pending',
    });
    expect(record!.id).toMatch(UUID_V4);
    expect(record!.stamp).toBe(new Date(record!.createdAt).toISOString());
    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    expect(server.arrivals).toEqual([]);
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(errorToasts()).toEqual([]);
    expect(failedToasts()).toEqual([]);

    net.restore();

    await until(() => expect(server.effects).toHaveLength(1));
    expect(server.arrivals).toHaveLength(1);
    expect(server.of('rating')[0]).toMatchObject({
      key: record!.id,
      articleId: '101',
      fields: { ...FENCE, rating: 1 },
    });
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(tab.unhandled).toEqual([]);
  });
});

describe('1b. a dislike made offline, with offline reading on', () => {
  it('is kept once its reason is chosen, not before, and is sent with the reason', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const tab = await openTab(server);

    net.drop();
    await tab.user.click(dislikeOf(tab));
    expect(isPressed(dislikeOf(tab))).toBe(true);
    await flushIo();
    expect(await storedRecords(idb.factory)).toEqual([]);

    await tab.user.click(
      within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
        name: 'Clickbait',
      }),
    );

    const [record] = await recordsReach(idb.factory, 1);
    expect(record).toMatchObject({
      action: { type: 'rate', rating: -1, reason: 'clickbait' },
      fence: FENCE,
      key: record!.id,
    });
    expect(isPressed(dislikeOf(tab))).toBe(true);
    expect(server.arrivals).toEqual([]);
    expect(errorToasts()).toEqual([]);

    net.restore();

    await until(() => expect(server.effects).toHaveLength(1));
    expect(server.of('rating')[0]).toMatchObject({
      key: record!.id,
      fields: { ...FENCE, rating: -1, reason: 'clickbait' },
    });
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(isPressed(dislikeOf(tab))).toBe(true);
  });
});

describe('2. a rating made offline, with offline reading off', () => {
  it('fails at once with a hint, with no request, no retry and no stored record, and works as before online', async () => {
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const tab = await openTab(server);

    net.drop();
    await tab.user.click(likeOf(tab));

    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    const hint = await findToast(/needs a connection/);
    expect(hint).toHaveTextContent('This change needs a connection.');
    expect(hint).toHaveTextContent('turn on offline reading in Settings');
    expect(isPressed(likeOf(tab))).toBe(false);
    expect(failedToasts()).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    expect(rowCount(await dumpDatabase(idb.factory), 'queue')).toBe(0);
    expect(await storedRecords(idb.factory)).toEqual([]);

    net.restore();
    await tab.user.click(likeOf(tab));

    await findToast('Marked as liked');
    expect(server.of('rating')).toHaveLength(1);
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(await storedRecords(idb.factory)).toEqual([]);
    expect(tab.unhandled).toEqual([]);
  });
});

describe('3. a rating and a bookmark made offline on one article', () => {
  it('are sent one after the other, the second fenced by the answer of the first', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const tab = await openTab(server);

    net.drop();
    await tab.user.click(likeOf(tab));
    await tab.user.click(bookmarkOf(tab));
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(isPressed(bookmarkOf(tab))).toBe(true);
    const records = await recordsReach(idb.factory, 2);
    const rating = records.find((record) => record.action.type === 'rate')!;
    const bookmark = records.find((record) => record.action.type === 'bookmark')!;
    expect(rating).toMatchObject({ fence: FENCE, after: null });
    expect(bookmark).toMatchObject({ fence: null, after: rating.id });
    expect(server.arrivals).toEqual([]);

    const ratingGate = server.gate('rating');
    const bookmarkGate = server.gate('bookmark');
    net.restore();
    await ratingGate.reached;
    await flushIo();
    expect(server.of('bookmark')).toHaveLength(0);
    ratingGate.release();
    await bookmarkGate.reached;

    expect(server.of('rating')[0]).toMatchObject({
      key: rating.id,
      fields: { ...FENCE, rating: 1 },
    });
    expect(server.of('bookmark')[0]).toMatchObject({
      key: bookmark.id,
      fields: { stateVersion: '5', contentRevision: '2' },
    });
    const stored = await storedRecords(idb.factory);
    expect(stored.find((record) => record.id === bookmark.id)?.fence).toEqual({
      stateVersion: '5',
      contentRevision: '2',
    });
    bookmarkGate.release();

    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.effects.map((effect) => effect.kind)).toEqual(['rating', 'bookmark']);
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(isPressed(bookmarkOf(tab))).toBe(true);
    expect(errorToasts()).toEqual([]);
  });
});

describe('4. an answer that is lost', () => {
  it('is repeated by the next replay under the same key and body, with one effect', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    connection(server);
    const tab = await openTab(server);
    const user = fakeTimers();
    server.fault({ when: 'after', act: 'network' }, { kinds: ['rating'], times: 3 });

    await user.click(likeOf(tab));
    await advance(0);
    expect(server.of('rating')).toHaveLength(1);
    await advance(500);
    expect(server.of('rating')).toHaveLength(2);
    await advance(1000);
    expect(server.of('rating')).toHaveLength(3);
    await advance(5000);

    expect(failedToasts()).toEqual([]);
    expect(isPressed(likeOf(tab))).toBe(true);
    const [record] = await recordsReach(idb.factory, 1);
    expect(server.effects).toHaveLength(1);

    requestReplayEvent();
    await advance(0);
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));

    const sent = server.of('rating');
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((arrival) => arrival.key))).toEqual(new Set([record!.id]));
    expect(new Set(sent.map((arrival) => JSON.stringify(arrival.fields))).size).toBe(1);
    expect(sent.map((arrival) => arrival.replayed)).toEqual([false, true, true, true]);
    expect(server.effects).toHaveLength(1);
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(failedToasts()).toEqual([]);
  });
});

describe('5. a change that is 24 hours old', () => {
  it('is not sent from a day to the millisecond on, is rolled back and announced once; one a millisecond younger is sent', async () => {
    setClock(T0);
    writeOfflineEnabled(A, true);
    resetPage([ITEM, SECOND, THIRD]);
    const server = createArticleServer([ITEM, SECOND, THIRD]);
    connection(server);
    const rating = { type: 'rate', rating: 1 } as const;
    await putRecord(
      makeRecord('too-old', {
        articleId: '101',
        action: rating,
        fence: FENCE,
        createdAt: T0 - DAY - 1,
      }),
    );
    await putRecord(
      makeRecord('a-day-to-the-millisecond', {
        articleId: '103',
        action: rating,
        fence: FENCE,
        createdAt: T0 - DAY,
      }),
    );
    await putRecord(
      makeRecord('just-in-time', {
        articleId: '102',
        action: rating,
        fence: FENCE,
        createdAt: T0 - DAY + 1,
      }),
    );

    const tab = await openTab(server);

    await until(() => expect(server.of('rating')).toHaveLength(1));
    expect(server.of('rating')[0]).toMatchObject({
      key: 'just-in-time',
      articleId: '102',
      fields: { ...FENCE, rating: 1 },
    });
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(isPressed(likeOf(tab))).toBe(false);
    expect(isPressed(likeOf(tab, THIRD_TITLE))).toBe(false);
    expect(isPressed(likeOf(tab, SECOND_TITLE))).toBe(true);
    const notice = await findToast('2 offline changes expired and were not sent');
    expect(screen.getAllByText('2 offline changes expired and were not sent')).toHaveLength(1);

    await tab.user.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    requestReplayEvent();
    await flushIo();
    expect(screen.queryByText(/offline change/)).toBeNull();
    expect(server.of('rating')).toHaveLength(1);
  });
});

describe('6. the account check before a replay', () => {
  async function queueOffline(server: ReturnType<typeof createArticleServer>) {
    writeOfflineEnabled(A, true);
    const net = connection(server);
    const tab = await openTab(server);
    net.drop();
    await tab.user.click(likeOf(tab));
    const [record] = await recordsReach(idb.factory, 1);
    return { net, tab, record: record! };
  }

  it('sends nothing and freezes the records when it answers 401, then sends them after the same account signed in again', async () => {
    const server = createArticleServer([ITEM]);
    const { net, tab, record } = await queueOffline(server);
    const checks = tab.calls('GET /me').length;

    server.fake.me = null;
    net.restore();

    await until(async () => expect((await storedRecords(idb.factory))[0]?.state).toBe('frozen'));
    expect(tab.calls('GET /me').length).toBeGreaterThan(checks);
    expect(server.arrivals).toEqual([]);
    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    expect(await storedRecords(idb.factory)).toHaveLength(1);

    server.routes['POST /auth/verify'] = () => {
      server.fake.me = makeMe();
      return json(200, { user: server.fake.me });
    };
    await act(async () => {
      await tab.session.verifyCode({ email: 'a@example.com', code: '123456' });
    });
    await act(async () => {
      await tab.router.navigate({ to: '/read/$lane', params: { lane: 'for_you' } });
    });

    await until(() => expect(server.of('rating')).toHaveLength(1));
    expect(server.of('rating')[0]).toMatchObject({
      key: record.id,
      fields: { ...FENCE, rating: 1 },
    });
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    await until(() => expect(isPressed(likeOf(tab))).toBe(true));
  });

  it('sends nothing when it answers another account', async () => {
    const server = createArticleServer([ITEM]);
    const { net, tab } = await queueOffline(server);
    const checks = tab.calls('GET /me').length;

    server.fake.me = makeMe({ id: B });
    net.restore();

    await until(() => expect(tab.calls('GET /me').length).toBeGreaterThan(checks));
    await flushIo();
    expect(server.arrivals).toEqual([]);
    expect(tab.calls('POST /articles/:id/rating')).toHaveLength(0);
    const kept = await storedRecords(idb.factory);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.accountId).toBe(A);
  });

  it('never sends the records of one account under another that signed in', async () => {
    const server = createArticleServer([ITEM]);
    const { net, tab } = await queueOffline(server);

    server.fake.me = null;
    net.restore();
    await until(async () => expect((await storedRecords(idb.factory))[0]?.state).toBe('frozen'));
    server.routes['POST /auth/verify'] = () => {
      server.fake.me = makeMe({ id: B, email: 'b@example.com' });
      return json(200, { user: server.fake.me });
    };
    await act(async () => {
      await tab.session.verifyCode({ email: 'b@example.com', code: '123456' });
    });
    await act(async () => {
      await tab.router.navigate({ to: '/read/$lane', params: { lane: 'for_you' } });
    });
    await until(async () => expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]));
    await flushIo();

    expect(server.arrivals).toEqual([]);
    expect(isPressed(likeOf(tab))).toBe(false);
  });
});

describe('7. a change that went stale on another device', () => {
  it('drops the record and the later ones of that article, shows the server state, and sends the other article', async () => {
    writeOfflineEnabled(A, true);
    resetPage([ITEM, SECOND]);
    const server = createArticleServer([ITEM, SECOND]);
    const net = connection(server);
    const tab = await openTab(server);

    net.drop();
    await tab.user.click(likeOf(tab));
    await tab.user.click(bookmarkOf(tab));
    await tab.user.click(likeOf(tab, SECOND_TITLE));
    await recordsReach(idb.factory, 3);
    server.change('101', { rating: -1 });

    net.restore();

    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.of('rating').map((arrival) => arrival.articleId)).toEqual(['101', '102']);
    expect(server.of('bookmark')).toHaveLength(0);
    expect(server.effects.map((effect) => `${effect.kind}:${effect.articleId}`)).toEqual([
      'rating:102',
    ]);
    expect(isPressed(dislikeOf(tab))).toBe(true);
    expect(isPressed(likeOf(tab))).toBe(false);
    expect(isPressed(bookmarkOf(tab))).toBe(false);
    expect(isPressed(likeOf(tab, SECOND_TITLE))).toBe(true);
    expect(
      screen.getAllByText("This changed on another device, so your change wasn't applied."),
    ).toHaveLength(1);
    expect(failedToasts()).toEqual([]);
  });
});

describe('8. refusals and failures during a replay', () => {
  async function queueOffline(server: ReturnType<typeof createArticleServer>) {
    writeOfflineEnabled(A, true);
    const net = connection(server);
    const tab = await openTab(server);
    net.drop();
    await tab.user.click(likeOf(tab));
    const [record] = await recordsReach(idb.factory, 1);
    return { net, tab, record: record! };
  }

  it.each([
    [400, 'VALIDATION_FAILED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ] as const)('sends the record once and drops it for a %s', async (status, code) => {
    const server = createArticleServer([ITEM]);
    server.fault({ when: 'before', act: { status, code } }, { times: 5 });
    const { net, tab, record } = await queueOffline(server);

    net.restore();

    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.of('rating')).toHaveLength(1);
    expect(server.of('rating')[0]?.key).toBe(record.id);
    expect(await screen.findByText("Couldn't save — retry")).toBeInTheDocument();
    expect(isPressed(likeOf(tab))).toBe(false);

    requestReplayEvent();
    await flushIo();
    expect(server.of('rating')).toHaveLength(1);
  });

  it('waits out Retry-After after a 503 and sends again within the same replay', async () => {
    const server = createArticleServer([ITEM]);
    const { net, tab, record } = await queueOffline(server);
    fakeTimers();
    server.fault(
      {
        when: 'before',
        act: { status: 503, code: 'UNAVAILABLE', headers: { 'Retry-After': '2' } },
      },
      { kinds: ['rating'] },
    );

    net.restore();
    await advance(0);
    await until(() => expect(server.of('rating')).toHaveLength(1));
    await advance(1999);
    expect(server.of('rating')).toHaveLength(1);
    await advance(1);

    await until(() => expect(server.of('rating')).toHaveLength(2));
    expect(server.of('rating').map((arrival) => arrival.key)).toEqual([record.id, record.id]);
    expect(server.effects).toHaveLength(1);
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(failedToasts()).toEqual([]);
  });

  it('keeps a record whose requests do not reach the server for the next replay', async () => {
    const server = createArticleServer([ITEM]);
    const { net, tab, record } = await queueOffline(server);
    fakeTimers();
    server.fault({ when: 'before', act: 'network' }, { kinds: ['rating'], times: 3 });

    net.restore();
    await advance(0);
    await advance(500);
    await advance(1000);
    await advance(5000);

    expect(server.of('rating')).toHaveLength(3);
    expect(await storedRecords(idb.factory)).toHaveLength(1);
    expect(isPressed(likeOf(tab))).toBe(true);
    expect(failedToasts()).toEqual([]);

    requestReplayEvent();
    await advance(0);

    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.of('rating')).toHaveLength(4);
    expect(new Set(server.of('rating').map((arrival) => arrival.key))).toEqual(
      new Set([record.id]),
    );
    expect(isPressed(likeOf(tab))).toBe(true);
  });
});

describe('9. two tabs of one browser', () => {
  it('send each record once, the other tab settling its entry from the broadcast', async () => {
    writeOfflineEnabled(A, true);
    const locks = new FakeLocks();
    installLocks(locks);
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const first = await openTab(server);

    net.drop();
    await first.user.click(likeOf(first));
    const [record] = await recordsReach(idb.factory, 1);
    const second = await openTab(server);
    await until(() => expect(isPressed(likeOf(second))).toBe(true));
    expect(page.tabs).toHaveLength(2);
    const checks = () => first.calls('GET /me').length + second.calls('GET /me').length;
    const before = checks();

    net.restore();

    await until(() => expect(server.of('rating')).toHaveLength(1));
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    for (const tab of page.tabs) {
      await until(() => expect(tab.store.offline.waiting()).toEqual([]));
      await until(() => expect(tab.store.get(record!.id)?.status).toBe('done'));
    }
    await flushIo();
    expect(server.of('rating')).toHaveLength(1);
    expect(server.of('rating')[0]?.key).toBe(record!.id);
    expect(server.effects).toHaveLength(1);
    expect(checks() - before).toBe(1);
    expect(isPressed(likeOf(first))).toBe(true);
    expect(isPressed(likeOf(second))).toBe(true);
    expect(errorToasts()).toEqual([]);
  });
});

describe('9b. a send while another tab holds the lock', () => {
  it('waits for the lock, and goes out once the other tab has let go of it', async () => {
    writeOfflineEnabled(A, true);
    const locks = new FakeLocks();
    installLocks(locks);
    resetPage([ITEM, SECOND]);
    const server = createArticleServer([ITEM, SECOND]);
    const net = connection(server);
    const first = await openTab(server);
    net.drop();
    await first.user.click(likeOf(first));
    await recordsReach(idb.factory, 1);
    const second = await openTab(server);
    await until(() => expect(isPressed(likeOf(second))).toBe(true));
    const gate = server.gate('rating');

    net.restore();
    await gate.reached;
    expect(server.of('rating').map((arrival) => arrival.articleId)).toEqual(['101']);

    await second.user.click(likeOf(second, SECOND_TITLE));
    await flushIo();
    expect(server.of('rating').map((arrival) => arrival.articleId)).toEqual(['101']);
    expect(isPressed(likeOf(second, SECOND_TITLE))).toBe(true);
    expect(errorToasts()).toEqual([]);

    gate.release();

    await until(() =>
      expect(server.of('rating').map((arrival) => arrival.articleId)).toEqual(['101', '102']),
    );
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.effects).toHaveLength(2);
    expect(isPressed(likeOf(second, SECOND_TITLE))).toBe(true);
  });
});

describe('10. a page that is loaded again', () => {
  it('shows the pending rating of the earlier page, sends it on mount and offers no suggestion', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    server.state.suggestion = { cardId: '31', side: 'yes' };
    const net = connection(server);
    const first = await openTab(server);
    net.drop();
    await first.user.click(likeOf(first));
    const [record] = await recordsReach(idb.factory, 1);
    first.unmount();

    resetPage([ITEM]);
    const offline = await openTab(server);
    await until(() => expect(isPressed(likeOf(offline))).toBe(true));
    await flushIo();
    expect(offline.calls('POST /articles/:id/rating')).toHaveLength(0);
    expect(await storedRecords(idb.factory)).toHaveLength(1);
    offline.unmount();

    resetPage([ITEM]);
    const gate = server.gate('rating');
    net.restore();
    const reloaded = await openTab(server);
    await until(() => expect(isPressed(likeOf(reloaded))).toBe(true));
    await gate.reached;
    expect(server.of('rating')).toHaveLength(1);
    expect(server.of('rating')[0]).toMatchObject({
      key: record!.id,
      fields: { ...FENCE, rating: 1 },
    });
    expect(isPressed(likeOf(reloaded))).toBe(true);
    gate.release();

    const toast = await findToast('Marked as liked');
    expect(buttonNames(toast)).toEqual(['Undo', 'Dismiss']);
    expect(reloaded.calls('GET /cards')).toHaveLength(0);
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(isPressed(likeOf(reloaded))).toBe(true);
  });
});

describe('11. changes that cannot wait', () => {
  const unhide: ReaderAction = { type: 'unhide' };
  const retryCapture: ReaderAction = { type: 'retryCapture', captureGeneration: '1' };
  const promptAnswer: ReaderAction = { type: 'promptAnswer', liked: true };

  it.each([
    ['unhide', unhide, 'unhide'],
    ['retryCapture', retryCapture, 'bookmark/retry-capture'],
    ['promptAnswer', promptAnswer, 'prompt-answer'],
  ] as const)(
    '%s offline never enters IndexedDB and fails at once with the hint',
    async (_name, action, path) => {
      writeOfflineEnabled(A, true);
      const server = createArticleServer([ITEM]);
      const net = connection(server);
      const tab = await openTab(server);
      net.drop();
      const store = page.tabs[0]!.store;

      let status: string | undefined;
      act(() => {
        status = store.dispatch(ITEM, action).status;
      });

      expect(tab.calls(`POST /articles/:id/${path}`)).toHaveLength(0);
      expect(status).toBe('failed');
      expect((await findToast('This change needs a connection.')).textContent).not.toContain(
        'Settings',
      );
      await flushIo();
      expect(tab.calls(`POST /articles/:id/${path}`)).toHaveLength(0);
      expect(rowCount(await dumpDatabase(idb.factory), 'queue')).toBe(0);
      expect(await storedRecords(idb.factory)).toEqual([]);
      expect(server.arrivals).toEqual([]);
    },
  );

  it('drops the implicit open and dwell without a word', async () => {
    writeOfflineEnabled(A, true);
    const server = createArticleServer([ITEM]);
    const net = connection(server);
    const tab = await openTab(server);
    net.drop();
    const store = page.tabs[0]!.store;
    const statuses: string[] = [];

    act(() => {
      statuses.push(store.dispatch(ITEM, { type: 'open' }).status);
      statuses.push(store.dispatch(ITEM, { type: 'dwell', ms: 30_000 }).status);
    });
    await flushIo();

    expect(statuses).toEqual(['failed', 'failed']);
    expect(tab.calls('POST /articles/:id/open')).toHaveLength(0);
    expect(tab.calls('POST /articles/:id/dwell')).toHaveLength(0);
    expect(toastTexts().filter((text) => /connection|save/.test(text))).toEqual([]);
    expect(await storedRecords(idb.factory)).toEqual([]);
  });
});

describe('12. settled actions', () => {
  function rig(clock: { now: number }) {
    const transport = new FakeTransport();
    let counter = 0;
    const store = createReaderActions({
      transport,
      preferences: () => ({ markReadOnRate: true }),
      now: () => clock.now,
      newId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    });
    return { transport, store };
  }

  async function rate(
    { transport, store }: ReturnType<typeof rig>,
    item: ArticleListItem,
  ): Promise<string> {
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    transport.sends.at(-1)!.resolve({
      item: acked(item, { rating: 1 }),
      mutationId: '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10',
    });
    await handle.result;
    return handle.id;
  }

  it('leave the store once they can no longer be undone', async () => {
    const clock = { now: T0 };
    const subject = rig(clock);
    const { store } = subject;
    const ids: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
      ids.push(await rate(subject, makeItem({ id: String(5000 + index) })));
    }
    expect(store.recent()).toHaveLength(1000);

    clock.now += UNDO_WINDOW_MS - 1;
    store.observe([]);
    expect(ids.filter((id) => store.get(id) !== undefined)).toHaveLength(1000);
    expect(store.recent()).toHaveLength(1000);

    clock.now += 2;
    store.observe([]);

    expect(ids.filter((id) => store.get(id) !== undefined)).toHaveLength(0);
    expect(store.recent()).toEqual([]);
    expect(store.retained()).toEqual({ actions: 0, recents: 0 });
  });

  it('leave the store at once when they are not undoable, but not while they are unsettled', async () => {
    const clock = { now: T0 };
    const { transport, store } = rig(clock);
    const item = makeItem();
    const opened = store.dispatch(item, { type: 'open' });
    transport.sends
      .at(-1)!
      .resolve({ item: { ...item }, mutationId: '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10' });
    await opened.result;
    const other = makeItem({ id: '202' });
    const sending = store.dispatch(other, { type: 'rate', rating: 1 });

    expect(store.get(opened.id)).toBeUndefined();
    expect(store.get(sending.id)?.status).toBe('sending');
    expect(store.retained().actions).toBe(1);
  });
});
