import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../src/api/client.js';
import { ApiProvider, useApi } from '../../src/api/context.js';
import { createQueryClient } from '../../src/api/query-client.js';
import { meKey } from '../../src/api/query-keys.js';
import { createI18n } from '../../src/i18n/index.js';
import { SessionProvider, useAccountId, useMe, useSession } from '../../src/session/context.js';
import { createSession, type Session } from '../../src/session/session.js';
import { failure, fakeFetch } from '../api/fake-fetch.js';
import { USER_A_ID, makeMe } from './fixtures.js';

function setup() {
  const fake = fakeFetch(() => failure(401, 'UNAUTHENTICATED'));
  const queryClient = createQueryClient();
  const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={session.api}>
        <SessionProvider session={session}>{children}</SessionProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
  return { ...fake, queryClient, session, wrapper };
}

const sessions: Session[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
});

function signedIn(me = makeMe()) {
  const started = setup();
  sessions.push(started.session);
  started.queryClient.setQueryData(meKey(), me);
  return started;
}

describe('useMe', () => {
  it('returns the cached account without asking the server', () => {
    const me = makeMe({ displayName: 'Ann' });
    const { wrapper, requests } = signedIn(me);

    const { result } = renderHook(() => useMe(), { wrapper });

    expect(result.current).toEqual(me);
    expect(requests).toHaveLength(0);
  });

  it('follows the account when it changes', async () => {
    const { wrapper, queryClient } = signedIn();
    const { result } = renderHook(() => useMe(), { wrapper });

    act(() => {
      queryClient.setQueryData(meKey(), makeMe({ displayName: 'Bea' }));
    });

    await waitFor(() => expect(result.current.displayName).toBe('Bea'));
  });

  it.each([
    ['nobody is signed in', null],
    ['the account is not known yet', undefined],
  ])('throws when %s', (_name, cached) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { wrapper, queryClient } = setup();
    if (cached !== undefined) queryClient.setQueryData(meKey(), cached);

    expect(() => renderHook(() => useMe(), { wrapper })).toThrow(/signed-in account/);
  });
});

describe('useAccountId', () => {
  it('returns the id of the account', () => {
    const { wrapper } = signedIn();

    const { result } = renderHook(() => useAccountId(), { wrapper });

    expect(result.current).toBe(USER_A_ID);
  });
});

describe('providers', () => {
  it('hand out the session and the client they were given', () => {
    const { wrapper, session } = signedIn();

    const { result } = renderHook(() => ({ session: useSession(), api: useApi() }), { wrapper });

    expect(result.current.session).toBe(session);
    expect(result.current.api).toBe(session.api);
  });

  it('are required by their hooks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => renderHook(() => useSession())).toThrow(/SessionProvider/);
    expect(() => renderHook(() => useApi())).toThrow(/ApiProvider/);
  });

  it('give useApi the client of the nearest provider', () => {
    const outer = createApiClient();
    const inner = createApiClient();

    const { result } = renderHook(() => useApi(), {
      wrapper: ({ children }) => (
        <ApiProvider client={outer}>
          <ApiProvider client={inner}>{children}</ApiProvider>
        </ApiProvider>
      ),
    });

    expect(result.current).toBe(inner);
  });
});
