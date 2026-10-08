import type { ArticleListItem } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { createReaderActions } from '../../../src/features/reader/actions/store.js';
import {
  OFFLINE_ACTIONS,
  READER_FIELDS,
  type ActionHandle,
  type ActionQueue,
  type ActionResult,
  type Fence,
  type ReaderAction,
  type ReaderActions,
  type ReaderState,
  type RecordPatch,
  type SettledNote,
  type UndoResult,
} from '../../../src/features/reader/actions/types.js';
import type { QueueRecord } from '../../../src/offline/types.js';
import {
  FakeTransport,
  acked,
  apiError,
  invalidResponseError,
  makeItem,
  networkError,
  type SendCall,
} from './fake-transport.js';

const T0 = Date.parse('2026-10-08T08:00:00.000Z');
const ACCOUNT = 'account-a';
const REQUEST_ID = '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10';
const FENCE: Fence = { stateVersion: '4', contentRevision: '2' };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settleAll(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await tick();
}

function readerOf(item: ArticleListItem): ReaderState {
  return Object.fromEntries(READER_FIELDS.map((field) => [field, item[field]])) as ReaderState;
}

/** The queue store of an account, in memory, with a log of what was asked of it. */
class FakeQueue implements ActionQueue {
  readonly accountId = ACCOUNT;
  readonly records = new Map<string, QueueRecord>();
  readonly log: string[] = [];
  readonly announced: SettledNote[] = [];
  private readonly listeners = new Set<(note: SettledNote) => void>();
  enabledNow = true;
  onlineNow = true;
  failSaves = false;
  holding = 0;

  enabled = () => this.enabledNow;
  online = () => this.onlineNow;

  save(record: QueueRecord): Promise<boolean> {
    this.log.push(`save:${record.id}`);
    if (this.failSaves) return Promise.resolve(false);
    this.records.set(record.id, structuredClone(record));
    return Promise.resolve(true);
  }

  change(id: string, patch: RecordPatch): Promise<boolean> {
    const current = this.records.get(id);
    this.log.push(`change:${id}:${Object.keys(patch).join(',')}`);
    if (current === undefined) return Promise.resolve(false);
    this.records.set(id, structuredClone({ ...current, ...patch }));
    return Promise.resolve(true);
  }

  remove(id: string): Promise<void> {
    this.log.push(`remove:${id}`);
    this.records.delete(id);
    return Promise.resolve();
  }

  announce(note: SettledNote): void {
    this.announced.push(note);
  }

  hear(listener: (note: SettledNote) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.holding += 1;
    try {
      return await work();
    } finally {
      this.holding -= 1;
    }
  }

  /** Another tab says how a record ended. */
  emit(note: SettledNote): void {
    for (const listener of [...this.listeners]) listener(note);
  }

  saved(): string[] {
    return this.log.filter((entry) => entry.startsWith('save:'));
  }
}

interface Seen {
  record: QueueRecord | undefined;
  holding: number;
}

/** Notes what the queue store held, and whether the tab held the lock, when each request began. */
class ObservingTransport extends FakeTransport {
  readonly seen: Seen[] = [];

  constructor(private readonly queue: FakeQueue) {
    super();
  }

  override send(
    articleId: string,
    action: ReaderAction,
    fence: Fence,
    idempotencyKey: string,
    signal: AbortSignal,
  ) {
    const record = [...this.queue.records.values()].find((entry) => entry.key === idempotencyKey);
    this.seen.push({ record: record && structuredClone(record), holding: this.queue.holding });
    return super.send(articleId, action, fence, idempotencyKey, signal);
  }
}

interface Rig {
  store: ReaderActions;
  queue: FakeQueue;
  transport: ObservingTransport;
  settled: { handle: ActionHandle; result: ActionResult }[];
  clock: { now: number };
}

function rig(options: { enabled?: boolean; online?: boolean; retries?: number } = {}): Rig {
  const queue = new FakeQueue();
  queue.enabledNow = options.enabled ?? true;
  queue.onlineNow = options.online ?? true;
  const transport = new ObservingTransport(queue);
  const clock = { now: T0 };
  const settled: Rig['settled'] = [];
  let counter = 0;
  const store = createReaderActions({
    transport,
    queue,
    preferences: () => ({ markReadOnRate: true }),
    now: () => clock.now,
    newId: () => `id-${(counter += 1)}`,
    maxRetries: options.retries ?? 0,
    backoffMs: () => 0,
    onSettled: (handle, result) => {
      settled.push({ handle, result });
    },
  });
  return { store, queue, transport, settled, clock };
}

const mutation = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ack(call: SendCall, item: ArticleListItem, patch: Partial<ArticleListItem> = {}) {
  const next = acked(item, patch);
  call.resolve({ item: next, mutationId: mutation(call.index + 1) });
  return next;
}

function sendAt(transport: FakeTransport, index: number): SendCall {
  const call = transport.sends[index];
  expect(call, `expected request ${index + 1}`).toBeDefined();
  return call!;
}

function recordOf(overrides: Partial<QueueRecord> & Pick<QueueRecord, 'id'>): QueueRecord {
  return {
    schema: 1,
    key: overrides.id,
    accountId: ACCOUNT,
    articleId: '101',
    action: { type: 'rate', rating: 1 },
    fence: FENCE,
    after: null,
    before: readerOf(makeItem()),
    createdAt: T0 - 1000,
    stamp: new Date(T0 - 1000).toISOString(),
    markRead: true,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: T0 - 1000,
    ...overrides,
  };
}

const ELIGIBLE: Record<(typeof OFFLINE_ACTIONS)[number], ReaderAction> = {
  read: { type: 'read' },
  unread: { type: 'unread' },
  rate: { type: 'rate', rating: 1 },
  bookmark: { type: 'bookmark' },
  unbookmark: { type: 'unbookmark' },
  addLabel: { type: 'addLabel', labelId: '9' },
  removeLabel: { type: 'removeLabel', labelId: '9' },
};

const NOT_ELIGIBLE: ReaderAction[] = [
  { type: 'unhide' },
  { type: 'promptAnswer', liked: true },
  { type: 'retryCapture', captureGeneration: '1' },
  { type: 'open' },
  { type: 'dwell', ms: 30_000 },
];

