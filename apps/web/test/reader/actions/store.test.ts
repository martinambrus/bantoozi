import type { ArticleListItem, MarkReadFilter } from '@bantoozi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiError } from '../../../src/api/errors.js';
import { createReaderActions } from '../../../src/features/reader/actions/store.js';
import {
  READER_FIELDS,
  UNDOABLE_ACTIONS,
  type ActionHandle,
  type ActionResponse,
  type ActionResult,
  type BulkResult,
  type ReaderAction,
  type ReaderActions,
  type ReaderActionsOptions,
  type ReaderState,
} from '../../../src/features/reader/actions/types.js';
import {
  FakeTransport,
  abortedError,
  acked,
  apiError,
  invalidResponseError,
  makeItem,
  networkError,
  type RecordedCall,
  type SendCall,
} from './fake-transport.js';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const SYSTEM_TIME = Date.parse('2031-01-01T00:00:00.000Z');
const NOW = new Date(T0).toISOString();
const SERVER_TIME = '2026-06-01T12:00:00.250Z';
const EARLIER = '2026-05-30T10:00:00.000Z';
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
const REQUEST_ID = '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SYSTEM_TIME);
});

interface Rig {
  readonly store: ReaderActions;
  readonly transport: FakeTransport;
  readonly settled: { handle: ActionHandle; result: ActionResult }[];
  readonly prefs: { markReadOnRate: boolean };
  readonly clock: { now: number };
  /** Moves the injected clock and the fake timers forward together. */
  advance(ms: number): Promise<void>;
}

function rig(overrides: Partial<ReaderActionsOptions> = {}, tuned = true): Rig {
  const transport = new FakeTransport();
  const clock = { now: T0 };
  const prefs = { markReadOnRate: true };
  const settled: Rig['settled'] = [];
  let counter = 0;
  const store = createReaderActions({
    transport,
    preferences: () => ({ markReadOnRate: prefs.markReadOnRate }),
    now: () => clock.now,
    newId: () => `id-${++counter}`,
    ...(tuned ? { maxRetries: 2, backoffMs: () => 100 } : {}),
    onSettled: (handle, result) => {
      settled.push({ handle, result });
    },
    ...overrides,
  });
  return {
    store,
    transport,
    settled,
    prefs,
    clock,
    async advance(ms) {
      clock.now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

/** Runs every pending microtask and every timer that is already due. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const PENDING = Symbol('pending');

/** The settled value of a promise; an assertion failure (not a hang) when it has not settled. */
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
const mutationOf = (call: RecordedCall): string => mid(call.index + 1);

function readerOf(item: ArticleListItem): ReaderState {
  return Object.fromEntries(READER_FIELDS.map((field) => [field, item[field]])) as ReaderState;
}

/** The view of `row` once the server state `server` has been adopted. */
function adopted(row: ArticleListItem, server: ArticleListItem): ArticleListItem {
  return { ...row, ...readerOf(server) };
}

/** Answers a `send` call with the next state of `item` and returns that state. */
function ack(
  call: SendCall,
  item: ArticleListItem,
  patch: Partial<ArticleListItem> = {},
  extra: Partial<Omit<ActionResponse, 'item' | 'mutationId'>> = {},
): ArticleListItem {
  const next = acked(item, patch);
  call.resolve({ item: next, mutationId: mutationOf(call), ...extra });
  return next;
}

function answerBulk(
  call: RecordedCall<{ count: number; mutationId: string; items: ArticleListItem[] }>,
  items: ArticleListItem[],
): void {
  call.resolve({ count: items.length, mutationId: mutationOf(call), items });
}

function asDone(result: ActionResult): Extract<ActionResult, { status: 'done' }> {
  expect(result.status).toBe('done');
  return result as Extract<ActionResult, { status: 'done' }>;
}

function asFailed(result: ActionResult): Extract<ActionResult, { status: 'failed' }> {
  expect(result.status).toBe('failed');
  return result as Extract<ActionResult, { status: 'failed' }>;
}

function asStale(result: ActionResult): Extract<ActionResult, { status: 'stale' }> {
  expect(result.status).toBe('stale');
  return result as Extract<ActionResult, { status: 'stale' }>;
}

const rate = (rating: 1 | -1 | null): ReaderAction => ({ type: 'rate', rating });

describe('O1 optimistic rating before any response', () => {
  it('rating +1 sets the rating and marks the item read when markReadOnRate is on', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    expect(store.view(item)).toMatchObject({
      rating: 1,
      readAt: NOW,
      reason: null,
      archivedAt: null,
    });
  });

  it('rating +1 leaves readAt null when markReadOnRate is off', () => {
    const { store, prefs } = rig();
    prefs.markReadOnRate = false;
    const item = makeItem();
    store.dispatch(item, rate(1));
    expect(store.view(item)).toMatchObject({ rating: 1, readAt: null });
  });

  it('rating -1 marks the item read when markReadOnRate is on and not when it is off', () => {
    const { store, prefs } = rig();
    const on = makeItem({ id: '101' });
    const off = makeItem({ id: '102' });
    store.dispatch(on, rate(-1));
    expect(store.view(on)).toMatchObject({ rating: -1, readAt: NOW });
    prefs.markReadOnRate = false;
    store.dispatch(off, rate(-1));
    expect(store.view(off)).toMatchObject({ rating: -1, readAt: null });
  });

  it('hide sets archivedAt', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: 1, hide: true });
    expect(store.view(item)).toMatchObject({ rating: 1, archivedAt: NOW });
  });

  it('rating -1 with a reason sets the reason', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: -1, reason: 'clickbait' });
    expect(store.view(item)).toMatchObject({ rating: -1, reason: 'clickbait' });
  });

  it('rating -1 without a reason leaves the reason null', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, rate(-1));
    expect(store.view(item)).toMatchObject({ rating: -1, reason: null });
  });

  it('rating +1 on a disliked item clears the old reason', () => {
    const { store } = rig();
    const item = makeItem({ rating: -1, reason: 'seen', readAt: EARLIER });
    store.dispatch(item, rate(1));
    expect(store.view(item)).toMatchObject({ rating: 1, reason: null, readAt: EARLIER });
  });

  it('rating null clears rating and reason and leaves readAt and archivedAt alone', () => {
    const { store } = rig();
    const item = makeItem({ rating: -1, reason: 'seen', readAt: EARLIER, archivedAt: EARLIER });
    store.dispatch(item, rate(null));
    expect(store.view(item)).toMatchObject({
      rating: null,
      reason: null,
      readAt: EARLIER,
      archivedAt: EARLIER,
    });
  });

  it('rating null on an unread item does not mark it read', () => {
    const { store } = rig();
    const item = makeItem({ rating: 1 });
    store.dispatch(item, rate(null));
    expect(store.view(item)).toMatchObject({ rating: null, readAt: null });
  });
});

describe('O2 optimistic patch per action', () => {
  it('read sets readAt', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'read' });
    expect(store.view(item).readAt).toBe(NOW);
  });

  it('read with the expand trigger sets readAt', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'read', trigger: 'expand' });
    expect(store.view(item).readAt).toBe(NOW);
  });

  it('unread clears readAt and archivedAt', () => {
    const { store } = rig();
    const item = makeItem({ readAt: EARLIER, archivedAt: EARLIER });
    store.dispatch(item, { type: 'unread' });
    expect(store.view(item)).toMatchObject({ readAt: null, archivedAt: null });
  });

  it('unhide clears archivedAt and keeps readAt and the rating', () => {
    const { store } = rig();
    const item = makeItem({ readAt: EARLIER, archivedAt: EARLIER, rating: 1 });
    store.dispatch(item, { type: 'unhide' });
    expect(store.view(item)).toMatchObject({ archivedAt: null, readAt: EARLIER, rating: 1 });
  });

  it('bookmark sets bookmarkedAt', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'bookmark' });
    expect(store.view(item).bookmarkedAt).toBe(NOW);
  });

  it('unbookmark clears bookmarkedAt', () => {
    const { store } = rig();
    const item = makeItem({ bookmarkedAt: EARLIER });
    store.dispatch(item, { type: 'unbookmark' });
    expect(store.view(item).bookmarkedAt).toBeNull();
  });

  it('addLabel appends the label', () => {
    const { store } = rig();
    const item = makeItem({ labelIds: ['5'] });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    expect(store.view(item).labelIds).toEqual(['5', '9']);
  });

  it('addLabel adds a label only once, also when it is added twice', () => {
    const { store } = rig();
    const item = makeItem({ labelIds: ['5'] });
    store.dispatch(item, { type: 'addLabel', labelId: '5' });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    expect(store.view(item).labelIds).toEqual(['5', '9']);
  });

  it('removeLabel removes the label and keeps the others', () => {
    const { store } = rig();
    const item = makeItem({ labelIds: ['5', '9'] });
    store.dispatch(item, { type: 'removeLabel', labelId: '5' });
    expect(store.view(item).labelIds).toEqual(['9']);
  });

  it('open sets readAt when it is null', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'open' });
    expect(store.view(item).readAt).toBe(NOW);
  });

  it('open keeps an existing readAt', () => {
    const { store } = rig();
    const item = makeItem({ readAt: EARLIER });
    store.dispatch(item, { type: 'open' });
    expect(store.view(item).readAt).toBe(EARLIER);
  });

  it('promptAnswer liked sets rating 1', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'promptAnswer', liked: true });
    expect(store.view(item).rating).toBe(1);
  });

  it('promptAnswer not liked sets rating -1', () => {
    const { store } = rig();
    const item = makeItem({ rating: 1 });
    store.dispatch(item, { type: 'promptAnswer', liked: false });
    expect(store.view(item).rating).toBe(-1);
  });

  it('dwell changes nothing', () => {
    const { store } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'dwell', ms: 30_000 });
    expect(store.view(item)).toEqual(item);
  });

  it('retryCapture shows the capture as pending', () => {
    const { store } = rig();
    const item = makeItem({
      bookmarkedAt: EARLIER,
      bookmarkCapture: {
        status: 'failed',
        generation: '2',
        snapshotId: null,
        capturedAt: null,
        errorCode: 'FETCH_FAILED',
      },
    });
    store.dispatch(item, { type: 'retryCapture', captureGeneration: '2' });
    expect(store.view(item).bookmarkCapture).toMatchObject({ status: 'pending' });
    expect(store.view(item).bookmarkedAt).toBe(EARLIER);
  });

  it('applies the optimistic changes of several actions on one item in order', () => {
    const { store } = rig();
    const item = makeItem({ labelIds: ['5'] });
    store.dispatch(item, { type: 'bookmark' });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    store.dispatch(item, { type: 'removeLabel', labelId: '5' });
    expect(store.view(item)).toMatchObject({ bookmarkedAt: NOW, labelIds: ['9'] });
  });

  it('keeps the changes of one article away from another', () => {
    const { store } = rig();
    const first = makeItem({ id: '101' });
    const second = makeItem({ id: '102' });
    store.dispatch(first, { type: 'bookmark' });
    expect(store.view(second)).toBe(second);
  });
});

