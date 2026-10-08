import type { ArticleListItem, MarkReadFilter } from '@bantoozi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createReaderActions } from '../../../src/features/reader/actions/store.js';
import type {
  ActionHandle,
  ActionResult,
  ReaderAction,
  ReaderActions,
  ReaderActionsOptions,
} from '../../../src/features/reader/actions/types.js';
import {
  FakeTransport,
  acked,
  apiError,
  makeItem,
  type RecordedCall,
  type SendCall,
} from './fake-transport.js';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const SYSTEM_TIME = Date.parse('2031-01-01T00:00:00.000Z');
const EARLIER = '2026-05-30T10:00:00.000Z';
const SERVER_TIME = '2026-06-01T12:00:00.250Z';
const REQUEST_ID = '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SYSTEM_TIME);
});

interface Rig {
  readonly store: ReaderActions;
  readonly transport: FakeTransport;
  readonly settled: { handle: ActionHandle; result: ActionResult }[];
  readonly clock: { now: number };
  advance(ms: number): Promise<void>;
}

function rig(overrides: Partial<ReaderActionsOptions> = {}): Rig {
  const transport = new FakeTransport();
  const clock = { now: T0 };
  const settled: Rig['settled'] = [];
  let counter = 0;
  const store = createReaderActions({
    transport,
    preferences: () => ({ markReadOnRate: true }),
    now: () => clock.now,
    newId: () => `id-${++counter}`,
    maxRetries: 2,
    backoffMs: () => 100,
    onSettled: (handle, result) => {
      settled.push({ handle, result });
    },
    ...overrides,
  });
  return {
    store,
    transport,
    settled,
    clock,
    async advance(ms) {
      clock.now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const PENDING = Symbol('pending');

async function outcome<T>(promise: Promise<T>): Promise<T> {
  await flush();
  const value = await Promise.race([promise, Promise.resolve(PENDING)]);
  expect(value, 'expected the promise to have settled').not.toBe(PENDING);
  return value as T;
}

function nth<T>(items: readonly T[], index: number): T {
  expect(items.length, `expected at least ${index + 1} recorded call(s)`).toBeGreaterThan(index);
  return items[index] as T;
}

const mid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rate = (rating: 1 | -1 | null): ReaderAction => ({ type: 'rate', rating });

function rows(count: number, first = 1000): ArticleListItem[] {
  return Array.from({ length: count }, (_, index) => makeItem({ id: String(first + index) }));
}

function targetsOf(call: RecordedCall): { id: string }[] {
  return (call.body as { targets: { id: string }[] }).targets;
}

const filter: MarkReadFilter = { lane: 'for_you', olderThan: '2026-06-01T11:59:00.000Z' };

async function ratedAndAcknowledged(rigged: Rig) {
  const item = makeItem();
  const handle = rigged.store.dispatch(item, rate(1));
  await flush();
  const call = nth(rigged.transport.sends, 0);
  const response = acked(item, { rating: 1, readAt: SERVER_TIME });
  call.resolve({ item: response, mutationId: mid(1) });
  await flush();
  return { item, handle, response };
}

describe('bulk size limits', () => {
  it('rejects a markRead of more than 500 items with a RangeError and sends nothing', async () => {
    const { store, transport } = rig();
    const items = rows(501);
    await expect(store.bulk({ kind: 'markRead', items })).rejects.toBeInstanceOf(RangeError);
    await flush();
    expect(transport.calls).toHaveLength(0);
    expect(store.view(items[0] as ArticleListItem)).toBe(items[0]);
  });

  it('rejects a rateBulk of more than 200 items with a RangeError and sends nothing', async () => {
    const { store, transport } = rig();
    const items = rows(201);
    await expect(store.bulk({ kind: 'rateBulk', items, rating: 1 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await flush();
    expect(transport.calls).toHaveLength(0);
    expect(store.view(items[0] as ArticleListItem)).toBe(items[0]);
  });

  it('sends exactly 500 markRead items and exactly 200 rateBulk items', async () => {
    const { store, transport } = rig();
    void store.bulk({ kind: 'markRead', items: rows(500) });
    void store.bulk({ kind: 'rateBulk', items: rows(200, 5000), rating: -1 });
    await flush();
    expect(targetsOf(nth(transport.markReads, 0))).toHaveLength(500);
    expect(targetsOf(nth(transport.rateBulks, 0))).toHaveLength(200);
  });

  it('does not limit the loaded items of a markReadFilter bulk', async () => {
    const { store, transport } = rig();
    const items = rows(501);
    void store.bulk({ kind: 'markReadFilter', filter, datasetVersion: 'ds-1', items });
    await flush();
    expect(nth(transport.markReads, 0).body).toEqual({ filter, datasetVersion: 'ds-1' });
    expect(store.view(items[500] as ArticleListItem).readAt).not.toBeNull();
  });
});

describe('rateBulk targets', () => {
  it('carry no analysisRequestId, also for items that have a selected analysis', async () => {
    const { store, transport } = rig();
    const analysis = { mode: 'training', status: 'pending', requestId: REQUEST_ID } as const;
    const items = [makeItem({ id: '101', analysis }), makeItem({ id: '102', analysis })];
    void store.bulk({ kind: 'rateBulk', items, rating: 1 });
    await flush();
    const targets = targetsOf(nth(transport.rateBulks, 0));
    expect(targets).toEqual([
      { id: '101', stateVersion: '4', contentRevision: '2' },
      { id: '102', stateVersion: '4', contentRevision: '2' },
    ]);
    for (const target of targets) expect(Object.keys(target)).not.toContain('analysisRequestId');
  });
});

describe('retries of bulk and undo requests', () => {
  const unavailable = () => apiError(503, 'ENGINE_UNAVAILABLE');

  it('retries a failed markRead request under the same key and body, then succeeds', async () => {
    const { store, transport, advance } = rig();
    const pending = store.bulk({ kind: 'markRead', items: rows(2) });
    await flush();
    nth(transport.markReads, 0).reject(unavailable());
    await advance(99);
    expect(transport.markReads).toHaveLength(1);
    await advance(1);
    expect(transport.markReads).toHaveLength(2);
    const [first, second] = [nth(transport.markReads, 0), nth(transport.markReads, 1)];
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual(first.body);
    second.resolve({ count: 2, mutationId: mid(7) });
    expect(await outcome(pending)).toEqual({ status: 'done', mutationId: mid(7), count: 2 });
    await advance(10 * 60_000);
    expect(transport.markReads).toHaveLength(2);
  });

  it('retries a failed markReadFilter request under the same key and body, then succeeds', async () => {
    const { store, transport, advance } = rig();
    const pending = store.bulk({
      kind: 'markReadFilter',
      filter,
      datasetVersion: 'ds-1',
      items: rows(2),
    });
    await flush();
    nth(transport.markReads, 0).reject(apiError(500, 'INTERNAL'));
    await advance(100);
    expect(transport.markReads).toHaveLength(2);
    const [first, second] = [nth(transport.markReads, 0), nth(transport.markReads, 1)];
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual({ filter, datasetVersion: 'ds-1' });
    second.resolve({ count: 30, mutationId: mid(8) });
    expect(await outcome(pending)).toEqual({ status: 'done', mutationId: mid(8), count: 30 });
  });

  it('retries a failed rateBulk request under the same key and body, then succeeds', async () => {
    const { store, transport, advance } = rig();
    const items = rows(2);
    const pending = store.bulk({ kind: 'rateBulk', items, rating: 1 });
    await flush();
    nth(transport.rateBulks, 0).reject(unavailable());
    await advance(100);
    expect(transport.rateBulks).toHaveLength(2);
    const [first, second] = [nth(transport.rateBulks, 0), nth(transport.rateBulks, 1)];
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual(first.body);
    const served = items.map((item) => acked(item, { rating: 1 }));
    second.resolve({ count: 2, mutationId: mid(9), items: served });
    expect(await outcome(pending)).toEqual({ status: 'done', mutationId: mid(9), count: 2 });
  });

  it('does not retry a bulk request that is refused with 400', async () => {
    const { store, transport, advance } = rig();
    const pending = store.bulk({ kind: 'markRead', items: rows(2) });
    await flush();
    nth(transport.markReads, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    expect(await outcome(pending)).toMatchObject({ status: 'failed' });
    await advance(10 * 60_000);
    expect(transport.markReads).toHaveLength(1);
  });

  it('retries a failed undo request under the same key and body, then succeeds', async () => {
    const rigged = rig();
    const { store, transport, advance } = rigged;
    const { handle, response } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    nth(transport.undos, 0).reject(unavailable());
    await advance(99);
    expect(transport.undos).toHaveLength(1);
    await advance(1);
    expect(transport.undos).toHaveLength(2);
    const [first, second] = [nth(transport.undos, 0), nth(transport.undos, 1)];
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual({ mutationId: mid(1) });
    const restored = acked(response, { rating: null, readAt: null });
    second.resolve({ count: 1, mutationId: mid(2), items: [restored] });
    expect(await outcome(pending)).toEqual({ status: 'undone', items: [restored] });
  });

  it('does not retry an undo request that fails with a permanent error', async () => {
    const rigged = rig();
    const { store, transport, advance } = rigged;
    const { handle } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    nth(transport.undos, 0).reject(apiError(403, 'FORBIDDEN'));
    expect(await outcome(pending)).toMatchObject({ status: 'failed' });
    await advance(10 * 60_000);
    expect(transport.undos).toHaveLength(1);
  });
});

describe('Retry-After', () => {
  it('is waited out instead of the backoff on a single action', async () => {
    const { store, transport, advance } = rig();
    store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 3000));
    await advance(2999);
    expect(transport.sends).toHaveLength(1);
    await advance(1);
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).key).toBe(nth(transport.sends, 0).key);
  });

  it('is waited out instead of a longer backoff, neither added to it nor capped by it', async () => {
    const { store, transport, advance } = rig({ backoffMs: () => 500 });
    store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(503, 'ENGINE_UNAVAILABLE', undefined, 20));
    await advance(19);
    expect(transport.sends).toHaveLength(1);
    await advance(1);
    expect(transport.sends).toHaveLength(2);
  });

  it('is waited out instead of the backoff on a bulk request', async () => {
    const { store, transport, advance } = rig();
    void store.bulk({ kind: 'markRead', items: rows(2) });
    await flush();
    nth(transport.markReads, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 3000));
    await advance(2999);
    expect(transport.markReads).toHaveLength(1);
    await advance(1);
    expect(transport.markReads).toHaveLength(2);
  });
});

describe('view identity', () => {
  it('returns the identical object for repeated calls with an active overlay until the version changes', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'bookmark' });

    const shown = store.view(item);
    const version = store.getVersion();
    expect(shown).not.toBe(item);
    expect(store.view(item)).toBe(shown);
    expect(store.view(item)).toBe(shown);
    expect(store.getVersion()).toBe(version);

    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    expect(store.getVersion()).toBeGreaterThan(version);
    const changed = store.view(item);
    expect(changed).not.toBe(shown);
    expect(changed).toMatchObject({ labelIds: ['9'] });
    expect(store.view(item)).toBe(changed);
  });

  it('returns a new object when an acknowledgement changes the displayed state', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    const before = store.view(item);
    nth(transport.sends, 0).resolve({
      item: acked(item, { bookmarkedAt: SERVER_TIME }),
      mutationId: mid(1),
    });
    await flush();
    const after = store.view(item);
    expect(after).not.toBe(before);
    expect(after.bookmarkedAt).toBe(SERVER_TIME);
    expect(store.view(item)).toBe(after);
  });
});

