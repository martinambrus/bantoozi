import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeLocks, installLocks, removeLocks } from '../offline/fake-locks.js';
import { USER_A_ID } from '../session/fixtures.js';
import type { FakeServer } from '../support/app.js';
import { makeMe } from '../session/fixtures.js';
import {
  EMAIL,
  bodiesOf,
  deferred,
  harness,
  openSettings,
  patchMe,
  settingsRoutes,
} from './support.js';

const LOCK = `bantoozi:preferences:${USER_A_ID}`;
const TITLE = 'Preferences are being adjusted in another tab or window';
const TAKE_OVER = 'Edit here instead';
const SWITCH = 'Simple mode';

let locks: FakeLocks;
const grantedPreferences = () =>
  locks.granted.filter((name) => name.startsWith('bantoozi:preferences:'));

beforeEach(() => {
  locks = new FakeLocks();
  installLocks(locks);
});

afterEach(() => {
  removeLocks();
});

type Tab = Awaited<ReturnType<typeof openSettings>>;

/** Another window on the same account: `openSettings` looks for the one heading of the page. */
async function openAnotherWindow(): Promise<Tab> {
  const server: FakeServer = { me: makeMe({ email: EMAIL }), routes: {} };
  server.routes = settingsRoutes(server);
  const app = await harness.open({ path: '/settings', server });
  await within(app.container).findByRole('heading', { level: 1, name: 'Settings' });
  return { ...app, server };
}

const prefsOf = (tab: Tab) =>
  within(within(tab.container).getByRole('region', { name: 'Reading preferences' }));
const switchOf = (tab: Tab) => prefsOf(tab).getByRole('switch', { name: SWITCH });
const overlayOf = (tab: Tab) => prefsOf(tab).queryByText(TITLE)?.closest('[role="status"]') ?? null;

/** Another tab, as far as this one can tell: it holds the lock until `release()`. */
function holdElsewhere(name = LOCK) {
  const held = deferred();
  void locks.request(name, () => held.promise);
  return held.release;
}