describe('O3 acknowledgement', () => {
  const row = (): ArticleListItem =>
    makeItem({
      lane: 'for_you',
      tier: 4,
      pLike: 0.82,
      topReason: { kind: 'card', cardId: '31', title: 'EV battery tech', p: 0.82 },
      analysis: { mode: 'active', status: 'complete', requestId: REQUEST_ID },
      cluster: { id: '9', size: 3, otherFeeds: ['Other Daily'] },
      feed: { id: '7', title: 'Row feed', iconUrl: null },
    });

  /** What the API answers: a global projection whose view fields differ from the row's. */
  const projection = (item: ArticleListItem): ArticleListItem =>
    acked(item, {
      lane: 'everything',
      tier: null,
      pLike: null,
      topReason: null,
      analysis: { mode: 'off', status: 'not_requested', requestId: null },
      cluster: null,
      feed: null,
      rating: 1,
      readAt: SERVER_TIME,
      labelIds: ['5'],
      bookmarkedAt: EARLIER,
      archivedAt: EARLIER,
    });

  it('takes the reader fields of the response and keeps the rows own view fields', async () => {
    const { store, transport } = rig();
    const item = row();
    store.dispatch(item, rate(1));
    await flush();
    const response = projection(item);
    nth(transport.sends, 0).resolve({ item: response, mutationId: mid(1) });
    await flush();
    const view = store.view(item);
    expect(view).toEqual(adopted(item, response));
    expect(view).toMatchObject({
      stateVersion: '5',
      readAt: SERVER_TIME,
      lane: 'for_you',
      tier: 4,
      pLike: 0.82,
      cluster: { id: '9', size: 3, otherFeeds: ['Other Daily'] },
      feed: { id: '7', title: 'Row feed', iconUrl: null },
    });
  });

  it('keeps the fields of a richer item type that are not reader fields', async () => {
    const { store, transport } = rig();
    const detail = { ...row(), excerptHtml: '<p>Hello</p>', bodyLead: 'Lead' };
    store.dispatch(detail, { type: 'bookmark' });
    expect(store.view(detail)).toMatchObject({ excerptHtml: '<p>Hello</p>', bodyLead: 'Lead' });
    await flush();
    ack(nth(transport.sends, 0), detail, { bookmarkedAt: SERVER_TIME });
    await flush();
    expect(store.view(detail)).toMatchObject({
      excerptHtml: '<p>Hello</p>',
      bodyLead: 'Lead',
      bookmarkedAt: SERVER_TIME,
      stateVersion: '5',
    });
  });

  it('resolves the result as done with the receipt, suggestion, prompt and no dropped request', async () => {
    const { store, transport } = rig();
    const item = row();
    const handle = store.dispatch(item, rate(1));
    await flush();
    const response = projection(item);
    nth(transport.sends, 0).resolve({
      item: response,
      mutationId: mid(7),
      exampleSuggestion: { cardId: '31', side: 'yes' },
    });
    const result = asDone(await outcome(handle.result));
    expect(result).toMatchObject({
      status: 'done',
      mutationId: mid(7),
      exampleSuggestion: { cardId: '31', side: 'yes' },
      prompt: false,
      droppedAnalysisRequestId: null,
    });
    expect(result.item).toMatchObject({ id: item.id, stateVersion: '5' });
  });

  it('reports a null suggestion and prompt false when the response carries neither', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'read' });
    await flush();
    ack(nth(transport.sends, 0), item, { readAt: SERVER_TIME });
    expect(await outcome(handle.result)).toMatchObject({
      status: 'done',
      exampleSuggestion: null,
      prompt: false,
      droppedAnalysisRequestId: null,
    });
  });

  it('passes the prompt of a dwell response on', async () => {
    const { store, transport } = rig();
    const item = makeItem({ readAt: EARLIER });
    const handle = store.dispatch(item, { type: 'dwell', ms: 45_000 });
    await flush();
    ack(nth(transport.sends, 0), item, {}, { prompt: true });
    expect(await outcome(handle.result)).toMatchObject({
      status: 'done',
      prompt: true,
      exampleSuggestion: null,
    });
  });

  it('records the receipt on the handle and marks it done', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(store.get(handle.id)).toMatchObject({ status: 'sending', mutationId: null });
    const call = nth(transport.sends, 0);
    ack(call, item, { bookmarkedAt: SERVER_TIME });
    await flush();
    expect(store.get(handle.id)).toMatchObject({ status: 'done', mutationId: mutationOf(call) });
  });

  it.each<[string, ReaderAction]>([
    ['read with the expand trigger', { type: 'read', trigger: 'expand' }],
    ['read', { type: 'read' }],
    ['unread', { type: 'unread' }],
    ['unhide', { type: 'unhide' }],
    [
      'rate with every option',
      {
        type: 'rate',
        rating: -1,
        reason: 'clickbait',
        hide: true,
        analysisRequestId: REQUEST_ID,
        selection: 'calibration',
      },
    ],
    ['promptAnswer', { type: 'promptAnswer', liked: true, analysisRequestId: REQUEST_ID }],
    ['bookmark', { type: 'bookmark', mediaPolicyFeedId: '7' }],
    ['unbookmark', { type: 'unbookmark' }],
    ['addLabel', { type: 'addLabel', labelId: '9' }],
    ['removeLabel', { type: 'removeLabel', labelId: '5' }],
    ['retryCapture', { type: 'retryCapture', captureGeneration: '2' }],
    ['open', { type: 'open' }],
    ['dwell', { type: 'dwell', ms: 12_000 }],
  ])(
    'sends a %s action unchanged, keyed by its id, with the fence of the item',
    async (_n, action) => {
      const { store, transport } = rig();
      const item = makeItem({ labelIds: ['5'] });
      const handle = store.dispatch(item, action);
      await flush();
      const call = nth(transport.sends, 0);
      expect(transport.sends).toHaveLength(1);
      expect(call.articleId).toBe(item.id);
      expect(call.action).toEqual(action);
      expect(call.key).toBe(handle.id);
      expect(call.fence).toEqual({ stateVersion: '4', contentRevision: '2' });
      expect(call.signal.aborted).toBe(false);
    },
  );
});

describe('O4 per-article serialization', () => {
  it('does not send a second action on the same article until the first one settles', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const first = store.dispatch(item, rate(1));
    const second = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(nth(transport.sends, 0).action).toMatchObject({ type: 'rate' });
    expect(store.get(first.id)?.status).toBe('sending');
    expect(store.get(second.id)?.status).toBe('queued');
    await advance(MINUTE);
    expect(transport.sends).toHaveLength(1);
  });

  it('sends the second action with the stateVersion of the first response item', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    const first = ack(nth(transport.sends, 0), item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    expect(transport.sends).toHaveLength(2);
    const second = nth(transport.sends, 1);
    expect(second.action).toEqual({ type: 'bookmark' });
    expect(second.fence).toEqual({
      stateVersion: first.stateVersion,
      contentRevision: first.contentRevision,
    });
    expect(first.stateVersion).toBe('5');
  });

  it('chains the fences of three queued actions through their responses', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '8' });
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    await flush();
    expect(transport.sends).toHaveLength(1);
    const afterFirst = ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).fence.stateVersion).toBe('9');
    const afterSecond = ack(nth(transport.sends, 1), afterFirst, { bookmarkedAt: SERVER_TIME });
    await flush();
    expect(transport.sends).toHaveLength(3);
    expect(nth(transport.sends, 2).action).toEqual({ type: 'addLabel', labelId: '9' });
    expect(nth(transport.sends, 2).fence.stateVersion).toBe('10');
    expect(afterSecond.stateVersion).toBe('10');
  });

  it('sends an action on another article concurrently', async () => {
    const { store, transport } = rig();
    const first = makeItem({ id: '101', stateVersion: '4' });
    const second = makeItem({ id: '102', stateVersion: '6', contentRevision: '3' });
    store.dispatch(first, rate(1));
    store.dispatch(second, { type: 'bookmark' });
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(transport.sendsFor('101')).toHaveLength(1);
    expect(transport.sendsFor('102')).toHaveLength(1);
    expect(nth(transport.sendsFor('102'), 0).fence).toEqual({
      stateVersion: '6',
      contentRevision: '3',
    });
  });

  it('does not release the queue of one article when another article settles', async () => {
    const { store, transport } = rig();
    const busy = makeItem({ id: '101' });
    const other = makeItem({ id: '102' });
    store.dispatch(busy, rate(1));
    store.dispatch(busy, { type: 'bookmark' });
    store.dispatch(other, { type: 'read' });
    await flush();
    expect(transport.sends).toHaveLength(2);
    ack(nth(transport.sendsFor('102'), 0), other, { readAt: SERVER_TIME });
    await flush();
    expect(transport.sends).toHaveLength(2);
    ack(nth(transport.sendsFor('101'), 0), busy, { rating: 1 });
    await flush();
    expect(transport.sendsFor('101')).toHaveLength(2);
  });

  it('keeps a queued action waiting while the first one is backing off before a retry', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    nth(transport.sends, 0).reject(apiError(503, 'ENGINE_UNAVAILABLE'));
    await advance(99);
    expect(transport.sends).toHaveLength(1);
    await advance(1);
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toMatchObject({ type: 'rate' });
    const first = ack(nth(transport.sends, 1), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(3);
    expect(nth(transport.sends, 2).action).toEqual({ type: 'bookmark' });
    expect(nth(transport.sends, 2).fence.stateVersion).toBe(first.stateVersion);
  });

  it('fences a later action with the acknowledged state although the caller holds the old item', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '5', contentRevision: '2' });
  });

  it('skips a cancelled queued action and sends the next one after the first settles', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    const middle = store.dispatch(item, { type: 'bookmark' });
    store.dispatch(item, { type: 'addLabel', labelId: '9' });
    await flush();
    expect(store.cancel(middle.id)).toBe(true);
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toEqual({ type: 'addLabel', labelId: '9' });
    expect(nth(transport.sends, 1).fence.stateVersion).toBe('5');
  });
});