describe('what is kept on the device', () => {
  it.each(OFFLINE_ACTIONS)('keeps a %s before its first request', async (type) => {
    const { store, queue, transport } = rig();
    const handle = store.dispatch(makeItem(), ELIGIBLE[type]);
    await settleAll();

    expect(queue.saved()).toEqual([`save:${handle.id}`]);
    expect(transport.sends).toHaveLength(1);
    expect(transport.seen[0]?.record).toMatchObject({
      id: handle.id,
      key: handle.id,
      action: ELIGIBLE[type],
    });
  });

  it.each(NOT_ELIGIBLE)('never keeps $type', async (action) => {
    const { store, queue, transport } = rig();
    store.dispatch(makeItem(), action);
    await settleAll();

    expect(queue.log).toEqual([]);
    expect(queue.records.size).toBe(0);
    expect(transport.sends).toHaveLength(1);
    expect(transport.seen[0]).toEqual({ record: undefined, holding: 0 });
  });

  it('keeps nothing while the account has not chosen offline reading, and sends as before', async () => {
    const { store, queue, transport } = rig({ enabled: false });
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: 1 });
    await settleAll();
    ack(sendAt(transport, 0), makeItem(), { rating: 1 });
    await handle.result;

    expect(queue.log).toEqual([]);
    expect(transport.seen[0]).toEqual({ record: undefined, holding: 0 });
  });

  it('writes the record in full: key, fence of the state acted on, before-state, time, stamp, snapshot, and the mark of a request that left', async () => {
    const { store, queue } = rig();
    const item = makeItem();
    const action: ReaderAction = {
      type: 'rate',
      rating: -1,
      reason: 'clickbait',
      hide: true,
      analysisRequestId: REQUEST_ID,
    };

    const handle = store.dispatch(item, action, { snapshot: { id: 's1', contentRevision: '9' } });
    await settleAll();

    expect(queue.records.get(handle.id)).toEqual({
      schema: 1,
      id: handle.id,
      key: handle.id,
      accountId: ACCOUNT,
      articleId: '101',
      action,
      fence: { stateVersion: '4', contentRevision: '9', snapshotId: 's1' },
      after: null,
      before: readerOf(item),
      createdAt: T0,
      stamp: new Date(T0).toISOString(),
      markRead: true,
      snapshot: { id: 's1', contentRevision: '9' },
      sent: true,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: T0,
    });
  });

  it('removes the record when the change is acknowledged and tells the other tabs', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    const next = ack(sendAt(transport, 0), item, { bookmarkedAt: '2026-10-08T08:00:00.000Z' });
    await handle.result;
    await settleAll();

    expect(queue.records.size).toBe(0);
    expect(queue.announced).toEqual([
      { id: handle.id, outcome: 'done', item: next, mutationId: mutation(1) },
    ]);
  });

  it.each([
    ['stale', apiError(409, 'STALE_STATE', { item: makeItem({ stateVersion: '6' }) }), 'stale'],
    ['a refusal', apiError(400, 'VALIDATION_FAILED'), 'failed'],
  ] as const)('removes the record when the change ends as %s', async (_name, error, outcome) => {
    const { store, queue, transport } = rig();
    const handle = store.dispatch(makeItem(), { type: 'bookmark' });
    await settleAll();
    sendAt(transport, 0).reject(error);
    await handle.result;
    await settleAll();

    expect(queue.records.size).toBe(0);
    expect(queue.announced.map((note) => note.outcome)).toEqual([outcome]);
  });

  it('removes the record of a change that is cancelled before it is sent', async () => {
    const { store, queue } = rig({ online: false });
    const held = store.dispatch(makeItem(), { type: 'rate', rating: -1 }, { hold: true });
    expect(store.cancel(held.id)).toBe(true);
    await settleAll();

    expect(queue.log).toEqual([]);
    const queued = store.dispatch(makeItem({ id: '202' }), { type: 'read' });
    await settleAll();
    expect(queue.records.has(queued.id)).toBe(true);
  });

  it('removes the record of a kept change that is cancelled while it waits behind another', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();
    const behind = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    expect(queue.records.has(behind.id)).toBe(true);

    expect(store.cancel(behind.id)).toBe(true);
    await settleAll();

    expect(queue.records.has(behind.id)).toBe(false);
    expect(queue.announced).toEqual([{ id: behind.id, outcome: 'cancelled' }]);
    expect(store.view(item).bookmarkedAt).toBeNull();
    expect(store.offline.waiting()).toHaveLength(1);
  });

  it('keeps the record when the store is released, for the next page', async () => {
    const { store, queue, settled } = rig({ online: false });
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: 1 });
    await settleAll();

    store.reset();
    await settleAll();

    expect(queue.records.has(handle.id)).toBe(true);
    expect(queue.announced).toEqual([]);
    expect(settled).toEqual([]);
    expect(await handle.result).toEqual({ status: 'cancelled' });
  });
});

describe('a record that cannot be written', () => {
  it('lets the change go to the server as it did before, with no record and no lock', async () => {
    const { store, queue, transport } = rig();
    queue.failSaves = true;
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();

    expect(transport.seen[0]).toEqual({ record: undefined, holding: 0 });
    ack(sendAt(transport, 0), item, { rating: 1 });
    expect(await handle.result).toMatchObject({ status: 'done' });
    await settleAll();
    expect(queue.records.size).toBe(0);
    expect(queue.announced).toEqual([]);
  });

  it('fails the change at once without a connection, and does not suggest turning offline reading on', async () => {
    const { store, queue, transport } = rig({ online: false });
    queue.failSaves = true;
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: 1 });

    expect(await handle.result).toMatchObject({
      status: 'failed',
      error: { code: 'OFFLINE', details: { eligible: false } },
    });
    expect(transport.calls).toEqual([]);
  });
});

