import { QueryClient } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { createI18n } from '../../src/i18n/index.js';
import { createAppRouter } from '../../src/router.js';
import { makeMe } from '../session/fixtures.js';

vi.mock('../../src/features/why/did-you-like-prompt.js', async () => {
  const { createElement } = await import('react');
  return { DidYouLikePrompt: () => createElement('p', null, 'The prompt is mounted') };
});
// The wizard reads queries; only the layout around it is under test.
vi.mock('../../src/features/onboarding/onboarding-page.js', async () => {
  const { createElement } = await import('react');
  return { OnboardingPage: () => createElement('h1', null, 'Welcome') };
});

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
}

describe('the "Did you like it?" prompt in the _authed layout', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  });

  it('is mounted once for a signed-in account', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKey(), makeMe());

    await renderOnboarding(queryClient);

    expect(await screen.findAllByText('The prompt is mounted')).toHaveLength(1);
  });

  it('is mounted once the account is known, not before', async () => {
    const queryClient = new QueryClient();
    await renderOnboarding(queryClient);
    await screen.findByRole('heading');
    expect(screen.queryByText('The prompt is mounted')).toBeNull();

    act(() => {
      queryClient.setQueryData(meKey(), makeMe());
    });

    expect(await screen.findByText('The prompt is mounted')).toBeInTheDocument();
  });

  it('goes with the account', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKey(), makeMe());
    await renderOnboarding(queryClient);
    await screen.findByText('The prompt is mounted');

    act(() => {
      queryClient.setQueryData(meKey(), null);
    });

    expect(screen.queryByText('The prompt is mounted')).toBeNull();
  });
});