describe('O5 fence source', () => {
  it('fences the first action with the version and revision of the item it is given', async () => {
    const { store, transport } = rig();
    store.dispatch(makeItem({ stateVersion: '4', contentRevision: '2' }), rate(1));
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '4', contentRevision: '2' });
    expect(nth(transport.sends, 0).fence.snapshotId).toBeUndefined();
  });

  it('fences an item without a reader row with state version 0', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '0' });
    store.dispatch(item, { type: 'read' });
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '0', contentRevision: '2' });
    ack(nth(transport.sends, 0), item, { readAt: SERVER_TIME });
    await flush();
    expect(nth(transport.sends, 1).fence.stateVersion).toBe('1');
  });

  it('uses a newer item passed to observe before the dispatch', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '5', contentRevision: '2' });
    store.observe([makeItem({ stateVersion: '7', contentRevision: '3' })]);
    store.dispatch(item, rate(1));
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '7', contentRevision: '3' });
  });

  it('never lowers the known state with an older observed item', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '5' });
    store.observe([makeItem({ stateVersion: '7', contentRevision: '3', rating: -1 })]);
    store.observe([item]);
    expect(store.view(item)).toMatchObject({ stateVersion: '7', rating: -1 });
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '7', contentRevision: '3' });
  });

  it('does not let an older acknowledgement lower a newer observed state', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.dispatch(item, rate(1));
    await flush();
    store.observe([makeItem({ stateVersion: '7', contentRevision: '3', rating: -1 })]);
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(store.view(item)).toMatchObject({ stateVersion: '7', rating: -1 });
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '7', contentRevision: '3' });
  });

  it('compares state versions as numbers, not as text', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '9' });
    store.observe([makeItem({ stateVersion: '10', contentRevision: '3' })]);
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '10', contentRevision: '3' });
  });

  it('uses the item given to dispatch when it is newer than what was observed', async () => {
    const { store, transport } = rig();
    store.observe([makeItem({ stateVersion: '3' })]);
    store.dispatch(makeItem({ stateVersion: '5' }), rate(1));
    await flush();
    expect(nth(transport.sends, 0).fence.stateVersion).toBe('5');
  });

  it('puts the snapshot id and its content revision into the fence', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4', contentRevision: '3' });
    store.dispatch(item, { type: 'unbookmark' }, { snapshot: { id: '55', contentRevision: '1' } });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({
      stateVersion: '4',
      contentRevision: '1',
      snapshotId: '55',
    });
  });

  it('keeps the snapshot revision on a queued snapshot action and chains only the version', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4', contentRevision: '3' });
    const snapshot = { id: '55', contentRevision: '1' };
    store.dispatch(item, { type: 'addLabel', labelId: '9' }, { snapshot });
    store.dispatch(item, { type: 'addLabel', labelId: '10' }, { snapshot });
    await flush();
    ack(nth(transport.sends, 0), item, { labelIds: ['9'] });
    await flush();
    expect(nth(transport.sends, 1).fence).toEqual({
      stateVersion: '5',
      contentRevision: '1',
      snapshotId: '55',
    });
  });
});

describe('O6 rollback of only the failed action', () => {
  it('rolls back a failed rating, keeps the queued bookmark and sends it with the pre-rating fence', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const rating = store.dispatch(item, rate(1));
    const bookmark = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(store.view(item)).toMatchObject({ rating: 1, readAt: NOW, bookmarkedAt: NOW });

    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();

    expect(store.view(item)).toMatchObject({ rating: null, readAt: null, bookmarkedAt: NOW });
    asFailed(await outcome(rating.result));
    expect(transport.sends).toHaveLength(2);
    const second = nth(transport.sends, 1);
    expect(second.action).toEqual({ type: 'bookmark' });
    expect(second.fence).toEqual({ stateVersion: '4', contentRevision: '2' });

    ack(second, item, { bookmarkedAt: SERVER_TIME });
    await flush();
    expect(store.view(item)).toMatchObject({
      rating: null,
      bookmarkedAt: SERVER_TIME,
      stateVersion: '5',
    });
    expect((await outcome(bookmark.result)).status).toBe('done');
  });

  it('shows the second rating when the first of two ratings fails', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, rate(-1));
    await flush();
    expect(store.view(item).rating).toBe(-1);
    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.view(item)).toMatchObject({ rating: -1, readAt: NOW });
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toMatchObject({ type: 'rate', rating: -1 });
    expect(nth(transport.sends, 1).fence.stateVersion).toBe('4');
  });

  it('rolls back a failed bookmark without touching the acknowledged rating before it', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    const rated = ack(nth(transport.sends, 0), item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    nth(transport.sends, 1).reject(apiError(403, 'FORBIDDEN'));
    await flush();
    expect(store.view(item)).toEqual(adopted(item, rated));
    expect(store.view(item)).toMatchObject({
      rating: 1,
      readAt: SERVER_TIME,
      bookmarkedAt: null,
      stateVersion: '5',
    });
  });

  it('keeps the rollback of one article away from another', async () => {
    const { store, transport } = rig();
    const first = makeItem({ id: '101' });
    const second = makeItem({ id: '102' });
    store.dispatch(first, rate(1));
    store.dispatch(second, rate(-1));
    await flush();
    nth(transport.sendsFor('101'), 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.view(first)).toEqual(first);
    expect(store.view(second)).toMatchObject({ rating: -1 });
  });

  it('rolls back cleanly when a later action was dispatched with the already optimistic item', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1, readAt: SERVER_TIME });
    await flush();

    store.dispatch(item, { type: 'bookmark' });
    store.dispatch(store.view(item), { type: 'addLabel', labelId: '9' });
    await flush();
    nth(transport.sends, 1).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.view(item)).toMatchObject({
      stateVersion: '5',
      rating: 1,
      readAt: SERVER_TIME,
      bookmarkedAt: null,
      labelIds: ['9'],
    });
    expect(nth(transport.sends, 2).action).toEqual({ type: 'addLabel', labelId: '9' });
    expect(nth(transport.sends, 2).fence).toEqual({ stateVersion: '5', contentRevision: '2' });
  });
});

describe('O7 retries', () => {
  const transient: readonly (readonly [string, () => ApiError])[] = [
    ['network error', networkError],
    ['429', () => apiError(429, 'RATE_LIMITED')],
    ['500', () => apiError(500, 'INTERNAL')],
    ['502', () => apiError(502, 'INTERNAL')],
    ['503', () => apiError(503, 'ENGINE_UNAVAILABLE')],
    ['504', () => apiError(504, 'INTERNAL')],
  ];

  const permanent: readonly (readonly [string, () => ApiError])[] = [
    ['400', () => apiError(400, 'VALIDATION_FAILED')],
    ['403', () => apiError(403, 'FORBIDDEN')],
    ['404', () => apiError(404, 'NOT_FOUND')],
    ['409 CONFLICT', () => apiError(409, 'CONFLICT', { reason: 'not_opened' })],
    ['409 CONFLICT without details', () => apiError(409, 'CONFLICT')],
    ['invalid response', invalidResponseError],
  ];

  it.each(transient)(
    'retries a %s failure with the same key, fence and body, then fails and rolls back',
    async (_name, makeError) => {
      const backoffMs = vi.fn((_attempt: number) => 100);
      const { store, transport, advance } = rig({ backoffMs });
      const item = makeItem();
      const handle = store.dispatch(item, { type: 'rate', rating: -1, reason: 'promo' });
      await flush();
      const errors = [makeError(), makeError(), makeError()];

      nth(transport.sends, 0).reject(errors[0]);
      await advance(99);
      expect(transport.sends).toHaveLength(1);
      expect(store.view(item)).toMatchObject({ rating: -1, reason: 'promo' });
      await advance(1);
      expect(transport.sends).toHaveLength(2);

      nth(transport.sends, 1).reject(errors[1]);
      await advance(99);
      expect(transport.sends).toHaveLength(2);
      await advance(1);
      expect(transport.sends).toHaveLength(3);

      nth(transport.sends, 2).reject(errors[2]);
      await flush();
      await advance(10 * MINUTE);
      expect(transport.sends).toHaveLength(3);

      for (const call of transport.sends) {
        expect(call.key).toBe(handle.id);
        expect(call.articleId).toBe(item.id);
        expect(call.body).toEqual(nth(transport.sends, 0).body);
        expect(call.fence).toEqual({ stateVersion: '4', contentRevision: '2' });
      }
      expect(backoffMs.mock.calls.slice(0, 2)).toEqual([[1], [2]]);
      const result = asFailed(await outcome(handle.result));
      expect(result.error).toBe(errors[2]);
      expect(store.view(item)).toEqual(item);
      expect(store.get(handle.id)?.status).toBe('failed');
    },
  );

  it.each(transient)('succeeds when the retry after a %s is answered', async (_name, makeError) => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(makeError());
    await advance(100);
    expect(transport.sends).toHaveLength(2);
    const response = ack(nth(transport.sends, 1), item, { rating: 1, readAt: SERVER_TIME });
    const result = asDone(await outcome(handle.result));
    expect(result.mutationId).toBe(mutationOf(nth(transport.sends, 1)));
    expect(store.view(item)).toEqual(adopted(item, response));
    await advance(MINUTE);
    expect(transport.sends).toHaveLength(2);
  });

  it('does not retry a 429 before its retryAfterMs has passed', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 3000));
    await advance(2999);
    expect(transport.sends).toHaveLength(1);
    await advance(101);
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).key).toBe(nth(transport.sends, 0).key);
  });

  it.each(permanent)(
    'sends a request that is answered with %s exactly once',
    async (_n, makeError) => {
      const { store, transport, advance } = rig();
      const item = makeItem();
      const handle = store.dispatch(item, rate(1));
      await flush();
      const error = makeError();
      nth(transport.sends, 0).reject(error);
      await flush();
      await advance(10 * MINUTE);
      expect(transport.sends).toHaveLength(1);
      expect(asFailed(await outcome(handle.result)).error).toBe(error);
      expect(store.view(item)).toEqual(item);
    },
  );

  it.each([0, 1, 3])('honours maxRetries %i', async (maxRetries) => {
    const { store, transport, advance } = rig({ maxRetries });
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      expect(transport.sends).toHaveLength(attempt);
      nth(transport.sends, attempt - 1).reject(apiError(503, 'ENGINE_UNAVAILABLE'));
      await advance(100);
    }
    await advance(10 * MINUTE);
    expect(transport.sends).toHaveLength(maxRetries + 1);
    expect((await outcome(handle.result)).status).toBe('failed');
  });

  it('defaults to two retries with 500 ms and then 1000 ms of backoff', async () => {
    const transport = new FakeTransport();
    const store = createReaderActions({ transport, preferences: () => ({ markReadOnRate: true }) });
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(networkError());
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sends).toHaveLength(2);
    nth(transport.sends, 1).reject(networkError());
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sends).toHaveLength(3);
    nth(transport.sends, 2).reject(networkError());
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(transport.sends).toHaveLength(3);
    expect((await outcome(handle.result)).status).toBe('failed');
  });
});