describe('changes that follow each other', () => {
  it('chains the second after the first and fences it by the answer to the first, written before the first is removed', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = store.dispatch(item, { type: 'rate', rating: 1 });
    const second = store.dispatch(item, { type: 'bookmark' });
    await settleAll();

    expect(queue.records.get(first.id)).toMatchObject({ after: null, fence: FENCE });
    expect(queue.records.get(second.id)).toMatchObject({ after: first.id, fence: null });
    expect(transport.sends).toHaveLength(1);

    ack(sendAt(transport, 0), item, { rating: 1 });
    await settleAll();

    const fenced = { stateVersion: '5', contentRevision: '2' };
    expect(sendAt(transport, 1).fence).toEqual(fenced);
    expect(transport.seen[1]?.record).toMatchObject({ id: second.id, fence: fenced });
    expect(queue.log.indexOf(`change:${second.id}:fence`)).toBeGreaterThan(-1);
    expect(queue.log.indexOf(`change:${second.id}:fence`)).toBeLessThan(
      queue.log.indexOf(`remove:${first.id}`),
    );
  });

  it('follows the nearest earlier change that is kept, and takes its fence from the state then known', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const opened = store.dispatch(item, { type: 'open' });
    const third = store.dispatch(item, { type: 'read' });
    await settleAll();

    expect(queue.records.get(third.id)).toMatchObject({ after: null, fence: null });
    ack(sendAt(transport, 0), item);
    await opened.result;
    await settleAll();

    expect(sendAt(transport, 1).fence).toEqual({ stateVersion: '5', contentRevision: '2' });
    expect(transport.seen[1]?.record?.fence).toEqual({ stateVersion: '5', contentRevision: '2' });
  });

  it('records the state shown before each change', async () => {
    const { store, queue } = rig({ online: false });
    const item = makeItem();
    const liked = store.dispatch(item, { type: 'rate', rating: 1 });
    const marked = store.dispatch(item, { type: 'bookmark' });
    await settleAll();

    expect(queue.records.get(liked.id)?.before).toEqual(readerOf(item));
    expect(queue.records.get(marked.id)?.before).toMatchObject({ rating: 1, bookmarkedAt: null });
  });
});

describe('a dislike held for its reason', () => {
  it('is kept when it is released, with the reason chosen', async () => {
    const { store, queue, transport } = rig();
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: -1 }, { hold: true });
    await settleAll();

    expect(queue.log).toEqual([]);
    expect(transport.sends).toHaveLength(0);

    store.release(handle.id, { reason: 'seen' });
    await settleAll();

    expect(queue.records.get(handle.id)).toMatchObject({
      action: { type: 'rate', rating: -1, reason: 'seen' },
      fence: FENCE,
    });
    expect(transport.seen[0]?.record?.action).toEqual({ type: 'rate', rating: -1, reason: 'seen' });
  });

  it('waits on the device when it is released without a connection', async () => {
    const { store, queue, transport } = rig({ online: false });
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: -1 }, { hold: true });
    store.release(handle.id, { reason: 'promo', hide: true });
    await settleAll();

    expect(handle.status).toBe('waiting');
    expect(transport.calls).toEqual([]);
    expect(queue.records.get(handle.id)?.action).toEqual({
      type: 'rate',
      rating: -1,
      reason: 'promo',
      hide: true,
    });
  });
});

describe('a key that the server found obsolete', () => {
  it('is replaced in the record before the rating is sent again without its request id', async () => {
    const { store, queue, transport } = rig();
    const handle = store.dispatch(makeItem(), {
      type: 'rate',
      rating: 1,
      analysisRequestId: REQUEST_ID,
    });
    await settleAll();
    sendAt(transport, 0).reject(apiError(409, 'CONFLICT', { reason: 'obsolete_request' }));
    await settleAll();

    const again = sendAt(transport, 1);
    expect(again.key).not.toBe(handle.id);
    expect(again.action).toEqual({ type: 'rate', rating: 1 });
    expect(transport.seen[1]?.record).toMatchObject({
      id: handle.id,
      key: again.key,
      action: { type: 'rate', rating: 1 },
    });
    expect(queue.log.indexOf(`change:${handle.id}:key,action`)).toBeGreaterThan(-1);
  });
});

