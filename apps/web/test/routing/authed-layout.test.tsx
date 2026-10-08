import { QueryClient } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { createI18n } from '../../src/i18n/index.js';
import { createAppRouter } from '../../src/router.js';
import { makeMe } from '../session/fixtures.js';

// The layout is under test, so the screen below it and the prompt it mounts, which read queries, are
// stood in for. Only i18next is provided, which shows the layout itself needs neither a
// QueryClientProvider nor a SessionProvider.
vi.mock('../../src/features/onboarding/onboarding-page.js', async () => {
  const { createElement } = await import('react');
  return { OnboardingPage: () => createElement('h1', null, 'Welcome') };
});
vi.mock('../../src/features/why/did-you-like-prompt.js', () => ({ DidYouLikePrompt: () => null }));

async function renderOnboarding(queryClient: QueryClient) {
  const router = createAppRouter(
    { queryClient, loadMe: () => Promise.resolve(makeMe()) },
    createMemoryHistory({ initialEntries: ['/onboarding'] }),
  );
  await router.load();
  render(
    <I18nextProvider i18n={createI18n()}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await waitFor(() => expect(router.state.status).toBe('idle'));
  expect(router.state.matches.at(-1)?.routeId).toBe('/_authed/onboarding');
}

describe('_authed layout', () => {
  beforeEach(() => {
    // jsdom has no scrolling; the router's scroll restoration would log "not implemented".
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  it('renders the screen below it for a signed-in account', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKey(), makeMe());

    await renderOnboarding(queryClient);

    expect(await screen.findByRole('heading')).toBeInTheDocument();
  });

  it('renders it before the account has been asked for', async () => {
    await renderOnboarding(new QueryClient());

    expect(await screen.findByRole('heading')).toBeInTheDocument();
  });

  it('renders nothing once the account is gone, before the router has redirected', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKey(), makeMe());
    await renderOnboarding(queryClient);
    await screen.findByRole('heading');

    act(() => {
      queryClient.setQueryData(meKey(), null);
    });

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('renders nothing for a signed-out cache, then the screen once an account signs in', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKey(), null);
    await renderOnboarding(queryClient);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(meKey(), makeMe());
    });

    expect(await screen.findByRole('heading')).toBeInTheDocument();
  });
});