describe('O8 fence of a retried request', () => {
  it('never changes even if a newer state was observed meanwhile', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem({ stateVersion: '4', contentRevision: '2' });
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    nth(transport.sends, 0).reject(apiError(503, 'ENGINE_UNAVAILABLE'));
    await flush();
    store.observe([makeItem({ stateVersion: '7', contentRevision: '3' })]);
    await advance(100);
    expect(transport.sends).toHaveLength(2);
    nth(transport.sends, 1).reject(networkError());
    await flush();
    store.observe([makeItem({ stateVersion: '9', contentRevision: '3' })]);
    await advance(100);
    expect(transport.sends).toHaveLength(3);
    for (const call of transport.sends) {
      expect(call.fence).toEqual({ stateVersion: '4', contentRevision: '2' });
      expect(call.body).toEqual(nth(transport.sends, 0).body);
      expect(call.key).toBe(nth(transport.sends, 0).key);
    }
  });

  it('is the original one when the retry follows a Retry-After wait', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(429, 'RATE_LIMITED', undefined, 2000));
    await flush();
    store.observe([makeItem({ stateVersion: '6' })]);
    await advance(2100);
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).fence.stateVersion).toBe('4');
  });
});

describe('O9 STALE_STATE', () => {
  const serverItem = (item: ArticleListItem): ArticleListItem =>
    makeItem({
      ...item,
      lane: 'everything',
      tier: null,
      pLike: null,
      stateVersion: '8',
      contentRevision: '3',
      rating: -1,
      reason: 'seen',
      readAt: SERVER_TIME,
      labelIds: ['5'],
    });

  it('adopts the reader fields of details.item, rolls back, reports stale and does not retry', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem({ lane: 'for_you', tier: 4, pLike: 0.82 });
    const handle = store.dispatch(item, rate(1));
    await flush();
    const server = serverItem(item);
    nth(transport.sends, 0).reject(apiError(409, 'STALE_STATE', { item: server }));
    await flush();
    await advance(10 * MINUTE);

    expect(transport.sends).toHaveLength(1);
    expect(store.view(item)).toEqual(adopted(item, server));
    expect(store.view(item)).toMatchObject({
      lane: 'for_you',
      tier: 4,
      rating: -1,
      reason: 'seen',
      stateVersion: '8',
    });
    expect(asStale(await outcome(handle.result)).item).toEqual(server);
    expect(store.get(handle.id)?.status).toBe('stale');
  });

  it('sends the next queued action on that article with the adopted fence', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    const server = serverItem(item);
    nth(transport.sends, 0).reject(apiError(409, 'STALE_STATE', { item: server }));
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toEqual({ type: 'bookmark' });
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '8', contentRevision: '3' });
    expect(store.view(item)).toMatchObject({ rating: -1, reason: 'seen', bookmarkedAt: NOW });
  });

  it('reports stale with a null item when details.item is null and still rolls back', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(409, 'STALE_STATE', { item: null }));
    await flush();
    await advance(10 * MINUTE);
    expect(transport.sends).toHaveLength(1);
    expect(await outcome(handle.result)).toEqual({ status: 'stale', item: null });
    expect(store.view(item)).toEqual(item);
  });

  it('treats an older details.item as no news and does not lower the known state', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '6' });
    store.dispatch(item, rate(1));
    await flush();
    nth(transport.sends, 0).reject(
      apiError(409, 'STALE_STATE', { item: makeItem({ stateVersion: '5', rating: -1 }) }),
    );
    await flush();
    expect(store.view(item)).toBe(item);
  });
});

describe('O10 hold', () => {
  it('shows the change at once but makes no request until release', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    expect(store.view(item)).toMatchObject({ rating: -1, readAt: NOW });
    await flush();
    await advance(MINUTE);
    expect(transport.calls).toHaveLength(0);
    expect(store.get(handle.id)?.status).toBe('held');
  });

  it('sends exactly one request with the chosen reason on release', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    await flush();
    store.release(handle.id, { reason: 'clickbait' });
    await flush();
    expect(transport.sends).toHaveLength(1);
    const call = nth(transport.sends, 0);
    expect(call.action).toMatchObject({ type: 'rate', rating: -1, reason: 'clickbait' });
    expect(call.key).toBe(handle.id);
    expect(call.fence).toEqual({ stateVersion: '4', contentRevision: '2' });
    expect(store.view(item)).toMatchObject({ rating: -1, reason: 'clickbait' });
    expect(store.get(handle.id)?.status).toBe('sending');
  });

  it('sends exactly one request without a reason when released without a patch', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    store.release(handle.id);
    await flush();
    expect(transport.sends).toHaveLength(1);
    const action = nth(transport.sends, 0).action;
    expect(action).toMatchObject({ type: 'rate', rating: -1 });
    expect((action as { reason?: string }).reason).toBeUndefined();
    expect(store.view(item)).toMatchObject({ rating: -1, reason: null });
  });

  it('applies hide from the release patch to the request and to the shown item', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    store.release(handle.id, { hide: true });
    await flush();
    expect(nth(transport.sends, 0).action).toMatchObject({ type: 'rate', rating: -1, hide: true });
    expect(store.view(item).archivedAt).toBe(NOW);
  });

  it('cancel while held returns true, removes the change, sends nothing and settles cancelled', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    await flush();
    expect(store.cancel(handle.id)).toBe(true);
    expect(store.view(item)).toEqual(item);
    await advance(MINUTE);
    expect(transport.calls).toHaveLength(0);
    expect(await outcome(handle.result)).toEqual({ status: 'cancelled' });
    expect(store.get(handle.id)?.status).toBe('cancelled');
  });

  it('cancel after the request was sent returns false and leaves the action running', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    store.release(handle.id, { reason: 'seen' });
    await flush();
    expect(store.cancel(handle.id)).toBe(false);
    expect(store.view(item)).toMatchObject({ rating: -1, reason: 'seen' });
    expect(nth(transport.sends, 0).signal.aborted).toBe(false);
    ack(nth(transport.sends, 0), item, { rating: -1, reason: 'seen', readAt: SERVER_TIME });
    expect((await outcome(handle.result)).status).toBe('done');
  });

  it('keeps a later action on the same article waiting for the release', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const held = store.dispatch(item, rate(-1), { hold: true });
    const later = store.dispatch(item, { type: 'bookmark' });
    await flush();
    await advance(MINUTE);
    expect(transport.calls).toHaveLength(0);
    expect(store.get(later.id)?.status).toBe('queued');
    expect(store.view(item)).toMatchObject({ rating: -1, bookmarkedAt: NOW });

    store.release(held.id, { reason: 'shallow' });
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(nth(transport.sends, 0).action).toMatchObject({ type: 'rate', reason: 'shallow' });
    const first = ack(nth(transport.sends, 0), item, { rating: -1, reason: 'shallow' });
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toEqual({ type: 'bookmark' });
    expect(nth(transport.sends, 1).fence.stateVersion).toBe(first.stateVersion);
  });

  it('lets the queued action go ahead when the held one is cancelled', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const held = store.dispatch(item, rate(-1), { hold: true });
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(store.cancel(held.id)).toBe(true);
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(nth(transport.sends, 0).action).toEqual({ type: 'bookmark' });
    expect(nth(transport.sends, 0).fence.stateVersion).toBe('4');
    expect(store.view(item)).toMatchObject({ rating: null, bookmarkedAt: NOW });
  });

  it('does not send a cancelled held action when its timer later calls release', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    expect(store.cancel(handle.id)).toBe(true);
    store.release(handle.id, { reason: 'other' });
    await flush();
    expect(transport.calls).toHaveLength(0);
    expect(store.view(item)).toEqual(item);
  });

  it('sends a held action once even if it is released twice', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    store.release(handle.id, { reason: 'promo' });
    store.release(handle.id, { reason: 'other' });
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(nth(transport.sends, 0).action).toMatchObject({ reason: 'promo' });
  });

  it('does not modify the action object it was given when the release patch is applied', async () => {
    const { store, transport } = rig();
    const action: ReaderAction = { type: 'rate', rating: -1 };
    const handle = store.dispatch(makeItem(), action, { hold: true });
    store.release(handle.id, { reason: 'promo', hide: true });
    await flush();
    expect(action).toEqual({ type: 'rate', rating: -1 });
    expect(nth(transport.sends, 0).action).toEqual({
      type: 'rate',
      rating: -1,
      reason: 'promo',
      hide: true,
    });
  });

  it('cancels a queued action that has not been sent and reports true', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    const queued = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(store.cancel(queued.id)).toBe(true);
    expect(store.view(item)).toMatchObject({ rating: 1, bookmarkedAt: null });
    expect(await outcome(queued.result)).toEqual({ status: 'cancelled' });
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(1);
  });

  it('cancel returns false for an action that was acknowledged, one that failed and an unknown id', async () => {
    const { store, transport } = rig();
    const first = makeItem({ id: '101' });
    const second = makeItem({ id: '102' });
    const done = store.dispatch(first, rate(1));
    const failed = store.dispatch(second, rate(1));
    await flush();
    const response = ack(nth(transport.sendsFor('101'), 0), first, { rating: 1 });
    nth(transport.sendsFor('102'), 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.cancel(done.id)).toBe(false);
    expect(store.cancel(failed.id)).toBe(false);
    expect(store.cancel('nope')).toBe(false);
    expect(store.get(done.id)?.status).toBe('done');
    expect(store.get(failed.id)?.status).toBe('failed');
    expect(store.view(first)).toEqual(adopted(first, response));
    expect(store.view(second)).toEqual(second);
    expect(store.recent()).toHaveLength(1);
  });
});