describe('a send that cannot reach the server', () => {
  it.each([
    ['a network error', networkError()],
    ['a 503', apiError(503, 'UNAVAILABLE')],
    ['a 500', apiError(500, 'INTERNAL')],
    ['a 429', apiError(429, 'RATE_LIMITED')],
    ['a 401', apiError(401, 'UNAUTHENTICATED')],
  ])('leaves the change waiting, shown, and unreported after %s', async (_name, error) => {
    const { store, queue, transport, settled } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(error);
    await settleAll();

    expect(handle.status).toBe('waiting');
    expect(handle.replayed).toBe(true);
    expect(settled).toEqual([]);
    expect(store.view(item).rating).toBe(1);
    expect(store.offline.waiting().map((waiting) => waiting.id)).toEqual([handle.id]);
    expect(queue.records.has(handle.id)).toBe(true);
    expect(transport.sends).toHaveLength(1);
  });

  it.each([
    ['a 400', apiError(400, 'VALIDATION_FAILED')],
    ['a 403', apiError(403, 'FORBIDDEN')],
    ['a 404', apiError(404, 'NOT_FOUND')],
    ['a 409', apiError(409, 'CONFLICT', { reason: 'something' })],
    ['an invalid answer', invalidResponseError()],
  ])('fails the change at once after %s, and removes its record', async (_name, error) => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(error);
    const result = await handle.result;
    await settleAll();

    expect(result.status).toBe('failed');
    expect(store.view(item).rating).toBeNull();
    expect(store.offline.waiting()).toEqual([]);
    expect(queue.records.size).toBe(0);
  });

  it('sends the waiting change again, under the same key and fence, when asked to drain', async () => {
    const { store, queue, transport, settled } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    const draining = store.offline.drain();
    await settleAll();
    const again = sendAt(transport, 1);
    expect([again.key, again.fence, again.action]).toEqual([
      handle.id,
      FENCE,
      { type: 'rate', rating: 1 },
    ]);
    expect(transport.seen[1]?.holding).toBe(1);
    ack(again, item, { rating: 1 });
    await draining;
    await settleAll();

    expect(handle.status).toBe('done');
    expect(queue.records.size).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toMatchObject({
      status: 'done',
      exampleSuggestion: null,
      prompt: false,
    });
    expect(store.offline.waiting()).toEqual([]);
  });

  it('never shows an example suggestion or the prompt for an answer to a replayed change', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    const draining = store.offline.drain();
    await settleAll();
    sendAt(transport, 1).resolve({
      item: acked(item, { rating: 1 }),
      mutationId: mutation(2),
      exampleSuggestion: { cardId: '31', side: 'yes' },
      prompt: true,
    });
    await draining;

    expect(await handle.result).toMatchObject({
      status: 'done',
      exampleSuggestion: null,
      prompt: false,
    });
  });

  it('shows a suggestion for a change that was sent at the first try', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).resolve({
      item: acked(item, { rating: 1 }),
      mutationId: mutation(1),
      exampleSuggestion: { cardId: '31', side: 'yes' },
    });

    expect(await handle.result).toMatchObject({
      status: 'done',
      exampleSuggestion: { cardId: '31', side: 'yes' },
    });
  });

  it('keeps a later change on the device behind the waiting one, and sends it after', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    const second = store.dispatch(item, { type: 'bookmark' });
    await settleAll();

    expect(second.status).toBe('queued');
    expect(queue.records.get(second.id)).toMatchObject({ after: first.id });
    expect(transport.sends).toHaveLength(1);
    expect(store.offline.waiting().map((waiting) => waiting.id)).toEqual([first.id, second.id]);

    const draining = store.offline.drain();
    await settleAll();
    const next = ack(sendAt(transport, 1), item, { rating: 1 });
    await settleAll();
    expect(sendAt(transport, 2).fence).toEqual({
      stateVersion: next.stateVersion,
      contentRevision: next.contentRevision,
    });
    ack(sendAt(transport, 2), next, { bookmarkedAt: '2026-10-08T08:00:01.000Z' });
    await draining;
    await settleAll();

    expect(queue.records.size).toBe(0);
    expect(store.offline.waiting()).toEqual([]);
  });

  it('fails a change that cannot be kept when it follows one that waits', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    const unhide = store.dispatch(item, { type: 'unhide' });

    expect(unhide.status).toBe('failed');
    expect(await unhide.result).toMatchObject({ status: 'failed', error: { code: 'NETWORK' } });
    expect(transport.sends).toHaveLength(1);
  });
});

describe('a bulk action and the changes that wait', () => {
  it('is refused at once when a change of one of its articles waits for a replay', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    const result = await store.bulk({ kind: 'markRead', items: [item, makeItem({ id: '202' })] });

    expect(result).toMatchObject({ status: 'failed', error: { code: 'OFFLINE' } });
    expect(transport.markReads).toEqual([]);
    expect(store.view(makeItem({ id: '202' })).readAt).toBeNull();
  });

  it('is refused when the change in front of it stops to wait for a replay, and the others go on', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const other = makeItem({ id: '202' });
    const rating = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    const bulk = store.bulk({ kind: 'markRead', items: [item, other] });
    const later = store.dispatch(other, { type: 'bookmark' });
    await settleAll();
    expect(transport.sends).toHaveLength(1);

    sendAt(transport, 0).reject(networkError());

    await expect(bulk).resolves.toMatchObject({ status: 'failed', error: { code: 'OFFLINE' } });
    expect(rating.status).toBe('waiting');
    expect(transport.markReads).toEqual([]);
    expect(store.view(other).readAt).toBeNull();
    await settleAll();
    expect(sendAt(transport, 1)).toMatchObject({ articleId: '202', action: { type: 'bookmark' } });
    expect(later.status).toBe('sending');
  });
});

describe('a change made without a connection', () => {
  it('waits on the device, shown, with no request, when the account chose offline reading', async () => {
    const { store, queue, transport, settled } = rig({ online: false });
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'bookmark' });
    await settleAll();

    expect(handle.status).toBe('waiting');
    expect(transport.calls).toEqual([]);
    expect(settled).toEqual([]);
    expect(store.view(item).bookmarkedAt).not.toBeNull();
    expect(queue.records.get(handle.id)).toMatchObject({ fence: FENCE });
  });

  it.each([
    ['rate', { type: 'rate', rating: 1 } as ReaderAction, true],
    ['bookmark', { type: 'bookmark' } as ReaderAction, true],
    ['unhide', { type: 'unhide' } as ReaderAction, false],
    ['promptAnswer', { type: 'promptAnswer', liked: true } as ReaderAction, false],
    ['retryCapture', { type: 'retryCapture', captureGeneration: '1' } as ReaderAction, false],
  ])(
    'fails %s at once when the account has not chosen offline reading or it cannot wait',
    async (_name, action, eligible) => {
      const { store, queue, transport } = rig({ enabled: eligible ? false : true, online: false });
      const item = makeItem();

      const handle = store.dispatch(item, action);

      expect(handle.status).toBe('failed');
      const result = await handle.result;
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'OFFLINE', kind: 'network', details: { eligible } },
      });
      expect(store.view(item)).toEqual(item);
      await settleAll();
      expect(transport.calls).toEqual([]);
      expect(queue.log).toEqual([]);
    },
  );

  it('does not retry a request when the browser says it is offline', async () => {
    const { store, queue, transport } = rig({ online: true, retries: 2 });
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    queue.onlineNow = false;
    sendAt(transport, 0).reject(networkError());
    await settleAll();

    expect(handle.status).toBe('waiting');
    expect(transport.sends).toHaveLength(1);
  });
});