describe('the preferences lock across tabs', () => {
  it('shows an overlay and sends nothing while another tab holds the lock', async () => {
    holdElsewhere();
    const tab = await openSettings();

    await waitFor(() => expect(overlayOf(tab)).not.toBeNull());
    expect(overlayOf(tab)).toHaveTextContent(TITLE);
    expect(switchOf(tab).closest('[inert]')).not.toBeNull();
    expect(overlayOf(tab)?.closest('[inert]')).toBeNull();

    await tab.user.click(switchOf(tab));

    expect(tab.calls('PATCH /me')).toHaveLength(0);
    expect(switchOf(tab)).toHaveAttribute('aria-checked', 'false');
  });

  it('shows what the other tab saved and saves again once that tab lets go', async () => {
    const release = holdElsewhere();
    const tab = await openSettings();
    await waitFor(() => expect(overlayOf(tab)).not.toBeNull());
    const before = tab.calls('GET /me').length;
    tab.server.me = {
      ...tab.server.me!,
      preferences: { ...tab.server.me!.preferences, simpleMode: true },
    };

    await act(async () => {
      release();
    });

    await waitFor(() => expect(overlayOf(tab)).toBeNull());
    await waitFor(() => expect(tab.calls('GET /me').length).toBeGreaterThan(before));
    await waitFor(() => expect(switchOf(tab)).toHaveAttribute('aria-checked', 'true'));
    expect(switchOf(tab).closest('[inert]')).toBeNull();

    await tab.user.click(switchOf(tab));

    await waitFor(() => expect(tab.calls('PATCH /me')).toHaveLength(1));
    expect(bodiesOf(tab.calls('PATCH /me'))).toEqual([{ preferences: { simpleMode: false } }]);
  });

  it('takes the lock over on "Edit here instead" and locks the tab that had it', async () => {
    const sending = deferred();
    const first = await openSettings({
      routes: (server) => ({
        'PATCH /me': async (request, params) => {
          await sending.promise;
          return patchMe(server)(request, params);
        },
      }),
    });
    await waitFor(() => expect(grantedPreferences()).toHaveLength(1));
    expect(overlayOf(first)).toBeNull();
    await first.user.click(switchOf(first));
    await first.user.click(prefsOf(first).getByRole('radio', { name: 'Newest first' }));
    await first.user.click(prefsOf(first).getByRole('radio', { name: 'Best match' }));
    await waitFor(() => expect(first.calls('PATCH /me')).toHaveLength(2));

    const second = await openAnotherWindow();
    await waitFor(() => expect(overlayOf(second)).not.toBeNull());
    await second.user.click(prefsOf(second).getByRole('button', { name: TAKE_OVER }));

    await waitFor(() => expect(overlayOf(second)).toBeNull());
    await waitFor(() => expect(overlayOf(first)).not.toBeNull());
    expect(switchOf(second).closest('[inert]')).toBeNull();

    await act(async () => {
      sending.release();
    });
    await first.user.click(prefsOf(first).getByRole('radio', { name: 'Newest first' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(first.calls('PATCH /me')).toHaveLength(2);
    await second.user.click(switchOf(second));
    await waitFor(() => expect(second.calls('PATCH /me')).toHaveLength(1));
  });

  it('drops a change that was waiting for its turn when the lock is lost', async () => {
    const sending = deferred();
    const first = await openSettings({
      routes: (server) => ({
        'PATCH /me': async (request, params) => {
          await sending.promise;
          return patchMe(server)(request, params);
        },
      }),
    });
    await waitFor(() => expect(grantedPreferences()).toHaveLength(1));
    await first.user.click(switchOf(first));
    await first.user.click(switchOf(first));
    await waitFor(() => expect(first.calls('PATCH /me')).toHaveLength(1));

    const second = await openAnotherWindow();
    await second.user.click(
      await within(second.container).findByRole('button', { name: TAKE_OVER }),
    );
    await waitFor(() => expect(overlayOf(first)).not.toBeNull());
    await act(async () => {
      sending.release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(first.calls('PATCH /me')).toHaveLength(1);
  });

  it('moves the focus to the button when the controls are locked under it', async () => {
    const first = await openSettings();
    await waitFor(() => expect(grantedPreferences()).toHaveLength(1));
    switchOf(first).focus();
    expect(switchOf(first)).toHaveFocus();

    const second = await openAnotherWindow();
    const button = await within(second.container).findByRole('button', { name: TAKE_OVER });
    act(() => button.click());

    await waitFor(() => expect(overlayOf(first)).not.toBeNull());
    expect(prefsOf(first).getByRole('button', { name: TAKE_OVER })).toHaveFocus();
  });

  it('lets go of the lock when the screen goes away', async () => {
    const tab = await openSettings();
    await waitFor(() => expect(locks.granted).toContain(LOCK));
    expect(await locks.request(LOCK, { ifAvailable: true }, (lock) => lock)).toBeNull();

    tab.unmount();

    await waitFor(async () => {
      expect(await locks.request(LOCK, { ifAvailable: true }, (lock) => lock)).not.toBeNull();
    });
  });

  it('keeps one lock for each account', async () => {
    holdElsewhere('bantoozi:preferences:0192f7a0-0000-7000-8000-00000000000b');
    const tab = await openSettings();

    await waitFor(() => expect(locks.granted).toContain(LOCK));
    expect(overlayOf(tab)).toBeNull();
    expect(switchOf(tab).closest('[inert]')).toBeNull();
  });

  it('changes nothing where the browser has no Web Locks', async () => {
    removeLocks();
    const tab = await openSettings();

    expect(overlayOf(tab)).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
    await tab.user.click(switchOf(tab));

    await waitFor(() => expect(tab.calls('PATCH /me')).toHaveLength(1));
    expect(bodiesOf(tab.calls('PATCH /me'))).toEqual([{ preferences: { simpleMode: true } }]);
  });
});
