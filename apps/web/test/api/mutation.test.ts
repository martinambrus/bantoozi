import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { createApiClient } from '../../src/api/client.js';
import { ApiProvider } from '../../src/api/context.js';
import { ApiError } from '../../src/api/errors.js';
import { useApiMutation, type ApiMutationResult } from '../../src/api/mutation.js';
import { createQueryClient } from '../../src/api/query-client.js';
import { routes } from '../../src/api/routes.js';
import { makeMe } from '../session/fixtures.js';
import {
  UUID_V4,
  failure,
  fakeFetch,
  json,
  noContent,
  type FakeHandler,
  type RecordedRequest,
} from './fake-fetch.js';

function setup(handler?: FakeHandler) {
  const fake = fakeFetch(handler);
  const client = createApiClient({ fetch: fake.fetch });
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ApiProvider, { client, children }),
    );
  return { ...fake, wrapper };
}

const keyOf = (request: RecordedRequest | undefined) => request?.headers.get('idempotency-key');

/** `act` hands back a thenable without `catch`, and its value is lost unless it is captured. */
async function inAct<T>(run: () => Promise<T>): Promise<T> {
  let value: T | undefined;
  await act(async () => {
    value = await run();
  });
  return value as T;
}
const rename = { body: { displayName: 'Ann' } };

describe('useApiMutation', () => {
  it('keeps the key and the body when TanStack retries the intent', async () => {
    let attempt = 0;
    const { wrapper, requests } = setup(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return json(200, makeMe({ displayName: 'Ann' }));
    });
    const { result } = renderHook(
      () => useApiMutation(routes.meUpdate, { retry: 1, retryDelay: 0 }),
      { wrapper },
    );

    await inAct(() => result.current.mutateAsync(rename));

    expect(requests).toHaveLength(2);
    expect(keyOf(requests[0])).toMatch(UUID_V4);
    expect(keyOf(requests[1])).toBe(keyOf(requests[0]));
    expect(requests[1]?.body).toBe('{"displayName":"Ann"}');
    expect(requests[1]?.body).toBe(requests[0]?.body);
  });

  it('keeps the key when the variables of a failed mutation are sent again', async () => {
    let attempt = 0;
    const { wrapper, requests } = setup(() => {
      attempt += 1;
      return attempt === 1 ? failure(503, 'ENGINE_UNAVAILABLE') : json(200, makeMe());
    });
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    act(() => result.current.mutate(rename));
    await waitFor(() => expect(result.current.isError).toBe(true));
    const failed = result.current.variables;
    act(() => result.current.mutate(failed));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requests).toHaveLength(2);
    expect(keyOf(requests[1])).toBe(keyOf(requests[0]));
    expect(requests[1]?.body).toBe(requests[0]?.body);
  });

  it('makes a new key for each mutate, even with the very same input object', async () => {
    const { wrapper, requests } = setup(() => json(200, makeMe()));
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    await inAct(() => result.current.mutateAsync(rename));
    await inAct(() => result.current.mutateAsync(rename));

    expect(keyOf(requests[0])).toMatch(UUID_V4);
    expect(keyOf(requests[1])).toMatch(UUID_V4);
    expect(keyOf(requests[1])).not.toBe(keyOf(requests[0]));
  });

  it('sends the key the caller gives', async () => {
    const { wrapper, requests } = setup(() => json(200, makeMe()));
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    await inAct(() => result.current.mutateAsync({ ...rename, idempotencyKey: 'queued-1' }));

    expect(keyOf(requests[0])).toBe('queued-1');
  });

  it('does not retry on its own', async () => {
    const { wrapper, requests } = setup(() => failure(503, 'ENGINE_UNAVAILABLE'));
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    act(() => result.current.mutate(rename));
    await waitFor(() => expect(result.current.isError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toHaveLength(1);
  });

  it('rejects with the ApiError', async () => {
    const { wrapper } = setup(() => failure(409, 'STALE_STATE', { reason: 'stale_version' }));
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    const error = await inAct(() => result.current.mutateAsync(rename).catch((e: unknown) => e));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'STALE_STATE', reason: 'stale_version' });
  });

  it('resolves with the validated output', async () => {
    const me = makeMe({ displayName: 'Ann' });
    const { wrapper } = setup(() => json(200, me));
    const { result } = renderHook(() => useApiMutation(routes.meUpdate), { wrapper });

    await expect(inAct(() => result.current.mutateAsync(rename))).resolves.toEqual(me);
  });

  it('adds no key to a route that has none', async () => {
    const { wrapper, requests } = setup(() => json(200, { next: 'check_email' }));
    const { result } = renderHook(() => useApiMutation(routes.authRequestCode), { wrapper });
    const variables = { body: { email: 'a@example.com' } };

    await inAct(() => result.current.mutateAsync(variables));

    expect(keyOf(requests[0])).toBeNull();
    await waitFor(() => expect(result.current.variables).toEqual(variables));
  });

  it('mutates a route that takes no input without arguments', async () => {
    const { wrapper, requests } = setup(() => noContent());
    const { result } = renderHook(() => useApiMutation(routes.meDelete), { wrapper });

    await inAct(() => result.current.mutateAsync());

    expect(requests[0]?.method).toBe('DELETE');
    expect(keyOf(requests[0])).toMatch(UUID_V4);
  });

  it('keeps mutate and mutateAsync stable across renders', () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(() => useApiMutation(routes.meDelete), { wrapper });
    const { mutate, mutateAsync } = result.current;

    rerender();

    expect(result.current.mutate).toBe(mutate);
    expect(result.current.mutateAsync).toBe(mutateAsync);
  });

  it('asks for the input a route needs', () => {
    const typeOnly = (
      rate: ApiMutationResult<typeof routes.articleRate>,
      remove: ApiMutationResult<typeof routes.meDelete>,
    ) => {
      // @ts-expect-error articleRate needs its params and body
      rate.mutate();
      remove.mutate();
    };

    expect(typeOnly).toBeTypeOf('function');
  });
});
