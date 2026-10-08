import { MutationObserver, QueryObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/api/errors.js';
import { createQueryClient } from '../../src/api/query-client.js';

const network = () =>
  new ApiError({ kind: 'network', status: null, code: 'NETWORK', message: 'offline' });
const http = (status: number, retryAfterMs: number | null = null) =>
  new ApiError({ kind: 'http', status, code: 'TEST', message: 'test', retryAfterMs });

/** Starts the query and reports through `calls` how often its function ran. */
function observe(queryFn: () => Promise<string>) {
  const client = createQueryClient();
  const calls = vi.fn(queryFn);
  const observer = new QueryObserver(client, { queryKey: ['probe'], queryFn: calls });
  observer.subscribe(() => undefined);
  return { observer, calls };
}

const afterMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('createQueryClient', () => {
  it('retries a transient failure with backoff, twice at most', async () => {
    vi.useFakeTimers();
    const { observer, calls } = observe(() => Promise.reject(network()));

    await afterMs(0);
    expect(calls).toHaveBeenCalledTimes(1);
    await afterMs(999);
    expect(calls).toHaveBeenCalledTimes(1);
    await afterMs(1);
    expect(calls).toHaveBeenCalledTimes(2);
    await afterMs(1999);
    expect(calls).toHaveBeenCalledTimes(2);
    await afterMs(1);
    expect(calls).toHaveBeenCalledTimes(3);
    await afterMs(60_000);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().status).toBe('error');
  });

  it('delivers the data once a retry succeeds', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { observer } = observe(() => {
      attempt += 1;
      return attempt < 3 ? Promise.reject(http(503)) : Promise.resolve('ok');
    });

    await afterMs(3000);

    expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: 'ok' });
  });

  it.each([
    ['a network failure', network()],
    ['a 500', http(500)],
    ['a 503', http(503)],
    ['a 429', http(429)],
  ])('retries %s', async (_name, error) => {
    vi.useFakeTimers();
    const { calls } = observe(() => Promise.reject(error));

    await afterMs(1000);

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 400', http(400)],
    ['a 401', http(401)],
    ['a 403', http(403)],
    ['a 404', http(404)],
    ['a 409', http(409)],
    [
      'an invalid response',
      new ApiError({
        kind: 'invalid_response',
        status: 200,
        code: 'INVALID_RESPONSE',
        message: 'bad body',
      }),
    ],
    [
      'an abort',
      new ApiError({ kind: 'aborted', status: null, code: 'ABORTED', message: 'aborted' }),
    ],
    ['an error of the app itself', new Error('boom')],
  ])('does not retry %s', async (_name, error) => {
    vi.useFakeTimers();
    const { calls, observer } = observe(() => Promise.reject(error));

    await afterMs(60_000);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().status).toBe('error');
  });

  it('never retries sooner than Retry-After', async () => {
    vi.useFakeTimers();
    const { calls } = observe(() => Promise.reject(http(429, 5000)));

    await afterMs(4999);
    expect(calls).toHaveBeenCalledTimes(1);
    await afterMs(1);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('leaves a Retry-After that is too long to the screen', async () => {
    vi.useFakeTimers();
    const { calls, observer } = observe(() => Promise.reject(http(503, 120_000)));

    await afterMs(300_000);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().status).toBe('error');
  });

  it('never retries a mutation', async () => {
    vi.useFakeTimers();
    const mutationFn = vi.fn(() => Promise.reject(network()));
    const mutation = new MutationObserver(createQueryClient(), { mutationFn });

    const outcome = mutation.mutate().catch((error: unknown) => error);
    await afterMs(60_000);

    expect(await outcome).toBeInstanceOf(ApiError);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe('a mutation made while the browser is offline', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('fails at once instead of waiting unseen for the connection', async () => {
    onlineManager.setOnline(false);
    const mutationFn = vi.fn(() => Promise.reject(network()));
    const mutation = new MutationObserver(createQueryClient(), { mutationFn });

    const outcome = mutation.mutate().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(mutation.getCurrentResult().isPaused).toBe(false);
    expect(await outcome).toBeInstanceOf(ApiError);
  });

  it('is not paused by default, whichever screen starts it', () => {
    expect(createQueryClient().getDefaultOptions().mutations).toMatchObject({
      networkMode: 'always',
      retry: false,
    });
  });
});
