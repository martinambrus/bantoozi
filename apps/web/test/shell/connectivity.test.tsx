import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createI18n, type Language } from '../../src/i18n/index.js';
import { noContent } from '../api/fake-fetch.js';
import { READER_READS, createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';

const { open } = createHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

function server(language: Language = 'en') {
  return {
    me: makeMe({ displayName: 'Ada Lovelace', email: 'ada@example.com', locale: language }),
    routes: { ...READER_READS, 'POST /auth/logout': () => noContent() },
  };
}

function connectionIs(online: boolean) {
  const line = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  return {
    set(next: boolean) {
      line.mockReturnValue(next);
      act(() => {
        window.dispatchEvent(new Event(next ? 'online' : 'offline'));
      });
    },
  };
}

const text = (language: Language, key: string) => createI18n(language).t(key);

describe('the connection notice', () => {
  it('reaches a person in a modal, and is replaced when the connection is back', async () => {
    const connection = connectionIs(true);
    const app = await open({ path: '/read/for_you', server: server() });
    await app.user.click(screen.getByRole('button', { name: 'Menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog).toHaveAttribute('open');

    connection.set(false);
    const region = within(dialog).getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent("You're offline");
    expect(screen.getByText(text('en', 'shell:offlineBanner'))).toBeVisible();

    connection.set(true);
    expect(within(dialog).getByRole('status')).toHaveTextContent("You're back online");
    expect(within(dialog).getByRole('status')).not.toHaveTextContent("You're offline");
    expect(within(dialog).getByRole('status').querySelectorAll('[data-tone]')).toHaveLength(1);
    expect(screen.queryByText(text('en', 'shell:offlineBanner'))).not.toBeInTheDocument();
  });

  it('is in the page when no modal is open', async () => {
    const connection = connectionIs(true);
    await open({ path: '/read/for_you', server: server() });

    connection.set(false);
    const notice = screen.getByText("You're offline.");
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(notice.closest('dialog')).toBeNull();
    expect(screen.getByText(text('en', 'shell:offlineBanner'))).toBeVisible();
  });

  it('shows one notice at a time, however often the connection comes and goes', async () => {
    const connection = connectionIs(true);
    await open({ path: '/read/for_you', server: server() });

    connection.set(false);
    connection.set(true);
    connection.set(false);

    expect(screen.getAllByText(/^You're (offline|back online)\.$/)).toHaveLength(1);
    expect(screen.getByText("You're offline.")).toBeVisible();
  });

  it('says nothing about a connection that was already gone when the app started', async () => {
    const connection = connectionIs(false);
    await open({ path: '/read/for_you', server: server() });
    expect(screen.getByText(text('en', 'shell:offlineBanner'))).toBeVisible();
    expect(screen.queryByText("You're offline.")).not.toBeInTheDocument();

    connection.set(true);
    expect(screen.getByText("You're back online.")).toBeVisible();
  });

  it('is in Slovak for a Slovak account', async () => {
    const connection = connectionIs(true);
    await open({ path: '/read/for_you', server: server('sk'), language: 'sk' });

    connection.set(false);
    expect(screen.getByText('Ste offline.')).toBeVisible();
    connection.set(true);
    expect(screen.getByText('Ste znova online.')).toBeVisible();
  });
});
