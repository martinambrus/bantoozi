import type { FeedInfo } from '@bantoozi/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../../src/api/client.js';
import { ApiProvider } from '../../src/api/context.js';
import { meKey } from '../../src/api/query-keys.js';
import { DeadFeedBanner } from '../../src/features/feeds/dead-feed-banner.js';
import { createI18n, type Language } from '../../src/i18n/index.js';
import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import { SessionProvider } from '../../src/session/context.js';
import { clearAccountKeys, forgetAccountMemory } from '../../src/session/local-keys.js';
import type { Session } from '../../src/session/session.js';
import { failure, fakeFetch, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { USER_A_ID, USER_B_ID, makeMe } from '../session/fixtures.js';
import { DELETE_FEED, dismissalKeys, feedsServer, makeSubscription, rowOf } from './support.js';

const FAILED_AT = '2026-10-01T08:00:00.000Z';
const FAILED_AGAIN_AT = '2026-10-05T08:00:00.000Z';

function deadFeed(overrides: Partial<FeedInfo> = {}): FeedInfo {
  return makeSubscription({
    feed: {
      id: '9',
      title: 'Dead Blog',
      status: 'dead',
      lastErrorCode: 'FEED_DNS_ERROR',
      lastErrorAt: FAILED_AT,
      ...overrides,
    },
  }).feed;
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearAccountKeys(USER_A_ID);
  localStorage.clear();
});

/** The banner alone, as the reader's feed view renders it: providers, no router. */
function renderBanner(feed: FeedInfo, language: Language = 'en') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(meKey(), makeMe());
  const fake = fakeFetch((request) =>
    request.method === 'DELETE' && request.pathname === '/api/v1/subscriptions/9'
      ? noContent()
      : failure(404, 'NOT_FOUND'),
  );
  const api = createApiClient({ fetch: fake.fetch });
  const i18n = createI18n(language);
  // The session as far as the banner uses it: one sign-in, which lasts.
  const session = { currentSignIn: () => 0 } as Partial<Session> as Session;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={api}>
          <SessionProvider session={session}>
            <ToastProvider>{children}</ToastProvider>
          </SessionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
  const view = render(<DeadFeedBanner feed={feed} />, { wrapper });
  const again = (next: FeedInfo) => view.rerender(<DeadFeedBanner feed={next} />);
  return { ...view, again, requests: fake.requests, user: userEvent.setup() };
}

const message = (reason = "We couldn't find that website.") =>
  `This feed stopped working on Oct 1, 2026: ${reason}`;

