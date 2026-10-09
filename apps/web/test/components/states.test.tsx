import { APP_ERROR_CODES, QUOTA_LIMIT_NAMES } from '@bantoozi/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ApiErrorInit } from '../../src/api/errors.js';
import { EmptyState } from '../../src/components/states/empty-state.js';
import { ErrorState } from '../../src/components/states/error-state.js';
import { LoadingState } from '../../src/components/states/loading-state.js';
import { OfflineState } from '../../src/components/states/offline-state.js';
import { QueryState } from '../../src/components/states/query-state.js';
import { QuotaLimitState } from '../../src/components/states/quota-limit-state.js';
import { useOnline } from '../../src/components/states/use-online.js';
import { errorMessage } from '../../src/components/error-message.js';
import { createI18n, type Language } from '../../src/i18n/index.js';

function renderWithI18n(ui: ReactNode, language: Language = 'en') {
  return render(<I18nextProvider i18n={createI18n(language)}>{ui}</I18nextProvider>);
}

function httpError(code: string, details?: ApiErrorInit['details']) {
  return new ApiError({ kind: 'http', status: 422, code, message: `raw ${code}`, details });
}

const networkError = () =>
  new ApiError({ kind: 'network', status: null, code: 'NETWORK', message: 'Failed to fetch' });

function setNavigatorOnline(online: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
});