describe('O11 undo', () => {
  async function ratedAndAcknowledged(rigged: Rig) {
    const item = makeItem();
    const handle = rigged.store.dispatch(item, rate(1));
    await flush();
    const call = nth(rigged.transport.sends, 0);
    const response = ack(call, item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    return { item, handle, call, response, mutationId: mutationOf(call) };
  }

  it('calls undo once with the mutation id of the action under a key of its own', async () => {
    const rigged = rig();
    const { handle, mutationId } = await ratedAndAcknowledged(rigged);
    void rigged.store.undo(handle.id);
    await flush();
    expect(rigged.transport.undos).toHaveLength(1);
    const undoCall = nth(rigged.transport.undos, 0);
    expect(undoCall.body).toEqual({ mutationId });
    expect(undoCall.key).not.toBe(handle.id);
    expect(undoCall.key.length).toBeGreaterThan(0);
    expect(undoCall.signal.aborted).toBe(false);
  });

  it('adopts the returned items and reports undone when the server restores the state', async () => {
    const rigged = rig();
    const { store, transport } = rigged;
    const { item, handle, response } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    const restored = acked(response, { rating: null, readAt: null });
    answerBulk(nth(transport.undos, 0), [restored]);
    expect(await outcome(pending)).toEqual({ status: 'undone', items: [restored] });
    expect(store.view(item)).toEqual(adopted(item, restored));
    expect(store.view(item)).toMatchObject({ rating: null, readAt: null, stateVersion: '6' });
  });

  it('fences the next action with the state the undo restored', async () => {
    const rigged = rig();
    const { store, transport } = rigged;
    const { item, handle, response } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    answerBulk(nth(transport.undos, 0), [acked(response, { rating: null, readAt: null })]);
    await outcome(pending);
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '6', contentRevision: '2' });
  });

  it('adopts the items of a 409 STALE_STATE and reports conflict', async () => {
    const rigged = rig();
    const { store, transport } = rigged;
    const { item, handle } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    const newer = makeItem({ stateVersion: '9', rating: -1, readAt: SERVER_TIME });
    nth(transport.undos, 0).reject(apiError(409, 'STALE_STATE', { items: [newer] }));
    expect(await outcome(pending)).toEqual({ status: 'conflict', items: [newer] });
    expect(store.view(item)).toEqual(adopted(item, newer));
  });

  it.each(['not_undoable', 'already_undone', 'expired'] as const)(
    'refuses with %s when the server answers 409 CONFLICT with that reason',
    async (reason) => {
      const rigged = rig();
      const { store, transport } = rigged;
      const { handle } = await ratedAndAcknowledged(rigged);
      const pending = store.undo(handle.id);
      await flush();
      nth(transport.undos, 0).reject(apiError(409, 'CONFLICT', { reason }));
      expect(await outcome(pending)).toEqual({ status: 'refused', reason });
    },
  );

  it('refuses with unknown when the server answers 404', async () => {
    const rigged = rig();
    const { store, transport } = rigged;
    const { handle } = await ratedAndAcknowledged(rigged);
    const pending = store.undo(handle.id);
    await flush();
    nth(transport.undos, 0).reject(apiError(404, 'NOT_FOUND'));
    expect(await outcome(pending)).toEqual({ status: 'refused', reason: 'unknown' });
  });

  it('waits for the acknowledgement of an action in flight and then undoes it', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    const pending = store.undo(handle.id);
    await flush();
    expect(transport.undos).toHaveLength(0);

    const call = nth(transport.sends, 0);
    const response = ack(call, item, { rating: 1 });
    await flush();
    expect(transport.undos).toHaveLength(1);
    expect(nth(transport.undos, 0).body).toEqual({ mutationId: mutationOf(call) });

    const restored = acked(response, { rating: null, readAt: null });
    answerBulk(nth(transport.undos, 0), [restored]);
    expect(await outcome(pending)).toMatchObject({ status: 'undone' });
  });

  it('cancels a held action instead of calling undo', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    expect(await outcome(store.undo(handle.id))).toEqual({ status: 'cancelled' });
    expect(transport.calls).toHaveLength(0);
    expect(store.view(item)).toEqual(item);
    expect(await outcome(handle.result)).toEqual({ status: 'cancelled' });
  });

  it('cancels a queued action instead of calling undo and never sends it', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const first = store.dispatch(item, rate(1));
    const queued = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(await outcome(store.undo(queued.id))).toEqual({ status: 'cancelled' });
    expect(transport.undos).toHaveLength(0);
    expect(store.view(item)).toMatchObject({ rating: 1, bookmarkedAt: null });
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(transport.undos).toHaveLength(0);
    expect((await outcome(first.result)).status).toBe('done');
    expect(await outcome(queued.result)).toEqual({ status: 'cancelled' });
  });

  it('undoes a bulk action through the id listed in recent()', async () => {
    const { store, transport } = rig();
    const items = [makeItem({ id: '101' }), makeItem({ id: '102' })];
    const pendingBulk = store.bulk({ kind: 'markRead', items });
    await flush();
    const bulkCall = nth(transport.markReads, 0);
    bulkCall.resolve({ count: 2, mutationId: mutationOf(bulkCall) });
    await outcome(pendingBulk);
    const entry = nth(store.recent(), 0);
    const pending = store.undo(entry.id);
    await flush();
    expect(transport.undos).toHaveLength(1);
    expect(nth(transport.undos, 0).body).toEqual({ mutationId: mutationOf(bulkCall) });
    const restored = items.map((item) => acked(acked(item), { readAt: null }));
    answerBulk(nth(transport.undos, 0), restored);
    expect(await outcome(pending)).toEqual({ status: 'undone', items: restored });
    expect(store.recent()).toEqual([]);
    expect(store.view(items[0] as ArticleListItem).readAt).toBeNull();
  });
});

describe('O12 open, dwell and retryCapture are not undoable', () => {
  const capture = {
    status: 'failed',
    generation: '2',
    snapshotId: null,
    capturedAt: null,
    errorCode: 'FETCH_FAILED',
  } as const;

  it.each<[string, ReaderAction, Partial<ArticleListItem>]>([
    ['open', { type: 'open' }, {}],
    ['dwell', { type: 'dwell', ms: 20_000 }, { readAt: EARLIER }],
    [
      'retryCapture',
      { type: 'retryCapture', captureGeneration: '2' },
      { bookmarkedAt: EARLIER, bookmarkCapture: capture },
    ],
  ])(
    'refuses to undo %s without any request and keeps it out of recent()',
    async (_n, action, base) => {
      const { store, transport } = rig();
      const item = makeItem(base);
      const handle = store.dispatch(item, action);
      await flush();
      ack(nth(transport.sends, 0), item, { readAt: item.readAt ?? SERVER_TIME });
      await flush();
      asDone(await outcome(handle.result));
      expect(store.recent()).toEqual([]);
      expect(await outcome(store.undo(handle.id))).toEqual({
        status: 'refused',
        reason: 'not_undoable',
      });
      expect(transport.undos).toHaveLength(0);
      expect(store.recent()).toEqual([]);
    },
  );
});

describe('O13 obsolete analysis request', () => {
  const obsolete = () => apiError(409, 'CONFLICT', { reason: 'obsolete_request' });
  const withRequest: ReaderAction = { type: 'rate', rating: 1, analysisRequestId: REQUEST_ID };

  it('resends the rating once without the request id under a new key', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, withRequest);
    await flush();
    const first = nth(transport.sends, 0);
    expect(first.action).toMatchObject({ analysisRequestId: REQUEST_ID });
    first.reject(obsolete());
    await advance(100);

    expect(transport.sends).toHaveLength(2);
    const resend = nth(transport.sends, 1);
    expect(resend.action).toMatchObject({ type: 'rate', rating: 1 });
    expect((resend.action as { analysisRequestId?: string }).analysisRequestId).toBeUndefined();
    expect(resend.key).not.toBe(first.key);
    expect(resend.key.length).toBeGreaterThan(0);
    expect(resend.fence).toEqual(first.fence);
    expect(resend.articleId).toBe(first.articleId);
    expect(store.view(item)).toMatchObject({ rating: 1 });

    const response = ack(resend, item, { rating: 1, readAt: SERVER_TIME });
    const result = asDone(await outcome(handle.result));
    expect(result.droppedAnalysisRequestId).toBe(REQUEST_ID);
    expect(result.mutationId).toBe(mutationOf(resend));
    expect(store.view(item)).toEqual(adopted(item, response));
    await advance(MINUTE);
    expect(transport.sends).toHaveLength(2);
  });

  it('does not resend again when the resend is refused as obsolete too', async () => {
    const { store, transport, advance } = rig();
    const handle = store.dispatch(makeItem(), withRequest);
    await flush();
    nth(transport.sends, 0).reject(obsolete());
    await advance(100);
    nth(transport.sends, 1).reject(obsolete());
    await advance(10 * MINUTE);
    expect(transport.sends).toHaveLength(2);
    expect((await outcome(handle.result)).status).toBe('failed');
  });

  it('keeps a queued action waiting while the rating is resent and fences it with the resend response', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    store.dispatch(item, withRequest);
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    nth(transport.sends, 0).reject(obsolete());
    await advance(100);
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).action).toMatchObject({ type: 'rate', rating: 1 });
    await advance(MINUTE);
    expect(transport.sends).toHaveLength(2);
    const resent = ack(nth(transport.sends, 1), item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    expect(transport.sends).toHaveLength(3);
    expect(nth(transport.sends, 2).action).toEqual({ type: 'bookmark' });
    expect(nth(transport.sends, 2).fence.stateVersion).toBe(resent.stateVersion);
  });

  it.each(['not_opened', 'already_undone', 'something_else'])(
    'does not resend after a 409 CONFLICT with reason %s',
    async (reason) => {
      const { store, transport, advance } = rig();
      const item = makeItem();
      const handle = store.dispatch(item, withRequest);
      await flush();
      nth(transport.sends, 0).reject(apiError(409, 'CONFLICT', { reason }));
      await advance(10 * MINUTE);
      expect(transport.sends).toHaveLength(1);
      expect((await outcome(handle.result)).status).toBe('failed');
      expect(store.view(item)).toEqual(item);
    },
  );

  it('reports no dropped request for a rating that was accepted with its request id', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, withRequest);
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    expect(asDone(await outcome(handle.result)).droppedAnalysisRequestId).toBeNull();
  });
});

