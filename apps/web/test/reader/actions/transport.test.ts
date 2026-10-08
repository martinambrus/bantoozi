import type { MarkReadFilter } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../../../src/api/client.js';
import { ApiError } from '../../../src/api/errors.js';
import { createReaderTransport } from '../../../src/features/reader/actions/transport.js';
import type { Fence, ReaderAction } from '../../../src/features/reader/actions/types.js';
import { failure, fakeFetch, json, type FakeHandler } from '../../api/fake-fetch.js';
import { makeItem } from './fake-transport.js';

const KEY = 'key-1';
const MUTATION = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '5b0f1a54-2d1c-4a53-9d7e-3b1f6c1e9a10';
const FENCE: Fence = { stateVersion: '4', contentRevision: '2' };
const SNAPSHOT_FENCE: Fence = { stateVersion: '4', contentRevision: '1', snapshotId: '55' };
const item = makeItem({ id: '101' });
const plain = { item, mutationId: MUTATION };

function setup(handler: FakeHandler = () => json(200, plain)) {
  const fake = fakeFetch(handler);
  const transport = createReaderTransport(createApiClient({ fetch: fake.fetch }));
  return { ...fake, transport };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

interface SendCase {
  readonly name: string;
  readonly action: ReaderAction;
  readonly fence?: Fence;
  readonly method: 'POST' | 'DELETE';
  readonly path: string;
  /** The JSON body of a POST. */
  readonly body?: Record<string, unknown>;
  /** The query string of a DELETE. */
  readonly query?: Record<string, string>;
  readonly reply?: Record<string, unknown>;
}

const fenceFields = { stateVersion: '4', contentRevision: '2' };
const snapshotFields = { stateVersion: '4', contentRevision: '1', snapshotId: '55' };

const sendCases: readonly SendCase[] = [
  {
    name: 'read',
    action: { type: 'read' },
    method: 'POST',
    path: '/api/v1/articles/101/read',
    body: fenceFields,
  },
  {
    name: 'read with the expand trigger',
    action: { type: 'read', trigger: 'expand' },
    method: 'POST',
    path: '/api/v1/articles/101/read',
    body: { ...fenceFields, trigger: 'expand' },
  },
  {
    name: 'unread',
    action: { type: 'unread' },
    method: 'POST',
    path: '/api/v1/articles/101/unread',
    body: fenceFields,
  },
  {
    name: 'unhide',
    action: { type: 'unhide' },
    method: 'POST',
    path: '/api/v1/articles/101/unhide',
    body: fenceFields,
  },
  {
    name: 'open',
    action: { type: 'open' },
    method: 'POST',
    path: '/api/v1/articles/101/open',
    body: fenceFields,
  },
  {
    name: 'dwell',
    action: { type: 'dwell', ms: 12_000 },
    method: 'POST',
    path: '/api/v1/articles/101/dwell',
    body: { ...fenceFields, ms: 12_000 },
    reply: { ...plain, prompt: false },
  },
  {
    name: 'like',
    action: { type: 'rate', rating: 1 },
    method: 'POST',
    path: '/api/v1/articles/101/rating',
    body: { ...fenceFields, rating: 1 },
    reply: { ...plain, exampleSuggestion: null },
  },
  {
    name: 'un-rate',
    action: { type: 'rate', rating: null },
    method: 'POST',
    path: '/api/v1/articles/101/rating',
    body: { ...fenceFields, rating: null },
    reply: { ...plain, exampleSuggestion: null },
  },
  {
    name: 'dislike with a reason and hide',
    action: { type: 'rate', rating: -1, reason: 'clickbait', hide: true },
    method: 'POST',
    path: '/api/v1/articles/101/rating',
    body: { ...fenceFields, rating: -1, reason: 'clickbait', hide: true },
    reply: { ...plain, exampleSuggestion: null },
  },
  {
    name: 'rate with every option',
    action: {
      type: 'rate',
      rating: -1,
      reason: 'seen',
      hide: false,
      analysisRequestId: REQUEST_ID,
      selection: 'calibration',
    },
    method: 'POST',
    path: '/api/v1/articles/101/rating',
    body: {
      ...fenceFields,
      rating: -1,
      reason: 'seen',
      hide: false,
      analysisRequestId: REQUEST_ID,
      selection: 'calibration',
    },
    reply: { ...plain, exampleSuggestion: null },
  },
  {
    name: 'promptAnswer',
    action: { type: 'promptAnswer', liked: false },
    method: 'POST',
    path: '/api/v1/articles/101/prompt-answer',
    body: { ...fenceFields, liked: false },
  },
  {
    name: 'promptAnswer with a request id',
    action: { type: 'promptAnswer', liked: true, analysisRequestId: REQUEST_ID },
    method: 'POST',
    path: '/api/v1/articles/101/prompt-answer',
    body: { ...fenceFields, liked: true, analysisRequestId: REQUEST_ID },
  },
  {
    name: 'bookmark',
    action: { type: 'bookmark' },
    method: 'POST',
    path: '/api/v1/articles/101/bookmark',
    body: fenceFields,
  },
  {
    name: 'bookmark with the display feed',
    action: { type: 'bookmark', mediaPolicyFeedId: '7' },
    method: 'POST',
    path: '/api/v1/articles/101/bookmark',
    body: { ...fenceFields, mediaPolicyFeedId: '7' },
  },
  {
    name: 'unbookmark',
    action: { type: 'unbookmark' },
    method: 'DELETE',
    path: '/api/v1/articles/101/bookmark',
    query: fenceFields,
  },
  {
    name: 'retryCapture',
    action: { type: 'retryCapture', captureGeneration: '3' },
    method: 'POST',
    path: '/api/v1/articles/101/bookmark/retry-capture',
    body: { ...fenceFields, captureGeneration: '3' },
  },
  {
    name: 'addLabel',
    action: { type: 'addLabel', labelId: '9' },
    method: 'POST',
    path: '/api/v1/articles/101/labels',
    body: { ...fenceFields, labelId: '9' },
  },
  {
    name: 'removeLabel',
    action: { type: 'removeLabel', labelId: '9' },
    method: 'DELETE',
    path: '/api/v1/articles/101/labels/9',
    query: fenceFields,
  },
  {
    name: 'a snapshot unbookmark',
    action: { type: 'unbookmark' },
    fence: SNAPSHOT_FENCE,
    method: 'DELETE',
    path: '/api/v1/articles/101/bookmark',
    query: snapshotFields,
  },
  {
    name: 'a snapshot removeLabel',
    action: { type: 'removeLabel', labelId: '9' },
    fence: SNAPSHOT_FENCE,
    method: 'DELETE',
    path: '/api/v1/articles/101/labels/9',
    query: snapshotFields,
  },
  {
    name: 'a snapshot addLabel',
    action: { type: 'addLabel', labelId: '9' },
    fence: SNAPSHOT_FENCE,
    method: 'POST',
    path: '/api/v1/articles/101/labels',
    body: { ...snapshotFields, labelId: '9' },
  },
  {
    name: 'a snapshot read',
    action: { type: 'read' },
    fence: SNAPSHOT_FENCE,
    method: 'POST',
    path: '/api/v1/articles/101/read',
    body: snapshotFields,
  },
];

describe('send', () => {
  it.each(sendCases)(
    'sends $name to its route with the fence, the key and the signal',
    async ({ action, fence = FENCE, method, path, body, query, reply = plain }) => {
      const { transport, requests } = setup(() => json(200, reply));
      const controller = new AbortController();
      await transport.send('101', action, fence, KEY, controller.signal);

      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.method).toBe(method);
      expect(request?.pathname).toBe(path);
      expect(request?.headers.get('idempotency-key')).toBe(KEY);
      expect(request?.signal).toBe(controller.signal);
      if (method === 'POST') {
        expect(JSON.parse(request?.body as string)).toEqual(body);
        expect(Object.fromEntries(request?.query ?? [])).toEqual({});
      } else {
        expect(request?.body).toBeNull();
        expect(Object.fromEntries(request?.query ?? [])).toEqual(query);
      }
    },
  );

  it('sends the key it is given, also when the same action is sent again', async () => {
    const { transport, requests } = setup();
    const controller = new AbortController();
    await transport.send('101', { type: 'bookmark' }, FENCE, 'first', controller.signal);
    await transport.send('101', { type: 'bookmark' }, FENCE, 'first', controller.signal);
    await transport.send('101', { type: 'bookmark' }, FENCE, 'second', controller.signal);
    expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
      'first',
      'first',
      'second',
    ]);
  });

  it('encodes the article id and the label id in the path', async () => {
    const { transport, requests } = setup();
    const controller = new AbortController();
    await transport.send(
      'a/b',
      { type: 'removeLabel', labelId: 'c d' },
      FENCE,
      KEY,
      controller.signal,
    );
    expect(requests[0]?.pathname).toBe('/api/v1/articles/a%2Fb/labels/c%20d');
  });
});