describe('errorMessage', () => {
  describe.each(['en', 'sk'] as const)('in %s', (language) => {
    const { t } = createI18n(language);

    it.each(APP_ERROR_CODES)('gives a real message for %s', (code) => {
      const details =
        code === 'QUOTA_EXCEEDED' ? { limit: 'maxFeeds', used: 50, max: 50 } : undefined;
      const message = errorMessage(t, httpError(code, details));
      expect(message).toMatch(/\S{3}/);
      expect(message).not.toBe(code);
      expect(message).not.toMatch(/^(common:)?errors\./);
      expect(message).not.toMatch(/\{\{|undefined/);
    });

    it('gives a real message for FEED_HTTP_404, with the status', () => {
      const message = errorMessage(t, httpError('FEED_HTTP_404'));
      expect(message).toContain('404');
      expect(message).not.toMatch(/^(common:)?errors\./);
    });

    it.each([
      ['network', 'NETWORK'],
      ['invalid_response', 'INVALID_RESPONSE'],
      ['aborted', 'ABORTED'],
    ] as const)('maps the %s kind to errors.%s', (kind, key) => {
      const error = new ApiError({ kind, status: null, code: key, message: 'raw' });
      expect(errorMessage(t, error)).toBe(t(`common:errors.${key}`));
      expect(errorMessage(t, error)).not.toMatch(/^(common:)?errors\./);
    });

    it('falls back to UNKNOWN for unknown codes and non-ApiError values', () => {
      const unknown = t('common:errors.UNKNOWN');
      expect(unknown).not.toMatch(/^(common:)?errors\./);
      expect(errorMessage(t, httpError('SOMETHING_NEW'))).toBe(unknown);
      expect(errorMessage(t, new Error('boom'))).toBe(unknown);
      expect(errorMessage(t, 'boom')).toBe(unknown);
      expect(errorMessage(t, null)).toBe(unknown);
    });

    it.each(QUOTA_LIMIT_NAMES)('names the %s quota limit', (limit) => {
      const name = t(`common:quota.${limit}`);
      expect(name).not.toMatch(/^(common:)?quota\./);
      const message = errorMessage(t, httpError('QUOTA_EXCEEDED', { limit, used: 47, max: 50 }));
      expect(message).toContain(name);
      expect(message).toContain('47');
      expect(message).toContain('50');
    });

    it('does not print placeholders when the quota details are not the usual ones', () => {
      const message = errorMessage(
        t,
        httpError('QUOTA_EXCEEDED', { limit: 'invites', invitesLeft: 0 }),
      );
      expect(message).toMatch(/\S{3}/);
      expect(message).not.toMatch(/\{\{|undefined|NaN/);
      expect(errorMessage(t, httpError('QUOTA_EXCEEDED'))).toBe(message);
    });
  });

  it('is translated: Slovak differs from English for every code', () => {
    const en = createI18n('en').t;
    const sk = createI18n('sk').t;
    const details = { limit: 'maxFeeds', used: 50, max: 50 };
    for (const code of [...APP_ERROR_CODES, 'FEED_HTTP_404']) {
      const error = httpError(code, code === 'QUOTA_EXCEEDED' ? details : undefined);
      expect(errorMessage(sk, error), code).not.toBe(errorMessage(en, error));
    }
    for (const key of ['NETWORK', 'INVALID_RESPONSE', 'ABORTED', 'UNKNOWN']) {
      expect(sk(`common:errors.${key}`), key).not.toBe(en(`common:errors.${key}`));
    }
  });
});

describe('state components', () => {
  it('LoadingState is a status with an accessible label', () => {
    renderWithI18n(<LoadingState />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  });

  it('LoadingState accepts a specific label, and is localized', () => {
    renderWithI18n(<LoadingState label="Loading feeds…" />);
    expect(screen.getByRole('status', { name: 'Loading feeds…' })).toBeInTheDocument();
  });

  it('LoadingState is localized', () => {
    renderWithI18n(<LoadingState />, 'sk');
    expect(
      screen.getByRole('status', { name: createI18n('sk').t('common:states.loading') }),
    ).toBeInTheDocument();
  });

  it('EmptyState shows a title, a body and an action', () => {
    renderWithI18n(
      <EmptyState
        title="No labels yet"
        body="Labels group articles."
        action={<button>Add</button>}
      />,
    );
    expect(screen.getByText('No labels yet')).toBeInTheDocument();
    expect(screen.getByText('Labels group articles.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('EmptyState needs only a title', () => {
    renderWithI18n(<EmptyState title="Nothing" />);
    expect(screen.getByText('Nothing')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ErrorState shows the localized message and retries', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithI18n(<ErrorState error={httpError('INTERNAL')} onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    const { t } = createI18n('en');
    expect(alert).toHaveTextContent(t('common:states.errorTitle'));
    expect(alert).toHaveTextContent(t('common:errors.INTERNAL'));
    expect(alert).not.toHaveTextContent('raw INTERNAL');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState has no Retry button without a handler', () => {
    renderWithI18n(<ErrorState error={new Error('x')} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('OfflineState explains the situation and retries', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithI18n(<OfflineState onRetry={onRetry} />);
    const { t } = createI18n('en');
    expect(screen.getByText(t('common:states.offlineTitle'))).toBeInTheDocument();
    expect(screen.getByText(t('common:states.offlineBody'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('OfflineState has no Retry button without a handler', () => {
    renderWithI18n(<OfflineState />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['en', 'sk'] as const)(
    'QuotaLimitState shows used, max and the limit in %s',
    (language) => {
      renderWithI18n(<QuotaLimitState limit="maxCards" used={47} max={50} />, language);
      const { t } = createI18n(language);
      const state = screen.getByRole('status');
      expect(state).toHaveTextContent(t('common:states.quotaTitle'));
      expect(state).toHaveTextContent(t('common:quota.maxCards'));
      expect(state).toHaveTextContent('47');
      expect(state).toHaveTextContent('50');
    },
  );
});

describe('useOnline', () => {
  function Probe() {
    return <p>{useOnline() ? 'online' : 'offline'}</p>;
  }

  it('follows navigator.onLine and the online and offline events', () => {
    renderWithI18n(<Probe />);
    expect(screen.getByText('online')).toBeInTheDocument();
    setNavigatorOnline(false);
    expect(screen.getByText('offline')).toBeInTheDocument();
    setNavigatorOnline(true);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('starts from the current navigator.onLine value', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    renderWithI18n(<Probe />);
    expect(screen.getByText('offline')).toBeInTheDocument();
  });
});

describe('QueryState', () => {
  const i18n = createI18n('en');
  const t = i18n.t;

  function Probe({
    queryFn,
    isEmpty,
    empty,
  }: {
    queryFn: () => Promise<string>;
    isEmpty?: (data: string) => boolean;
    empty?: ReactNode;
  }) {
    const query = useQuery({ queryKey: ['probe'], queryFn, retry: false });
    return (
      <QueryState query={query} isEmpty={isEmpty} empty={empty}>
        {(data) => <p>data: {data}</p>}
      </QueryState>
    );
  }

  function renderQuery(props: Parameters<typeof Probe>[0], client = newClient()) {
    renderWithI18n(
      <QueryClientProvider client={client}>
        <Probe {...props} />
      </QueryClientProvider>,
    );
    return client;
  }

  function newClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  }

  const never = () => new Promise<string>(() => {});

  it('shows the loading state while pending', () => {
    renderQuery({ queryFn: never });
    expect(screen.getByRole('status', { name: t('common:states.loading') })).toBeInTheDocument();
  });

  it('renders the children with the data once loaded', async () => {
    renderQuery({ queryFn: () => Promise.resolve('fresh') });
    expect(await screen.findByText('data: fresh')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the default empty state when the data is empty', async () => {
    renderQuery({ queryFn: () => Promise.resolve(''), isEmpty: (data) => data === '' });
    expect(await screen.findByText(t('common:states.emptyTitle'))).toBeInTheDocument();
    expect(screen.queryByText(/^data:/)).not.toBeInTheDocument();
  });

  it('shows the given empty element when the data is empty', async () => {
    renderQuery({
      queryFn: () => Promise.resolve(''),
      isEmpty: (data) => data === '',
      empty: <p>No feeds yet</p>,
    });
    expect(await screen.findByText('No feeds yet')).toBeInTheDocument();
    expect(screen.queryByText(t('common:states.emptyTitle'))).not.toBeInTheDocument();
  });

  it('renders the children for data that is not empty', async () => {
    renderQuery({ queryFn: () => Promise.resolve('x'), isEmpty: (data) => data === '' });
    expect(await screen.findByText('data: x')).toBeInTheDocument();
  });

  it('shows the quota state for QUOTA_EXCEEDED', async () => {
    const error = httpError('QUOTA_EXCEEDED', { limit: 'maxLabels', used: 20, max: 20 });
    renderQuery({ queryFn: () => Promise.reject(error) });
    const state = await screen.findByText(t('common:states.quotaTitle'));
    expect(state).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(t('common:quota.maxLabels'));
    expect(screen.getByRole('status')).toHaveTextContent('20');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows the offline state for a network error and retries with a refetch', async () => {
    const user = userEvent.setup();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce('back');
    renderQuery({ queryFn });
    expect(await screen.findByText(t('common:states.offlineTitle'))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('data: back')).toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('shows the error state for any other error and retries with a refetch', async () => {
    const user = userEvent.setup();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError('INTERNAL'))
      .mockResolvedValueOnce('recovered');
    renderQuery({ queryFn });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('common:states.errorTitle'));
    expect(alert).toHaveTextContent(t('common:errors.INTERNAL'));

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('data: recovered')).toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('treats a value that is not an ApiError as an unknown error', async () => {
    renderQuery({ queryFn: () => Promise.reject(new Error('boom')) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('common:errors.UNKNOWN'));
    expect(alert).not.toHaveTextContent('boom');
  });

  it('shows the offline state instead of an endless spinner while offline', async () => {
    setNavigatorOnline(false);
    renderQuery({ queryFn: never });
    expect(await screen.findByText(t('common:states.offlineTitle'))).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: t('common:states.loading') })).toBeNull();

    setNavigatorOnline(true);
    expect(
      await screen.findByRole('status', { name: t('common:states.loading') }),
    ).toBeInTheDocument();
  });

  it('shows the offline state when going offline while loading', async () => {
    renderQuery({ queryFn: never });
    expect(screen.getByRole('status', { name: t('common:states.loading') })).toBeInTheDocument();
    setNavigatorOnline(false);
    expect(await screen.findByText(t('common:states.offlineTitle'))).toBeInTheDocument();
  });

  it('keeps showing the data while offline', async () => {
    const client = newClient();
    client.setQueryData(['probe'], 'cached');
    setNavigatorOnline(false);
    renderQuery({ queryFn: never }, client);
    expect(screen.getByText('data: cached')).toBeInTheDocument();
    expect(screen.queryByText(t('common:states.offlineTitle'))).not.toBeInTheDocument();
  });

  it('keeps showing the data when a refetch fails', async () => {
    const client = newClient();
    client.setQueryData(['probe'], 'cached');
    const queryFn = vi.fn<() => Promise<string>>().mockRejectedValue(httpError('INTERNAL'));
    renderQuery({ queryFn }, client);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalled());
    await vi.waitFor(() => expect(client.getQueryState(['probe'])?.status).toBe('error'));
    expect(screen.getByText('data: cached')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
