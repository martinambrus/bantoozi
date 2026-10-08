import type { ArticleListItem } from '@bantoozi/shared';
import { act, configure, getConfig, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useReaderActions,
  useReaderItem,
  useWaitingChanges,
} from '../../src/features/reader/actions/provider.js';
import type { ReaderActions } from '../../src/features/reader/actions/types.js';
import { createI18n } from '../../src/i18n/index.js';
import { writeOfflineEnabled } from '../../src/offline/device.js';
import { deleteRecord, putRecord } from '../../src/offline/queue.js';
import type * as QueueModule from '../../src/offline/queue.js';
import { requestReplay } from '../../src/offline/replay.js';
import { runResetHooks } from '../../src/session/reset.js';
import { findToast, renderReader } from '../article/harness.js';
import { makeItem } from '../reader/actions/fake-transport.js';
import {
  createArticleServer,
  flushIo,
  recordsReach,
  restoreVisibility,
  storedRecords,
  until,
} from './replay-support.js';
import { A, DAY, T0, freshIndexedDb, makeRecord, setClock } from './support.js';

const events = vi.hoisted(() => [] as string[]);

vi.mock('../../src/offline/queue.js', async (importOriginal) => {
  const original = await importOriginal<typeof QueueModule>();
  return {
    ...original,
    setRecordsState: async (...args: Parameters<typeof original.setRecordsState>) => {
      events.push(`${args[1]}:start`);
      const changed = await original.setRecordsState(...args);
      events.push(`${args[1]}:done`);
      return changed;
    },
  };
});

const idb = freshIndexedDb();
const ITEM = makeItem();
const FENCE = { stateVersion: '4', contentRevision: '2' };
const control: { store: ReaderActions | null } = { store: null };

function Probe({ item }: { item: ArticleListItem }) {
  const store = useReaderActions();
  const shown = useReaderItem(item);
  const waiting = useWaitingChanges(item.id);
  control.store = store;
  return (
    <div>
      <p data-testid="rating">{String(shown.rating)}</p>
      <p data-testid="waiting">{waiting.map((handle) => handle.status).join(',')}</p>
    </div>
  );
}

let online = true;

beforeEach(() => {
  events.length = 0;
  online = true;
  control.store = null;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreVisibility();
});

const shownRating = () => screen.getByTestId('rating').textContent;
const waitingStatuses = () => screen.getByTestId('waiting').textContent;

function mount(
  server = createArticleServer([ITEM, makeItem({ id: '102' }), makeItem({ id: '103' })]),
  language: 'en' | 'sk' = 'en',
) {
  const view = renderReader(<Probe item={ITEM} />, { routes: server.routes, language });
  return { server, ...view };
}

const rate = (id: string, articleId = '101', createdAt = Date.now() - 1000) =>
  makeRecord(id, { articleId, fence: FENCE, createdAt, action: { type: 'rate', rating: 1 } });