describe('the changes of an earlier page', () => {
  it('are shown as waiting changes, in the order they were made, and sent in that order', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = recordOf({ id: 'r1', createdAt: T0 - 3000 });
    const second = recordOf({
      id: 'r2',
      action: { type: 'bookmark' },
      fence: null,
      after: 'r1',
      createdAt: T0 - 2000,
    });
    for (const record of [first, second]) queue.records.set(record.id, record);

    store.offline.adopt([second, first], store.offline.mark());

    expect(store.offline.waiting().map((waiting) => waiting.id)).toEqual(['r1', 'r2']);
    expect(store.offline.waiting().every((waiting) => waiting.status === 'waiting')).toBe(true);
    expect(store.view(item)).toMatchObject({ rating: 1, bookmarkedAt: expect.any(String) });
    expect(store.offline.waiting('999')).toEqual([]);

    const draining = store.offline.drain();
    await settleAll();
    expect(transport.sends).toHaveLength(1);
    expect(sendAt(transport, 0)).toMatchObject({ key: 'r1', fence: FENCE });
    const next = ack(sendAt(transport, 0), item, { rating: 1 });
    await settleAll();
    expect(sendAt(transport, 1)).toMatchObject({
      key: 'r2',
      fence: { stateVersion: next.stateVersion, contentRevision: next.contentRevision },
    });
    ack(sendAt(transport, 1), next, { bookmarkedAt: '2026-10-08T08:00:01.000Z' });
    await draining;
    await settleAll();

    expect(queue.records.size).toBe(0);
    expect(store.offline.waiting()).toEqual([]);
    for (const call of transport.sends) expect(call.signal.aborted).toBe(false);
  });

  it('send the request id of a rating with the rating', async () => {
    const { store, queue, transport } = rig();
    const action: ReaderAction = { type: 'rate', rating: 1, analysisRequestId: REQUEST_ID };
    const record = recordOf({ id: 'r1', action });
    queue.records.set(record.id, record);
    store.offline.adopt([record]);

    const draining = store.offline.drain();
    await settleAll();

    expect(sendAt(transport, 0).action).toEqual(action);
    ack(sendAt(transport, 0), makeItem(), { rating: 1 });
    await draining;
  });

  it('are shown once, whatever number of times they are adopted', () => {
    const { store } = rig();
    const record = recordOf({ id: 'r1' });

    store.offline.adopt([record]);
    store.offline.adopt([record]);

    expect(store.offline.waiting()).toHaveLength(1);
  });

  it('leave out the records of another account', () => {
    const { store } = rig();

    store.offline.adopt([recordOf({ id: 'r1', accountId: 'account-b' })]);

    expect(store.offline.waiting()).toEqual([]);
  });

  it('use the fence of the state they were made on when their record has none and nothing precedes it', async () => {
    const { store, queue, transport } = rig();
    const orphan = recordOf({
      id: 'r1',
      fence: null,
      after: 'gone',
      before: readerOf(makeItem({ stateVersion: '7' })),
    });
    queue.records.set(orphan.id, orphan);
    store.offline.adopt([orphan]);
    store.observe([makeItem({ stateVersion: '9' })]);

    const draining = store.offline.drain();
    await settleAll();

    expect(sendAt(transport, 0).fence).toEqual({ stateVersion: '7', contentRevision: '2' });
    ack(sendAt(transport, 0), makeItem({ stateVersion: '7' }), { rating: 1 });
    await draining;
  });

  it('are settled as cancelled when their record is gone, but not when it was written after the list was read', async () => {
    const { store, queue } = rig({ online: false });
    const item = makeItem();
    const early = store.dispatch(item, { type: 'read' });
    await settleAll();
    const mark = store.offline.mark();
    const late = store.dispatch(makeItem({ id: '202' }), { type: 'read' });
    await settleAll();
    expect(store.offline.waiting()).toHaveLength(2);

    store.offline.adopt([], mark);

    expect(early.status).toBe('cancelled');
    expect(late.status).toBe('waiting');
    expect(store.view(item)).toEqual(item);
    expect(queue.records.has(late.id)).toBe(true);
  });

  it('are settled by what another tab announces, with no request from this one', async () => {
    const { store, queue, transport, settled } = rig();
    const item = makeItem();
    queue.records.set('r1', recordOf({ id: 'r1' }));
    store.offline.adopt([recordOf({ id: 'r1' })]);
    const next = acked(item, { rating: 1 });

    queue.emit({ id: 'r1', outcome: 'done', item: next, mutationId: mutation(7) });
    await settleAll();

    expect(await store.get('r1')?.result).toMatchObject({ status: 'done', item: next });
    expect(store.get('r1')?.mutationId).toBe(mutation(7));
    expect(store.view(item)).toEqual({ ...item, ...readerOf(next) });
    expect(transport.calls).toEqual([]);
    expect(settled).toHaveLength(1);
    expect(store.offline.waiting()).toEqual([]);
  });

  it.each([
    [{ id: 'r1', outcome: 'stale', item: null }, 'stale'],
    [{ id: 'r1', outcome: 'failed', status: 404, code: 'NOT_FOUND' }, 'failed'],
    [{ id: 'r1', outcome: 'cancelled' }, 'cancelled'],
  ] as const)('are settled as %j by the other tab', async (note, status) => {
    const { store, queue } = rig();
    store.offline.adopt([recordOf({ id: 'r1' })]);

    queue.emit(note);
    await settleAll();

    expect(store.get('r1')?.status).toBe(status);
  });

  it('are not sent when their record was removed by another tab while this one waited for its turn', async () => {
    const { store, queue, transport } = rig();
    const record = recordOf({ id: 'r1' });
    queue.records.set('r1', record);
    store.offline.adopt([record]);
    queue.records.delete('r1');

    await store.offline.drain();
    await settleAll();

    expect(transport.calls).toEqual([]);
    expect(store.get('r1')?.status).toBe('cancelled');
  });

  it('are not sent when another tab announces them while this one is about to send', async () => {
    const { store, queue, transport } = rig();
    const record = recordOf({ id: 'r1' });
    queue.records.set('r1', record);
    store.offline.adopt([record]);
    const draining = store.offline.drain();
    queue.emit({ id: 'r1', outcome: 'cancelled' });
    queue.records.delete('r1');
    await draining;

    expect(transport.calls).toEqual([]);
  });
});