describe('send responses', () => {
  const signal = () => new AbortController().signal;

  it.each<[string, ReaderAction]>([
    ['read', { type: 'read' }],
    ['unread', { type: 'unread' }],
    ['unhide', { type: 'unhide' }],
    ['open', { type: 'open' }],
    ['promptAnswer', { type: 'promptAnswer', liked: true }],
    ['bookmark', { type: 'bookmark' }],
    ['unbookmark', { type: 'unbookmark' }],
    ['retryCapture', { type: 'retryCapture', captureGeneration: '3' }],
    ['addLabel', { type: 'addLabel', labelId: '9' }],
    ['removeLabel', { type: 'removeLabel', labelId: '9' }],
  ])('returns only the item and the receipt for the %s action', async (_name, action) => {
    const { transport } = setup();
    const response = await transport.send('101', action, FENCE, KEY, signal());
    expect(response).toStrictEqual({ item, mutationId: MUTATION });
  });

  it('returns the item and receipt of a retry-capture answered with 202', async () => {
    const { transport } = setup(() => json(202, plain));
    const response = await transport.send(
      '101',
      { type: 'retryCapture', captureGeneration: '3' },
      FENCE,
      KEY,
      signal(),
    );
    expect(response).toStrictEqual({ item, mutationId: MUTATION });
  });

  it('adds the example suggestion of a rating', async () => {
    const exampleSuggestion = { cardId: '31', side: 'no' };
    const { transport } = setup(() => json(200, { ...plain, exampleSuggestion }));
    const response = await transport.send('101', { type: 'rate', rating: 1 }, FENCE, KEY, signal());
    expect(response).toStrictEqual({ item, mutationId: MUTATION, exampleSuggestion });
  });

  it('keeps a null example suggestion of a rating', async () => {
    const { transport } = setup(() => json(200, { ...plain, exampleSuggestion: null }));
    const response = await transport.send('101', { type: 'rate', rating: 1 }, FENCE, KEY, signal());
    expect(response).toStrictEqual({ item, mutationId: MUTATION, exampleSuggestion: null });
  });

  it.each([true, false])('adds the prompt flag %s of a dwell', async (prompt) => {
    const { transport } = setup(() => json(200, { ...plain, prompt }));
    const response = await transport.send('101', { type: 'dwell', ms: 5000 }, FENCE, KEY, signal());
    expect(response).toStrictEqual({ item, mutationId: MUTATION, prompt });
  });
});