describe('the replay triggers of the provider', () => {
  it('does nothing while the browser is offline, whatever asks for it', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1'));
    online = false;

    const { calls, requests } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));
    expect(shownRating()).toBe('1');

    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      requestReplay();
    });
    await flushIo();

    expect(requests).toEqual([]);
    expect(calls('POST', '/articles/101/rating')).toEqual([]);
    expect(await storedRecords(idb.factory)).toHaveLength(1);
  });

  it('replays when the browser comes online, when the page is shown and when asked', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1', '101'));
    online = false;
    const { server, calls } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await until(() => expect(server.of('rating').map((arrival) => arrival.key)).toEqual(['r1']));
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    await until(() => expect(waitingStatuses()).toBe(''));
    expect(calls('GET', '/me').length).toBeGreaterThanOrEqual(1);

    await putRecord(rate('r2', '102'));
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flushIo();
    expect(server.of('rating')).toHaveLength(1);

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() =>
      expect(server.of('rating').map((arrival) => arrival.key)).toEqual(['r1', 'r2']),
    );
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));

    await putRecord(rate('r3', '103'));
    act(() => {
      requestReplay();
    });
    await until(() =>
      expect(server.of('rating').map((arrival) => arrival.key)).toEqual(['r1', 'r2', 'r3']),
    );
    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
  });

  it('runs one replay at a time', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1'));
    online = false;
    const { server, calls } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));
    const gate = server.gate('rating');
    online = true;

    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      requestReplay();
    });
    await gate.reached;
    act(() => {
      requestReplay();
    });
    await flushIo();
    gate.release();

    await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    expect(server.of('rating')).toHaveLength(1);
    expect(calls('GET', '/me')).toHaveLength(1);
  });

  it('stops showing the changes whose records were discarded, offline, with no request', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1', '101'));
    online = false;
    const { requests } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));
    expect(shownRating()).toBe('1');

    await deleteRecord(A, 'r1');
    act(() => {
      requestReplay();
    });

    await until(() => expect(waitingStatuses()).toBe(''));
    expect(shownRating()).toBe('null');
    expect(control.store?.offline.waiting()).toEqual([]);
    expect(requests).toEqual([]);
    expect(await storedRecords(idb.factory)).toEqual([]);
  });

  it('keeps showing the changes whose records remain, offline', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1', '101'));
    await putRecord(rate('r2', '102'));
    online = false;
    const { requests } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));

    await deleteRecord(A, 'r2');
    act(() => {
      requestReplay();
    });
    await flushIo();

    expect(waitingStatuses()).toBe('waiting');
    expect(shownRating()).toBe('1');
    expect(control.store?.offline.waiting().map((handle) => handle.id)).toEqual(['r1']);
    expect(requests).toEqual([]);
  });

  it('shows the changes of an earlier page as waiting changes of their article', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1', '101'));
    await putRecord(rate('r2', '102'));
    online = false;

    mount();

    await until(() => expect(waitingStatuses()).toBe('waiting'));
    expect(control.store?.offline.waiting().map((handle) => handle.articleId)).toEqual([
      '101',
      '102',
    ]);
    expect(control.store?.offline.waiting('102')).toHaveLength(1);
  });
});

describe('a page that runs its effects twice', () => {
  it('replays a kept change once, and keeps listening for the connection', async () => {
    const strict = getConfig().reactStrictMode;
    configure({ reactStrictMode: true });
    try {
      writeOfflineEnabled(A, true);
      await putRecord(rate('r1', '101'));
      await putRecord(rate('r2', '102'));
      online = false;
      const { server } = mount();
      await until(() => expect(waitingStatuses()).toBe('waiting'));

      online = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      await until(() =>
        expect(server.of('rating').map((arrival) => arrival.key)).toEqual(['r1', 'r2']),
      );
      await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
      expect(server.effects).toHaveLength(2);

      await putRecord(rate('r3', '103'));
      act(() => {
        requestReplay();
      });
      await until(() =>
        expect(server.of('rating').map((arrival) => arrival.key)).toEqual(['r1', 'r2', 'r3']),
      );
      await until(async () => expect(await storedRecords(idb.factory)).toEqual([]));
    } finally {
      configure({ reactStrictMode: strict });
    }
  });
});