describe('DeadFeedBanner', () => {
  it('says when the feed stopped working and why, and offers Unsubscribe and Dismiss', () => {
    renderBanner(deadFeed());

    expect(screen.getByText(message())).toBeVisible();
    const unsubscribe = screen.getByRole('button', { name: 'Unsubscribe' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(unsubscribe).toHaveAccessibleDescription(message());
    expect(dismiss).toHaveAccessibleDescription(message());
  });

  it('writes the date in the language and the time zone of the account', () => {
    renderBanner(deadFeed({ lastErrorAt: '2026-10-01T22:30:00.000Z' }));

    expect(screen.getByText(/stopped working on Oct 2, 2026:/)).toBeVisible();
  });

  it('writes the date and the reason in Slovak', () => {
    renderBanner(deadFeed(), 'sk');

    const text = screen.getByText(/1\.\s*10\.\s*2026/).textContent ?? '';
    expect(text).not.toContain('{{');
    expect(text).not.toContain('stopped working');
    expect(text).toContain('Túto webovú stránku sa nepodarilo nájsť.');
  });

  it.each([
    ['FEED_TIMEOUT', 'The website took too long to answer.'],
    ['FEED_HTTP_410', 'The website answered with an error (410).'],
    ['SOMETHING_NEW', "We couldn't fetch it."],
    [null, "We couldn't fetch it."],
  ])('gives %s as the reason', (lastErrorCode, reason) => {
    renderBanner(deadFeed({ lastErrorCode }));

    expect(screen.getByText(message(reason))).toBeVisible();
  });

  it('leaves out the date when the failure has none', () => {
    renderBanner(deadFeed({ lastErrorAt: null }));

    expect(
      screen.getByText("This feed stopped working: We couldn't find that website."),
    ).toBeVisible();
  });

  it.each(['active', 'quarantined', 'paused'] as const)('shows nothing for a %s feed', (status) => {
    const { container } = renderBanner(deadFeed({ status }));

    expect(container).toBeEmptyDOMElement();
  });

  describe('Dismiss', () => {
    it('hides the notice and remembers it in the browser under the account and the failure', async () => {
      const { user, container } = renderBanner(deadFeed());

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(container).toBeEmptyDOMElement();
      const keys = dismissalKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^${USER_A_ID}`));
      expect(keys[0]).toContain(':9:');
      expect(keys[0]).toContain(FAILED_AT);
    });

    it('stays hidden when the banner renders again', async () => {
      const { user, container, again, unmount } = renderBanner(deadFeed());
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      again(deadFeed());
      expect(container).toBeEmptyDOMElement();

      unmount();
      const second = renderBanner(deadFeed());
      expect(second.container).toBeEmptyDOMElement();
    });

    it('shows the notice again for a newer failure, and a new dismissal replaces the old one', async () => {
      const { user, container, again } = renderBanner(deadFeed());
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(container).toBeEmptyDOMElement();

      again(deadFeed({ lastErrorAt: FAILED_AGAIN_AT }));

      expect(screen.getByText(/stopped working on Oct 5, 2026:/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(container).toBeEmptyDOMElement();
      expect(dismissalKeys()).toHaveLength(1);
      expect(dismissalKeys()[0]).toContain(FAILED_AGAIN_AT);
    });

    it('does not hide the notice of another feed', async () => {
      const first = renderBanner(deadFeed());
      await first.user.click(screen.getByRole('button', { name: 'Dismiss' }));
      first.unmount();

      renderBanner(deadFeed({ id: '10' }));

      expect(screen.getByText(message())).toBeVisible();
    });

    it('does not hide the notice for another account', () => {
      localStorage.setItem(`${USER_B_ID}:feeds:dead-feed-dismissed:9:${FAILED_AT}`, '1');

      renderBanner(deadFeed());

      expect(screen.getByText(message())).toBeVisible();
    });

    it('still hides the notice for now when the browser will not store it', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
      const { user, container } = renderBanner(deadFeed());

      await user.click(screen.getByRole('button', { name: 'Dismiss' }));

      expect(container).toBeEmptyDOMElement();
    });

    it('shows the notice when the browser will not say what was stored', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });

      renderBanner(deadFeed());

      expect(screen.getByText(message())).toBeVisible();
    });
  });

  describe('the dismissals when the account is removed from the device', () => {
    async function dismissed() {
      const view = renderBanner(deadFeed());
      await view.user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(dismissalKeys()).toHaveLength(1);
      return view;
    }

    it('are forgotten with the stored keys of the account', async () => {
      await dismissed();

      await act(async () => clearAccountKeys(USER_A_ID));

      expect(dismissalKeys()).toEqual([]);
      expect(screen.getByText(message())).toBeVisible();
    });

    it('are forgotten from memory too, when the browser would not store them', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
      const { user } = renderBanner(deadFeed());
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(message())).not.toBeInTheDocument();

      await act(async () => clearAccountKeys(USER_A_ID));

      expect(screen.getByText(message())).toBeVisible();
    });

    it('are kept when the keys of another account are cleared', async () => {
      await dismissed();

      await act(async () => clearAccountKeys(USER_B_ID));

      expect(dismissalKeys()).toHaveLength(1);
      expect(screen.queryByText(message())).not.toBeInTheDocument();
    });

    it('are kept in storage when only the memory of this tab is dropped, because another tab cleared it', async () => {
      await dismissed();

      await act(async () => forgetAccountMemory(USER_A_ID));

      expect(dismissalKeys()).toHaveLength(1);
      expect(screen.queryByText(message())).not.toBeInTheDocument();
    });
  });

  describe('Unsubscribe', () => {
    it('asks first, then deletes the subscription', async () => {
      const { user, requests } = renderBanner(deadFeed());

      await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
      const confirm = await screen.findByRole('dialog', { name: 'Unsubscribe from “Dead Blog”?' });
      expect(requests).toHaveLength(0);
      await user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]!.method).toBe('DELETE');
      expect(requests[0]!.pathname).toBe('/api/v1/subscriptions/9');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('does nothing when you cancel', async () => {
      const { user, requests } = renderBanner(deadFeed());

      await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
      const confirm = await screen.findByRole('dialog', { name: 'Unsubscribe from “Dead Blog”?' });
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

      expect(requests).toHaveLength(0);
      expect(screen.getByText(message())).toBeVisible();
    });
  });
});

describe('dead feeds in the feed list', () => {
  const { open } = createHarness();

  async function openList(extra: { logout?: boolean } = {}) {
    const { server, state } = feedsServer({
      subscriptions: [
        makeSubscription({
          feed: {
            id: '9',
            title: 'Dead Blog',
            status: 'dead',
            lastErrorCode: 'FEED_DNS_ERROR',
            lastErrorAt: FAILED_AT,
          },
        }),
        makeSubscription({ feed: { id: '2', title: 'Fine Blog' } }),
        makeSubscription({
          feed: {
            id: '3',
            title: 'Shaky Blog',
            status: 'quarantined',
            lastErrorCode: 'FEED_TIMEOUT',
            lastErrorAt: FAILED_AT,
          },
        }),
      ],
    });
    server.routes[DELETE_FEED] = (_request, params) => {
      state.subscriptions = state.subscriptions.filter((sub) => sub.feed.id !== params['feedId']);
      return noContent();
    };
    if (extra.logout === true) server.routes['POST /auth/logout'] = () => noContent();
    const app = await open({ path: '/feeds', server });
    await screen.findByRole('heading', { level: 3, name: 'Dead Blog' });
    return { app, server, state };
  }

  it('shows the notice under dead feeds only', async () => {
    await openList();

    expect(within(rowOf('Dead Blog')).getByText(message())).toBeVisible();
    expect(within(rowOf('Fine Blog')).queryByText(/stopped working/)).toBeNull();
    expect(within(rowOf('Shaky Blog')).queryByText(/stopped working/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('keeps a dismissed notice away when the screen is opened again', async () => {
    const { app } = await openList();
    await app.user.click(within(rowOf('Dead Blog')).getByRole('button', { name: 'Dismiss' }));
    expect(within(rowOf('Dead Blog')).queryByText(/stopped working/)).toBeNull();
    app.unmount();

    await openList();

    expect(within(rowOf('Dead Blog')).queryByText(/stopped working/)).toBeNull();
    expect(within(rowOf('Dead Blog')).getByText('Stopped')).toBeVisible();
  });

  it('forgets the dismissal when the account signs out', async () => {
    const { app } = await openList({ logout: true });
    await app.user.click(within(rowOf('Dead Blog')).getByRole('button', { name: 'Dismiss' }));
    expect(dismissalKeys()).toHaveLength(1);

    await act(async () => app.session.logout());

    expect(dismissalKeys()).toEqual([]);
  });

  it('removes the feed from the list when you unsubscribe from the notice', async () => {
    const { app } = await openList();

    await app.user.click(within(rowOf('Dead Blog')).getByRole('button', { name: 'Unsubscribe' }));
    const confirm = await screen.findByRole('dialog', { name: 'Unsubscribe from “Dead Blog”?' });
    await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Dead Blog' }),
      ).not.toBeInTheDocument(),
    );
    expect(app.calls(DELETE_FEED)).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Fine Blog' })).toBeVisible();
  });
});