describe('changes that are 24 hours old', () => {
  it('are dropped, rolled back and not sent, at the boundary and not a millisecond before it', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const cutoff = T0;
    const expired = recordOf({ id: 'old', createdAt: cutoff, articleId: '101' });
    const fresh = recordOf({ id: 'new', createdAt: cutoff + 1, articleId: '202', fence: FENCE });
    for (const record of [expired, fresh]) queue.records.set(record.id, record);
    store.offline.adopt([expired, fresh]);

    expect(store.offline.expire(cutoff)).toBe(1);
    await settleAll();

    expect(store.get('old')?.status).toBe('cancelled');
    expect(store.get('new')?.status).toBe('waiting');
    expect(queue.records.has('old')).toBe(false);
    expect(queue.records.has('new')).toBe(true);
    expect(store.view(item)).toEqual(item);
    expect(transport.calls).toEqual([]);
    expect(store.offline.expire(cutoff)).toBe(0);
  });
});

describe('a replayed change that ended in a refusal', () => {
  function twoArticles() {
    const kit = rig();
    const a1 = recordOf({ id: 'a1', articleId: '101', createdAt: T0 - 5000 });
    const a2 = recordOf({
      id: 'a2',
      articleId: '101',
      action: { type: 'bookmark' },
      fence: null,
      after: 'a1',
      createdAt: T0 - 4000,
    });
    const b1 = recordOf({
      id: 'b1',
      articleId: '202',
      createdAt: T0 - 3000,
      before: readerOf(makeItem({ id: '202' })),
    });
    for (const record of [a1, a2, b1]) kit.queue.records.set(record.id, record);
    kit.store.offline.adopt([a1, a2, b1]);
    return kit;
  }

  it('on a stale state drops it and what follows on that article, adopts the server state and sends the other article', async () => {
    const { store, queue, transport, settled } = twoArticles();
    const server = makeItem({ rating: -1, stateVersion: '9' });
    const draining = store.offline.drain();
    await settleAll();
    sendAt(transport, 0).reject(apiError(409, 'STALE_STATE', { item: server }));
    await settleAll();
    ack(sendAt(transport, 1), makeItem({ id: '202' }), { rating: 1 });
    await draining;
    await settleAll();

    expect(transport.sends.map((call) => call.articleId)).toEqual(['101', '202']);
    expect(store.get('a1')?.status).toBe('stale');
    expect(store.get('a2')?.status).toBe('cancelled');
    expect(store.get('b1')?.status).toBe('done');
    expect(settled.map(({ handle, result }) => [handle.id, result.status])).toEqual([
      ['a2', 'cancelled'],
      ['a1', 'stale'],
      ['b1', 'done'],
    ]);
    expect(store.view(makeItem())).toMatchObject({
      rating: -1,
      stateVersion: '9',
      bookmarkedAt: null,
    });
    expect(queue.records.size).toBe(0);
  });

  it('on a refusal drops it and what follows on that article', async () => {
    const { store, queue, transport } = twoArticles();
    const draining = store.offline.drain();
    await settleAll();
    sendAt(transport, 0).reject(apiError(404, 'NOT_FOUND'));
    await settleAll();
    ack(sendAt(transport, 1), makeItem({ id: '202' }), { rating: 1 });
    await draining;
    await settleAll();

    expect(transport.sends.map((call) => call.articleId)).toEqual(['101', '202']);
    expect(store.get('a1')?.status).toBe('failed');
    expect(store.get('a2')?.status).toBe('cancelled');
    expect(queue.records.size).toBe(0);
    expect(store.view(makeItem())).toEqual(makeItem());
  });

  it('keeps the later changes of an article when the earlier one failed at its first try, online', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = store.dispatch(item, { type: 'rate', rating: 1 });
    const second = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    sendAt(transport, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await settleAll();

    expect(first.status).toBe('failed');
    expect(sendAt(transport, 1).key).toBe(second.id);
    expect(queue.records.has(second.id)).toBe(true);
  });
});