describe('acknowledged no-ops', () => {
  it('leaves an ack with an unchanged stateVersion out of recent() and refuses its undo as not_undoable', async () => {
    const { store, transport } = rig();
    const item = makeItem({ readAt: EARLIER });
    const handle = store.dispatch(item, { type: 'read' });
    await flush();
    nth(transport.sends, 0).resolve({ item, mutationId: mid(1) });
    expect(await outcome(handle.result)).toMatchObject({ status: 'done', mutationId: mid(1) });
    expect(store.recent()).toEqual([]);
    expect(await outcome(store.undo(handle.id))).toEqual({
      status: 'refused',
      reason: 'not_undoable',
    });
    expect(transport.undos).toHaveLength(0);
  });

  it('judges a no-op by the version that was sent, not by the row the caller held', async () => {
    const { store, transport } = rig();
    const held = makeItem({ stateVersion: '4' });
    const current = makeItem({ stateVersion: '7', contentRevision: '3', bookmarkedAt: EARLIER });
    store.observe([current]);
    const handle = store.dispatch(held, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '7', contentRevision: '3' });
    nth(transport.sends, 0).resolve({ item: current, mutationId: mid(1) });
    await outcome(handle.result);
    expect(store.recent()).toEqual([]);
  });

  it('leaves a markRead that changed no row out of recent()', async () => {
    const { store, transport } = rig();
    const pending = store.bulk({ kind: 'markRead', items: rows(2) });
    await flush();
    nth(transport.markReads, 0).resolve({ count: 0, mutationId: mid(1) });
    expect(await outcome(pending)).toEqual({ status: 'done', mutationId: mid(1), count: 0 });
    expect(store.recent()).toEqual([]);
  });
});