describe('send failures', () => {
  const signal = () => new AbortController().signal;

  it('rejects with the ApiError of the client, details included', async () => {
    const newer = makeItem({ id: '101', stateVersion: '8' });
    const { transport } = setup(() => failure(409, 'STALE_STATE', { item: newer }));
    const error = await rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, signal()),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'http',
      status: 409,
      code: 'STALE_STATE',
      details: { item: newer },
    });
  });

  it('keeps the Retry-After of a 429 on the error', async () => {
    const { transport } = setup(() =>
      failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '3' }),
    );
    const error = await rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, signal()),
    );
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3000 });
  });

  it('sends a request once and does not retry a 503 itself', async () => {
    const { transport, fetchMock } = setup(() => failure(503, 'ENGINE_UNAVAILABLE'));
    const error = await rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, signal()),
    );
    expect(error).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with a network error when the request cannot be made', async () => {
    const { transport } = setup(() => Promise.reject(new TypeError('offline')));
    const error = await rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, signal()),
    );
    expect(error).toMatchObject({ kind: 'network' });
  });

  it('rejects with an aborted error when the signal fires', async () => {
    const { transport } = setup(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, controller.signal),
    );
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'aborted' });
  });

  it('rejects with invalid_response when the answer has no item', async () => {
    const { transport } = setup(() => json(200, { mutationId: MUTATION }));
    const error = await rejection(
      transport.send('101', { type: 'bookmark' }, FENCE, KEY, signal()),
    );
    expect(error).toMatchObject({ kind: 'invalid_response' });
  });
});