describe('what the store lets go of', () => {
  it('keeps a failed change for its retry, and lets it go with the undo window', async () => {
    const { store, transport, clock } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    sendAt(transport, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await handle.result;

    store.observe([]);
    expect(store.get(handle.id)).toBeDefined();
    clock.now += 10 * 60_000 + 1;
    store.observe([]);
    expect(store.get(handle.id)).toBeUndefined();
    expect(store.retained()).toEqual({ actions: 0, recents: 0 });
  });
});

/** The page loads again: a new store over the same queue store and server, showing what was kept. */
function reload(kit: Rig): ReaderActions {
  kit.store.reset();
  let counter = 100;
  const store = createReaderActions({
    transport: kit.transport,
    queue: kit.queue,
    preferences: () => ({ markReadOnRate: true }),
    now: () => kit.clock.now,
    newId: () => `id-${(counter += 1)}`,
    maxRetries: 0,
    backoffMs: () => 0,
  });
  store.offline.adopt([...kit.queue.records.values()], store.offline.mark());
  return store;
}

/** Asks for the undo without waiting for it: what it answers is read from `result` when it has. */
function watching(store: ReaderActions, actionId: string): { result: UndoResult | undefined } {
  const watched: { result: UndoResult | undefined } = { result: undefined };
  void store.undo(actionId).then((result) => {
    watched.result = result;
  });
  return watched;
}

describe('undoing a change that waits on the device and was never sent', () => {
  it.each([
    ['without a connection', false],
    ['with the connection back before the replay', true],
  ])('cancels it at once, %s', async (_name, online) => {
    const { store, queue, transport, settled } = rig({ online: false });
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    expect(handle.status).toBe('waiting');
    queue.onlineNow = online;

    const undone = watching(store, handle.id);
    await settleAll();

    expect(handle.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(await handle.result).toEqual({ status: 'cancelled' });
    expect(transport.calls).toEqual([]);
    expect(queue.records.size).toBe(0);
    expect(queue.announced).toEqual([{ id: handle.id, outcome: 'cancelled' }]);
    expect(store.view(item)).toEqual(item);
    expect(store.offline.waiting()).toEqual([]);
    expect(settled.map(({ result }) => result.status)).toEqual(['cancelled']);
  });

  it('cancels a change of an earlier page at once while online, before the replay has sent it', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const record = recordOf({ id: 'r1' });
    queue.records.set('r1', record);
    store.offline.adopt([record]);
    expect(store.view(item).rating).toBe(1);

    const undone = watching(store, 'r1');
    await settleAll();

    expect(store.get('r1')?.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(transport.calls).toEqual([]);
    expect(queue.records.size).toBe(0);
    expect(queue.announced).toEqual([{ id: 'r1', outcome: 'cancelled' }]);
    expect(store.view(item)).toEqual(item);
  });

  it('cancels it at once after the page loaded again in between', async () => {
    const kit = rig({ online: false });
    const item = makeItem();
    const made = kit.store.dispatch(item, { type: 'bookmark' });
    await settleAll();

    const store = reload(kit);
    expect(store.offline.waiting().map((waiting) => waiting.id)).toEqual([made.id]);
    const undone = watching(store, made.id);
    await settleAll();

    expect(store.get(made.id)?.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(kit.transport.calls).toEqual([]);
    expect(kit.queue.records.size).toBe(0);
    expect(store.view(item)).toEqual(item);
  });

  it('cancels a change that is behind one that was sent, and leaves the sent one alone', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const sent = recordOf({ id: 'r1', sent: true, createdAt: T0 - 2000 });
    const unsent = recordOf({
      id: 'r2',
      action: { type: 'bookmark' },
      fence: null,
      after: 'r1',
      createdAt: T0 - 1000,
    });
    for (const record of [sent, unsent]) queue.records.set(record.id, record);
    store.offline.adopt([sent, unsent]);

    const bookmark = watching(store, 'r2');
    const rating = watching(store, 'r1');
    await settleAll();

    expect(store.get('r2')?.status).toBe('cancelled');
    expect(bookmark.result).toEqual({ status: 'cancelled' });
    expect(store.get('r1')?.status).toBe('waiting');
    expect(rating.result).toBeUndefined();
    expect([...queue.records.keys()]).toEqual(['r1']);
    expect(transport.calls).toEqual([]);
    expect(store.view(item)).toMatchObject({ rating: 1, bookmarkedAt: null });
  });
});

describe('undoing a change whose send may have reached the server', () => {
  async function lost(kit: Rig, item: ArticleListItem) {
    const handle = kit.store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    sendAt(kit.transport, 0).reject(networkError());
    await settleAll();
    expect(handle.status).toBe('waiting');
    return handle;
  }

  it('waits for the replay to send it again under its key, and only then undoes it by its receipt', async () => {
    const kit = rig();
    const { store, queue, transport } = kit;
    const item = makeItem();
    const handle = await lost(kit, item);
    expect(queue.records.get(handle.id)).toMatchObject({ sent: true });

    const undone = watching(store, handle.id);
    await settleAll();

    expect(undone.result).toBeUndefined();
    expect(handle.status).toBe('waiting');
    expect(queue.records.has(handle.id)).toBe(true);
    expect(queue.announced).toEqual([]);
    expect(transport.sends).toHaveLength(1);
    expect(store.view(item).rating).toBe(1);

    const draining = store.offline.drain();
    await settleAll();
    expect(sendAt(transport, 1)).toMatchObject({ key: handle.id, fence: FENCE });
    ack(sendAt(transport, 1), item, { rating: 1 });
    await draining;
    await settleAll();

    expect(transport.undos).toHaveLength(1);
    expect(transport.undos[0]?.body).toEqual({ mutationId: mutation(2) });
    transport.undos[0]?.resolve({ count: 1, mutationId: mutation(9), items: [item] });
    await settleAll();
    expect(undone.result).toMatchObject({ status: 'undone' });
  });

  it('does the same after the page loaded again in between, which its record remembers', async () => {
    const kit = rig();
    const item = makeItem();
    const handle = await lost(kit, item);

    const store = reload(kit);
    const undone = watching(store, handle.id);
    await settleAll();

    expect(undone.result).toBeUndefined();
    expect(store.get(handle.id)?.status).toBe('waiting');
    expect(kit.queue.records.has(handle.id)).toBe(true);
    expect(kit.queue.announced).toEqual([]);
    expect(kit.transport.sends).toHaveLength(1);

    const draining = store.offline.drain();
    await settleAll();
    expect(sendAt(kit.transport, 1).key).toBe(handle.id);
    ack(sendAt(kit.transport, 1), item, { rating: 1 });
    await draining;
    await settleAll();
    expect(kit.transport.undos).toHaveLength(1);
  });

  it('waits for the replay too when the page loaded again while the first request was out', async () => {
    const kit = rig();
    const item = makeItem();
    const handle = kit.store.dispatch(item, { type: 'rate', rating: 1 });
    await settleAll();
    expect(kit.transport.sends).toHaveLength(1);

    const store = reload(kit);
    const undone = watching(store, handle.id);
    await settleAll();

    expect(undone.result).toBeUndefined();
    expect(store.get(handle.id)?.status).toBe('waiting');
    expect(kit.queue.records.has(handle.id)).toBe(true);
    expect(kit.queue.announced).toEqual([]);

    const draining = store.offline.drain();
    await settleAll();
    expect(sendAt(kit.transport, 1).key).toBe(handle.id);
    ack(sendAt(kit.transport, 1), item, { rating: 1 });
    await draining;
    await settleAll();
    expect(kit.transport.undos).toHaveLength(1);
  });

  it.each([
    ['a 503', apiError(503, 'UNAVAILABLE')],
    ['a 429', apiError(429, 'RATE_LIMITED')],
    ['a 401', apiError(401, 'UNAUTHENTICATED')],
  ])(
    'marks the record before its request leaves, and keeps the mark after %s',
    async (_name, error) => {
      const { store, queue, transport } = rig();
      const handle = store.dispatch(makeItem(), { type: 'rate', rating: 1 });
      await settleAll();
      expect(transport.sends).toHaveLength(1);
      expect(queue.records.get(handle.id)).toMatchObject({ sent: true });
      sendAt(transport, 0).reject(error);
      await settleAll();

      expect(handle.status).toBe('waiting');
      expect(queue.records.get(handle.id)).toMatchObject({ sent: true });
    },
  );

  it('does not mark a record whose change only waited for a connection', async () => {
    const { store, queue } = rig({ online: false });
    const handle = store.dispatch(makeItem(), { type: 'rate', rating: 1 });
    await settleAll();

    expect(handle.status).toBe('waiting');
    expect(queue.records.get(handle.id)).not.toHaveProperty('sent');
    expect(queue.log).toEqual([`save:${handle.id}`]);
  });
});

describe('cancelling a change that another change of the article waits behind', () => {
  it('leaves the later change kept on the state the cancelled one acted on, and sends only it at the next replay', async () => {
    const { store, queue, transport } = rig({ online: false });
    const item = makeItem();
    const like = store.dispatch(item, { type: 'rate', rating: 1 });
    const bookmark = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    expect(queue.records.get(bookmark.id)).toMatchObject({ after: like.id, fence: null });

    const undone = watching(store, like.id);
    await settleAll();

    expect(like.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(queue.records.has(like.id)).toBe(false);
    expect(queue.records.get(bookmark.id)).toMatchObject({ after: null, fence: FENCE });
    expect(store.view(item)).toMatchObject({ rating: null, bookmarkedAt: expect.any(String) });
    expect(store.offline.waiting().map((waiting) => waiting.id)).toEqual([bookmark.id]);
    expect(transport.calls).toEqual([]);

    queue.onlineNow = true;
    const draining = store.offline.drain();
    await settleAll();
    expect(transport.sends).toHaveLength(1);
    expect(sendAt(transport, 0)).toMatchObject({
      key: bookmark.id,
      fence: FENCE,
      action: { type: 'bookmark' },
    });
    ack(sendAt(transport, 0), item, { bookmarkedAt: '2026-10-08T08:00:00.000Z' });
    await draining;
    await settleAll();

    expect(transport.sends).toHaveLength(1);
    expect(queue.records.size).toBe(0);
    expect(store.offline.waiting()).toEqual([]);
  });

  it('hands over the fence the cancelled change had, not the state learned since', async () => {
    const { store, queue, transport } = rig({ online: false });
    const item = makeItem();
    const like = store.dispatch(item, { type: 'rate', rating: 1 });
    const bookmark = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    store.observe([makeItem({ stateVersion: '6' })]);

    const undone = watching(store, like.id);
    await settleAll();

    expect(like.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(queue.records.get(bookmark.id)).toMatchObject({ after: null, fence: FENCE });
    queue.onlineNow = true;
    const draining = store.offline.drain();
    await settleAll();
    expect(sendAt(transport, 0)).toMatchObject({ key: bookmark.id, fence: FENCE });
    ack(sendAt(transport, 0), item, { bookmarkedAt: '2026-10-08T08:00:00.000Z' });
    await draining;
  });

  it('does the same for the changes of an earlier page', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = recordOf({ id: 'r1', createdAt: T0 - 2000 });
    const second = recordOf({
      id: 'r2',
      action: { type: 'bookmark' },
      fence: null,
      after: 'r1',
      createdAt: T0 - 1000,
    });
    for (const record of [first, second]) queue.records.set(record.id, record);
    store.offline.adopt([first, second]);

    const undone = watching(store, 'r1');
    await settleAll();

    expect(store.get('r1')?.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(queue.records.get('r2')).toMatchObject({ after: null, fence: FENCE });
    expect(transport.calls).toEqual([]);

    const draining = store.offline.drain();
    await settleAll();
    expect(transport.sends).toHaveLength(1);
    expect(sendAt(transport, 0)).toMatchObject({ key: 'r2', fence: FENCE });
    ack(sendAt(transport, 0), item, { bookmarkedAt: '2026-10-08T08:00:00.000Z' });
    await draining;
    expect(queue.records.size).toBe(0);
  });

  it('has the change behind it follow what the cancelled one followed', async () => {
    const { store, queue, transport } = rig();
    const item = makeItem();
    const first = recordOf({ id: 'r1', action: { type: 'read' }, createdAt: T0 - 3000 });
    const middle = recordOf({ id: 'r2', fence: null, after: 'r1', createdAt: T0 - 2000 });
    const last = recordOf({
      id: 'r3',
      action: { type: 'bookmark' },
      fence: null,
      after: 'r2',
      createdAt: T0 - 1000,
    });
    for (const record of [first, middle, last]) queue.records.set(record.id, record);
    store.offline.adopt([first, middle, last]);

    const undone = watching(store, 'r2');
    await settleAll();

    expect(store.get('r2')?.status).toBe('cancelled');
    expect(undone.result).toEqual({ status: 'cancelled' });
    expect(queue.records.get('r3')).toMatchObject({ after: 'r1', fence: null });
    expect(queue.records.get('r1')).toMatchObject({ after: null, fence: FENCE });

    const draining = store.offline.drain();
    await settleAll();
    const next = ack(sendAt(transport, 0), item, { readAt: '2026-10-08T08:00:00.000Z' });
    await settleAll();
    expect(sendAt(transport, 1)).toMatchObject({
      key: 'r3',
      fence: { stateVersion: next.stateVersion, contentRevision: next.contentRevision },
    });
    ack(sendAt(transport, 1), next, { bookmarkedAt: '2026-10-08T08:00:01.000Z' });
    await draining;
    await settleAll();

    expect(transport.sends.map((call) => call.key)).toEqual(['r1', 'r3']);
    expect(queue.records.size).toBe(0);
  });

  it('has the changes queued behind a cancelled one on this page follow what it followed', async () => {
    const { store, queue } = rig({ online: false });
    const item = makeItem();
    const first = store.dispatch(item, { type: 'read' });
    const middle = store.dispatch(item, { type: 'rate', rating: 1 });
    const last = store.dispatch(item, { type: 'bookmark' });
    await settleAll();
    expect(queue.records.get(last.id)).toMatchObject({ after: middle.id });
    expect([first.status, middle.status, last.status]).toEqual(['waiting', 'queued', 'queued']);

    expect(store.cancel(middle.id)).toBe(true);
    await settleAll();

    expect(queue.records.get(last.id)).toMatchObject({ after: first.id, fence: null });
    expect(queue.records.get(first.id)).toMatchObject({ after: null, fence: FENCE });
  });
});