describe('O14 example suggestion', () => {
  const suggestion = { cardId: '31', side: 'no' } as const;

  it('is returned for a normal action', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 }, { exampleSuggestion: suggestion });
    const result = asDone(await outcome(handle.result));
    expect(result.exampleSuggestion).toEqual(suggestion);
    expect(handle.replayed).toBe(false);
  });

  it('is null for an action dispatched with replayed: true', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1), { replayed: true });
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 }, { exampleSuggestion: suggestion });
    const result = asDone(await outcome(handle.result));
    expect(result.exampleSuggestion).toBeNull();
    expect(result.mutationId).toBe(mid(1));
    expect(handle.replayed).toBe(true);
    expect(store.view(item)).toMatchObject({ rating: 1, stateVersion: '5' });
  });
});

describe('O15 bulk actions', () => {
  const bulkItems = () => [
    makeItem({ id: '101', stateVersion: '4', contentRevision: '2' }),
    makeItem({ id: '102', stateVersion: '9', contentRevision: '2' }),
    makeItem({ id: '103', stateVersion: '6', contentRevision: '5' }),
  ];

  it('markRead shows every item read at once and sends each item with its newest fence', async () => {
    const { store, transport } = rig();
    const [a, b, c] = bulkItems() as [ArticleListItem, ArticleListItem, ArticleListItem];
    store.observe([makeItem({ id: '102', stateVersion: '10', contentRevision: '3' })]);
    const pending = store.bulk({ kind: 'markRead', items: [a, b, c] });
    await flush();
    for (const item of [a, b, c]) expect(store.view(item).readAt).toBe(NOW);
    expect(transport.markReads).toHaveLength(1);
    const call = nth(transport.markReads, 0);
    expect(call.body).toEqual({
      targets: [
        { id: '101', stateVersion: '4', contentRevision: '2' },
        { id: '102', stateVersion: '10', contentRevision: '3' },
        { id: '103', stateVersion: '6', contentRevision: '5' },
      ],
    });
    expect(call.key.length).toBeGreaterThan(0);

    call.resolve({ count: 3, mutationId: mutationOf(call) });
    expect(await outcome(pending)).toEqual({
      status: 'done',
      mutationId: mutationOf(call),
      count: 3,
    });
  });

  it('fences a single action on a bulk-read item at stateVersion + 1 after the acknowledgement', async () => {
    const { store, transport } = rig();
    const [a, b, c] = bulkItems() as [ArticleListItem, ArticleListItem, ArticleListItem];
    store.observe([makeItem({ id: '102', stateVersion: '10', contentRevision: '3' })]);
    const pending = store.bulk({ kind: 'markRead', items: [a, b, c] });
    await flush();
    const call = nth(transport.markReads, 0);
    call.resolve({ count: 3, mutationId: mutationOf(call) });
    await outcome(pending);

    for (const item of [a, b, c]) expect(store.view(item).readAt).not.toBeNull();
    store.dispatch(a, { type: 'bookmark' });
    store.dispatch(b, { type: 'bookmark' });
    store.dispatch(c, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sendsFor('101'), 0).fence).toEqual({
      stateVersion: '5',
      contentRevision: '2',
    });
    expect(nth(transport.sendsFor('102'), 0).fence).toEqual({
      stateVersion: '11',
      contentRevision: '3',
    });
    expect(nth(transport.sendsFor('103'), 0).fence).toEqual({
      stateVersion: '7',
      contentRevision: '5',
    });
  });

  it('markRead rolls every item back when the request fails', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const pending = store.bulk({ kind: 'markRead', items });
    await flush();
    for (const item of items) expect(store.view(item).readAt).toBe(NOW);
    const error = apiError(400, 'VALIDATION_FAILED');
    nth(transport.markReads, 0).reject(error);
    const result = await outcome(pending);
    expect(result).toMatchObject({ status: 'failed' });
    expect((result as Extract<BulkResult, { status: 'failed' }>).error).toBe(error);
    for (const item of items) expect(store.view(item)).toEqual(item);

    store.dispatch(items[1] as ArticleListItem, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '9', contentRevision: '2' });
  });

  it('markRead leaves a single action on another article of the same list alone', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const outsider = makeItem({ id: '104' });
    store.dispatch(outsider, rate(1));
    const pending = store.bulk({ kind: 'markRead', items });
    await flush();
    nth(transport.markReads, 0).reject(apiError(403, 'FORBIDDEN'));
    await outcome(pending);
    expect(store.view(outsider)).toMatchObject({ rating: 1 });
  });

  const filter: MarkReadFilter = {
    lane: 'for_you',
    minTier: 3,
    olderThan: '2026-06-01T11:59:00.000Z',
  };

  it('markReadFilter sends the filter with the dataset version and marks the given items read', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const pending = store.bulk({
      kind: 'markReadFilter',
      filter,
      datasetVersion: 'ds-7',
      items,
    });
    await flush();
    expect(transport.markReads).toHaveLength(1);
    const call = nth(transport.markReads, 0);
    expect(call.body).toEqual({ filter, datasetVersion: 'ds-7' });
    for (const item of items) expect(store.view(item).readAt).toBe(NOW);
    call.resolve({ count: 42, mutationId: mutationOf(call) });
    expect(await outcome(pending)).toEqual({
      status: 'done',
      mutationId: mutationOf(call),
      count: 42,
    });
  });

  it('markReadFilter rolls back and reports stale with the reason when the dataset changed', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const pending = store.bulk({
      kind: 'markReadFilter',
      filter,
      datasetVersion: 'ds-7',
      items,
    });
    await flush();
    nth(transport.markReads, 0).reject(
      apiError(409, 'STALE_STATE', { reason: 'dataset_changed', datasetVersion: 'ds-8' }),
    );
    expect(await outcome(pending)).toEqual({
      status: 'stale',
      items: [],
      reason: 'dataset_changed',
    });
    for (const item of items) expect(store.view(item)).toEqual(item);
  });

  it('rateBulk sends the targets with the rating, shows it at once and adopts the response items', async () => {
    const { store, transport } = rig();
    const [a, b] = bulkItems() as [ArticleListItem, ArticleListItem, ArticleListItem];
    const pending = store.bulk({ kind: 'rateBulk', items: [a, b], rating: 1 });
    await flush();
    expect(transport.rateBulks).toHaveLength(1);
    const call = nth(transport.rateBulks, 0);
    expect(call.body).toEqual({
      targets: [
        { id: '101', stateVersion: '4', contentRevision: '2' },
        { id: '102', stateVersion: '9', contentRevision: '2' },
      ],
      rating: 1,
    });
    expect(store.view(a).rating).toBe(1);
    expect(store.view(b).rating).toBe(1);

    const serverA = acked(a, { rating: 1, readAt: SERVER_TIME });
    const serverB = acked(b, { rating: 1, readAt: SERVER_TIME });
    call.resolve({ count: 2, mutationId: mutationOf(call), items: [serverA, serverB] });
    expect(await outcome(pending)).toEqual({
      status: 'done',
      mutationId: mutationOf(call),
      count: 2,
    });
    expect(store.view(a)).toEqual(adopted(a, serverA));
    expect(store.view(b)).toEqual(adopted(b, serverB));

    store.dispatch(b, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '10', contentRevision: '2' });
  });

  it('rateBulk rolls the ratings back when the request fails', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const pending = store.bulk({ kind: 'rateBulk', items, rating: -1 });
    await flush();
    for (const item of items) expect(store.view(item).rating).toBe(-1);
    nth(transport.rateBulks, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    expect(await outcome(pending)).toMatchObject({ status: 'failed' });
    for (const item of items) expect(store.view(item)).toEqual(item);
  });

  it('markRead adopts the items of a 409 STALE_STATE, rolls every item back and reports stale', async () => {
    const { store, transport } = rig();
    const items = bulkItems();
    const [a, b, c] = items as [ArticleListItem, ArticleListItem, ArticleListItem];
    const pending = store.bulk({ kind: 'markRead', items });
    await flush();
    const newer = makeItem({
      id: '102',
      stateVersion: '12',
      contentRevision: '3',
      rating: -1,
      readAt: SERVER_TIME,
    });
    nth(transport.markReads, 0).reject(apiError(409, 'STALE_STATE', { items: [newer] }));
    expect(await outcome(pending)).toEqual({ status: 'stale', items: [newer], reason: null });
    expect(store.view(a)).toEqual(a);
    expect(store.view(b)).toEqual(adopted(b, newer));
    expect(store.view(c)).toEqual(c);

    store.dispatch(b, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence).toEqual({ stateVersion: '12', contentRevision: '3' });
  });

  it('rateBulk adopts the items of a 409 STALE_STATE, rolls the ratings back and reports stale', async () => {
    const { store, transport } = rig();
    const [a, b] = bulkItems() as [ArticleListItem, ArticleListItem, ArticleListItem];
    const pending = store.bulk({ kind: 'rateBulk', items: [a, b], rating: 1 });
    await flush();
    const newer = makeItem({
      id: '101',
      stateVersion: '6',
      contentRevision: '2',
      rating: -1,
      reason: 'seen',
      readAt: SERVER_TIME,
    });
    nth(transport.rateBulks, 0).reject(apiError(409, 'STALE_STATE', { items: [newer] }));
    expect(await outcome(pending)).toEqual({ status: 'stale', items: [newer], reason: null });
    expect(store.view(a)).toEqual(adopted(a, newer));
    expect(store.view(b)).toEqual(b);
  });

  it('rateBulk with null shows the ratings cleared', async () => {
    const { store, transport } = rig();
    const items = bulkItems().map((item) => makeItem({ ...item, rating: 1, readAt: EARLIER }));
    void store.bulk({ kind: 'rateBulk', items, rating: null });
    await flush();
    for (const item of items) {
      expect(store.view(item)).toMatchObject({ rating: null, reason: null, readAt: EARLIER });
    }
    expect(nth(transport.rateBulks, 0).body).toMatchObject({ rating: null });
  });
});