describe('newest known state', () => {
  it('prefers a newer contentRevision when the stateVersions are equal', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4', contentRevision: '2' });
    store.observe([item]);
    store.observe([makeItem({ stateVersion: '4', contentRevision: '3' })]);
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '4', contentRevision: '3' });
  });

  it('adopts the item of a STALE_STATE that only a newer contentRevision makes newer', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4', contentRevision: '2' });
    const handle = store.dispatch(item, rate(1));
    await flush();
    const revised = makeItem({ stateVersion: '4', contentRevision: '3' });
    nth(transport.sends, 0).reject(apiError(409, 'STALE_STATE', { item: revised }));
    expect(await outcome(handle.result)).toEqual({ status: 'stale', item: revised });
    expect(store.view(item)).toMatchObject({ stateVersion: '4', contentRevision: '3' });

    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '4', contentRevision: '3' });
  });
});

describe('retry', () => {
  const states: readonly (readonly [string, (rigged: Rig) => Promise<ActionHandle>])[] = [
    [
      'sending',
      async ({ store }) => {
        const handle = store.dispatch(makeItem(), rate(1));
        await flush();
        return handle;
      },
    ],
    [
      'queued',
      async ({ store }) => {
        const item = makeItem();
        store.dispatch(item, rate(1));
        const handle = store.dispatch(item, { type: 'bookmark' });
        await flush();
        return handle;
      },
    ],
    [
      'held',
      async ({ store }) => {
        const handle = store.dispatch(makeItem(), rate(-1), { hold: true });
        await flush();
        return handle;
      },
    ],
    [
      'done',
      async ({ store, transport }) => {
        const item = makeItem();
        const handle = store.dispatch(item, rate(1));
        await flush();
        nth(transport.sends, 0).resolve({ item: acked(item), mutationId: mid(1) });
        await flush();
        return handle;
      },
    ],
    [
      'stale',
      async ({ store, transport }) => {
        const handle = store.dispatch(makeItem(), rate(1));
        await flush();
        nth(transport.sends, 0).reject(
          apiError(409, 'STALE_STATE', { item: makeItem({ stateVersion: '8' }) }),
        );
        await flush();
        return handle;
      },
    ],
    [
      'cancelled',
      async ({ store }) => {
        const handle = store.dispatch(makeItem(), rate(-1), { hold: true });
        store.cancel(handle.id);
        await flush();
        return handle;
      },
    ],
  ];

  it.each(states)('returns null for a %s action and sends nothing', async (status, start) => {
    const rigged = rig();
    const handle = await start(rigged);
    const calls = rigged.transport.calls.length;
    const shown = rigged.store.view(makeItem());
    expect(rigged.store.get(handle.id)?.status).toBe(status);
    expect(rigged.store.retry(handle.id)).toBeNull();
    await flush();
    expect(rigged.transport.calls).toHaveLength(calls);
    expect(rigged.store.get(handle.id)?.status).toBe(status);
    expect(rigged.store.view(makeItem())).toEqual(shown);
  });
});