describe('the end of the session', () => {
  it('freezes the changes kept for the account before the store is released', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1'));
    online = false;
    mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));
    const store = control.store!;
    const release = store.reset;
    store.reset = () => {
      events.push('released');
      release();
    };

    await act(async () => {
      await runResetHooks('unauthorized');
    });
    await flushIo();

    expect(events).toEqual(['frozen:start', 'frozen:done', 'released']);
    const [record] = await storedRecords(idb.factory);
    expect(record).toMatchObject({ id: 'r1', state: 'frozen' });
  });

  it.each(['logout', 'account_switch', 'remote'] as const)(
    'releases the store without freezing anything after a %s reset',
    async (reason) => {
      writeOfflineEnabled(A, true);
      await putRecord(rate('r1'));
      online = false;
      mount();
      await until(() => expect(waitingStatuses()).toBe('waiting'));

      await act(async () => {
        await runResetHooks(reason);
      });
      await flushIo();

      expect(events).toEqual([]);
      expect(await storedRecords(idb.factory)).toHaveLength(1);
      expect(control.store?.offline.waiting()).toEqual([]);
    },
  );

  it('does not replay once the store is released', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1'));
    online = false;
    const { server } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));

    await act(async () => {
      await runResetHooks('logout');
    });
    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
      requestReplay();
    });
    await flushIo();

    expect(server.arrivals).toEqual([]);
    expect(await storedRecords(idb.factory)).toHaveLength(1);
  });
});

describe('what the person is told', () => {
  it('says in Slovak that the change needs a connection', async () => {
    online = false;
    const server = createArticleServer([ITEM]);
    const view = renderReader(<Probe item={ITEM} />, { routes: server.routes, language: 'sk' });
    await until(() => expect(control.store).not.toBeNull());

    act(() => {
      control.store!.dispatch(ITEM, { type: 'rate', rating: 1 });
      control.store!.dispatch(makeItem({ id: '102' }), { type: 'unhide' });
    });

    const hint = await findToast(/vyžaduje pripojenie/);
    expect(hint).toBeInTheDocument();
    expect(screen.getAllByText(/Táto zmena vyžaduje pripojenie/)).toHaveLength(1);
    expect(view.requests).toEqual([]);
  });

  it('says in Slovak that offline changes expired', async () => {
    setClock(T0);
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1', '101', T0 - DAY - 1));
    mount(undefined, 'sk');
    vi.useRealTimers();

    expect(
      await findToast('1 zmena vykonaná offline vypršala a nebola odoslaná'),
    ).toBeInTheDocument();
  });

  it.each([
    ['en', 1, '1 offline change expired and was not sent'],
    ['en', 2, '2 offline changes expired and were not sent'],
    ['en', 0, '0 offline changes expired and were not sent'],
    ['sk', 1, '1 zmena vykonaná offline vypršala a nebola odoslaná'],
    ['sk', 2, '2 zmeny vykonané offline vypršali a neboli odoslané'],
    ['sk', 4, '4 zmeny vykonané offline vypršali a neboli odoslané'],
    ['sk', 5, '5 zmien vykonaných offline vypršalo a nebolo odoslaných'],
    ['sk', 0, '0 zmien vykonaných offline vypršalo a nebolo odoslaných'],
  ] as const)('writes the expiry notice in %s for %i', (language, count, text) => {
    expect(createI18n(language).t('offline:replay.expired', { count })).toBe(text);
  });

  it.each([
    [
      'en',
      'article:toast.offlineOptIn',
      'This change needs a connection. You can turn on offline reading in Settings.',
    ],
    ['en', 'article:toast.offlineNeedsConnection', 'This change needs a connection.'],
    [
      'sk',
      'article:toast.offlineOptIn',
      'Táto zmena vyžaduje pripojenie. Čítanie offline si môžete zapnúť v Nastaveniach.',
    ],
    ['sk', 'article:toast.offlineNeedsConnection', 'Táto zmena vyžaduje pripojenie.'],
  ] as const)('writes %s %s', (language, key, text) => {
    expect(createI18n(language).t(key)).toBe(text);
  });
});

describe('the records that stay', () => {
  it('are read again by a page that opens later', async () => {
    writeOfflineEnabled(A, true);
    await putRecord(rate('r1'));
    online = false;
    const { unmount } = mount();
    await until(() => expect(waitingStatuses()).toBe('waiting'));
    unmount();

    mount();

    await until(() => expect(waitingStatuses()).toBe('waiting'));
    await recordsReach(idb.factory, 1);
  });
});