describe('O16 recent actions and change notification', () => {
  it('lists acknowledged undoable single actions newest first', async () => {
    const { store, transport, advance, clock } = rig();
    const first = makeItem({ id: '101' });
    const second = makeItem({ id: '102' });
    const one = store.dispatch(first, rate(1));
    await flush();
    await advance(1000);
    ack(nth(transport.sends, 0), first, { rating: 1 });
    await flush();
    const two = store.dispatch(second, { type: 'bookmark' });
    await flush();
    await advance(2000);
    ack(nth(transport.sends, 1), second, { bookmarkedAt: SERVER_TIME });
    await flush();

    expect(store.recent()).toHaveLength(2);
    expect(store.recent()[0]).toMatchObject({
      id: two.id,
      kind: 'bookmark',
      articleIds: ['102'],
      at: clock.now,
      mutationId: mutationOf(nth(transport.sends, 1)),
    });
    expect(store.recent()[1]).toMatchObject({
      id: one.id,
      kind: 'rate',
      articleIds: ['101'],
      at: T0 + 1000,
      mutationId: mutationOf(nth(transport.sends, 0)),
    });
  });

  const undoable: Record<(typeof UNDOABLE_ACTIONS)[number], ReaderAction> = {
    read: { type: 'read' },
    unread: { type: 'unread' },
    unhide: { type: 'unhide' },
    rate: { type: 'rate', rating: 1 },
    promptAnswer: { type: 'promptAnswer', liked: false },
    bookmark: { type: 'bookmark' },
    unbookmark: { type: 'unbookmark' },
    addLabel: { type: 'addLabel', labelId: '9' },
    removeLabel: { type: 'removeLabel', labelId: '5' },
  };

  it.each(UNDOABLE_ACTIONS)('lists an acknowledged %s action', async (type) => {
    const { store, transport } = rig();
    const item = makeItem({ labelIds: ['5'] });
    const handle = store.dispatch(item, undoable[type]);
    await flush();
    const call = nth(transport.sends, 0);
    ack(call, item, {});
    await flush();
    expect(store.recent()).toHaveLength(1);
    expect(store.recent()[0]).toMatchObject({
      id: handle.id,
      kind: type,
      articleIds: [item.id],
      mutationId: mutationOf(call),
    });
  });

  it('does not list actions that are in flight, held, failed, stale or cancelled', async () => {
    const { store, transport } = rig();
    store.dispatch(makeItem({ id: '101' }), rate(1));
    store.dispatch(makeItem({ id: '102' }), rate(1));
    store.dispatch(makeItem({ id: '103' }), rate(1));
    const held = store.dispatch(makeItem({ id: '104' }), rate(1), { hold: true });
    await flush();
    expect(store.recent()).toEqual([]);
    nth(transport.sendsFor('101'), 0).reject(apiError(400, 'VALIDATION_FAILED'));
    nth(transport.sendsFor('102'), 0).reject(
      apiError(409, 'STALE_STATE', { item: makeItem({ id: '102', stateVersion: '8' }) }),
    );
    store.cancel(held.id);
    await flush();
    expect(store.recent()).toEqual([]);
  });

  it('lists acknowledged bulk actions with their article ids and receipt', async () => {
    const { store, transport, advance } = rig();
    const items = [makeItem({ id: '101' }), makeItem({ id: '102' }), makeItem({ id: '103' })];
    const marked = store.bulk({
      kind: 'markRead',
      items: [items[0], items[1]] as ArticleListItem[],
    });
    await flush();
    nth(transport.markReads, 0).resolve({ count: 2, mutationId: mid(61) });
    await outcome(marked);
    await advance(1000);
    const rated = store.bulk({
      kind: 'rateBulk',
      items: [items[2]] as ArticleListItem[],
      rating: 1,
    });
    await flush();
    answerBulk(nth(transport.rateBulks, 0), [acked(items[2] as ArticleListItem, { rating: 1 })]);
    await outcome(rated);

    const recent = store.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ kind: 'rateBulk', articleIds: ['103'] });
    expect(recent[1]).toMatchObject({
      kind: 'markRead',
      articleIds: ['101', '102'],
      at: T0,
      mutationId: mid(61),
    });
    expect(recent[0]?.id).not.toBe(recent[1]?.id);
  });

  it('drops an entry 10 minutes after its acknowledgement and not before', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(store.recent()).toHaveLength(1);
    await advance(TEN_MINUTES - 1000);
    expect(store.recent()).toHaveLength(1);
    await advance(2000);
    expect(store.recent()).toEqual([]);
  });

  it('measures the 10 minutes from the acknowledgement, not from the dispatch', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    await advance(5 * MINUTE);
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    await advance(9 * MINUTE);
    expect(store.recent()).toHaveLength(1);
    await advance(2 * MINUTE);
    expect(store.recent()).toEqual([]);
  });

  it('drops an entry once it has been undone', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    const response = ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    const pending = store.undo(handle.id);
    await flush();
    answerBulk(nth(transport.undos, 0), [acked(response, { rating: null, readAt: null })]);
    await outcome(pending);
    expect(store.recent()).toEqual([]);
  });

  it('notifies subscribers and increases the version when an action is dispatched', async () => {
    const { store } = rig();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getVersion();
    store.dispatch(makeItem(), rate(1));
    expect(store.getVersion()).toBeGreaterThan(before);
    await flush();
    expect(listener).toHaveBeenCalled();
  });

  it('notifies subscribers and increases the version when an action is acknowledged', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getVersion();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(store.getVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
  });

  it('notifies subscribers and increases the version when an action is rolled back', async () => {
    const { store, transport } = rig();
    store.dispatch(makeItem(), rate(1));
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getVersion();
    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.getVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
  });

  it('notifies subscribers and increases the version when an undo completes', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    const response = ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    const pending = store.undo(handle.id);
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getVersion();
    answerBulk(nth(transport.undos, 0), [acked(response, { rating: null, readAt: null })]);
    await outcome(pending);
    expect(store.getVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
  });

  it('stops notifying a subscriber after it unsubscribes', async () => {
    const { store } = rig();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.dispatch(makeItem(), rate(1));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('O17 view identity', () => {
  it('returns the very same object when nothing is known and nothing is unsettled', () => {
    const { store } = rig();
    const item = makeItem();
    expect(store.view(item)).toBe(item);
  });

  it('ignores a known state that is older than the item or equal to it', () => {
    const { store } = rig();
    const item = makeItem({ stateVersion: '10', rating: null });
    store.observe([makeItem({ stateVersion: '9', rating: -1, readAt: EARLIER })]);
    expect(store.view(item)).toBe(item);
    store.observe([makeItem({ stateVersion: '10', rating: null })]);
    expect(store.view(item)).toBe(item);
  });

  it('returns an object with the reader fields of a newer known state', () => {
    const { store } = rig();
    const item = makeItem({ stateVersion: '4' });
    const newer = makeItem({
      stateVersion: '5',
      rating: 1,
      readAt: EARLIER,
      lane: 'maybe',
      tier: 2,
    });
    store.observe([newer]);
    const view = store.view(item);
    expect(view).not.toBe(item);
    expect(view).toEqual(adopted(item, newer));
    expect(view.lane).toBe(item.lane);
  });

  it('applies the unsettled changes on top of a newer observed state', () => {
    const { store } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.dispatch(item, { type: 'bookmark' });
    store.observe([makeItem({ stateVersion: '6', rating: 1, readAt: EARLIER, labelIds: ['5'] })]);
    expect(store.view(item)).toMatchObject({
      stateVersion: '6',
      rating: 1,
      readAt: EARLIER,
      labelIds: ['5'],
      bookmarkedAt: NOW,
    });
  });

  it('returns the very same refetched item once the acknowledged state has caught up', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    const response = ack(nth(transport.sends, 0), item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    expect(store.view(item)).toEqual(adopted(item, response));
    const refetched = makeItem({ ...response, lane: 'for_you' });
    expect(store.view(refetched)).toBe(refetched);
  });

  it('returns the very same object again after the only unsettled action is rolled back', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    expect(store.view(item)).not.toBe(item);
    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.view(item)).toBe(item);
  });

  it('returns the very same object again after a held action is cancelled', () => {
    const { store } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    expect(store.view(item)).not.toBe(item);
    store.cancel(handle.id);
    expect(store.view(item)).toBe(item);
  });

  it('leaves other articles untouched while one has unsettled actions', () => {
    const { store } = rig();
    const busy = makeItem({ id: '101' });
    const idle = makeItem({ id: '102' });
    store.dispatch(busy, { type: 'bookmark' });
    expect(store.view(idle)).toBe(idle);
  });
});

describe('O18 reset', () => {
  it('aborts the signal of every request that is in flight', async () => {
    const { store, transport } = rig();
    store.dispatch(makeItem({ id: '101' }), rate(1));
    store.dispatch(makeItem({ id: '102' }), { type: 'bookmark' });
    await flush();
    expect(transport.sends.map((call) => call.signal.aborted)).toEqual([false, false]);
    store.reset();
    await flush();
    expect(transport.sends.map((call) => call.signal.aborted)).toEqual([true, true]);
  });

  it('aborts in-flight bulk and undo requests too', async () => {
    const { store, transport } = rig();
    const item = makeItem({ id: '101' });
    const handle = store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    void store.undo(handle.id);
    void store.bulk({ kind: 'markRead', items: [makeItem({ id: '102' })] });
    await flush();
    expect(nth(transport.undos, 0).signal.aborted).toBe(false);
    expect(nth(transport.markReads, 0).signal.aborted).toBe(false);
    store.reset();
    await flush();
    expect(nth(transport.undos, 0).signal.aborted).toBe(true);
    expect(nth(transport.markReads, 0).signal.aborted).toBe(true);
  });

  it.each<[string, (call: SendCall, item: ArticleListItem) => void]>([
    ['a late acknowledgement', (call, item) => void ack(call, item, { rating: 1 })],
    ['a late abort error', (call) => call.reject(abortedError())],
    ['a late network error', (call) => call.reject(networkError())],
    [
      'a late stale answer',
      (call, item) =>
        call.reject(
          apiError(409, 'STALE_STATE', { item: makeItem({ ...item, stateVersion: '8' }) }),
        ),
    ],
  ])('changes nothing when %s of an aborted request arrives', async (_n, answer) => {
    const { store, transport, settled, advance } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    store.reset();
    await flush();
    const settledAfterReset = settled.length;
    answer(nth(transport.sends, 0), item);
    await flush();
    await advance(10 * MINUTE);
    expect(store.view(item)).toBe(item);
    expect(store.recent()).toEqual([]);
    expect(settled).toHaveLength(settledAfterReset);
    expect(transport.sends).toHaveLength(1);
  });

  it('forgets held actions, so a release after the reset sends nothing', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(-1), { hold: true });
    store.reset();
    store.release(handle.id, { reason: 'seen' });
    await flush();
    expect(transport.calls).toHaveLength(0);
    expect(store.view(item)).toBe(item);
  });

  it('forgets known states, so a dispatch after the reset is fenced by the item it is given', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.observe([makeItem({ stateVersion: '7', rating: -1 })]);
    store.reset();
    expect(store.view(item)).toBe(item);
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(nth(transport.sends, 0).fence.stateVersion).toBe('4');
  });

  it('forgets queued actions, so they are never sent after the reset', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    store.dispatch(item, { type: 'bookmark' });
    await flush();
    store.reset();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(transport.sends).toHaveLength(1);
    expect(store.view(item)).toBe(item);
  });

  it('forgets acknowledged actions, so recent() is empty', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(store.recent()).toHaveLength(1);
    store.reset();
    expect(store.recent()).toEqual([]);
  });

  it('cancels a retry that was waiting for its backoff', async () => {
    const { store, transport, advance } = rig();
    store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(apiError(503, 'ENGINE_UNAVAILABLE'));
    await flush();
    store.reset();
    await advance(10 * MINUTE);
    expect(transport.sends).toHaveLength(1);
  });

  it('works normally after a reset and ignores answers of the earlier generation', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4' });
    store.dispatch(item, rate(1));
    await flush();
    const stale = nth(transport.sends, 0);
    store.reset();

    const handle = store.dispatch(item, { type: 'bookmark' });
    await flush();
    expect(transport.sends).toHaveLength(2);
    const fresh = nth(transport.sends, 1);
    expect(fresh.fence).toEqual({ stateVersion: '4', contentRevision: '2' });

    ack(stale, item, { rating: 1, readAt: SERVER_TIME });
    await flush();
    expect(store.view(item)).toMatchObject({ rating: null, bookmarkedAt: NOW, stateVersion: '4' });

    const response = ack(fresh, item, { bookmarkedAt: SERVER_TIME });
    expect(asDone(await outcome(handle.result)).mutationId).toBe(mutationOf(fresh));
    expect(store.view(item)).toEqual(adopted(item, response));
    expect(store.recent()).toHaveLength(1);
  });
});