describe('undo without a receipt', () => {
  it('refuses an unknown id as unknown without a request', async () => {
    const { store, transport } = rig();
    expect(await outcome(store.undo('nope'))).toEqual({ status: 'refused', reason: 'unknown' });
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses a failed action as unknown without a request', async () => {
    const { store, transport } = rig();
    const handle = store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    expect((await outcome(handle.result)).status).toBe('failed');
    expect(await outcome(store.undo(handle.id))).toEqual({ status: 'refused', reason: 'unknown' });
    expect(transport.undos).toHaveLength(0);
  });

  it('refuses a stale action as unknown without a request', async () => {
    const { store, transport } = rig();
    const handle = store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(
      apiError(409, 'STALE_STATE', { item: makeItem({ stateVersion: '8' }) }),
    );
    expect((await outcome(handle.result)).status).toBe('stale');
    expect(await outcome(store.undo(handle.id))).toEqual({ status: 'refused', reason: 'unknown' });
    expect(transport.undos).toHaveLength(0);
  });
});

describe('reset', () => {
  const unsettled: readonly (readonly [string, (rigged: Rig) => ActionHandle])[] = [
    ['sending', ({ store }) => store.dispatch(makeItem(), rate(1))],
    [
      'queued',
      ({ store }) => {
        const item = makeItem();
        store.dispatch(item, rate(1));
        return store.dispatch(item, { type: 'bookmark' });
      },
    ],
    ['held', ({ store }) => store.dispatch(makeItem(), rate(-1), { hold: true })],
  ];

  it.each(unsettled)(
    'resolves the result of a %s action as cancelled without calling onSettled',
    async (_name, start) => {
      const rigged = rig();
      const handle = start(rigged);
      await flush();
      rigged.store.reset();
      expect(await outcome(handle.result)).toEqual({ status: 'cancelled' });
      await rigged.advance(10 * 60_000);
      expect(rigged.settled).toEqual([]);
    },
  );

  it('leaves the result of an action that settled before the reset as it was', async () => {
    const rigged = rig();
    const { handle } = await ratedAndAcknowledged(rigged);
    expect(rigged.settled).toHaveLength(1);
    rigged.store.reset();
    await flush();
    expect(rigged.settled).toHaveLength(1);
    expect(await outcome(handle.result)).toMatchObject({ status: 'done' });
  });
});