describe('bulk and undo', () => {
  const signal = () => new AbortController().signal;
  const targets = [
    { id: '101', stateVersion: '4', contentRevision: '2' },
    { id: '102', stateVersion: '9', contentRevision: '5' },
  ];
  const filter: MarkReadFilter = {
    lane: 'for_you',
    minTier: 3,
    feedId: '7',
    olderThan: '2026-06-01T11:59:00.000Z',
  };

  it('sends markRead with explicit targets to /articles/mark-read', async () => {
    const { transport, requests } = setup(() => json(200, { count: 2, mutationId: MUTATION }));
    const controller = new AbortController();
    const response = await transport.markRead({ targets }, KEY, controller.signal);

    expect(response).toStrictEqual({ count: 2, mutationId: MUTATION });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.pathname).toBe('/api/v1/articles/mark-read');
    expect(requests[0]?.headers.get('idempotency-key')).toBe(KEY);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ targets });
  });

  it('sends markRead by filter with the dataset version', async () => {
    const { transport, requests } = setup(() => json(200, { count: 40, mutationId: MUTATION }));
    const response = await transport.markRead({ filter, datasetVersion: 'ds-7' }, KEY, signal());

    expect(response).toStrictEqual({ count: 40, mutationId: MUTATION });
    expect(requests[0]?.pathname).toBe('/api/v1/articles/mark-read');
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ filter, datasetVersion: 'ds-7' });
  });

  it.each([1, -1, null] as const)(
    'sends rateBulk with rating %s to /articles/rate-bulk',
    async (rating) => {
      const { transport, requests } = setup(() =>
        json(200, { count: 2, mutationId: MUTATION, items: [item] }),
      );
      const controller = new AbortController();
      const response = await transport.rateBulk({ targets, rating }, KEY, controller.signal);

      expect(response).toStrictEqual({ count: 2, mutationId: MUTATION, items: [item] });
      expect(requests[0]?.method).toBe('POST');
      expect(requests[0]?.pathname).toBe('/api/v1/articles/rate-bulk');
      expect(requests[0]?.headers.get('idempotency-key')).toBe(KEY);
      expect(requests[0]?.signal).toBe(controller.signal);
      expect(JSON.parse(requests[0]?.body as string)).toEqual({ targets, rating });
    },
  );

  it('passes the targets of a rateBulk on as they are, a request id included', async () => {
    const { transport, requests } = setup(() =>
      json(200, { count: 1, mutationId: MUTATION, items: [item] }),
    );
    const withRequest = [
      { id: '101', stateVersion: '4', contentRevision: '2', analysisRequestId: REQUEST_ID },
    ];
    await transport.rateBulk({ targets: withRequest, rating: 1 }, KEY, signal());
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ targets: withRequest, rating: 1 });
  });

  it('sends undo with the mutation id to /articles/undo', async () => {
    const { transport, requests } = setup(() =>
      json(200, { count: 1, mutationId: '00000000-0000-4000-8000-000000000002', items: [item] }),
    );
    const controller = new AbortController();
    const response = await transport.undo(MUTATION, 'undo-key', controller.signal);

    expect(response).toStrictEqual({
      count: 1,
      mutationId: '00000000-0000-4000-8000-000000000002',
      items: [item],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.pathname).toBe('/api/v1/articles/undo');
    expect(requests[0]?.headers.get('idempotency-key')).toBe('undo-key');
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ mutationId: MUTATION });
  });

  it('rejects with the ApiError of the client and does not retry', async () => {
    const newer = makeItem({ id: '101', stateVersion: '8' });
    const { transport, fetchMock } = setup(() => failure(409, 'STALE_STATE', { items: [newer] }));
    const error = await rejection(transport.undo(MUTATION, KEY, signal()));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'STALE_STATE', details: { items: [newer] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a bulk request answered with a 503 without retrying it', async () => {
    const { transport, fetchMock } = setup(() => failure(503, 'ENGINE_UNAVAILABLE'));
    const error = await rejection(transport.markRead({ targets }, KEY, signal()));
    expect(error).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