describe('O19 retry of a failed action', () => {
  it('re-applies the change and sends the same key and body again', async () => {
    const { store, transport, advance } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, { type: 'rate', rating: -1, reason: 'clickbait' });
    await flush();
    nth(transport.sends, 0).reject(apiError(400, 'VALIDATION_FAILED'));
    await flush();
    expect(store.view(item)).toEqual(item);
    await advance(MINUTE);
    expect(transport.sends).toHaveLength(1);

    const again = store.retry(handle.id);
    expect(again).not.toBeNull();
    expect(again?.id).toBe(handle.id);
    expect(store.view(item)).toMatchObject({ rating: -1, reason: 'clickbait', readAt: NOW });
    await flush();
    expect(transport.sends).toHaveLength(2);
    const second = nth(transport.sends, 1);
    expect(second.key).toBe(nth(transport.sends, 0).key);
    expect(second.action).toEqual(nth(transport.sends, 0).action);
    expect(second.fence).toEqual(nth(transport.sends, 0).fence);
    expect(second.body).toEqual(nth(transport.sends, 0).body);
    expect(store.get(handle.id)?.status).toBe('sending');

    const response = ack(second, item, { rating: -1, reason: 'clickbait', readAt: SERVER_TIME });
    const result = asDone(await outcome((again as ActionHandle).result));
    expect(result.mutationId).toBe(mutationOf(second));
    expect(store.view(item)).toEqual(adopted(item, response));
    expect(store.get(handle.id)?.status).toBe('done');
  });

  it('keeps the original fence even if a newer state was observed after the failure', async () => {
    const { store, transport } = rig();
    const item = makeItem({ stateVersion: '4' });
    const handle = store.dispatch(item, { type: 'bookmark' });
    await flush();
    nth(transport.sends, 0).reject(apiError(403, 'FORBIDDEN'));
    await flush();
    store.observe([makeItem({ stateVersion: '8', contentRevision: '3' })]);
    store.retry(handle.id);
    await flush();
    expect(transport.sends).toHaveLength(2);
    expect(nth(transport.sends, 1).fence).toEqual({ stateVersion: '4', contentRevision: '2' });
    expect(nth(transport.sends, 1).key).toBe(handle.id);
  });

  it('returns null for an unknown action', () => {
    const { store } = rig();
    expect(store.retry('nope')).toBeNull();
  });

  it('returns null for an action that has not failed', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    expect(store.retry(handle.id)).toBeNull();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    await flush();
    expect(store.retry(handle.id)).toBeNull();
    expect(transport.sends).toHaveLength(1);
  });
});

describe('O20 settlement callback', () => {
  it('fires once with the done result', async () => {
    const { store, transport, settled } = rig();
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    expect(settled).toHaveLength(0);
    ack(nth(transport.sends, 0), item, { rating: 1 });
    const result = await outcome(handle.result);
    await flush();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toEqual(result);
    expect(settled[0]?.handle).toMatchObject({
      id: handle.id,
      articleId: item.id,
      action: { type: 'rate', rating: 1 },
    });
  });

  it('fires once with the failed result after all retries, not once per attempt', async () => {
    const { store, transport, settled, advance } = rig();
    const handle = store.dispatch(makeItem(), rate(1));
    await flush();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      nth(transport.sends, attempt).reject(networkError());
      await advance(100);
      expect(settled).toHaveLength(attempt < 2 ? 0 : 1);
    }
    const result = await outcome(handle.result);
    await advance(10 * MINUTE);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toEqual(result);
    expect(settled[0]?.result.status).toBe('failed');
  });

  it('fires once with the stale result', async () => {
    const { store, transport, settled } = rig();
    const handle = store.dispatch(makeItem(), rate(1));
    await flush();
    nth(transport.sends, 0).reject(
      apiError(409, 'STALE_STATE', { item: makeItem({ stateVersion: '8' }) }),
    );
    const result = await outcome(handle.result);
    await flush();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toEqual(result);
    expect(settled[0]?.result.status).toBe('stale');
  });

  it('fires once with the cancelled result', async () => {
    const { store, settled } = rig();
    const handle = store.dispatch(makeItem(), rate(-1), { hold: true });
    await flush();
    expect(settled).toHaveLength(0);
    store.cancel(handle.id);
    await flush();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toEqual({ status: 'cancelled' });
    expect(settled[0]?.handle.id).toBe(handle.id);
  });

  it('fires once for an action cancelled through undo', async () => {
    const { store, settled } = rig();
    const handle = store.dispatch(makeItem(), rate(-1), { hold: true });
    await outcome(store.undo(handle.id));
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result.status).toBe('cancelled');
  });

  it('fires once for a rating that was resent without its request id', async () => {
    const { store, transport, settled, advance } = rig();
    const item = makeItem();
    store.dispatch(item, { type: 'rate', rating: 1, analysisRequestId: REQUEST_ID });
    await flush();
    nth(transport.sends, 0).reject(apiError(409, 'CONFLICT', { reason: 'obsolete_request' }));
    await advance(100);
    expect(settled).toHaveLength(0);
    ack(nth(transport.sends, 1), item, { rating: 1 });
    await flush();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.result).toMatchObject({
      status: 'done',
      droppedAnalysisRequestId: REQUEST_ID,
    });
  });

  it('fires once per action when several actions settle, in the order they settle', async () => {
    const { store, transport, settled } = rig();
    const item = makeItem();
    const first = store.dispatch(item, rate(1));
    const second = store.dispatch(item, { type: 'bookmark' });
    const other = store.dispatch(makeItem({ id: '102' }), { type: 'read' });
    await flush();
    ack(nth(transport.sendsFor('102'), 0), makeItem({ id: '102' }), { readAt: SERVER_TIME });
    await flush();
    const afterFirst = ack(nth(transport.sendsFor('101'), 0), item, { rating: 1 });
    await flush();
    ack(nth(transport.sendsFor('101'), 1), afterFirst, { bookmarkedAt: SERVER_TIME });
    await flush();
    expect(settled.map((entry) => entry.handle.id)).toEqual([other.id, first.id, second.id]);
    expect(settled.map((entry) => entry.result.status)).toEqual(['done', 'done', 'done']);
  });

  it('works without an onSettled callback', async () => {
    const transport = new FakeTransport();
    const store = createReaderActions({
      transport,
      preferences: () => ({ markReadOnRate: true }),
      newId: () => 'only-id',
    });
    const item = makeItem();
    const handle = store.dispatch(item, rate(1));
    await flush();
    ack(nth(transport.sends, 0), item, { rating: 1 });
    expect((await outcome(handle.result)).status).toBe('done');
  });
});

describe('Handles and defaults', () => {
  it('gives each action its own generated id, which is also its idempotency key', async () => {
    const { store, transport } = rig();
    const item = makeItem();
    const first = store.dispatch(item, rate(1));
    const second = store.dispatch(makeItem({ id: '102' }), { type: 'bookmark' });
    await flush();
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
    expect(nth(transport.sendsFor('101'), 0).key).toBe(first.id);
    expect(nth(transport.sendsFor('102'), 0).key).toBe(second.id);
  });

  it('describes the dispatched action on the handle', async () => {
    const { store, clock, advance } = rig();
    await advance(1234);
    const item = makeItem({ id: '101' });
    const action: ReaderAction = { type: 'addLabel', labelId: '9' };
    const handle = store.dispatch(item, action);
    expect(handle).toMatchObject({
      articleId: '101',
      action,
      mutationId: null,
      createdAt: clock.now,
      replayed: false,
    });
    expect(store.get(handle.id)).toMatchObject({ id: handle.id, articleId: '101' });
  });

  it('returns undefined for an action id it does not know', () => {
    const { store } = rig();
    expect(store.get('nope')).toBeUndefined();
  });

  it('uses crypto.randomUUID ids and the system clock when no newId or now is given', async () => {
    const transport = new FakeTransport();
    const store = createReaderActions({ transport, preferences: () => ({ markReadOnRate: true }) });
    const first = store.dispatch(makeItem({ id: '101' }), rate(1));
    const second = store.dispatch(makeItem({ id: '102' }), rate(1));
    await flush();
    expect(first.id).toMatch(UUID);
    expect(second.id).toMatch(UUID);
    expect(first.id).not.toBe(second.id);
    expect(nth(transport.sendsFor('101'), 0).key).toBe(first.id);
    expect(first.createdAt).toBe(SYSTEM_TIME);
    expect(store.view(makeItem({ id: '101' })).readAt).toBe(new Date(SYSTEM_TIME).toISOString());
  });
});