describe('recent bulk actions', () => {
  it('lists an acknowledged markReadFilter bulk with the ids of the given items', async () => {
    const { store, transport } = rig();
    const items = [makeItem({ id: '101' }), makeItem({ id: '102' })];
    const pending = store.bulk({ kind: 'markReadFilter', filter, datasetVersion: 'ds-3', items });
    await flush();
    nth(transport.markReads, 0).resolve({ count: 40, mutationId: mid(5) });
    await outcome(pending);
    expect(store.recent()).toEqual([
      {
        id: expect.any(String) as string,
        kind: 'markReadFilter',
        articleIds: ['101', '102'],
        at: T0,
        mutationId: mid(5),
      },
    ]);
  });
});

describe('markRead acknowledgement', () => {
  it('fences a later action at stateVersion + 1 only on the rows a markRead changed', async () => {
    const { store, transport } = rig();
    const unread = makeItem({ id: '101', stateVersion: '4' });
    const read = makeItem({ id: '102', stateVersion: '9', readAt: EARLIER });
    const pending = store.bulk({ kind: 'markRead', items: [unread, read] });
    await flush();
    nth(transport.markReads, 0).resolve({ count: 1, mutationId: mid(1) });
    await outcome(pending);
    store.dispatch(unread, { type: 'bookmark' });
    store.dispatch(read, { type: 'bookmark' });
    await flush();
    const [first, second] = transport.sends as [SendCall, SendCall];
    expect(first.fence.stateVersion).toBe('5');
    expect(second.fence.stateVersion).toBe('9');
    expect(store.view(read).readAt).toBe(EARLIER);
  });
});

describe('bulk ordering', () => {
  it('sends a bulk after an earlier action on one of its articles, fenced at its acknowledged version', async () => {
    const { store, transport } = rig();
    const first = makeItem({ id: '101', stateVersion: '4' });
    const second = makeItem({ id: '102', stateVersion: '7' });
    store.dispatch(first, rate(1));
    const pending = store.bulk({ kind: 'markRead', items: [first, second] });
    await flush();
    expect(transport.markReads).toHaveLength(0);
    expect(store.view(second).readAt).not.toBeNull();
    nth(transport.sends, 0).resolve({
      item: acked(first, { rating: 1, readAt: SERVER_TIME }),
      mutationId: mid(1),
    });
    await flush();
    const call = nth(transport.markReads, 0);
    expect(call.body).toEqual({
      targets: [
        { id: '101', stateVersion: '5', contentRevision: '2' },
        { id: '102', stateVersion: '7', contentRevision: '2' },
      ],
    });
    call.resolve({ count: 1, mutationId: mid(2) });
    expect(await outcome(pending)).toEqual({ status: 'done', mutationId: mid(2), count: 1 });
  });

  it('sends an action on an article after a bulk that covers it, fenced at the version the bulk left', async () => {
    const { store, transport } = rig();
    const item = makeItem({ id: '101', stateVersion: '4' });
    const pending = store.bulk({ kind: 'markRead', items: [item] });
    await flush();
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(transport.sends).toHaveLength(0);
    nth(transport.markReads, 0).resolve({ count: 1, mutationId: mid(1) });
    await outcome(pending);
    await flush();
    expect(nth(transport.sends, 0).fence.stateVersion).toBe('5');
  });

  it('waits for a held action ahead of it until that action is released and acknowledged', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const held = store.dispatch(item, rate(-1), { hold: true });
    void store.bulk({ kind: 'rateBulk', items: [item], rating: 1 });
    await flush();
    expect(transport.calls).toHaveLength(0);
    store.release(held.id);
    await flush();
    expect(transport.calls.map((call) => call.method)).toEqual(['send']);
    nth(transport.sends, 0).resolve({ item: acked(item, { rating: -1 }), mutationId: mid(1) });
    await flush();
    expect(transport.calls.map((call) => call.method)).toEqual(['send', 'rateBulk']);
    expect(targetsOf(nth(transport.rateBulks, 0))).toEqual([
      { id: '101', stateVersion: '5', contentRevision: '2' },
    ]);
  });

  it('goes as soon as a held action ahead of it is cancelled', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const held = store.dispatch(item, rate(-1), { hold: true });
    void store.bulk({ kind: 'markRead', items: [item] });
    await flush();
    expect(store.cancel(held.id)).toBe(true);
    await flush();
    expect(transport.calls.map((call) => call.method)).toEqual(['markRead']);
  });

  it('fails a bulk still waiting for its turn when the account is reset, and sends nothing', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    const pending = store.bulk({ kind: 'markRead', items: [item] });
    await flush();
    store.reset();
    expect(await outcome(pending)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } });
    await flush();
    expect(transport.markReads).toHaveLength(0);
  });
});

describe('a long Retry-After', () => {
  it('is not waited out above 30 s: the action fails after its one request', async () => {
    const { store, transport, advance } = rig();
    const handle = store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 30_001));
    expect(await outcome(handle.result)).toMatchObject({
      status: 'failed',
      error: { status: 429, retryAfterMs: 30_001 },
    });
    await advance(60_000);
    expect(transport.sends).toHaveLength(1);
  });

  it('is waited out at exactly 30 s', async () => {
    const { store, transport, advance } = rig();
    store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 30_000));
    await advance(29_999);
    expect(transport.sends).toHaveLength(1);
    await advance(1);
    expect(transport.sends).toHaveLength(2);
  });
});
